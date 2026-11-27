//! Notes (ADR 032): markdown pages in the sidebar, in folders that nest (ADR 042). A note may be
//! attached to a task; its body links tasks, projects, epics and meetings with
//! `task:<id>`, `project:<id>`, `epic:<id>` and `meeting:<id>` URLs (ADR 042), which the
//! core leaves as text.

use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::commands::{client_id, linked_task};
use crate::error::{Error, Result};
use crate::model::{Id, Note, NoteFolder};
use crate::ops::{Batch, Change, Entity, OpKind};
use crate::rank;

/// Longest note title, in characters.
pub const MAX_NOTE_TITLE_CHARS: usize = 300;
/// Longest note body, in characters.
pub const MAX_NOTE_BODY_CHARS: usize = 1_000_000;
/// Longest folder name, in characters.
const MAX_FOLDER_NAME_CHARS: usize = 100;
/// Deepest a folder may sit: a top-level folder is at depth 1.
pub const MAX_FOLDER_DEPTH: usize = 8;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(default)]
pub struct NewNote {
    /// Client-generated UUID; generated when absent.
    pub id: Option<Id>,
    /// May be blank.
    pub title: String,
    pub body: String,
    pub folder_id: Option<Id>,
    pub task_id: Option<Id>,
    /// Defaults to the end of its folder.
    pub rank: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum NoteChange {
    Title(String),
    Body(String),
    /// Moves it to a folder (`None`: the top level). Without a `Rank` change in the same
    /// update it goes to the end of that folder.
    FolderId(Option<Id>),
    /// Attaches it to a task, or detaches it with `None`.
    TaskId(Option<Id>),
    Rank(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(default)]
pub struct NewNoteFolder {
    pub id: Option<Id>,
    pub name: String,
    /// The folder to create it in; `None` at the top level.
    pub parent_id: Option<Id>,
    /// Defaults to after the last folder at that level.
    pub rank: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum NoteFolderChange {
    Name(String),
    /// Moves it into another folder (`None`: the top level). Without a `Rank` change in
    /// the same update it goes after the folders already there.
    ParentId(Option<Id>),
    Rank(String),
}

// ---------------------------------------------------------------------------------------
// Commands

pub(crate) fn create_note(b: &mut Batch<'_, '_>, n: NewNote) -> Result<()> {
    let id = client_id(n.id)?;
    let title = note_title(&n.title)?;
    check_body(&n.body)?;
    if let Some(folder_id) = &n.folder_id {
        live_folder(b, folder_id)?;
    }
    if let Some(task_id) = &n.task_id {
        linked_task(b, task_id)?;
    }
    let rank = match n.rank {
        Some(r) => {
            rank::validate(&r)?;
            r
        }
        None => end_of_folder(b, n.folder_id.as_deref())?,
    };
    b.apply(Change::new(
        Entity::Note,
        &id,
        OpKind::Create,
        json!({
            "title": title,
            "body": n.body,
            "folder_id": n.folder_id,
            "task_id": n.task_id,
            "rank": rank,
            "created_at": b.now,
            "updated_at": b.now,
            "deleted_at": null,
        }),
    ))
}

pub(crate) fn update_note(b: &mut Batch<'_, '_>, id: &str, changes: Vec<NoteChange>) -> Result<()> {
    if changes.is_empty() {
        return Err(Error::invalid("update_note needs at least one change"));
    }
    let note = live_note(b, id)?;
    let mut patch = Map::new();
    let mut moved_to: Option<Option<Id>> = None;
    for change in changes {
        let (key, value) = match change {
            NoteChange::Title(t) => ("title", json!(note_title(&t)?)),
            NoteChange::Body(body) => {
                check_body(&body)?;
                ("body", json!(body))
            }
            NoteChange::FolderId(folder) => {
                if let Some(f) = &folder {
                    live_folder(b, f)?;
                }
                moved_to = Some(folder.clone());
                ("folder_id", json!(folder))
            }
            NoteChange::TaskId(task) => {
                if let Some(t) = &task {
                    linked_task(b, t)?;
                }
                ("task_id", json!(task))
            }
            NoteChange::Rank(r) => {
                rank::validate(&r)?;
                ("rank", json!(r))
            }
        };
        patch.insert(key.into(), value);
    }
    if let Some(folder) = moved_to
        && folder != note.folder_id
        && !patch.contains_key("rank")
    {
        patch.insert("rank".into(), json!(end_of_folder(b, folder.as_deref())?));
    }
    patch.insert("updated_at".into(), json!(b.now));
    b.apply(Change::new(
        Entity::Note,
        id,
        OpKind::Update,
        Value::Object(patch),
    ))
}

pub(crate) fn delete_note(b: &mut Batch<'_, '_>, id: &str) -> Result<()> {
    live_note(b, id)?;
    b.apply(Change::new(
        Entity::Note,
        id,
        OpKind::Delete,
        json!({ "deleted_at": b.now, "updated_at": b.now }),
    ))
}

pub(crate) fn create_folder(b: &mut Batch<'_, '_>, n: NewNoteFolder) -> Result<()> {
    let id = client_id(n.id)?;
    let name = folder_name(&n.name)?;
    if let Some(parent) = &n.parent_id {
        live_folder(b, parent)?;
        if depth(b, Some(parent))? + 1 > MAX_FOLDER_DEPTH {
            return Err(too_deep());
        }
    }
    let rank = match n.rank {
        Some(r) => {
            rank::validate(&r)?;
            r
        }
        None => end_of_level(b, n.parent_id.as_deref())?,
    };
    b.apply(Change::new(
        Entity::NoteFolder,
        &id,
        OpKind::Create,
        json!({
            "name": name,
            "parent_id": n.parent_id,
            "rank": rank,
            "created_at": b.now,
            "updated_at": b.now,
            "deleted_at": null,
        }),
    ))
}

pub(crate) fn update_folder(
    b: &mut Batch<'_, '_>,
    id: &str,
    changes: Vec<NoteFolderChange>,
) -> Result<()> {
    if changes.is_empty() {
        return Err(Error::invalid(
            "update_note_folder needs at least one change",
        ));
    }
    let folder = live_folder(b, id)?;
    let mut patch = Map::new();
    let mut moved_to: Option<Option<Id>> = None;
    for change in changes {
        let (key, value) = match change {
            NoteFolderChange::Name(n) => ("name", json!(folder_name(&n)?)),
            NoteFolderChange::ParentId(parent) => {
                if let Some(p) = &parent {
                    live_folder(b, p)?;
                    if p == id || ancestors(b, p)?.iter().any(|a| a == id) {
                        return Err(Error::invalid(
                            "a folder cannot move into itself or one of its own folders",
                        ));
                    }
                    if depth(b, Some(p))? + subtree_height(b, id)? > MAX_FOLDER_DEPTH {
                        return Err(too_deep());
                    }
                }
                moved_to = Some(parent.clone());
                ("parent_id", json!(parent))
            }
            NoteFolderChange::Rank(r) => {
                rank::validate(&r)?;
                ("rank", json!(r))
            }
        };
        patch.insert(key.into(), value);
    }
    if let Some(parent) = moved_to
        && parent != folder.parent_id
        && !patch.contains_key("rank")
    {
        patch.insert("rank".into(), json!(end_of_level(b, parent.as_deref())?));
    }
    patch.insert("updated_at".into(), json!(b.now));
    b.apply(Change::new(
        Entity::NoteFolder,
        id,
        OpKind::Update,
        Value::Object(patch),
    ))
}

/// Moves the folder's notes and subfolders up into its parent (the top level for a
/// top-level folder), at the end and in their order, then deletes it. Undo puts them back.
pub(crate) fn delete_folder(b: &mut Batch<'_, '_>, id: &str) -> Result<()> {
    let folder = live_folder(b, id)?;
    let parent = folder.parent_id.clone();
    let children: Vec<Id> = {
        let mut stmt = b.tx.prepare(
            "SELECT id FROM note_folders WHERE parent_id = ?1 AND deleted_at IS NULL \
             ORDER BY rank, id",
        )?;
        stmt.query_map([id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?
    };
    let mut last_folder = end_folder_rank(b, parent.as_deref())?;
    for child in children {
        let rank = rank::key_between(last_folder.as_deref(), None)?;
        b.apply(Change::new(
            Entity::NoteFolder,
            &child,
            OpKind::Update,
            json!({ "parent_id": parent, "rank": rank, "updated_at": b.now }),
        ))?;
        last_folder = Some(rank);
    }
    let inside: Vec<Id> = {
        let mut stmt = b.tx.prepare(
            "SELECT id FROM notes WHERE folder_id = ?1 AND deleted_at IS NULL ORDER BY rank, id",
        )?;
        stmt.query_map([id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?
    };
    let mut last = end_rank(b, parent.as_deref())?;
    for note_id in inside {
        let rank = rank::key_between(last.as_deref(), None)?;
        b.apply(Change::new(
            Entity::Note,
            &note_id,
            OpKind::Update,
            json!({ "folder_id": parent, "rank": rank, "updated_at": b.now }),
        ))?;
        last = Some(rank);
    }
    b.apply(Change::new(
        Entity::NoteFolder,
        id,
        OpKind::Delete,
        json!({ "deleted_at": b.now, "updated_at": b.now }),
    ))
}

/// A title with its whitespace (line breaks included) tidied to single spaces.
fn note_title(raw: &str) -> Result<String> {
    let title = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.chars().count() > MAX_NOTE_TITLE_CHARS {
        return Err(Error::invalid(format!(
            "a note title has at most {MAX_NOTE_TITLE_CHARS} characters"
        )));
    }
    Ok(title)
}

fn check_body(body: &str) -> Result<()> {
    if body.len() > MAX_NOTE_BODY_CHARS && body.chars().count() > MAX_NOTE_BODY_CHARS {
        return Err(Error::invalid(format!(
            "a note has at most {MAX_NOTE_BODY_CHARS} characters"
        )));
    }
    Ok(())
}

fn folder_name(raw: &str) -> Result<String> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(Error::invalid("folder name cannot be empty"));
    }
    if name.chars().count() > MAX_FOLDER_NAME_CHARS {
        return Err(Error::invalid(format!(
            "a folder name has at most {MAX_FOLDER_NAME_CHARS} characters"
        )));
    }
    Ok(name)
}

fn end_rank(b: &Batch<'_, '_>, folder_id: Option<&str>) -> Result<Option<String>> {
    Ok(b.tx.query_row(
        "SELECT MAX(rank) FROM notes WHERE folder_id IS ?1 AND deleted_at IS NULL",
        [folder_id],
        |r| r.get(0),
    )?)
}

fn end_of_folder(b: &Batch<'_, '_>, folder_id: Option<&str>) -> Result<String> {
    rank::key_between(end_rank(b, folder_id)?.as_deref(), None)
}

/// The last rank among the live folders in `parent` (`None`: the top level).
fn end_folder_rank(b: &Batch<'_, '_>, parent: Option<&str>) -> Result<Option<String>> {
    Ok(b.tx.query_row(
        "SELECT MAX(rank) FROM note_folders WHERE parent_id IS ?1 AND deleted_at IS NULL",
        [parent],
        |r| r.get(0),
    )?)
}

fn end_of_level(b: &Batch<'_, '_>, parent: Option<&str>) -> Result<String> {
    rank::key_between(end_folder_rank(b, parent)?.as_deref(), None)
}

/// The folders above `id`, its parent first.
fn ancestors(b: &Batch<'_, '_>, id: &str) -> Result<Vec<Id>> {
    let mut out: Vec<Id> = Vec::new();
    let mut current = folder(b.tx, id)?.parent_id;
    while let Some(parent) = current {
        // A cycle (only from a bad merge) stops here instead of looping.
        if out.contains(&parent) || out.len() > MAX_FOLDER_DEPTH * 4 {
            break;
        }
        current = folder(b.tx, &parent)?.parent_id;
        out.push(parent);
    }
    Ok(out)
}

/// How deep a folder sits (1 at the top); 0 for the top level itself.
fn depth(b: &Batch<'_, '_>, id: Option<&str>) -> Result<usize> {
    Ok(match id {
        Some(id) => ancestors(b, id)?.len() + 1,
        None => 0,
    })
}

/// Levels in the folder and the live folders under it (1 for a folder with none).
fn subtree_height(b: &Batch<'_, '_>, id: &str) -> Result<usize> {
    let mut height = 1;
    let mut level = vec![id.to_owned()];
    while !level.is_empty() && height <= MAX_FOLDER_DEPTH {
        let mut next = Vec::new();
        for parent in &level {
            let mut stmt = b.tx.prepare_cached(
                "SELECT id FROM note_folders WHERE parent_id = ?1 AND deleted_at IS NULL",
            )?;
            let ids = stmt
                .query_map([parent], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            next.extend(ids);
        }
        if next.is_empty() {
            break;
        }
        height += 1;
        level = next;
    }
    Ok(height)
}

fn too_deep() -> Error {
    Error::invalid(format!(
        "folders nest at most {MAX_FOLDER_DEPTH} levels deep"
    ))
}

pub(crate) fn live_note(b: &Batch<'_, '_>, id: &str) -> Result<Note> {
    let note = note(b.tx, id)?;
    if note.deleted_at.is_some() {
        return Err(Error::not_found("note", id));
    }
    Ok(note)
}

fn live_folder(b: &Batch<'_, '_>, id: &str) -> Result<NoteFolder> {
    let folder = folder(b.tx, id)?;
    if folder.deleted_at.is_some() {
        return Err(Error::not_found("note folder", id));
    }
    Ok(folder)
}

// ---------------------------------------------------------------------------------------
// Reads

const NOTE_COLS: &str =
    "id, title, body, folder_id, task_id, rank, created_at, updated_at, deleted_at";
const FOLDER_COLS: &str = "id, name, parent_id, rank, created_at, updated_at, deleted_at";

fn note_row(r: &Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        title: r.get(1)?,
        body: r.get(2)?,
        folder_id: r.get(3)?,
        task_id: r.get(4)?,
        rank: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        deleted_at: r.get(8)?,
    })
}

fn folder_row(r: &Row<'_>) -> rusqlite::Result<NoteFolder> {
    Ok(NoteFolder {
        id: r.get(0)?,
        name: r.get(1)?,
        parent_id: r.get(2)?,
        rank: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        deleted_at: r.get(6)?,
    })
}

/// Any note, deleted ones included.
pub(crate) fn note(conn: &Connection, id: &str) -> Result<Note> {
    conn.query_row(
        &format!("SELECT {NOTE_COLS} FROM notes WHERE id = ?1"),
        [id],
        note_row,
    )
    .optional()?
    .ok_or_else(|| Error::not_found("note", id))
}

/// Any folder, deleted ones included.
pub(crate) fn folder(conn: &Connection, id: &str) -> Result<NoteFolder> {
    conn.query_row(
        &format!("SELECT {FOLDER_COLS} FROM note_folders WHERE id = ?1"),
        [id],
        folder_row,
    )
    .optional()?
    .ok_or_else(|| Error::not_found("note folder", id))
}

/// Live notes by rank.
pub(crate) fn notes(conn: &Connection) -> Result<Vec<Note>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {NOTE_COLS} FROM notes WHERE deleted_at IS NULL ORDER BY rank, id"
    ))?;
    let rows = stmt.query_map([], note_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Live folders by rank.
pub(crate) fn folders(conn: &Connection) -> Result<Vec<NoteFolder>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {FOLDER_COLS} FROM note_folders WHERE deleted_at IS NULL ORDER BY rank, id"
    ))?;
    let rows = stmt.query_map([], folder_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A note matching a search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NoteHit {
    pub note_id: Id,
    /// The title or the body around the matches, which are between `[` and `]`.
    pub snippet: String,
}

/// Live notes matching every word of `text` (prefix match on title and body), best first.
pub(crate) fn search_notes(conn: &Connection, text: &str, limit: u32) -> Result<Vec<NoteHit>> {
    let terms: Vec<String> = text
        .split_whitespace()
        .map(|word| format!("\"{}\"*", word.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT n.id, snippet(notes_fts, -1, '[', ']', '…', 16)
         FROM notes_fts
         JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ?1 AND n.deleted_at IS NULL
         ORDER BY bm25(notes_fts, 4.0, 1.0), n.updated_at DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![terms.join(" "), limit], |r| {
        Ok(NoteHit {
            note_id: r.get(0)?,
            snippet: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

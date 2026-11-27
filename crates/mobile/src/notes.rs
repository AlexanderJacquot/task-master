//! Notes (ADR 032) and new projects on the phone. Notes are the desktop's: markdown pages
//! in one level of folders, attached to a task or linking tasks and projects with
//! `task:<id>` and `project:<id>` URLs. Every write is one edit, undone and synced like
//! any other.

use taskmaster_core::{
    Command, NewAttachment, NewNote, NewNoteFolder, NewProject, Note, NoteChange, NoteFolderChange,
};

use crate::browse::{AttachmentItem, TaskRef, task_ref};
use crate::team::Data;
use crate::{AppError, AppResult, Core, lock, not_found};

/// The longest snippet a note row shows.
const SNIPPET_CHARS: usize = 140;

/// A folder of notes.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NoteFolderItem {
    pub id: String,
    pub name: String,
    /// Its live notes.
    pub count: u32,
    /// A folder of the team space.
    pub team: bool,
}

/// A note as a list draws it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NoteItem {
    pub id: String,
    /// May be blank: the app shows "Untitled".
    pub title: String,
    /// The start of the text without its markdown, or the words around a search match.
    pub snippet: String,
    pub folder_id: Option<String>,
    /// The task it is attached to.
    pub task: Option<TaskRef>,
    pub updated_at: i64,
    pub team: bool,
}

/// Every note, for the Notes screen.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NotesOverview {
    /// In their order.
    pub folders: Vec<NoteFolderItem>,
    /// Folder by folder in the folders' order, then those outside any folder; each group
    /// in its order.
    pub notes: Vec<NoteItem>,
}

/// What a link in a note's text points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum NoteLinkKind {
    Task,
    Project,
}

/// A `task:` or `project:` link in a note, with what it points at now (it may have been
/// renamed since the link was written).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NoteLink {
    /// As written: `task:<id>` or `project:<id>`.
    pub url: String,
    pub kind: NoteLinkKind,
    pub id: String,
    pub title: String,
    /// A task's stage (`None` for a project).
    pub stage: Option<crate::Stage>,
    /// A project's color.
    pub color: Option<String>,
}

/// A note in full.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NoteDetail {
    pub id: String,
    pub title: String,
    /// Markdown.
    pub body: String,
    pub folder_id: Option<String>,
    pub folder_name: Option<String>,
    pub task: Option<TaskRef>,
    /// The live targets of its `task:` and `project:` links; gone ones are left out.
    pub links: Vec<NoteLink>,
    pub attachments: Vec<AttachmentItem>,
    pub team: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One field of a note to change.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum NoteEdit {
    Title {
        value: String,
    },
    Body {
        value: String,
    },
    /// `None`: outside any folder. It goes to the end of the folder.
    Folder {
        id: Option<String>,
    },
    /// Attaches it to a task, or detaches it.
    Task {
        id: Option<String>,
    },
}

/// A new note.
#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct NewNoteInput {
    pub title: String,
    pub body: String,
    pub folder_id: Option<String>,
    pub task_id: Option<String>,
}

/// A new project.
#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct NewProjectInput {
    pub name: String,
    /// `#rrggbb`, or none.
    pub color: Option<String>,
    /// The top-level project (area) it sits in.
    pub parent_id: Option<String>,
}

fn invalid(message: &str) -> AppError {
    AppError::Invalid {
        message: message.into(),
    }
}

/// The first line of text in a note's body, without markdown marks, links shown as their
/// text and embedded files left out.
pub(crate) fn snippet(body: &str) -> String {
    for line in body.lines() {
        let line = line.trim();
        let line = line.trim_start_matches('#').trim_start();
        let line = ["- [ ] ", "- [x] ", "- [X] ", "- ", "* ", "> "]
            .iter()
            .find_map(|mark| line.strip_prefix(mark))
            .unwrap_or(line);
        let text = plain(line);
        if !text.trim().is_empty() {
            let text = text.trim();
            return match text.char_indices().nth(SNIPPET_CHARS) {
                Some((at, _)) => format!("{}…", text[..at].trim_end()),
                None => text.to_owned(),
            };
        }
    }
    String::new()
}

/// A line's text: `[text](url)` becomes `text`, `![name](url)` goes, `*`, `_` and `` ` ``
/// go.
fn plain(line: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        let image = rest[..open].ends_with('!');
        let before = if image {
            &rest[..open - 1]
        } else {
            &rest[..open]
        };
        out.push_str(before);
        let after = &rest[open + 1..];
        match after.find("](").and_then(|close| {
            after[close + 2..]
                .find(')')
                .map(|end| (close, close + 2 + end))
        }) {
            Some((close, end)) => {
                if !image {
                    out.push_str(&after[..close]);
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('[');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out.chars()
        .filter(|c| !matches!(c, '*' | '_' | '`'))
        .collect()
}

/// The ids a body links to with `(task:<id>)` or `(project:<id>)`, in order, once each.
pub(crate) fn linked_ids(body: &str, scheme: &str) -> Vec<String> {
    let pattern = format!("({scheme}:");
    let mut ids: Vec<String> = Vec::new();
    let mut rest = body;
    while let Some(at) = rest.find(&pattern) {
        let after = &rest[at + pattern.len()..];
        let end = after.find(')').unwrap_or(after.len());
        let id = after[..end].trim();
        if !id.is_empty() && !ids.iter().any(|i| i == id) {
            ids.push(id.to_owned());
        }
        rest = &after[end..];
    }
    ids
}

fn note_item(note: &Note, s: &Data, snippet_text: Option<String>) -> NoteItem {
    NoteItem {
        id: note.id.clone(),
        title: note.title.clone(),
        snippet: snippet_text.unwrap_or_else(|| snippet(&note.body)),
        folder_id: note.folder_id.clone(),
        task: note
            .task_id
            .as_deref()
            .and_then(|id| s.tasks.iter().find(|t| t.id == id))
            .map(|t| task_ref(t, s)),
        updated_at: note.updated_at,
        team: s.is_team(&note.id),
    }
}

#[uniffi::export]
impl Core {
    /// Every note and folder, both spaces.
    pub fn notes(&self) -> AppResult<NotesOverview> {
        let s = self.inner.data()?;
        let mut folders: Vec<_> = s.note_folders.iter().collect();
        folders.sort_by(|a, b| a.rank.cmp(&b.rank));
        let mut notes: Vec<_> = s.notes.iter().collect();
        let place = |folder: &Option<String>| match folder {
            Some(id) => folders
                .iter()
                .position(|f| &f.id == id)
                .unwrap_or(folders.len()),
            None => folders.len(),
        };
        notes.sort_by(|a, b| {
            place(&a.folder_id)
                .cmp(&place(&b.folder_id))
                .then_with(|| a.rank.cmp(&b.rank))
        });
        Ok(NotesOverview {
            folders: folders
                .iter()
                .map(|f| NoteFolderItem {
                    id: f.id.clone(),
                    name: f.name.clone(),
                    count: s
                        .notes
                        .iter()
                        .filter(|n| n.folder_id.as_deref() == Some(&*f.id))
                        .count() as u32,
                    team: s.is_team(&f.id),
                })
                .collect(),
            notes: notes.into_iter().map(|n| note_item(n, &s, None)).collect(),
        })
    }

    /// One note in full.
    pub fn note(&self, id: String) -> AppResult<NoteDetail> {
        let s = self.inner.data()?;
        let note = s
            .notes
            .iter()
            .find(|n| n.id == id)
            .ok_or_else(|| not_found("note"))?;
        let team = s.is_team(&note.id);
        let files = self.inner.files(team);
        let mut links = Vec::new();
        for id in linked_ids(&note.body, "task") {
            if let Some(t) = s.tasks.iter().find(|t| t.id == id) {
                links.push(NoteLink {
                    url: format!("task:{id}"),
                    kind: NoteLinkKind::Task,
                    title: t.title.clone(),
                    stage: Some(task_ref(t, &s).stage),
                    color: None,
                    id,
                });
            }
        }
        for id in linked_ids(&note.body, "project") {
            if let Some(p) = s.projects.iter().find(|p| p.id == id) {
                links.push(NoteLink {
                    url: format!("project:{id}"),
                    kind: NoteLinkKind::Project,
                    title: p.name.clone(),
                    stage: None,
                    color: p.color.clone(),
                    id,
                });
            }
        }
        Ok(NoteDetail {
            id: note.id.clone(),
            title: note.title.clone(),
            body: note.body.clone(),
            folder_id: note.folder_id.clone(),
            folder_name: note
                .folder_id
                .as_deref()
                .and_then(|id| s.note_folders.iter().find(|f| f.id == id))
                .map(|f| f.name.clone()),
            task: note
                .task_id
                .as_deref()
                .and_then(|id| s.tasks.iter().find(|t| t.id == id))
                .map(|t| task_ref(t, &s)),
            links,
            attachments: s
                .attachments
                .iter()
                .filter(|a| a.note_id.as_deref() == Some(&*note.id))
                .map(|a| AttachmentItem {
                    id: a.id.clone(),
                    name: a.name.clone(),
                    mime: a.mime.clone(),
                    size: a.size,
                    on_device: files.as_ref().is_some_and(|f| f.contains(&a.hash)),
                })
                .collect(),
            team,
            created_at: note.created_at,
            updated_at: note.updated_at,
        })
    }

    /// A task's notes: those attached to it, then those whose text links to it.
    pub fn task_notes(&self, task_id: String) -> AppResult<Vec<NoteItem>> {
        let s = self.inner.data()?;
        let link = format!("(task:{task_id})");
        let mut attached: Vec<_> = s
            .notes
            .iter()
            .filter(|n| n.task_id.as_deref() == Some(&*task_id))
            .collect();
        attached.sort_by_key(|n| std::cmp::Reverse(n.updated_at));
        let mut linking: Vec<_> = s
            .notes
            .iter()
            .filter(|n| n.task_id.as_deref() != Some(&*task_id) && n.body.contains(&link))
            .collect();
        linking.sort_by_key(|n| std::cmp::Reverse(n.updated_at));
        Ok(attached
            .into_iter()
            .chain(linking)
            .map(|n| note_item(n, &s, None))
            .collect())
    }

    /// Notes matching every word of `text` (title or body), best first, with the words
    /// around the match.
    pub fn search_notes(&self, text: String) -> AppResult<Vec<NoteItem>> {
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        let hits = self.inner.with_spaces(|s| Ok(s.search_notes(&text, 50)?))?;
        let s = self.inner.data()?;
        Ok(hits
            .into_iter()
            .filter_map(|hit| {
                let note = s.notes.iter().find(|n| n.id == hit.note_id)?;
                let words = hit.snippet.replace(['[', ']'], "");
                Some(note_item(note, &s, Some(plain(&words))))
            })
            .collect())
    }

    /// Writes a new note (at the end of its folder). Returns its id.
    pub fn create_note(&self, input: NewNoteInput) -> AppResult<String> {
        let id = taskmaster_core::new_id();
        self.inner.execute(
            vec![Command::CreateNote {
                note: NewNote {
                    id: Some(id.clone()),
                    title: input.title,
                    body: input.body,
                    folder_id: input.folder_id,
                    task_id: input.task_id,
                    rank: None,
                },
            }],
            None,
        )?;
        Ok(id)
    }

    /// Changes fields of a note, as one edit.
    pub fn edit_note(&self, id: String, edits: Vec<NoteEdit>) -> AppResult<()> {
        if edits.is_empty() {
            return Ok(());
        }
        let changes = edits
            .into_iter()
            .map(|edit| match edit {
                NoteEdit::Title { value } => NoteChange::Title(value),
                NoteEdit::Body { value } => NoteChange::Body(value),
                NoteEdit::Folder { id } => NoteChange::FolderId(id),
                NoteEdit::Task { id } => NoteChange::TaskId(id),
            })
            .collect();
        self.inner
            .execute(vec![Command::UpdateNote { id, changes }], None)?;
        Ok(())
    }

    /// Deletes a note (undo brings it back, with its files).
    pub fn delete_note(&self, id: String) -> AppResult<()> {
        self.inner.execute(vec![Command::DeleteNote { id }], None)?;
        Ok(())
    }

    /// Makes a folder after the last one. Returns its id.
    pub fn create_note_folder(&self, name: String) -> AppResult<String> {
        let name = name.trim().to_owned();
        if name.is_empty() {
            return Err(invalid("a folder needs a name"));
        }
        let id = taskmaster_core::new_id();
        self.inner.execute(
            vec![Command::CreateNoteFolder {
                folder: NewNoteFolder {
                    id: Some(id.clone()),
                    name,
                    rank: None,
                },
            }],
            None,
        )?;
        Ok(id)
    }

    pub fn rename_note_folder(&self, id: String, name: String) -> AppResult<()> {
        let name = name.trim().to_owned();
        if name.is_empty() {
            return Err(invalid("a folder needs a name"));
        }
        self.inner.execute(
            vec![Command::UpdateNoteFolder {
                id,
                changes: vec![NoteFolderChange::Name(name)],
            }],
            None,
        )?;
        Ok(())
    }

    /// Deletes a folder; its notes move to the end of the top level.
    pub fn delete_note_folder(&self, id: String) -> AppResult<()> {
        self.inner
            .execute(vec![Command::DeleteNoteFolder { id }], None)?;
        Ok(())
    }

    /// Attaches a file (a photo) to a note, copied into the app's store. Returns the
    /// attachment's id; the app writes `![name](attachment:<id>)` into the text.
    pub fn attach_note_file(
        &self,
        note_id: String,
        path: String,
        name: String,
    ) -> AppResult<String> {
        let stored = lock(&self.inner.store).files()?.put_file(&path)?;
        let name = crate::account::file_name(&path, &name);
        let id = taskmaster_core::new_id();
        self.inner.execute(
            vec![Command::CreateAttachment {
                attachment: NewAttachment {
                    id: Some(id.clone()),
                    task_id: None,
                    meeting_id: None,
                    note_id: Some(note_id),
                    hash: stored.hash,
                    mime: Some(taskmaster_core::mime_for(&name).to_owned()),
                    name,
                    size: stored.size,
                },
            }],
            None,
        )?;
        Ok(id)
    }

    /// Makes a project, at the end of its area (or of the top level). A project inside a
    /// team project is the team's; others are personal. Returns its id.
    pub fn create_project(&self, input: NewProjectInput) -> AppResult<String> {
        let name = input.name.trim().to_owned();
        if name.is_empty() {
            return Err(invalid("a project needs a name"));
        }
        if let Some(parent) = &input.parent_id {
            let s = self.inner.data()?;
            let area = s
                .projects
                .iter()
                .find(|p| &p.id == parent)
                .ok_or_else(|| not_found("project"))?;
            if area.parent_id.is_some() {
                return Err(invalid("projects go one level deep: pick a top-level one"));
            }
        }
        let id = taskmaster_core::new_id();
        self.inner.execute(
            vec![Command::CreateProject {
                project: NewProject {
                    id: Some(id.clone()),
                    name,
                    parent_id: input.parent_id,
                    color: input.color,
                    icon: None,
                    rank: None,
                },
            }],
            None,
        )?;
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snippet_is_the_first_line_of_text_without_markdown() {
        assert_eq!(snippet("# Title\n\nBody"), "Title");
        assert_eq!(
            snippet("\n\n- [ ] **Clear** the `cupboard`"),
            "Clear the cupboard"
        );
        assert_eq!(
            snippet("![plate](attachment:1)\nSee [Bleed](task:abc) in [Home](project:p)"),
            "See Bleed in Home"
        );
        assert_eq!(
            snippet("a [bracket without a link"),
            "a [bracket without a link"
        );
        assert_eq!(snippet(""), "");
        let long = "word ".repeat(60);
        let s = snippet(&long);
        assert!(s.ends_with('…') && s.chars().count() <= SNIPPET_CHARS + 1);
    }

    #[test]
    fn linked_ids_are_read_once_each_in_order() {
        let body = "[a](task:1) and [b](task:2), [a again](task:1), [p](project:9)";
        assert_eq!(linked_ids(body, "task"), vec!["1", "2"]);
        assert_eq!(linked_ids(body, "project"), vec!["9"]);
        assert!(linked_ids("no links", "task").is_empty());
    }
}

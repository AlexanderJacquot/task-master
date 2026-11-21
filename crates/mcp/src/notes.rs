//! Notes for agents (ADR 032): the user's markdown pages in folders, which may be attached
//! to a task and link tasks and projects with `[text](task:<id>)` / `[text](project:<id>)`.
//! Not to be confused with `add_note`, a session's progress note on its task.
//!
//! Notes have no owner: creating one is always allowed (it is the user's at once); changing
//! or deleting one follows Settings → Agents → _Let agents edit my tasks_, except notes this
//! server created.

use std::collections::HashMap;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;
use taskmaster_core::{
    Command, NewNote, NewNoteFolder, Note, NoteChange, NoteFolder, Snapshot, utc_date,
};

use super::{TaskServer, ToolResult, change_line, find_task, list_limit, listing};

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ListNotes {
    /// Words to find in titles and bodies (prefix match), best first. All notes when absent.
    #[serde(default)]
    pub query: Option<String>,
    /// Only the notes in this folder (its name or id); `""` for those outside any folder.
    #[serde(default)]
    pub folder: Option<String>,
    /// Only the notes about this task: attached to it or linking to it.
    #[serde(default)]
    pub task_id: Option<String>,
    /// At most this many rows (default 50, at most 200).
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct GetNote {
    pub note_id: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct CreateNote {
    /// May be empty ("Untitled").
    #[serde(default)]
    pub title: String,
    /// Markdown. Link a task with `[text](task:<id>)`, a project with
    /// `[text](project:<id>)`.
    #[serde(default)]
    pub body: String,
    /// A folder's name or id; a folder of that name is created when there is none.
    #[serde(default)]
    pub folder: Option<String>,
    /// Attach it to this task.
    #[serde(default)]
    pub task_id: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct UpdateNote {
    pub note_id: String,
    #[serde(default)]
    pub title: Option<String>,
    /// Replaces the body (markdown).
    #[serde(default)]
    pub body: Option<String>,
    /// Added at the end of the body, on a new paragraph.
    #[serde(default)]
    pub append_body: Option<String>,
    /// Move it to this folder (name or id; created when missing); `""` takes it out of any
    /// folder.
    #[serde(default)]
    pub folder: Option<String>,
    /// Attach it to this task; `""` detaches it.
    #[serde(default)]
    pub task_id: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DeleteNote {
    pub note_id: String,
}

/// A note's title as the app shows it.
pub(crate) fn title(note: &Note) -> &str {
    if note.title.trim().is_empty() {
        "Untitled"
    } else {
        &note.title
    }
}

/// A folder by id, else by name (ignoring case).
fn find_folder<'a>(snapshot: &'a Snapshot, given: &str) -> Option<&'a NoteFolder> {
    let given = given.trim();
    snapshot
        .note_folders
        .iter()
        .find(|f| f.id == given)
        .or_else(|| {
            snapshot
                .note_folders
                .iter()
                .find(|f| f.name.trim().eq_ignore_ascii_case(given))
        })
}

fn find_note<'a>(snapshot: &'a Snapshot, id: &str) -> Result<&'a Note, String> {
    snapshot
        .notes
        .iter()
        .find(|n| n.id == id)
        .ok_or_else(|| format!("note {id} not found"))
}

/// Ids linked from a body with `](<scheme><id>)`, in order, without repeats.
fn linked_ids(body: &str, scheme: &str) -> Vec<String> {
    let needle = format!("]({scheme}");
    let mut out: Vec<String> = Vec::new();
    let mut rest = body;
    while let Some(at) = rest.find(&needle) {
        rest = &rest[at + needle.len()..];
        let id: String = rest.chars().take_while(|c| *c != ')').collect();
        let id = id.to_ascii_lowercase();
        if id.len() == 36 && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// Whether the note is about the task: attached to it or linking to it.
fn is_about(note: &Note, task_id: &str) -> bool {
    note.task_id.as_deref() == Some(task_id)
        || linked_ids(&note.body, "task:")
            .iter()
            .any(|id| id == task_id)
}

/// One line of a listing: title, folder, attached task, last edit, id.
fn line(snapshot: &Snapshot, folders: &HashMap<&str, &str>, note: &Note) -> String {
    let mut parts = Vec::new();
    if let Some(folder) = note.folder_id.as_deref().and_then(|f| folders.get(f)) {
        parts.push(format!("in {folder}"));
    }
    if let Some(task) = note
        .task_id
        .as_deref()
        .and_then(|id| snapshot.tasks.iter().find(|t| t.id == id))
    {
        parts.push(format!("on task {}", task.title));
    }
    parts.push(format!("edited {}", utc_date(note.updated_at)));
    format!("- {} ({}, `{}`)", title(note), parts.join(", "), note.id)
}

/// A note in full, as markdown.
fn render(snapshot: &Snapshot, note: &Note) -> String {
    let mut out = format!("# {}\n\n- Id: `{}`\n", title(note), note.id);
    if let Some(folder) = note
        .folder_id
        .as_deref()
        .and_then(|id| snapshot.note_folders.iter().find(|f| f.id == id))
    {
        out.push_str(&format!("- Folder: {} (`{}`)\n", folder.name, folder.id));
    }
    if let Some(id) = &note.task_id {
        let task = snapshot
            .tasks
            .iter()
            .find(|t| &t.id == id)
            .map_or("(deleted)", |t| t.title.as_str());
        out.push_str(&format!("- Attached to task: {task} (`{id}`)\n"));
    }
    let tasks: Vec<String> = linked_ids(&note.body, "task:")
        .into_iter()
        .filter_map(|id| snapshot.tasks.iter().find(|t| t.id == id))
        .map(|t| format!("{} (`{}`)", t.title, t.id))
        .collect();
    if !tasks.is_empty() {
        out.push_str(&format!("- Links tasks: {}\n", tasks.join(", ")));
    }
    let projects: Vec<String> = linked_ids(&note.body, "project:")
        .into_iter()
        .filter_map(|id| snapshot.projects.iter().find(|p| p.id == id))
        .map(|p| format!("{} (`{}`)", p.name, p.id))
        .collect();
    if !projects.is_empty() {
        out.push_str(&format!("- Links projects: {}\n", projects.join(", ")));
    }
    let files: Vec<String> = snapshot
        .attachments
        .iter()
        .filter(|a| a.note_id.as_deref() == Some(note.id.as_str()))
        .map(|a| format!("{} (`{}`)", a.name, a.id))
        .collect();
    if !files.is_empty() {
        out.push_str(&format!("- Attachments: {}\n", files.join(", ")));
    }
    out.push_str(&format!(
        "- Created {}, edited {}\n\n",
        utc_date(note.created_at),
        utc_date(note.updated_at)
    ));
    let body = note.body.trim();
    out.push_str(if body.is_empty() { "(empty)" } else { body });
    out.push('\n');
    out
}

impl TaskServer {
    /// Notes this server created may always be changed; the user's follow the setting.
    pub(crate) fn check_may_edit_note(&self, note: &Note) -> Result<(), String> {
        if self
            .created_notes
            .lock()
            .is_ok_and(|mine| mine.contains(&note.id))
        {
            return Ok(());
        }
        self.check_may_edit_users("this note")
    }

    /// The folder `given` names: `Ok(None)` for `""` (no folder), creating one when no
    /// folder has that name or id. The commands that create it go first in the batch.
    fn folder_for(
        &self,
        snapshot: &Snapshot,
        given: &str,
        commands: &mut Vec<Command>,
    ) -> Result<Option<String>, String> {
        let name = given.trim();
        if name.is_empty() {
            return Ok(None);
        }
        if let Some(folder) = find_folder(snapshot, name) {
            return Ok(Some(folder.id.clone()));
        }
        let id = taskmaster_core::new_id();
        commands.push(Command::CreateNoteFolder {
            folder: NewNoteFolder {
                id: Some(id.clone()),
                name: name.to_owned(),
                rank: None,
            },
        });
        Ok(Some(id))
    }
}

#[tool_router(router = notes_router, vis = "pub(crate)")]
impl TaskServer {
    #[tool(
        description = "The user's notes (the app's Notes: markdown pages in folders, which \
                       may be attached to a task and link tasks and projects): title, \
                       folder, attached task, last edit and id. query finds words in titles \
                       and bodies (best first, with the words around the match); folder \
                       and task_id narrow it. Folders are listed too."
    )]
    pub fn list_notes(&self, Parameters(p): Parameters<ListNotes>) -> ToolResult {
        let limit = list_limit(p.limit) as usize;
        let query = p.query.as_deref().map(str::trim).filter(|q| !q.is_empty());
        let (snapshot, hits) = self.with_store(|s| {
            let hits = match query {
                Some(q) => Some(s.search_notes(q, super::MAX_LIST)?),
                None => None,
            };
            Ok((s.snapshot()?, hits))
        })?;
        let folders: HashMap<&str, &str> = snapshot
            .note_folders
            .iter()
            .map(|f| (f.id.as_str(), f.name.as_str()))
            .collect();
        let folder = match p.folder.as_deref() {
            None => None,
            Some(given) if given.trim().is_empty() => Some(None),
            Some(given) => Some(Some(
                find_folder(&snapshot, given)
                    .ok_or_else(|| format!("no folder named {given}"))?
                    .id
                    .clone(),
            )),
        };
        let keep = |n: &Note| {
            folder.as_ref().is_none_or(|f| &n.folder_id == f)
                && p.task_id.as_deref().is_none_or(|t| is_about(n, t))
        };
        let notes: HashMap<&str, &Note> =
            snapshot.notes.iter().map(|n| (n.id.as_str(), n)).collect();
        let mut lines = Vec::new();
        let mut total = 0;
        match &hits {
            Some(hits) => {
                for hit in hits {
                    let Some(note) = notes.get(hit.note_id.as_str()) else {
                        continue;
                    };
                    if !keep(note) {
                        continue;
                    }
                    total += 1;
                    if lines.len() < limit {
                        lines.push(format!(
                            "{}\n  {}",
                            line(&snapshot, &folders, note),
                            hit.snippet.replace('\n', " ")
                        ));
                    }
                }
            }
            None => {
                let mut sorted: Vec<&Note> = snapshot.notes.iter().filter(|n| keep(n)).collect();
                sorted.sort_by_key(|n| std::cmp::Reverse(n.updated_at));
                total = sorted.len();
                lines = sorted
                    .into_iter()
                    .take(limit)
                    .map(|n| line(&snapshot, &folders, n))
                    .collect();
            }
        }
        let more = total - lines.len();
        let mut out = listing(lines, more, "No notes match.");
        if query.is_none() && p.folder.is_none() && !snapshot.note_folders.is_empty() {
            let names: Vec<String> = snapshot
                .note_folders
                .iter()
                .map(|f| format!("{} (`{}`)", f.name, f.id))
                .collect();
            out.push_str(&format!("\n\nFolders: {}", names.join(", ")));
        }
        Ok(out)
    }

    #[tool(
        description = "One note in full as markdown: title, folder, attached task, the tasks \
                       and projects it links, its attachments, then its body."
    )]
    pub fn get_note(&self, Parameters(p): Parameters<GetNote>) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        Ok(render(&snapshot, find_note(&snapshot, &p.note_id)?))
    }

    #[tool(
        description = "Write a new note for the user (a markdown page in the app's Notes; \
                       not a progress note on your task, which is add_note). Optionally in a \
                       folder (by name or id; created if missing) and attached to a task. \
                       Link tasks with [text](task:<id>) and projects with \
                       [text](project:<id>). Returns its id."
    )]
    pub fn create_note(&self, Parameters(p): Parameters<CreateNote>) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        let mut commands = Vec::new();
        let folder_id = match p.folder.as_deref() {
            Some(f) => self.folder_for(&snapshot, f, &mut commands)?,
            None => None,
        };
        let task_id = match p
            .task_id
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            Some(id) => Some(find_task(&snapshot, id)?.id.clone()),
            None => None,
        };
        let id = taskmaster_core::new_id();
        commands.push(Command::CreateNote {
            note: NewNote {
                id: Some(id.clone()),
                title: p.title,
                body: p.body,
                folder_id,
                task_id,
                rank: None,
            },
        });
        let changes = self.write(commands)?;
        if let Ok(mut mine) = self.created_notes.lock() {
            mine.insert(id.clone());
        }
        let made = changes
            .notes
            .iter()
            .find(|n| n.id == id)
            .ok_or("the note was not written")?;
        Ok(format!(
            "Wrote note {} (`{id}`){}",
            title(made),
            change_line(&changes)
        ))
    }

    #[tool(
        description = "Change a note: title, body (replace, or append_body to add at the \
                       end), folder (name or id, created if missing; \"\" for none) or the \
                       task it is attached to (\"\" detaches it)."
    )]
    pub fn update_note(&self, Parameters(p): Parameters<UpdateNote>) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        let note = find_note(&snapshot, &p.note_id)?;
        self.check_may_edit_note(note)?;
        if p.body.is_some() && p.append_body.is_some() {
            return Err("give body or append_body, not both".into());
        }
        let mut commands = Vec::new();
        let mut changes = Vec::new();
        if let Some(t) = p.title {
            changes.push(NoteChange::Title(t));
        }
        if let Some(body) = p.body {
            changes.push(NoteChange::Body(body));
        }
        if let Some(more) = p.append_body.filter(|m| !m.trim().is_empty()) {
            let current = note.body.trim_end();
            changes.push(NoteChange::Body(if current.is_empty() {
                more
            } else {
                format!("{current}\n\n{more}")
            }));
        }
        if let Some(folder) = p.folder.as_deref() {
            let folder_id = self.folder_for(&snapshot, folder, &mut commands)?;
            if folder_id != note.folder_id {
                changes.push(NoteChange::FolderId(folder_id));
            }
        }
        if let Some(task) = p.task_id.as_deref() {
            let task_id = match task.trim() {
                "" => None,
                id => Some(find_task(&snapshot, id)?.id.clone()),
            };
            changes.push(NoteChange::TaskId(task_id));
        }
        if changes.is_empty() {
            return Err("nothing to change".into());
        }
        commands.push(Command::UpdateNote {
            id: note.id.clone(),
            changes,
        });
        let written = self.write(commands)?;
        let after = written
            .notes
            .iter()
            .find(|n| n.id == note.id)
            .unwrap_or(note);
        Ok(format!(
            "Updated note {}.{}",
            title(after),
            change_line(&written)
        ))
    }

    #[tool(
        description = "Delete a note (its attachments go with it; undo brings it back). Only \
                       when the user asks."
    )]
    pub fn delete_note(&self, Parameters(p): Parameters<DeleteNote>) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        let note = find_note(&snapshot, &p.note_id)?;
        self.check_may_edit_note(note)?;
        let changes = self.write(vec![Command::DeleteNote {
            id: note.id.clone(),
        }])?;
        Ok(format!(
            "Deleted note {}.{}",
            title(note),
            change_line(&changes)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::linked_ids;

    #[test]
    fn finds_linked_ids_once_each() {
        let a = "0192f0c6-0000-7000-8000-00000000abcd";
        let b = "0192f0c6-0000-7000-8000-00000000ABCE";
        let body = format!("[x](task:{a}) and [y](task:{b}), again [x](task:{a}) [p](project:{a})");
        assert_eq!(
            linked_ids(&body, "task:"),
            vec![a.to_owned(), b.to_ascii_lowercase()]
        );
        assert_eq!(linked_ids(&body, "project:"), vec![a.to_owned()]);
        assert!(linked_ids("[broken](task:123)", "task:").is_empty());
    }
}

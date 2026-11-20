//! The rest of what the user can do in the app: deleting tasks; editing and deleting
//! projects, epics and tags; attachments; removing agent sessions; and undo. Changes to the
//! user's data follow Settings → Agents → _Let agents edit my tasks_ (see the crate docs).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;
use taskmaster_core::{
    AttachmentChange, Command, EpicChange, EpicState, MAX_ATTACHMENT_BYTES, NewAttachment,
    ProjectChange, Snapshot, Tag, TagChange, TaskOwner,
};

use super::{TaskServer, ToolResult, change_line, find_task, non_empty, tag_key};

/// Largest attachment `read_attachment` returns as text.
const MAX_READ_BYTES: i64 = 256 * 1024;

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DeleteTask {
    pub task_id: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct UpdateTag {
    /// The tag: its name (`#` optional) or id.
    pub tag: String,
    /// New name, without spaces.
    #[serde(default)]
    pub name: Option<String>,
    /// A CSS color, like `#7a5cff`; `""` clears it.
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DeleteTag {
    /// The tag: its name (`#` optional) or id. It comes off every task.
    pub tag: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct UpdateProject {
    pub project_id: String,
    #[serde(default)]
    pub name: Option<String>,
    /// A CSS color; `""` clears it.
    #[serde(default)]
    pub color: Option<String>,
    /// An icon name; `""` clears it.
    #[serde(default)]
    pub icon: Option<String>,
    /// Move it into this area (a top-level project); `""` makes it top level.
    #[serde(default)]
    pub area_id: Option<String>,
    /// Archive (true) or bring back (false).
    #[serde(default)]
    pub archived: Option<bool>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DeleteProject {
    /// Refused while it still holds tasks, epics or projects: move or delete them first.
    pub project_id: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct UpdateEpic {
    pub epic_id: String,
    #[serde(default)]
    pub name: Option<String>,
    /// Markdown; `""` clears it.
    #[serde(default)]
    pub description: Option<String>,
    /// `YYYY-MM-DD`; `""` clears it.
    #[serde(default)]
    pub target_date: Option<String>,
    /// active, done or dropped.
    #[serde(default)]
    pub state: Option<String>,
    /// Its home project; `""` leaves it without one.
    #[serde(default)]
    pub project_id: Option<String>,
    /// A CSS color; `""` clears it.
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DeleteEpic {
    /// Its tasks stay, outside any epic.
    pub epic_id: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ListAttachments {
    /// Only this task's. All tasks' and notes' when neither this nor note_id is given.
    #[serde(default)]
    pub task_id: Option<String>,
    /// Only this note's.
    #[serde(default)]
    pub note_id: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct AttachFile {
    /// The task to attach it to; or give note_id.
    #[serde(default)]
    pub task_id: Option<String>,
    /// The note to attach it to (show it in the note's body with `![name](attachment:<id>)`
    /// for an image, `[name](attachment:<id>)` for a file).
    #[serde(default)]
    pub note_id: Option<String>,
    /// File name shown on the task or note. Defaults to the name in `path`.
    #[serde(default)]
    pub name: Option<String>,
    /// A file on this device to attach (local server only).
    #[serde(default)]
    pub path: Option<String>,
    /// Text content to attach (a note, a log, markdown).
    #[serde(default)]
    pub text: Option<String>,
    /// Binary content, base64-encoded.
    #[serde(default)]
    pub base64: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct AttachmentId {
    /// From list_attachments.
    pub attachment_id: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct RenameAttachment {
    pub attachment_id: String,
    pub name: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct RemoveAgentSession {
    /// An ended session (from list_agent_sessions).
    pub session_id: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct Undo {
    /// The change_id a write reported.
    pub change_id: String,
}

#[tool_router(router = edit_router, vis = "pub(crate)")]
impl TaskServer {
    #[tool(
        description = "Delete a task and all its subtasks (the user can bring them back with \
                       undo in the app; undo here takes the change_id). The user's tasks only \
                       when they ask."
    )]
    pub fn delete_task(&self, Parameters(p): Parameters<DeleteTask>) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        let task = find_task(&snapshot, &p.task_id)?;
        self.check_may_delete(&snapshot, task)?;
        let changes = self.write(vec![Command::DeleteTask {
            id: task.id.clone(),
        }])?;
        let subtasks = changes.tasks.len().saturating_sub(1);
        let with = match subtasks {
            0 => String::new(),
            1 => " and its subtask".into(),
            n => format!(" and its {n} subtasks"),
        };
        Ok(format!(
            "Deleted {}{with}.{}",
            task.title,
            change_line(&changes)
        ))
    }

    #[tool(description = "Tags with their ids and how many open tasks carry each.")]
    pub fn list_tags(&self) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        if snapshot.tags.is_empty() {
            return Ok("No tags.".into());
        }
        let lines: Vec<String> = snapshot
            .tags
            .iter()
            .map(|tag| {
                let count = snapshot
                    .tasks
                    .iter()
                    .filter(|t| t.completed_at.is_none() && t.tag_ids.contains(&tag.id))
                    .count();
                format!("- #{} (`{}`), {count} open tasks", tag.name, tag.id)
            })
            .collect();
        Ok(lines.join("\n"))
    }

    #[tool(description = "Rename a tag or change its color (everywhere it is used).")]
    pub fn update_tag(&self, Parameters(p): Parameters<UpdateTag>) -> ToolResult {
        self.check_may_edit_users("this tag")?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let tag = find_tag(&snapshot, &p.tag)?;
        let mut changes = Vec::new();
        if let Some(name) = p.name {
            changes.push(TagChange::Name(name.trim().to_owned()));
        }
        if let Some(color) = p.color {
            changes.push(TagChange::Color(non_empty(Some(color))));
        }
        if changes.is_empty() {
            return Err("nothing to change".into());
        }
        let done = self.write(vec![Command::UpdateTag {
            id: tag.id.clone(),
            changes,
        }])?;
        let name = done.tags.first().map_or(tag.name.as_str(), |t| &t.name);
        Ok(format!("Updated tag #{name}.{}", change_line(&done)))
    }

    #[tool(description = "Delete a tag: it comes off every task. Only when the user asks.")]
    pub fn delete_tag(&self, Parameters(p): Parameters<DeleteTag>) -> ToolResult {
        self.check_may_edit_users("this tag")?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let tag = find_tag(&snapshot, &p.tag)?;
        let changes = self.write(vec![Command::DeleteTag { id: tag.id.clone() }])?;
        Ok(format!(
            "Deleted tag #{}.{}",
            tag.name,
            change_line(&changes)
        ))
    }

    #[tool(
        description = "Change a project: rename it, set its color or icon, move it into an \
                       area or to the top level, archive it or bring it back."
    )]
    pub fn update_project(&self, Parameters(p): Parameters<UpdateProject>) -> ToolResult {
        self.check_may_edit_users("this project")?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let project = snapshot
            .projects
            .iter()
            .find(|x| x.id == p.project_id)
            .ok_or_else(|| format!("project {} not found", p.project_id))?;
        let mut changes = Vec::new();
        if let Some(name) = p.name {
            changes.push(ProjectChange::Name(name.trim().to_owned()));
        }
        if let Some(color) = p.color {
            changes.push(ProjectChange::Color(non_empty(Some(color))));
        }
        if let Some(icon) = p.icon {
            changes.push(ProjectChange::Icon(non_empty(Some(icon))));
        }
        if let Some(area) = p.area_id {
            changes.push(ProjectChange::ParentId(non_empty(Some(area))));
        }
        if let Some(archived) = p.archived {
            changes.push(ProjectChange::Archived(archived));
        }
        if changes.is_empty() {
            return Err("nothing to change".into());
        }
        let done = self.write(vec![Command::UpdateProject {
            id: project.id.clone(),
            changes,
        }])?;
        let updated = done.projects.first().unwrap_or(project);
        let archived = if updated.archived_at.is_some() {
            " (archived)"
        } else {
            ""
        };
        Ok(format!(
            "Updated project {}{archived} (`{}`){}",
            updated.name,
            updated.id,
            change_line(&done)
        ))
    }

    #[tool(
        description = "Delete a project. Refused while it still holds tasks, epics or \
                       projects. Only when the user asks."
    )]
    pub fn delete_project(&self, Parameters(p): Parameters<DeleteProject>) -> ToolResult {
        self.check_may_edit_users("this project")?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let project = snapshot
            .projects
            .iter()
            .find(|x| x.id == p.project_id)
            .ok_or_else(|| format!("project {} not found", p.project_id))?;
        let changes = self.write(vec![Command::DeleteProject {
            id: project.id.clone(),
        }])?;
        Ok(format!(
            "Deleted project {}.{}",
            project.name,
            change_line(&changes)
        ))
    }

    #[tool(
        description = "Change an epic: name, description, target date, state (active, done, \
                       dropped), home project, color."
    )]
    pub fn update_epic(&self, Parameters(p): Parameters<UpdateEpic>) -> ToolResult {
        self.check_may_edit_users("this epic")?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let epic = snapshot
            .epics
            .iter()
            .find(|x| x.id == p.epic_id)
            .ok_or_else(|| format!("epic {} not found", p.epic_id))?;
        let mut changes = Vec::new();
        if let Some(name) = p.name {
            changes.push(EpicChange::Name(name.trim().to_owned()));
        }
        if let Some(description) = p.description {
            changes.push(EpicChange::Description(non_empty(Some(description))));
        }
        if let Some(date) = p.target_date {
            changes.push(EpicChange::TargetDate(non_empty(Some(date))));
        }
        if let Some(state) = &p.state {
            let state = EpicState::parse(state.trim())
                .ok_or_else(|| format!("unknown state '{state}' (active, done, dropped)"))?;
            changes.push(EpicChange::State(state));
        }
        if let Some(project) = p.project_id {
            changes.push(EpicChange::ProjectId(non_empty(Some(project))));
        }
        if let Some(color) = p.color {
            changes.push(EpicChange::Color(non_empty(Some(color))));
        }
        if changes.is_empty() {
            return Err("nothing to change".into());
        }
        let done = self.write(vec![Command::UpdateEpic {
            id: epic.id.clone(),
            changes,
        }])?;
        let updated = done.epics.first().unwrap_or(epic);
        Ok(format!(
            "Updated epic {} ({}, `{}`){}",
            updated.name,
            updated.state.as_str(),
            updated.id,
            change_line(&done)
        ))
    }

    #[tool(
        description = "Delete an epic. Its tasks stay, outside any epic. Only when the user \
                       asks."
    )]
    pub fn delete_epic(&self, Parameters(p): Parameters<DeleteEpic>) -> ToolResult {
        self.check_may_edit_users("this epic")?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let epic = snapshot
            .epics
            .iter()
            .find(|x| x.id == p.epic_id)
            .ok_or_else(|| format!("epic {} not found", p.epic_id))?;
        let changes = self.write(vec![Command::DeleteEpic {
            id: epic.id.clone(),
        }])?;
        Ok(format!(
            "Deleted epic {}.{}",
            epic.name,
            change_line(&changes)
        ))
    }

    #[tool(
        description = "Attachments (files on tasks and notes) with their ids, names, types \
                       and sizes."
    )]
    pub fn list_attachments(&self, Parameters(p): Parameters<ListAttachments>) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        let lines: Vec<String> = snapshot
            .attachments
            .iter()
            .filter(|a| a.task_id.is_some() || a.note_id.is_some())
            .filter(|a| match (&p.task_id, &p.note_id) {
                (None, None) => true,
                (task, note) => {
                    (task.is_some() && a.task_id == *task) || (note.is_some() && a.note_id == *note)
                }
            })
            .map(|a| {
                let owner = match (&a.task_id, &a.note_id) {
                    (Some(id), _) => snapshot
                        .tasks
                        .iter()
                        .find(|t| &t.id == id)
                        .map_or("?".to_owned(), |t| t.title.clone()),
                    (_, Some(id)) => snapshot
                        .notes
                        .iter()
                        .find(|n| &n.id == id)
                        .map_or("?".to_owned(), |n| {
                            format!("note {}", super::notes::title(n))
                        }),
                    _ => "?".to_owned(),
                };
                format!(
                    "- {} ({}, {}) on {owner} (`{}`)",
                    a.name,
                    a.mime,
                    size_text(a.size),
                    a.id
                )
            })
            .collect();
        if lines.is_empty() {
            return Ok("No attachments.".into());
        }
        Ok(lines.join("\n"))
    }

    #[tool(
        description = "Attach a file to a task or a note: text, base64 content, or (on this \
                       device's server only) a file path. At most 50 MB."
    )]
    pub fn attach_file(&self, Parameters(p): Parameters<AttachFile>) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        let owner = match (p.task_id.as_deref(), p.note_id.as_deref()) {
            (Some(task_id), None) => {
                let task = find_task(&snapshot, task_id)?;
                self.check_may_change(&snapshot, task)?;
                Owner::Task(task)
            }
            (None, Some(note_id)) => {
                let note = snapshot
                    .notes
                    .iter()
                    .find(|n| n.id == note_id)
                    .ok_or_else(|| format!("note {note_id} not found"))?;
                self.check_may_edit_note(note)?;
                Owner::Note(note)
            }
            _ => return Err("give task_id or note_id (one of them)".into()),
        };
        let given = [p.path.is_some(), p.text.is_some(), p.base64.is_some()];
        if given.iter().filter(|g| **g).count() != 1 {
            return Err("give exactly one of path, text or base64".into());
        }
        let (stored, default_name) = if let Some(path) = &p.path {
            if !self.local_files {
                return Err(
                    "this server cannot read files by path; send the content as text or \
                     base64"
                        .into(),
                );
            }
            let name = std::path::Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned());
            (self.with_store(|s| s.files()?.put_file(path))?, name)
        } else {
            let bytes = match (&p.text, &p.base64) {
                (Some(text), _) => text.as_bytes().to_vec(),
                (_, Some(data)) => STANDARD
                    .decode(data.trim())
                    .map_err(|e| format!("base64 is not valid: {e}"))?,
                _ => unreachable!("one of them is given"),
            };
            if bytes.len() as i64 > MAX_ATTACHMENT_BYTES {
                return Err("attachments are limited to 50 MB".into());
            }
            (self.with_store(|s| s.files()?.put_bytes(&bytes))?, None)
        };
        let name = non_empty(p.name)
            .or(default_name)
            .ok_or("give a name for the file")?;
        let id = taskmaster_core::new_id();
        let changes = self.write(vec![Command::CreateAttachment {
            attachment: NewAttachment {
                id: Some(id.clone()),
                task_id: owner.task_id(),
                meeting_id: None,
                note_id: owner.note_id(),
                hash: stored.hash,
                name,
                mime: None,
                size: stored.size,
            },
        }])?;
        let made = changes
            .attachments
            .first()
            .ok_or("the file was not attached")?;
        Ok(format!(
            "Attached {} ({}) to {} (`{id}`){}",
            made.name,
            size_text(made.size),
            owner.label(),
            change_line(&changes)
        ))
    }

    #[tool(
        description = "Read an attachment: its text when it is a text file (up to 256 KB), \
                       else what it is (and, on this device, where the file is)."
    )]
    pub fn read_attachment(&self, Parameters(p): Parameters<AttachmentId>) -> ToolResult {
        let (attachment, path) = self.with_store(|s| {
            let a = s.attachment(&p.attachment_id)?;
            let path = s.attachment_path(&a.id);
            Ok((a, path))
        })?;
        if attachment.deleted_at.is_some() {
            return Err(format!("attachment {} not found", p.attachment_id));
        }
        let path = path.map_err(|e| e.to_string())?;
        if is_text(&attachment.mime) && attachment.size <= MAX_READ_BYTES {
            let bytes = std::fs::read(&path).map_err(|_| {
                "its content is not on this device yet (it syncs from another one)".to_owned()
            })?;
            return Ok(String::from_utf8_lossy(&bytes).into_owned());
        }
        let mut out = format!(
            "{} is {} ({}), not shown as text.",
            attachment.name,
            attachment.mime,
            size_text(attachment.size)
        );
        if self.local_files {
            out.push_str(&format!(" The file is at {}", path.display()));
        }
        Ok(out)
    }

    #[tool(description = "Rename an attachment.")]
    pub fn rename_attachment(&self, Parameters(p): Parameters<RenameAttachment>) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        let (attachment, owner) = attachment_and_owner(&snapshot, &p.attachment_id)?;
        match owner {
            Owner::Task(task) => self.check_may_change(&snapshot, task)?,
            Owner::Note(note) => self.check_may_edit_note(note)?,
        }
        let changes = self.write(vec![Command::UpdateAttachment {
            id: attachment.id.clone(),
            changes: vec![AttachmentChange::Name(p.name)],
        }])?;
        let name = changes
            .attachments
            .first()
            .map_or(attachment.name.as_str(), |a| &a.name);
        Ok(format!("Renamed it to {name}.{}", change_line(&changes)))
    }

    #[tool(description = "Take an attachment off its task or note. Only when the user asks.")]
    pub fn remove_attachment(&self, Parameters(p): Parameters<AttachmentId>) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        let (attachment, owner) = attachment_and_owner(&snapshot, &p.attachment_id)?;
        match owner {
            Owner::Task(task) if task.owner != TaskOwner::Agent => {
                self.check_may_edit_users("this task's file")?;
            }
            Owner::Task(_) => {}
            Owner::Note(note) => self.check_may_edit_note(note)?,
        }
        let changes = self.write(vec![Command::DeleteAttachment {
            id: attachment.id.clone(),
        }])?;
        Ok(format!(
            "Removed {} from {}.{}",
            attachment.name,
            owner.label(),
            change_line(&changes)
        ))
    }

    #[tool(
        description = "Remove an ended agent session (and its notes) from its task's \
                       history. Only when the user asks."
    )]
    pub fn remove_agent_session(
        &self,
        Parameters(p): Parameters<RemoveAgentSession>,
    ) -> ToolResult {
        self.check_may_edit_users("this session's history")?;
        let session = self.with_store(|s| s.agent_session(&p.session_id))?;
        if session.deleted_at.is_some() {
            return Err(format!("session {} not found", p.session_id));
        }
        if self.session.as_ref().is_some_and(|s| s.id == session.id) {
            return Err("this is the session you are running in".into());
        }
        if session.state.is_active() {
            return Err(format!(
                "session {} has not ended ({}); only ended sessions are removed",
                session.id,
                session.state.as_str()
            ));
        }
        let changes = self.write(vec![Command::DeleteAgentSession {
            id: session.id.clone(),
        }])?;
        Ok(format!(
            "Removed session `{}`.{}",
            session.id,
            change_line(&changes)
        ))
    }

    #[tool(
        description = "Undo one change, by the change_id a write reported: brings back what \
                       it deleted and reverts what it changed. Refused when the same things \
                       changed since; undo the newer changes first. Undoing an undo redoes it."
    )]
    pub fn undo(&self, Parameters(p): Parameters<Undo>) -> ToolResult {
        let id = p.change_id.trim();
        let mine = self.written.lock().is_ok_and(|w| w.contains(id));
        if !mine {
            self.check_may_edit_users("a change this server did not make")?;
        }
        let changes = self.with_store(|s| s.revert_batch(id))?;
        self.wrote(&changes);
        let mut parts = Vec::new();
        let mut count = |n: usize, what: &str| {
            if n > 0 {
                parts.push(format!("{n} {what}"));
            }
        };
        count(changes.tasks.len(), "tasks");
        count(changes.projects.len(), "projects");
        count(changes.epics.len(), "epics");
        count(changes.tags.len(), "tags");
        count(changes.attachments.len(), "attachments");
        count(changes.time_blocks.len(), "time blocks");
        count(changes.agent_sessions.len(), "agent sessions");
        let what = if parts.is_empty() {
            String::new()
        } else {
            format!(" ({})", parts.join(", "))
        };
        Ok(format!("Undid change {id}{what}.{}", change_line(&changes)))
    }
}

fn find_tag<'a>(snapshot: &'a Snapshot, value: &str) -> Result<&'a Tag, String> {
    let key = tag_key(value);
    snapshot
        .tags
        .iter()
        .find(|t| t.id == value.trim() || tag_key(&t.name) == key)
        .ok_or_else(|| format!("no tag '{value}' (list_tags shows them)"))
}

/// What a file an agent may change hangs off: a task or a note (meetings' are read-only).
enum Owner<'a> {
    Task(&'a taskmaster_core::Task),
    Note(&'a taskmaster_core::Note),
}

impl Owner<'_> {
    fn task_id(&self) -> Option<String> {
        match self {
            Self::Task(t) => Some(t.id.clone()),
            Self::Note(_) => None,
        }
    }

    fn note_id(&self) -> Option<String> {
        match self {
            Self::Task(_) => None,
            Self::Note(n) => Some(n.id.clone()),
        }
    }

    fn label(&self) -> String {
        match self {
            Self::Task(t) => t.title.clone(),
            Self::Note(n) => format!("note {}", super::notes::title(n)),
        }
    }
}

fn attachment_and_owner<'a>(
    snapshot: &'a Snapshot,
    id: &str,
) -> Result<(&'a taskmaster_core::Attachment, Owner<'a>), String> {
    let attachment = snapshot
        .attachments
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("attachment {id} not found"))?;
    if let Some(task_id) = attachment.task_id.as_deref() {
        return Ok((attachment, Owner::Task(find_task(snapshot, task_id)?)));
    }
    if let Some(note_id) = attachment.note_id.as_deref() {
        let note = snapshot
            .notes
            .iter()
            .find(|n| n.id == note_id)
            .ok_or_else(|| format!("note {note_id} not found"))?;
        return Ok((attachment, Owner::Note(note)));
    }
    Err(format!("attachment {id} is not on a task or a note"))
}

fn is_text(mime: &str) -> bool {
    mime.starts_with("text/")
        || matches!(
            mime,
            "application/json"
                | "application/xml"
                | "application/yaml"
                | "application/x-yaml"
                | "application/toml"
                | "application/javascript"
                | "image/svg+xml"
        )
}

fn size_text(bytes: i64) -> String {
    match bytes {
        b if b < 1024 => format!("{b} B"),
        b if b < 1024 * 1024 => format!("{:.1} KB", b as f64 / 1024.0),
        b => format!("{:.1} MB", b as f64 / 1_048_576.0),
    }
}

//! task-master MCP server (docs/adr/017-agent-sessions.md).
//!
//! A stdio MCP server over the local database, started by Claude Code for a session the
//! desktop app spawned (or by hand, without a session). It writes through the core's
//! commands, so ops, sync and the desktop's live reload apply; writes stay out of any undo
//! history.
//!
//! Rules: tasks an agent creates are `owner = agent` unless the user asks for one of their
//! own. An agent may change and delete its own tasks freely. Everything else the user can
//! do in the app (their tasks, projects, epics, tags, calendar, links, attachments,
//! deletes and undo) is open to it while Settings → Agents → _Let agents edit my tasks_
//! is on (the default); turned off, only the status of the session's task tree changes.
//! Always kept: the session's task is never closed, cancelled or deleted by its agent.
//! Notes and the session summary need a session. Projects and epics have no owner: those
//! an agent creates are the user's, so creating one returns an existing one of the same
//! name in the same place instead of a duplicate. Every write reports its change id;
//! `undo` reverts it.

mod calendar;
mod edit;
mod lineage;
pub mod locate;
mod meetings;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;
use taskmaster_core::{
    AgentSession, AgentSessionChange, AgentWorkflow, BlockOutcome, Command, Id, NewAgentNote,
    NewEpic, NewProject, NewTask, NewTimeBlock, Priority, SessionState, Snapshot, Status,
    StatusCategory, Store, Task, TaskChange, TaskOwner, TimeBlockChange,
};

use calendar::Offset;

/// Most rows a listing returns.
pub const MAX_LIST: u32 = 200;
const DEFAULT_LIST: u32 = 50;

type ToolResult = Result<String, String>;

/// Called after every successful write (the sync server announces the new ops).
pub type WriteHook = Arc<dyn Fn() + Send + Sync>;

/// The MCP server: one store, and the session it serves (if any).
#[derive(Clone)]
pub struct TaskServer {
    store: Arc<Mutex<Store>>,
    session: Option<AgentSession>,
    /// Where the session's task goes when the agent reports it done (Settings → Agents).
    workflow: AgentWorkflow,
    /// May the agent edit the user's own tasks (Settings → Agents)? When off, only the
    /// status of the session's task and its subtasks can change.
    edit_user_tasks: bool,
    /// May tools read and write files by path on this machine? Only the stdio server:
    /// the sync server must never open its own files for a remote caller.
    local_files: bool,
    /// Batches this server wrote: `undo` reverts them even with editing turned off.
    written: Arc<Mutex<HashSet<Id>>>,
    on_write: Option<WriteHook>,
    tool_router: ToolRouter<Self>,
}

impl TaskServer {
    /// Serves `store`; with `session_id`, for that session (which must be live).
    pub fn new(store: Store, session_id: Option<&str>) -> taskmaster_core::Result<Self> {
        let session = session_id.map(|id| store.agent_session(id)).transpose()?;
        if let Some(s) = &session
            && s.deleted_at.is_some()
        {
            return Err(taskmaster_core::Error::NotFound {
                entity: "agent session",
                id: s.id.clone(),
            });
        }
        Ok(Self {
            store: Arc::new(Mutex::new(store)),
            session,
            workflow: AgentWorkflow::default(),
            edit_user_tasks: true,
            local_files: true,
            written: Arc::default(),
            on_write: None,
            tool_router: Self::tool_router() + Self::edit_router(),
        })
    }

    /// Serves a store shared with its owner (the sync server's, ADR 024), without a
    /// session.
    pub fn shared(store: Arc<Mutex<Store>>) -> Self {
        Self {
            store,
            session: None,
            workflow: AgentWorkflow::default(),
            edit_user_tasks: true,
            local_files: false,
            written: Arc::default(),
            on_write: None,
            tool_router: Self::tool_router() + Self::edit_router(),
        }
    }

    /// Runs `hook` after every successful write.
    pub fn with_on_write(mut self, hook: WriteHook) -> Self {
        self.on_write = Some(hook);
        self
    }

    /// The statuses picked for agent work (the app passes `--done-status`).
    pub fn with_workflow(mut self, workflow: AgentWorkflow) -> Self {
        self.workflow = workflow;
        self
    }

    /// Whether the user's own tasks can be edited (on by default; the app passes
    /// `--no-edit-user-tasks` when Settings → Agents turns it off).
    pub fn with_edit_user_tasks(mut self, on: bool) -> Self {
        self.edit_user_tasks = on;
        self
    }

    /// The name of the status the session's task goes to when the agent reports it done.
    fn done_status_name(&self) -> String {
        self.with_store(|s| s.snapshot())
            .ok()
            .and_then(|snapshot| {
                self.workflow
                    .done_status(&snapshot.statuses)
                    .map(|s| s.name.clone())
            })
            .unwrap_or_else(|| "Review".into())
    }

    fn with_store<T>(
        &self,
        f: impl FnOnce(&mut Store) -> taskmaster_core::Result<T>,
    ) -> Result<T, String> {
        let mut store = self.store.lock().map_err(|_| "the store is unavailable")?;
        f(&mut store).map_err(|e| e.to_string())
    }

    /// Runs `f` on the served store (tests inspect what the tools wrote).
    #[doc(hidden)]
    pub fn with_store_for_tests<T>(
        &self,
        f: impl FnOnce(&mut Store) -> taskmaster_core::Result<T>,
    ) -> Result<T, String> {
        self.with_store(f)
    }

    fn session(&self) -> Result<&AgentSession, String> {
        self.session.as_ref().ok_or_else(|| {
            "this MCP server was started without a session; notes and summaries need one".to_owned()
        })
    }

    fn write(&self, commands: Vec<Command>) -> Result<taskmaster_core::Changes, String> {
        let changes = self.with_store(|s| s.execute_without_undo(commands))?;
        self.wrote(&changes);
        Ok(changes)
    }

    /// Bookkeeping after a write: remembers its batch for `undo`, runs the hook.
    fn wrote(&self, changes: &taskmaster_core::Changes) {
        if let Some(batch) = &changes.batch_id
            && let Ok(mut written) = self.written.lock()
        {
            written.insert(batch.clone());
        }
        if let Some(hook) = &self.on_write {
            hook();
        }
    }

    /// The user's own data (their tasks, projects, epics, tags, sessions): changed only
    /// while Settings → Agents allows it.
    fn check_may_edit_users(&self, what: &str) -> Result<(), String> {
        if self.edit_user_tasks {
            Ok(())
        } else {
            Err(format!(
                "{what} is the user's: editing the user's tasks is turned off (Settings → \
                 Agents); suggest the change in a note instead"
            ))
        }
    }

    /// What hangs off a task (time blocks, links, attachments, tags): agent tasks, the
    /// session's task tree, or any task while editing the user's tasks is allowed.
    fn check_may_change(&self, snapshot: &Snapshot, task: &Task) -> Result<(), String> {
        if task.owner == TaskOwner::Agent
            || self.edit_user_tasks
            || self.in_session_scope(snapshot, task)
        {
            Ok(())
        } else {
            Err(
                "this is the user's task, outside this session: editing the user's tasks is \
                 turned off (Settings → Agents); add a note or an agent task instead"
                    .into(),
            )
        }
    }

    /// Deleting `task` (and its subtasks): the user's tasks need the setting, and the
    /// session's own task is never deleted by its agent.
    fn check_may_delete(&self, snapshot: &Snapshot, task: &Task) -> Result<(), String> {
        if let Some(session) = &self.session
            && is_within(snapshot, &session.task_id, &task.id)
        {
            return Err(
                "this would delete the task this session works on; only the user deletes it".into(),
            );
        }
        if task.owner == TaskOwner::Agent {
            Ok(())
        } else {
            self.check_may_edit_users("this task")
        }
    }
}

/// The line a write's result ends with: its change id, which `undo` takes.
fn change_line(changes: &taskmaster_core::Changes) -> String {
    changes
        .batch_id
        .as_deref()
        .map(|id| format!("\nchange_id: {id} (undo reverts it)"))
        .unwrap_or_default()
}

/// Whether `id` is `root` or one of its subtasks, at any depth.
fn is_within(snapshot: &Snapshot, id: &str, root: &str) -> bool {
    let parents: HashMap<&str, Option<&str>> = snapshot
        .tasks
        .iter()
        .map(|t| (t.id.as_str(), t.parent_id.as_deref()))
        .collect();
    let mut current = Some(id);
    for _ in 0..=parents.len() {
        match current {
            Some(c) if c == root => return true,
            Some(c) => current = parents.get(c).copied().flatten(),
            None => return false,
        }
    }
    false
}

// ---------------------------------------------------------------------------------------
// Tool parameters

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct GetTask {
    /// Task id. Defaults to the session's task.
    #[serde(default)]
    pub task_id: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ListTasks {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub epic_id: Option<String>,
    /// Only direct subtasks of this task.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// `me` (the user's tasks) or `agent` (agents' own). Both when absent.
    #[serde(default)]
    pub owner: Option<String>,
    /// Include done and cancelled tasks (default false).
    #[serde(default)]
    pub include_closed: bool,
    /// At most this many rows (default 50, at most 200).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Continue after the task id returned as next_cursor. Reuse the same filters.
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ListAgentSessions {
    /// running, done, failed, cancelled, interrupted, or terminal. All when absent.
    #[serde(default)]
    pub state: Option<String>,
    /// Only sessions of this task.
    #[serde(default)]
    pub task_id: Option<String>,
    /// Only sessions of tasks in this project.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Consider only the most recent session per task, then apply the state filter.
    #[serde(default)]
    pub latest_only: bool,
    /// At most this many rows (default 50, at most 200).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Continue after the session id returned as next_cursor. Reuse the same filters.
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ListProjects {
    /// Include archived projects (default false).
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct Search {
    /// Words to find in titles and descriptions (prefix match).
    pub query: String,
    /// At most this many rows (default 50, at most 200).
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct CreateTask {
    pub title: String,
    /// Markdown.
    #[serde(default)]
    pub description: String,
    /// Parent task. In a session, defaults to the session's task (a step of it), unless
    /// `top_level` is set.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Make a task that is not a subtask. Ignored when `parent_id` is given.
    #[serde(default)]
    pub top_level: bool,
    /// Defaults to the parent's project, else the session task's.
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub epic_id: Option<String>,
    /// A status name, or a category: backlog, todo, in_progress, done, cancelled.
    #[serde(default)]
    pub status: Option<String>,
    /// urgent, high, normal (default) or low.
    #[serde(default)]
    pub priority: Option<String>,
    /// Ids of tasks that must be finished first.
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// `agent` (default: an agent task, kept apart) or `me`: a task of the user's own,
    /// only when they ask for one.
    #[serde(default)]
    pub owner: Option<String>,
    /// `YYYY-MM-DD`.
    #[serde(default)]
    pub due_date: Option<String>,
    /// `YYYY-MM-DD`: the day it is planned for (the Today list).
    #[serde(default)]
    pub today_on: Option<String>,
    /// Estimated minutes.
    #[serde(default)]
    pub estimate_min: Option<i64>,
    /// Tag names (`#` optional); missing tags are created.
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct CreateProject {
    pub name: String,
    /// The area (a top-level project) to put it in. Top level when absent. Projects nest
    /// one level only, so an area cannot itself be inside another.
    #[serde(default)]
    pub area_id: Option<String>,
    /// A CSS color, like `#7a5cff`.
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct CreateEpic {
    pub name: String,
    /// Its home project. In a session, defaults to the session task's project unless
    /// `no_project` is set.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Make an epic with no home project. Ignored when `project_id` is given.
    #[serde(default)]
    pub no_project: bool,
    /// The outcome it stands for. Markdown.
    #[serde(default)]
    pub description: Option<String>,
    /// `YYYY-MM-DD`.
    #[serde(default)]
    pub target_date: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct UpdateTask {
    pub task_id: String,
    /// A status name, or a category: backlog, todo, in_progress, done, cancelled.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// Replaces the description.
    #[serde(default)]
    pub description: Option<String>,
    /// Added at the end of the description, on a new paragraph.
    #[serde(default)]
    pub append_description: Option<String>,
    /// urgent, high, normal or low.
    #[serde(default)]
    pub priority: Option<String>,
    /// Replaces the prerequisites (task ids).
    #[serde(default)]
    pub depends_on: Option<Vec<String>>,
    /// Move it to this project (subtasks that shared its project follow); `""` puts it in
    /// the Inbox.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Move it to this epic (subtasks that shared its epic follow); `""` takes it out.
    #[serde(default)]
    pub epic_id: Option<String>,
    /// Make it a subtask of this task (it takes the parent's project and epic); `""` makes
    /// it a top-level task.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// `YYYY-MM-DD`; `""` clears it.
    #[serde(default)]
    pub due_date: Option<String>,
    /// `YYYY-MM-DD`, the day it is planned for (the Today list); `""` clears it.
    #[serde(default)]
    pub today_on: Option<String>,
    /// Estimated minutes; 0 clears it.
    #[serde(default)]
    pub estimate_min: Option<i64>,
    /// `me` makes an agent task the user's own (as Adopt does in the app).
    #[serde(default)]
    pub owner: Option<String>,
    /// Tag names to add (`#` optional); missing tags are created.
    #[serde(default)]
    pub add_tags: Vec<String>,
    /// Tag names to remove.
    #[serde(default)]
    pub remove_tags: Vec<String>,
    /// Reorder within its column (after any status change): `top`, `bottom`, or the id
    /// of a task in that column to place it right after.
    #[serde(default)]
    pub position: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct AddNote {
    /// One progress line or short paragraph: what was done, found or decided.
    pub body: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct CompleteSession {
    /// What was done, what is left, and anything the user must check. Markdown.
    pub summary: String,
    /// Ids of the session task's subtasks you are deliberately leaving open (not finished,
    /// or not yours to do); say why in the summary. Every other open subtask must be
    /// marked done first.
    #[serde(default)]
    pub left_open: Vec<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ListMeetings {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub epic_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    /// Only meetings with a participant whose name contains this (any case).
    #[serde(default)]
    pub participant: Option<String>,
    /// The user's UTC offset, like `+01:00`. Times are shown in it. Default: UTC.
    #[serde(default)]
    pub utc_offset: Option<String>,
    /// At most this many rows (default 50, at most 200).
    #[serde(default)]
    pub limit: Option<u32>,
    /// Continue after the meeting id returned as next_cursor. Reuse the same filters.
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct GetMeeting {
    pub meeting_id: String,
    /// The user's UTC offset, like `+01:00`. Default: UTC.
    #[serde(default)]
    pub utc_offset: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct GetCalendar {
    /// Start: a date (`2026-11-12`, local midnight) or a time (`2026-11-12T09:00`).
    /// Default: today.
    #[serde(default)]
    pub from: Option<String>,
    /// End: a date (included) or a time (excluded). Default: a week after `from`. At most
    /// 62 days.
    #[serde(default)]
    pub to: Option<String>,
    /// The user's UTC offset, like `+01:00` (`date +%:z`). Times are read and shown in
    /// it. Default: UTC.
    #[serde(default)]
    pub utc_offset: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ScheduleBlock {
    pub task_id: String,
    /// Start time, like `2026-11-12T09:00` (in `utc_offset`) or with its own offset.
    pub start: String,
    /// End time, after `start`, at most 24 hours later.
    pub end: String,
    /// The offset of times given without one, like `+01:00`. Default: UTC.
    #[serde(default)]
    pub utc_offset: Option<String>,
    /// planned (default), or worked to log time already spent (done, missed, cancelled).
    #[serde(default)]
    pub outcome: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct UpdateBlock {
    /// A block id from get_calendar.
    pub block_id: String,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    /// planned, worked, done, missed or cancelled.
    #[serde(default)]
    pub outcome: Option<String>,
    /// Take the block off the calendar.
    #[serde(default)]
    pub remove: bool,
    /// The offset of times given without one, like `+01:00`. Default: UTC.
    #[serde(default)]
    pub utc_offset: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct GetLineage {
    /// The task whose chains to show. Default: the session's task, unless `epic_id` or
    /// `project_id` is given.
    #[serde(default)]
    pub task_id: Option<String>,
    /// Instead of one task: the linked open tasks of this epic, ready ones first.
    #[serde(default)]
    pub epic_id: Option<String>,
    /// Instead of one task: the linked open tasks of this project, ready ones first.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Levels of prerequisites and dependents to follow (default 3, at most 10).
    #[serde(default)]
    pub depth: Option<u32>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct LinkTasks {
    /// The task that waits.
    pub task_id: String,
    /// The task to finish first.
    pub prerequisite_id: String,
    /// Remove the link instead of adding it.
    #[serde(default)]
    pub remove: bool,
}

// ---------------------------------------------------------------------------------------
// Tools

#[tool_router]
impl TaskServer {
    #[tool(
        description = "Full context of a task as markdown: status, project, epic, subtasks, \
                       prerequisites, dependents, earlier sessions and notes. Defaults to the \
                       session's task."
    )]
    pub fn get_task(&self, Parameters(p): Parameters<GetTask>) -> ToolResult {
        let id = match p.task_id {
            Some(id) => id,
            None => self.session()?.task_id.clone(),
        };
        self.with_store(|s| s.agent_brief(&id))
    }

    #[tool(
        description = "List tasks, compactly, with their ids. Filters combine. Open tasks \
                       only unless include_closed. Use next_cursor for the next page."
    )]
    pub fn list_tasks(&self, Parameters(p): Parameters<ListTasks>) -> ToolResult {
        let owner = p.owner.as_deref().map(parse_owner).transpose()?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let statuses = by_id(&snapshot.statuses);
        let limit = list_limit(p.limit);
        let start = match p.cursor.as_deref() {
            Some(cursor) => {
                snapshot
                    .tasks
                    .iter()
                    .position(|task| task.id == cursor)
                    .ok_or_else(|| format!("unknown task cursor '{cursor}'"))?
                    + 1
            }
            None => 0,
        };
        let mut lines = Vec::new();
        let mut more = 0;
        let mut next_cursor = None;
        for task in snapshot.tasks.iter().skip(start) {
            let keep = p
                .project_id
                .as_ref()
                .is_none_or(|v| task.project_id.as_ref() == Some(v))
                && p.epic_id
                    .as_ref()
                    .is_none_or(|v| task.epic_id.as_ref() == Some(v))
                && p.parent_id
                    .as_ref()
                    .is_none_or(|v| task.parent_id.as_ref() == Some(v))
                && owner.is_none_or(|o| task.owner == o)
                && (p.include_closed || !closed(&statuses, task));
            if !keep {
                continue;
            }
            if lines.len() < limit as usize {
                lines.push(task_line(&statuses, task));
                next_cursor = Some(task.id.as_str());
            } else {
                more += 1;
            }
        }
        if lines.is_empty() {
            return Ok("No tasks match.".to_owned());
        }
        let mut out = lines.join("\n");
        if more > 0
            && let Some(cursor) = next_cursor
        {
            out.push_str(&format!("\n… and {more} more\nnext_cursor: `{cursor}`"));
        }
        Ok(out)
    }

    #[tool(
        description = "List agent runs, newest first, with task title/status, timestamps, \
                       summary and error. Filter by session state (e.g. failed). \
                       latest_only checks each task's newest run before the state filter. \
                       Returns JSON with next_cursor for pagination."
    )]
    pub fn list_agent_sessions(&self, Parameters(p): Parameters<ListAgentSessions>) -> ToolResult {
        let state = p
            .state
            .as_deref()
            .map(|value| {
                SessionState::parse(&value.trim().to_ascii_lowercase()).ok_or_else(|| {
                    format!(
                        "unknown session state '{value}' \
                         (running, done, failed, cancelled, interrupted, terminal)"
                    )
                })
            })
            .transpose()?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let tasks: HashMap<&str, &Task> = snapshot
            .tasks
            .iter()
            .map(|task| (task.id.as_str(), task))
            .collect();
        let statuses = by_id(&snapshot.statuses);
        let cursor_key = p
            .cursor
            .as_deref()
            .map(|cursor| {
                snapshot
                    .agent_sessions
                    .iter()
                    .find(|session| session.id == cursor)
                    .map(|session| (session.started_at, session.id.as_str()))
                    .ok_or_else(|| format!("unknown session cursor '{cursor}'"))
            })
            .transpose()?;
        let mut sessions: Vec<&AgentSession> = snapshot.agent_sessions.iter().collect();
        sessions.sort_by(|a, b| {
            b.started_at
                .cmp(&a.started_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        let mut seen_tasks = HashSet::new();
        let matching: Vec<&AgentSession> = sessions
            .into_iter()
            .filter(|session| {
                let Some(task) = tasks.get(session.task_id.as_str()) else {
                    return false;
                };
                p.task_id.as_deref().is_none_or(|id| id == task.id)
                    && p.project_id
                        .as_deref()
                        .is_none_or(|id| task.project_id.as_deref() == Some(id))
                    && (!p.latest_only || seen_tasks.insert(session.task_id.as_str()))
            })
            .filter(|session| state.is_none_or(|state| session.state == state))
            .filter(|session| {
                cursor_key.is_none_or(|key| (session.started_at, session.id.as_str()) < key)
            })
            .collect();
        let limit = list_limit(p.limit) as usize;
        let next_cursor = (matching.len() > limit).then(|| matching[limit - 1].id.clone());
        let rows: Vec<_> = matching
            .into_iter()
            .take(limit)
            .map(|session| {
                let task = tasks[session.task_id.as_str()];
                serde_json::json!({
                    "session_id": session.id,
                    "task_id": task.id,
                    "task_title": task.title,
                    "task_status": statuses.get(task.status_id.as_str()).map(|s| s.name.as_str()),
                    "state": session.state.as_str(),
                    "started_at_ms": session.started_at,
                    "ended_at_ms": session.ended_at,
                    "summary": session.summary.as_deref().map(short_session_text),
                    "error": session.error.as_deref().map(short_session_text),
                })
            })
            .collect();
        Ok(serde_json::json!({
            "sessions": rows,
            "next_cursor": next_cursor,
        })
        .to_string())
    }

    #[tool(
        description = "Projects (with their areas) and epics (with their state and home \
                       project), with their ids. Archived projects only with include_archived."
    )]
    pub fn list_projects(&self, Parameters(p): Parameters<ListProjects>) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        let mut out = String::from("Projects:\n");
        let names: HashMap<&str, &str> = snapshot
            .projects
            .iter()
            .map(|p| (p.id.as_str(), p.name.as_str()))
            .collect();
        for project in snapshot
            .projects
            .iter()
            .filter(|x| p.include_archived || x.archived_at.is_none())
        {
            let area = project
                .parent_id
                .as_deref()
                .and_then(|id| names.get(id))
                .map(|name| format!("{name} / "))
                .unwrap_or_default();
            let archived = if project.archived_at.is_some() {
                "archived, "
            } else {
                ""
            };
            out.push_str(&format!(
                "- {area}{} ({archived}`{}`)\n",
                project.name, project.id
            ));
        }
        out.push_str("\nEpics:\n");
        for epic in &snapshot.epics {
            let home = epic
                .project_id
                .as_deref()
                .and_then(|id| names.get(id))
                .map_or("no project".to_owned(), |name| format!("in {name}"));
            out.push_str(&format!(
                "- {} ({}, {home}, `{}`)\n",
                epic.name,
                epic.state.as_str(),
                epic.id
            ));
        }
        Ok(out)
    }

    #[tool(
        description = "Create a project, top level or in an area (area_id, from \
                       list_projects). It is the user's at once (projects have no owner): \
                       create one only when the user asks. If a project of that name is \
                       already there, returns it instead. Returns its id."
    )]
    pub fn create_project(&self, Parameters(p): Parameters<CreateProject>) -> ToolResult {
        let name = p.name.trim();
        if name.is_empty() {
            return Err("the name cannot be empty".into());
        }
        let snapshot = self.with_store(|s| s.snapshot())?;
        let area = match p.area_id.as_deref() {
            Some(id) => Some(
                snapshot
                    .projects
                    .iter()
                    .find(|p| p.id == id && p.deleted_at.is_none())
                    .ok_or_else(|| format!("area {id} not found"))?,
            ),
            None => None,
        };
        let place = area.map(|a| format!(" in {}", a.name)).unwrap_or_default();
        if let Some(existing) = snapshot.projects.iter().find(|p| {
            p.deleted_at.is_none()
                && p.archived_at.is_none()
                && p.parent_id.as_deref() == area.map(|a| a.id.as_str())
                && p.name.trim().eq_ignore_ascii_case(name)
        }) {
            return Ok(format!(
                "Project {}{place} already exists (`{}`); nothing created.",
                existing.name, existing.id
            ));
        }
        let id = taskmaster_core::new_id();
        let changes = self.write(vec![Command::CreateProject {
            project: NewProject {
                id: Some(id.clone()),
                name: name.to_owned(),
                parent_id: area.map(|a| a.id.clone()),
                color: p.color,
                ..NewProject::default()
            },
        }])?;
        Ok(format!(
            "Created project {name}{place} (`{id}`){}",
            change_line(&changes)
        ))
    }

    #[tool(
        description = "Create an epic: an outcome that groups tasks, with an optional home \
                       project, description and target date. In a session, its project \
                       defaults to the session task's. It is the user's at once (epics have \
                       no owner): create one only when the user asks. If an epic of that \
                       name is already in that project, returns it instead. Returns its id."
    )]
    pub fn create_epic(&self, Parameters(p): Parameters<CreateEpic>) -> ToolResult {
        let name = p.name.trim();
        if name.is_empty() {
            return Err("the name cannot be empty".into());
        }
        let snapshot = self.with_store(|s| s.snapshot())?;
        let project_id = match (p.project_id, p.no_project, &self.session) {
            (Some(id), _, _) => Some(id),
            (None, false, Some(session)) => snapshot
                .tasks
                .iter()
                .find(|t| t.id == session.task_id)
                .and_then(|t| t.project_id.clone()),
            _ => None,
        };
        let project = match project_id.as_deref() {
            Some(id) => Some(
                snapshot
                    .projects
                    .iter()
                    .find(|p| p.id == id && p.deleted_at.is_none())
                    .ok_or_else(|| format!("project {id} not found"))?,
            ),
            None => None,
        };
        let place = project
            .map(|p| format!(" in {}", p.name))
            .unwrap_or_default();
        if let Some(existing) = snapshot.epics.iter().find(|e| {
            e.deleted_at.is_none()
                && e.project_id == project_id
                && e.name.trim().eq_ignore_ascii_case(name)
        }) {
            return Ok(format!(
                "Epic {}{place} already exists ({}, `{}`); nothing created.",
                existing.name,
                existing.state.as_str(),
                existing.id
            ));
        }
        let description = p
            .description
            .map(|d| d.trim().to_owned())
            .filter(|d| !d.is_empty());
        let target_date = p
            .target_date
            .map(|d| d.trim().to_owned())
            .filter(|d| !d.is_empty());
        let id = taskmaster_core::new_id();
        let changes = self.write(vec![Command::CreateEpic {
            epic: NewEpic {
                id: Some(id.clone()),
                name: name.to_owned(),
                project_id,
                description,
                target_date,
                ..NewEpic::default()
            },
        }])?;
        Ok(format!(
            "Created epic {name}{place} (`{id}`){}",
            change_line(&changes)
        ))
    }

    #[tool(description = "Find tasks by words in their title or description, best first.")]
    pub fn search(&self, Parameters(p): Parameters<Search>) -> ToolResult {
        let limit = list_limit(p.limit);
        let (ids, snapshot) =
            self.with_store(|s| Ok((s.search(&p.query, limit)?, s.snapshot()?)))?;
        let statuses = by_id(&snapshot.statuses);
        let tasks: HashMap<&str, &Task> =
            snapshot.tasks.iter().map(|t| (t.id.as_str(), t)).collect();
        let lines = ids
            .iter()
            .filter_map(|id| tasks.get(id.as_str()))
            .map(|task| task_line(&statuses, task))
            .collect();
        Ok(listing(lines, 0, "No tasks match."))
    }

    #[tool(
        description = "Create a task. By default an agent task, to track your own work (a \
                       step, a follow-up, a finding to handle); owner me makes one of the \
                       user's own, when they ask for it. In a session it becomes a subtask \
                       of the session's task unless parent_id or top_level is given. \
                       Returns its id."
    )]
    pub fn create_task(&self, Parameters(p): Parameters<CreateTask>) -> ToolResult {
        let owner = match p.owner.as_deref() {
            Some(o) => parse_owner(o)?,
            None => TaskOwner::Agent,
        };
        if owner == TaskOwner::Me {
            self.check_may_edit_users("a task of their own")?;
        }
        let snapshot = self.with_store(|s| s.snapshot())?;
        let parent_id = match (p.parent_id, p.top_level, &self.session) {
            (Some(id), _, _) => Some(id),
            (None, false, Some(session)) => Some(session.task_id.clone()),
            _ => None,
        };
        let project_id = p.project_id.or_else(|| {
            let from = parent_id
                .as_ref()
                .or(self.session.as_ref().map(|s| &s.task_id))?;
            snapshot
                .tasks
                .iter()
                .find(|t| &t.id == from)?
                .project_id
                .clone()
        });
        let status_id = p
            .status
            .as_deref()
            .map(|s| resolve_status(&snapshot, s))
            .transpose()?;
        let priority = p.priority.as_deref().map(parse_priority).transpose()?;
        let (tag_ids, mut commands) = resolve_tags(&snapshot, &p.tags, true)?;
        let id = taskmaster_core::new_id();
        commands.push(Command::CreateTask {
            task: NewTask {
                id: Some(id.clone()),
                title: p.title,
                description: p.description,
                owner,
                project_id,
                epic_id: p.epic_id,
                parent_id,
                status_id,
                priority: priority.unwrap_or_default(),
                due_date: non_empty(p.due_date),
                today_on: non_empty(p.today_on),
                estimate_min: p.estimate_min.filter(|m| *m > 0),
                tag_ids,
                ..NewTask::default()
            },
        });
        if !p.depends_on.is_empty() {
            commands.push(Command::UpdateTask {
                id: id.clone(),
                changes: vec![TaskChange::DependencyIds(p.depends_on)],
            });
        }
        let changes = self.write(commands)?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let statuses = by_id(&snapshot.statuses);
        let task = changes
            .tasks
            .iter()
            .find(|t| t.id == id)
            .ok_or("the task was not created")?;
        Ok(format!(
            "Created {}{}",
            task_line(&statuses, task).trim_start_matches("- "),
            change_line(&changes)
        ))
    }

    #[tool(
        description = "Change a task, the user's own or an agent's: status, title, \
                       description, priority, prerequisites, project, epic, parent, due \
                       date, today, estimate, tags, owner and its place in its column. In a \
                       session, the session's task cannot be marked done or cancelled \
                       (complete_session reports it) and its subtasks cannot be cancelled."
    )]
    pub fn update_task(&self, Parameters(p): Parameters<UpdateTask>) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        let task = find_task(&snapshot, &p.task_id)?;
        let own = task.owner == TaskOwner::Agent;
        if !own && !self.edit_user_tasks {
            let user_fields = p.title.is_some()
                || p.description.is_some()
                || p.append_description.is_some()
                || p.priority.is_some()
                || p.depends_on.is_some()
                || p.project_id.is_some()
                || p.epic_id.is_some()
                || p.parent_id.is_some()
                || p.due_date.is_some()
                || p.today_on.is_some()
                || p.estimate_min.is_some()
                || p.owner.is_some()
                || !p.add_tags.is_empty()
                || !p.remove_tags.is_empty()
                || p.position.is_some();
            if user_fields {
                return Err(
                    "this is the user's task: editing the user's tasks is turned off \
                            (Settings → Agents); only its status can be changed"
                        .into(),
                );
            }
            if !self.in_session_scope(&snapshot, task) {
                return Err(
                    "this is the user's task, outside this session: editing the \
                            user's tasks is turned off (Settings → Agents); add a note or an \
                            agent task instead"
                        .into(),
                );
            }
        }
        let mut commands = Vec::new();
        let mut changes = Vec::new();
        let mut status_id = task.status_id.clone();
        if let Some(status) = &p.status {
            let id = resolve_status(&snapshot, status)?;
            let category = snapshot
                .statuses
                .iter()
                .find(|s| s.id == id)
                .map(|s| s.category);
            // The user's subtasks of the session's task are steps of the work: the agent
            // marks them done as it finishes them. The session's task itself goes to the
            // user's review (complete_session), and cancelling stays the user's call.
            let is_session_task = self.session.as_ref().is_some_and(|s| s.task_id == task.id);
            let in_scope = self.in_session_scope(&snapshot, task);
            match category {
                Some(StatusCategory::Done) if !own && is_session_task => {
                    return Err(format!(
                        "the user closes this task after reviewing it; call complete_session \
                         when you are done, which moves it to {}",
                        self.done_status_name()
                    ));
                }
                Some(StatusCategory::Cancelled) if !own && in_scope => {
                    return Err(format!(
                        "only the user cancels their tasks; leave it open, list it in \
                         complete_session's left_open and say why in the summary (the task \
                         moves to {} for them)",
                        self.done_status_name()
                    ));
                }
                _ => {}
            }
            status_id = id.clone();
            changes.push(TaskChange::StatusId(id));
        }
        if let Some(parent) = &p.parent_id {
            let parent_id = match parent.trim() {
                "" => None,
                id => Some(find_task(&snapshot, id)?.id.clone()),
            };
            commands.push(Command::SetParent {
                id: task.id.clone(),
                parent_id,
            });
        }
        if let Some(title) = p.title {
            changes.push(TaskChange::Title(title));
        }
        match (p.description, p.append_description) {
            (Some(_), Some(_)) => {
                return Err("give description or append_description, not both".into());
            }
            (Some(d), None) => changes.push(TaskChange::Description(d)),
            (None, Some(more)) => {
                let current = task.description.trim_end();
                let joined = if current.is_empty() {
                    more
                } else {
                    format!("{current}\n\n{more}")
                };
                changes.push(TaskChange::Description(joined));
            }
            (None, None) => {}
        }
        if let Some(priority) = &p.priority {
            changes.push(TaskChange::Priority(parse_priority(priority)?));
        }
        if let Some(deps) = p.depends_on {
            changes.push(TaskChange::DependencyIds(deps));
        }
        if let Some(project) = p.project_id {
            changes.push(TaskChange::ProjectId(non_empty(Some(project))));
        }
        if let Some(epic) = p.epic_id {
            changes.push(TaskChange::EpicId(non_empty(Some(epic))));
        }
        if let Some(due) = p.due_date {
            changes.push(TaskChange::DueDate(non_empty(Some(due))));
        }
        if let Some(day) = p.today_on {
            changes.push(TaskChange::TodayOn(non_empty(Some(day))));
        }
        if let Some(minutes) = p.estimate_min {
            changes.push(TaskChange::EstimateMin(Some(minutes).filter(|m| *m != 0)));
        }
        if let Some(owner) = &p.owner {
            match parse_owner(owner)? {
                TaskOwner::Me if own => changes.push(TaskChange::Owner(TaskOwner::Me)),
                TaskOwner::Me => {}
                TaskOwner::Agent if own => {}
                TaskOwner::Agent => {
                    return Err("the user's tasks stay theirs; owner can only become me".into());
                }
            }
        }
        if let Some(position) = &p.position {
            changes.push(TaskChange::Rank(rank_in_column(
                &snapshot, task, &status_id, position,
            )?));
        }
        let (add, tag_commands) = resolve_tags(&snapshot, &p.add_tags, true)?;
        let (remove, _) = resolve_tags(&snapshot, &p.remove_tags, false)?;
        if !changes.is_empty() {
            commands.push(Command::UpdateTask {
                id: task.id.clone(),
                changes,
            });
        }
        commands.splice(0..0, tag_commands);
        for tag_id in add.into_iter().filter(|t| !task.tag_ids.contains(t)) {
            commands.push(Command::TagTask {
                task_id: task.id.clone(),
                tag_id,
            });
        }
        for tag_id in remove.into_iter().filter(|t| task.tag_ids.contains(t)) {
            commands.push(Command::UntagTask {
                task_id: task.id.clone(),
                tag_id,
            });
        }
        if commands.is_empty() {
            return Err("nothing to change".into());
        }
        let updated = self.write(commands)?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let statuses = by_id(&snapshot.statuses);
        let task = find_task(&snapshot, &p.task_id)?;
        let mut out = format!(
            "Updated {}",
            task_line(&statuses, task).trim_start_matches("- ")
        );
        if updated.tasks.len() > 1 {
            out.push_str(&format!(" ({} subtasks followed)", updated.tasks.len() - 1));
        }
        out.push_str(&change_line(&updated));
        Ok(out)
    }

    #[tool(
        description = "Record a progress note on the session's task: what you did, found or \
                       decided. Short; the user reads these to follow along."
    )]
    pub fn add_note(&self, Parameters(p): Parameters<AddNote>) -> ToolResult {
        let session = self.session()?;
        self.write(vec![Command::AddAgentNote {
            note: NewAgentNote {
                id: None,
                session_id: session.id.clone(),
                body: p.body,
            },
        }])?;
        Ok("Noted.".into())
    }

    #[tool(
        description = "Before you finish, record the session summary the user sees on the \
                       task: what was done, what is left, what to check. This reports the \
                       work done: the task moves to the status the user picked for agent \
                       work done (Review by default) for them to check. First mark every \
                       subtask you finished done with update_task (the user's subtasks \
                       too); list the ids of any you leave open in left_open, or this is \
                       refused."
    )]
    pub fn complete_session(&self, Parameters(p): Parameters<CompleteSession>) -> ToolResult {
        let session = self.session()?;
        if p.summary.trim().is_empty() {
            return Err("the summary cannot be empty".into());
        }
        // The software rule for subtasks: none is left open by oversight. Each open one is
        // either marked done first or named in left_open.
        let snapshot = self.with_store(|s| s.snapshot())?;
        let statuses = by_id(&snapshot.statuses);
        let open = open_subtasks(&snapshot, &statuses, &session.task_id);
        let unaccounted: Vec<&Task> = open
            .iter()
            .copied()
            .filter(|t| !p.left_open.contains(&t.id))
            .collect();
        if !unaccounted.is_empty() {
            let lines: Vec<String> = unaccounted
                .iter()
                .map(|t| task_line(&statuses, t))
                .collect();
            return Err(format!(
                "these subtasks are still open:\n{}\nMark the ones you finished done with \
                 update_task, then call complete_session again with the ids of the others \
                 in left_open (and say in the summary why they are left).",
                lines.join("\n")
            ));
        }
        if let Some(stray) = p
            .left_open
            .iter()
            .find(|id| !open.iter().any(|t| &t.id == *id))
        {
            return Err(format!(
                "`{stray}` in left_open is not an open subtask of this session's task"
            ));
        }
        // A headless run is ended by the app when Claude exits. Any other session (resumed
        // in a terminal, or still going after the app quit) ends here, or nothing would.
        let state = self.with_store(|s| s.agent_session(&session.id))?.state;
        let mut changes = vec![AgentSessionChange::Summary(Some(p.summary))];
        if state != SessionState::Running {
            changes.push(AgentSessionChange::State(SessionState::Done));
        }
        let mut commands = vec![Command::UpdateAgentSession {
            id: session.id.clone(),
            changes,
        }];
        // The software rule (ADR 017): the user's task goes to the status picked for agent
        // work done, unless it is there already or the user closed it.
        let target = self.workflow.done_status(&snapshot.statuses);
        let moved = snapshot
            .tasks
            .iter()
            .find(|t| t.id == session.task_id)
            .and_then(|task| self.workflow.on_done(&snapshot.statuses, task));
        let to = match (&moved, target) {
            (Some(_), Some(target)) => format!(" The task moved to {} for the user.", target.name),
            _ => String::new(),
        };
        commands.extend(moved);
        self.write(commands)?;
        Ok(if state == SessionState::Running {
            format!("Summary recorded.{to} The session ends when you finish your turn.")
        } else {
            format!("Summary recorded and the session marked done.{to}")
        })
    }

    #[tool(
        description = "The user's meetings (Scribe), newest first: time, title, state, \
                       participants and id. Filter by project, epic, task or participant. \
                       Read-only."
    )]
    pub fn list_meetings(&self, Parameters(p): Parameters<ListMeetings>) -> ToolResult {
        let offset = Offset::parse(p.utc_offset.as_deref().unwrap_or(""))?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let limit = list_limit(p.limit) as usize;
        let participant = p
            .participant
            .as_deref()
            .map(|n| n.trim().to_lowercase())
            .filter(|n| !n.is_empty());
        let mut newest: Vec<_> = snapshot.meetings.iter().rev().collect();
        if let Some(cursor) = p.cursor.as_deref() {
            let at = newest
                .iter()
                .position(|m| m.id == cursor)
                .ok_or_else(|| format!("unknown meeting cursor '{cursor}'"))?;
            newest.drain(..=at);
        }
        let matching: Vec<_> = newest
            .into_iter()
            .filter(|m| {
                p.project_id
                    .as_ref()
                    .is_none_or(|v| m.project_id.as_ref() == Some(v))
                    && p.epic_id
                        .as_ref()
                        .is_none_or(|v| m.epic_id.as_ref() == Some(v))
                    && p.task_id
                        .as_ref()
                        .is_none_or(|v| m.task_id.as_ref() == Some(v))
                    && participant.as_ref().is_none_or(|n| {
                        m.participants
                            .iter()
                            .any(|name| name.to_lowercase().contains(n))
                    })
            })
            .collect();
        if matching.is_empty() {
            return Ok("No meetings match.".to_owned());
        }
        let shown = &matching[..matching.len().min(limit)];
        let mut out = shown
            .iter()
            .map(|m| meetings::line(offset, m))
            .collect::<Vec<_>>()
            .join("\n");
        let more = matching.len() - shown.len();
        if more > 0
            && let Some(last) = shown.last()
        {
            out.push_str(&format!("\n… and {more} more\nnext_cursor: `{}`", last.id));
        }
        Ok(out)
    }

    #[tool(
        description = "One meeting in full as markdown: time, state, linked project, epic \
                       and task, participants, attachment names, notes and summary."
    )]
    pub fn get_meeting(&self, Parameters(p): Parameters<GetMeeting>) -> ToolResult {
        let offset = Offset::parse(p.utc_offset.as_deref().unwrap_or(""))?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let meeting = snapshot
            .meetings
            .iter()
            .find(|m| m.id == p.meeting_id)
            .ok_or_else(|| format!("meeting {} not found", p.meeting_id))?;
        Ok(meetings::render(&snapshot, offset, meeting))
    }

    #[tool(
        description = "The calendar day by day: time blocks (task, outcome, block id), \
                       meetings, the user's events from their shown Google calendars, and \
                       open tasks due or planned on each day. Pass utc_offset to read it in \
                       local time."
    )]
    pub fn get_calendar(&self, Parameters(p): Parameters<GetCalendar>) -> ToolResult {
        let offset = Offset::parse(p.utc_offset.as_deref().unwrap_or(""))?;
        let (from, to) = calendar::range(
            p.from.as_deref(),
            p.to.as_deref(),
            offset,
            taskmaster_core::now_ms(),
        )?;
        let (snapshot, events) = self.with_store(|s| {
            Ok((
                s.snapshot()?,
                s.calendar_events(&calendar::event_range(from, to))?,
            ))
        })?;
        Ok(calendar::render(&snapshot, &events, from, to, offset))
    }

    #[tool(
        description = "Plan time for a task: puts a planned block on the user's calendar \
                       (and their synced Google calendar), or logs time already worked \
                       (outcome worked). Check get_calendar for free time first."
    )]
    pub fn schedule_block(&self, Parameters(p): Parameters<ScheduleBlock>) -> ToolResult {
        let offset = Offset::parse(p.utc_offset.as_deref().unwrap_or(""))?;
        let start_at = calendar::parse_time("start", &p.start, offset)?;
        let end_at = calendar::parse_time("end", &p.end, offset)?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let task = find_task(&snapshot, &p.task_id)?;
        self.check_may_change(&snapshot, task)?;
        let outcome = p.outcome.as_deref().map(parse_outcome).transpose()?;
        let id = taskmaster_core::new_id();
        let changes = self.write(vec![Command::CreateTimeBlock {
            block: NewTimeBlock {
                id: Some(id.clone()),
                task_id: task.id.clone(),
                start_at,
                end_at,
                outcome,
            },
        }])?;
        let what = match outcome {
            None | Some(BlockOutcome::Planned) => "Planned",
            Some(BlockOutcome::Worked) => "Logged",
            Some(_) => "Recorded",
        };
        Ok(format!(
            "{what} {} to {} for {} (block `{id}`){}",
            p.start.trim(),
            p.end.trim(),
            task.title,
            change_line(&changes)
        ))
    }

    #[tool(description = "Move, resize, set the outcome of, or remove a time block.")]
    pub fn update_block(&self, Parameters(p): Parameters<UpdateBlock>) -> ToolResult {
        let offset = Offset::parse(p.utc_offset.as_deref().unwrap_or(""))?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let block = snapshot
            .time_blocks
            .iter()
            .find(|b| b.id == p.block_id && b.deleted_at.is_none())
            .ok_or_else(|| format!("block {} not found", p.block_id))?;
        let task = find_task(&snapshot, &block.task_id)?;
        self.check_may_change(&snapshot, task)?;
        if p.remove {
            if p.start.is_some() || p.end.is_some() || p.outcome.is_some() {
                return Err("give remove alone, or the changes without it".into());
            }
            if task.owner != TaskOwner::Agent && !self.in_session_scope(&snapshot, task) {
                self.check_may_edit_users("this task's block")?;
            }
            let changes = self.write(vec![Command::DeleteTimeBlock {
                id: block.id.clone(),
            }])?;
            return Ok(format!(
                "Removed block `{}` of {}{}",
                block.id,
                task.title,
                change_line(&changes)
            ));
        }
        let mut changes = Vec::new();
        if let Some(start) = &p.start {
            let at = calendar::parse_time("start", start, offset)?;
            changes.push(TimeBlockChange::StartAt(at));
        }
        if let Some(end) = &p.end {
            let at = calendar::parse_time("end", end, offset)?;
            changes.push(TimeBlockChange::EndAt(at));
        }
        if let Some(outcome) = &p.outcome {
            changes.push(TimeBlockChange::Outcome(parse_outcome(outcome)?));
        }
        if changes.is_empty() {
            return Err("nothing to change".into());
        }
        let changes = self.write(vec![Command::UpdateTimeBlock {
            id: block.id.clone(),
            changes,
        }])?;
        Ok(format!(
            "Updated block `{}` of {}{}",
            block.id,
            task.title,
            change_line(&changes)
        ))
    }

    #[tool(
        description = "The lineage (dependency links, as the Lineage view draws them): a \
                       task's prerequisites and dependents, nested, and whether it is ready; \
                       or, with epic_id or project_id, its linked open tasks, ready ones \
                       first. Defaults to the session's task."
    )]
    pub fn get_lineage(&self, Parameters(p): Parameters<GetLineage>) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        let depth = p.depth.unwrap_or(lineage::DEFAULT_DEPTH);
        match (p.task_id, p.epic_id, p.project_id) {
            (Some(id), None, None) => lineage::of_task(&snapshot, &id, depth),
            (None, Some(epic), None) => {
                let name = snapshot
                    .epics
                    .iter()
                    .find(|e| e.id == epic)
                    .map(|e| format!("epic {}", e.name))
                    .ok_or_else(|| format!("epic {epic} not found"))?;
                Ok(lineage::of_scope(
                    &snapshot,
                    |t| t.epic_id.as_deref() == Some(epic.as_str()),
                    &name,
                ))
            }
            (None, None, Some(project)) => {
                let name = snapshot
                    .projects
                    .iter()
                    .find(|e| e.id == project)
                    .map(|e| format!("project {}", e.name))
                    .ok_or_else(|| format!("project {project} not found"))?;
                Ok(lineage::of_scope(
                    &snapshot,
                    |t| t.project_id.as_deref() == Some(project.as_str()),
                    &name,
                ))
            }
            (None, None, None) => {
                let id = self.session()?.task_id.clone();
                lineage::of_task(&snapshot, &id, depth)
            }
            _ => Err("give one of task_id, epic_id or project_id".into()),
        }
    }

    #[tool(
        description = "Add (or remove) a lineage link: task_id waits on prerequisite_id. \
                       Links cannot form a circle."
    )]
    pub fn link_tasks(&self, Parameters(p): Parameters<LinkTasks>) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        let task = find_task(&snapshot, &p.task_id)?;
        let prerequisite = find_task(&snapshot, &p.prerequisite_id)?;
        self.check_may_change(&snapshot, task)?;
        let linked = task.dependency_ids.contains(&prerequisite.id);
        let mut deps = task.dependency_ids.clone();
        match (p.remove, linked) {
            (false, true) => {
                return Ok(format!(
                    "{} already waits on {}; nothing changed.",
                    task.title, prerequisite.title
                ));
            }
            (true, false) => {
                return Ok(format!(
                    "{} does not wait on {}; nothing changed.",
                    task.title, prerequisite.title
                ));
            }
            (false, false) => deps.push(prerequisite.id.clone()),
            (true, true) => deps.retain(|d| d != &prerequisite.id),
        }
        let changes = self.write(vec![Command::UpdateTask {
            id: task.id.clone(),
            changes: vec![TaskChange::DependencyIds(deps)],
        }])?;
        let done = if p.remove {
            format!("{} no longer waits on {}.", task.title, prerequisite.title)
        } else {
            format!("{} now waits on {}.", task.title, prerequisite.title)
        };
        Ok(format!("{done}{}", change_line(&changes)))
    }
}

impl TaskServer {
    /// The session's task or one of its subtasks (at any depth).
    fn in_session_scope(&self, snapshot: &Snapshot, task: &Task) -> bool {
        self.session
            .as_ref()
            .is_some_and(|session| is_within(snapshot, &task.id, &session.task_id))
    }

    fn instructions(&self) -> String {
        const VIEWS: &str = " get_calendar shows the user's time blocks, meetings and events \
                             (schedule_block plans time); list_meetings and get_meeting read \
                             the user's meetings and their notes; get_lineage shows which \
                             tasks wait on which (link_tasks adds a link).";
        let edit = if self.edit_user_tasks {
            "You may do anything the user can do in the app when they ask: edit their tasks \
             (update_task: status, fields, project, epic, parent, tags, order), create tasks of \
             their own (create_task with owner me), delete tasks (delete_task), edit or delete \
             projects, epics and tags, plan their calendar, link tasks and manage attachments. \
             Every write reports a change_id; undo reverts it."
        } else {
            "The user's own tasks, projects, epics and tags are read-only here; suggest \
             changes instead of making them. Your own agent tasks you may change and delete; \
             every write reports a change_id, and undo reverts your own changes."
        };
        let Some(session) = &self.session else {
            // Added to Claude by hand (docs/mcp.md): no task was sent, nothing to report.
            return format!(
                "task-master is the user's task manager. Use these tools \
                 when the user talks about their tasks, projects, plans or schedule: \
                 list_tasks, search and get_task read them (ids come from listings), \
                 and list_agent_sessions finds agent runs and failures. \
                 list_projects gives projects and epics, list_tags the tags; create_project \
                 and create_epic add them when the user asks (they are the user's at once). \
                 Tasks you create are agent tasks unless you pass owner me: kept apart from \
                 the user's own (they find them on the Agents page and can make them theirs), \
                 so say so when you create one. {edit}{VIEWS}"
            );
        };
        let mut text = format!(
            "task-master is the user's task manager. Use these tools to read task context \
             and to track your own progress: list_agent_sessions finds earlier runs and \
             failures; create agent tasks for the steps you plan, move \
             them to in_progress and done as you go, add short notes for findings and \
             decisions, and call complete_session with a summary before you finish. When \
             you finish a subtask of the task (yours or the user's), mark it done right \
             away; complete_session refuses while a subtask is open unless you list it in \
             left_open. The app then moves the task to {} for the user to check: never \
             mark the user's task done yourself. Agent tasks are kept apart from the user's \
             own. {edit}{VIEWS}",
            self.done_status_name()
        );
        text.push_str(&format!(
            " You are working on task `{}` (get_task without an id).",
            session.task_id
        ));
        if session.state != SessionState::Running {
            text.push_str(" This session has ended; it was resumed by hand.");
        }
        text
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for TaskServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("task-master", taskmaster_core::VERSION))
            .with_instructions(self.instructions())
    }
}

// ---------------------------------------------------------------------------------------
// Helpers

fn find_task<'a>(snapshot: &'a Snapshot, id: &str) -> Result<&'a Task, String> {
    snapshot
        .tasks
        .iter()
        .find(|t| t.id == id && t.deleted_at.is_none())
        .ok_or_else(|| format!("task {id} not found"))
}

fn by_id(statuses: &[Status]) -> HashMap<&str, &Status> {
    statuses.iter().map(|s| (s.id.as_str(), s)).collect()
}

/// The open (not done or cancelled) subtasks of `root`, at any depth, the user's and the
/// agents', in tree order.
fn open_subtasks<'a>(
    snapshot: &'a Snapshot,
    statuses: &HashMap<&str, &Status>,
    root: &str,
) -> Vec<&'a Task> {
    let mut children: HashMap<&str, Vec<&Task>> = HashMap::new();
    for task in &snapshot.tasks {
        if let Some(parent) = task.parent_id.as_deref()
            && task.deleted_at.is_none()
        {
            children.entry(parent).or_default().push(task);
        }
    }
    for list in children.values_mut() {
        list.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.id.cmp(&b.id)));
    }
    let mut open = Vec::new();
    let mut seen = HashSet::new();
    let mut stack: Vec<&Task> = children.get(root).cloned().unwrap_or_default();
    stack.reverse();
    while let Some(task) = stack.pop() {
        if !seen.insert(task.id.as_str()) {
            continue;
        }
        if !closed(statuses, task) {
            open.push(task);
        }
        if let Some(kids) = children.get(task.id.as_str()) {
            stack.extend(kids.iter().rev());
        }
    }
    open
}

fn closed(statuses: &HashMap<&str, &Status>, task: &Task) -> bool {
    statuses
        .get(task.status_id.as_str())
        .is_some_and(|s| matches!(s.category, StatusCategory::Done | StatusCategory::Cancelled))
}

/// `- [ ] Title (Status, agent, `id`)`.
fn task_line(statuses: &HashMap<&str, &Status>, task: &Task) -> String {
    let status = statuses
        .get(task.status_id.as_str())
        .map_or("?", |s| s.name.as_str());
    let agent = if task.owner == TaskOwner::Agent {
        ", agent"
    } else {
        ""
    };
    let parent = task
        .parent_id
        .as_deref()
        .map(|p| format!(", subtask of `{p}`"))
        .unwrap_or_default();
    format!(
        "- [{}] {} ({status}{agent}{parent}, `{}`)",
        if closed(statuses, task) { "x" } else { " " },
        task.title,
        task.id
    )
}

fn listing(lines: Vec<String>, more: usize, empty: &str) -> String {
    if lines.is_empty() {
        return empty.to_owned();
    }
    let mut out = lines.join("\n");
    if more > 0 {
        out.push_str(&format!(
            "\n… and {more} more (narrow the filters or raise limit)"
        ));
    }
    out
}

fn list_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(DEFAULT_LIST).clamp(1, MAX_LIST)
}

/// Keep session listings compact while preserving the reason for a failed run.
fn short_session_text(value: &str) -> String {
    const MAX_CHARS: usize = 400;
    let clean = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = clean.chars();
    let short: String = chars.by_ref().take(MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{short}…")
    } else {
        short
    }
}

/// A status by name (case-insensitive), else the first column of a category.
fn resolve_status(snapshot: &Snapshot, value: &str) -> Result<Id, String> {
    let value = value.trim();
    if let Some(status) = snapshot
        .statuses
        .iter()
        .find(|s| s.name.eq_ignore_ascii_case(value))
    {
        return Ok(status.id.clone());
    }
    let category = StatusCategory::parse(&value.to_ascii_lowercase().replace([' ', '-'], "_"))
        .ok_or_else(|| {
            let names: Vec<&str> = snapshot.statuses.iter().map(|s| s.name.as_str()).collect();
            format!(
                "unknown status '{value}': use one of {} or a category (backlog, todo, \
                 in_progress, done, cancelled)",
                names.join(", ")
            )
        })?;
    snapshot
        .statuses
        .iter()
        .find(|s| s.category == category)
        .map(|s| s.id.clone())
        .ok_or_else(|| format!("no column in category {}", category.as_str()))
}

fn parse_priority(value: &str) -> Result<Priority, String> {
    Ok(match value.trim().to_ascii_lowercase().as_str() {
        "urgent" => Priority::Urgent,
        "high" => Priority::High,
        "normal" => Priority::Normal,
        "low" => Priority::Low,
        other => {
            return Err(format!(
                "unknown priority '{other}' (urgent, high, normal, low)"
            ));
        }
    })
}

fn parse_owner(value: &str) -> Result<TaskOwner, String> {
    TaskOwner::parse(value.trim()).ok_or_else(|| format!("unknown owner '{value}' (me, agent)"))
}

fn parse_outcome(value: &str) -> Result<BlockOutcome, String> {
    BlockOutcome::parse(value.trim()).ok_or_else(|| {
        format!("unknown outcome '{value}' (planned, worked, done, missed, cancelled)")
    })
}

/// `None` for an absent or blank value, else the trimmed value.
fn non_empty(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

/// A tag's name as stored: no `#`, compared ignoring case.
fn tag_key(name: &str) -> String {
    name.trim().trim_start_matches('#').to_lowercase()
}

/// The ids of tags named `names`. With `create`, missing tags get new ids and the
/// commands that create them (to run first); otherwise an unknown name is an error.
fn resolve_tags(
    snapshot: &Snapshot,
    names: &[String],
    create: bool,
) -> Result<(Vec<Id>, Vec<Command>), String> {
    let mut ids = Vec::new();
    let mut commands = Vec::new();
    let mut made: HashMap<String, Id> = HashMap::new();
    for name in names {
        let key = tag_key(name);
        if key.is_empty() {
            return Err("a tag name cannot be empty".into());
        }
        let id = match snapshot
            .tags
            .iter()
            .find(|t| t.deleted_at.is_none() && tag_key(&t.name) == key)
        {
            Some(tag) => tag.id.clone(),
            None if !create => return Err(format!("no tag named '{name}'")),
            None => made
                .entry(key)
                .or_insert_with(|| {
                    let id = taskmaster_core::new_id();
                    commands.push(Command::CreateTag {
                        tag: taskmaster_core::NewTag {
                            id: Some(id.clone()),
                            name: name.trim().to_owned(),
                            color: None,
                        },
                    });
                    id
                })
                .clone(),
        };
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Ok((ids, commands))
}

/// A rank placing `task` in the column `status_id`: `top`, `bottom`, or right after the
/// task with the given id (which must be in that column).
fn rank_in_column(
    snapshot: &Snapshot,
    task: &Task,
    status_id: &str,
    position: &str,
) -> Result<String, String> {
    let mut column: Vec<&Task> = snapshot
        .tasks
        .iter()
        .filter(|t| t.status_id == status_id && t.id != task.id && t.deleted_at.is_none())
        .collect();
    column.sort_by(|a, b| a.rank.cmp(&b.rank));
    let ranks: Vec<&str> = column.iter().map(|t| t.rank.as_str()).collect();
    let (before, after) = match position.trim() {
        "top" => (None, ranks.first().copied()),
        "bottom" => (ranks.last().copied(), None),
        id => {
            let at = column.iter().position(|t| t.id == id).ok_or_else(|| {
                format!(
                    "position: give top, bottom or the id of a task in the same column, \
                     not '{id}'"
                )
            })?;
            (Some(ranks[at]), ranks.get(at + 1).copied())
        }
    };
    taskmaster_core::rank::key_between(before, after).map_err(|e| e.to_string())
}

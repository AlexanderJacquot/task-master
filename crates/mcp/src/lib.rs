//! task-master MCP server (docs/adr/017-agent-sessions.md).
//!
//! A stdio MCP server over the local database, started by Claude Code for a session the
//! desktop app spawned (or by hand, without a session). It writes through the core's
//! commands, so ops, sync and the desktop's live reload apply; writes stay out of any undo
//! history.
//!
//! Rules: tasks an agent creates are `owner = agent`. An agent may change its own tasks
//! freely, but of the user's tasks only the status, and only of the session's task and its
//! subtasks. Notes and the session summary need a session.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;
use taskmaster_core::{
    AgentSession, AgentSessionChange, AgentWorkflow, Command, Id, NewAgentNote, NewTask, Priority,
    SessionState, Snapshot, Status, StatusCategory, Store, Task, TaskChange, TaskOwner,
};

/// Most rows a listing returns.
pub const MAX_LIST: u32 = 200;
const DEFAULT_LIST: u32 = 50;

type ToolResult = Result<String, String>;

/// The MCP server: one store, and the session it serves (if any).
#[derive(Clone)]
pub struct TaskServer {
    store: Arc<Mutex<Store>>,
    session: Option<AgentSession>,
    /// Where the session's task goes when the agent reports it done (Settings → Agents).
    workflow: AgentWorkflow,
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
            tool_router: Self::tool_router(),
        })
    }

    /// The statuses picked for agent work (the app passes `--done-status`).
    pub fn with_workflow(mut self, workflow: AgentWorkflow) -> Self {
        self.workflow = workflow;
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
        self.with_store(|s| s.execute_without_undo(commands))
    }
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
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct UpdateTask {
    pub task_id: String,
    /// A status name, or a category: backlog, todo, in_progress, done, cancelled.
    #[serde(default)]
    pub status: Option<String>,
    /// Agent tasks only.
    #[serde(default)]
    pub title: Option<String>,
    /// Replaces the description. Agent tasks only.
    #[serde(default)]
    pub description: Option<String>,
    /// Added at the end of the description, on a new paragraph. Agent tasks only.
    #[serde(default)]
    pub append_description: Option<String>,
    /// urgent, high, normal or low. Agent tasks only.
    #[serde(default)]
    pub priority: Option<String>,
    /// Replaces the prerequisites (task ids). Agent tasks only.
    #[serde(default)]
    pub depends_on: Option<Vec<String>>,
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
                       only unless include_closed."
    )]
    pub fn list_tasks(&self, Parameters(p): Parameters<ListTasks>) -> ToolResult {
        let owner = p.owner.as_deref().map(parse_owner).transpose()?;
        let snapshot = self.with_store(|s| s.snapshot())?;
        let statuses = by_id(&snapshot.statuses);
        let limit = list_limit(p.limit);
        let mut lines = Vec::new();
        let mut more = 0;
        for task in &snapshot.tasks {
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
            } else {
                more += 1;
            }
        }
        Ok(listing(lines, more, "No tasks match."))
    }

    #[tool(description = "Projects (with their areas) and epics, with their ids.")]
    pub fn list_projects(&self) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        let mut out = String::from("Projects:\n");
        let names: HashMap<&str, &str> = snapshot
            .projects
            .iter()
            .map(|p| (p.id.as_str(), p.name.as_str()))
            .collect();
        for project in snapshot.projects.iter().filter(|p| p.archived_at.is_none()) {
            let area = project
                .parent_id
                .as_deref()
                .and_then(|id| names.get(id))
                .map(|name| format!("{name} / "))
                .unwrap_or_default();
            out.push_str(&format!("- {area}{} (`{}`)\n", project.name, project.id));
        }
        out.push_str("\nEpics:\n");
        for epic in &snapshot.epics {
            out.push_str(&format!(
                "- {} ({}, `{}`)\n",
                epic.name,
                epic.state.as_str(),
                epic.id
            ));
        }
        Ok(out)
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
        description = "Create an agent task to track your own work (a step, a follow-up, a \
                       finding to handle). In a session it becomes a subtask of the session's \
                       task unless parent_id or top_level is given. Returns its id."
    )]
    pub fn create_task(&self, Parameters(p): Parameters<CreateTask>) -> ToolResult {
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
        let id = taskmaster_core::new_id();
        let mut commands = vec![Command::CreateTask {
            task: NewTask {
                id: Some(id.clone()),
                title: p.title,
                description: p.description,
                owner: TaskOwner::Agent,
                project_id,
                epic_id: p.epic_id,
                parent_id,
                status_id,
                priority: priority.unwrap_or_default(),
                ..NewTask::default()
            },
        }];
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
            "Created {}",
            task_line(&statuses, task).trim_start_matches("- ")
        ))
    }

    #[tool(
        description = "Change a task. Agent tasks: any field. The user's tasks: only the \
                       status, and only of the session's task and its subtasks."
    )]
    pub fn update_task(&self, Parameters(p): Parameters<UpdateTask>) -> ToolResult {
        let snapshot = self.with_store(|s| s.snapshot())?;
        let task = snapshot
            .tasks
            .iter()
            .find(|t| t.id == p.task_id)
            .ok_or_else(|| format!("task {} not found", p.task_id))?;
        let own = task.owner == TaskOwner::Agent;
        let user_fields = p.title.is_some()
            || p.description.is_some()
            || p.append_description.is_some()
            || p.priority.is_some()
            || p.depends_on.is_some();
        if !own {
            if user_fields {
                return Err("this is the user's task: only its status can be changed".into());
            }
            if !self.in_session_scope(&snapshot, task) {
                return Err(
                    "this is the user's task, outside this session: it cannot be \
                            changed; add a note or an agent task instead"
                        .into(),
                );
            }
        }
        let mut changes = Vec::new();
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
            match category {
                Some(StatusCategory::Done) if !own && is_session_task => {
                    return Err(format!(
                        "the user closes this task after reviewing it; call complete_session \
                         when you are done, which moves it to {}",
                        self.done_status_name()
                    ));
                }
                Some(StatusCategory::Cancelled) if !own => {
                    return Err(format!(
                        "only the user cancels their tasks; leave it open, list it in \
                         complete_session's left_open and say why in the summary (the task \
                         moves to {} for them)",
                        self.done_status_name()
                    ));
                }
                _ => {}
            }
            changes.push(TaskChange::StatusId(id));
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
        if changes.is_empty() {
            return Err("nothing to change".into());
        }
        let updated = self.write(vec![Command::UpdateTask {
            id: task.id.clone(),
            changes,
        }])?;
        let statuses = by_id(&snapshot.statuses);
        let task = updated
            .tasks
            .iter()
            .find(|t| t.id == p.task_id)
            .ok_or("the task was not updated")?;
        Ok(format!(
            "Updated {}",
            task_line(&statuses, task).trim_start_matches("- ")
        ))
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
}

impl TaskServer {
    /// The session's task or one of its subtasks (at any depth).
    fn in_session_scope(&self, snapshot: &Snapshot, task: &Task) -> bool {
        let Some(session) = &self.session else {
            return false;
        };
        let parents: HashMap<&str, Option<&str>> = snapshot
            .tasks
            .iter()
            .map(|t| (t.id.as_str(), t.parent_id.as_deref()))
            .collect();
        let mut current = Some(task.id.as_str());
        for _ in 0..=parents.len() {
            match current {
                Some(id) if id == session.task_id => return true,
                Some(id) => current = parents.get(id).copied().flatten(),
                None => return false,
            }
        }
        false
    }

    fn instructions(&self) -> String {
        let mut text = format!(
            "task-master is the user's task manager. Use these tools to read task context \
             and to track your own progress: create agent tasks for the steps you plan, move \
             them to in_progress and done as you go, add short notes for findings and \
             decisions, and call complete_session with a summary before you finish. When \
             you finish a subtask of the task (yours or the user's), mark it done right \
             away; complete_session refuses while a subtask is open unless you list it in \
             left_open. The app then moves the task to {} for the user to check: never \
             mark the user's task done yourself. Agent tasks are kept apart from the user's own; never try to \
             change the user's other tasks.",
            self.done_status_name()
        );
        if let Some(session) = &self.session {
            text.push_str(&format!(
                " You are working on task `{}` (get_task without an id).",
                session.task_id
            ));
            if session.state != SessionState::Running {
                text.push_str(" This session has ended; it was resumed by hand.");
            }
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

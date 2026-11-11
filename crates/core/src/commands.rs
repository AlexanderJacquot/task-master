//! Commands: the only way to change data. Each one validates against the current state and
//! compiles to row [`Change`]s applied through the op engine, inside the caller's batch.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::clock::{check_date, check_id, new_id};
use crate::error::{Error, Result};
use crate::model::{
    AgentRuntime, BlockOutcome, EpicState, FILTER_NONE, Id, IsoDate, Priority, SessionState,
    Status, StatusCategory, Task, TaskOwner, Timestamp, VIEW_SPEC_VERSION, ViewScope, ViewSpec,
};
use crate::ops::{Batch, Change, Entity, OpKind};
use crate::{files, query, rank};

/// A user action. Several commands sent together form one undoable batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    CreateTask {
        task: NewTask,
    },
    UpdateTask {
        id: Id,
        changes: Vec<TaskChange>,
    },
    /// Drag and drop: new column and position.
    MoveTask {
        id: Id,
        status_id: Id,
        rank: String,
    },
    /// Makes the task a subtask of `parent_id`, or a top-level task when `None`.
    /// The task (and its subtasks) take the parent's project and epic.
    SetParent {
        id: Id,
        parent_id: Option<Id>,
    },
    /// Soft-deletes the task and all its subtasks.
    DeleteTask {
        id: Id,
    },
    TagTask {
        task_id: Id,
        tag_id: Id,
    },
    UntagTask {
        task_id: Id,
        tag_id: Id,
    },
    CreateProject {
        project: NewProject,
    },
    UpdateProject {
        id: Id,
        changes: Vec<ProjectChange>,
    },
    /// Refused while the project still holds tasks, epics or child projects.
    DeleteProject {
        id: Id,
    },
    CreateEpic {
        epic: NewEpic,
    },
    UpdateEpic {
        id: Id,
        changes: Vec<EpicChange>,
    },
    /// Detaches its tasks, then deletes the epic.
    DeleteEpic {
        id: Id,
    },
    CreateTag {
        tag: NewTag,
    },
    UpdateTag {
        id: Id,
        changes: Vec<TagChange>,
    },
    /// Removes the tag from every task, then deletes it.
    DeleteTag {
        id: Id,
    },
    /// A workflow column (settings).
    CreateStatus {
        status: NewStatus,
    },
    UpdateStatus {
        id: Id,
        changes: Vec<StatusChange>,
    },
    /// Refused while tasks are in it, or when it is the last `todo` or `done` column.
    DeleteStatus {
        id: Id,
    },
    CreateView {
        view: NewView,
    },
    UpdateView {
        id: Id,
        changes: Vec<ViewChange>,
    },
    DeleteView {
        id: Id,
    },
    /// Records a file already stored by hash (see `FileStore`) as attached to a task.
    CreateAttachment {
        attachment: NewAttachment,
    },
    UpdateAttachment {
        id: Id,
        changes: Vec<AttachmentChange>,
    },
    /// Detaches the file. Its content stays stored, so undo brings it back.
    DeleteAttachment {
        id: Id,
    },
    /// Places a task on the calendar.
    CreateTimeBlock {
        block: NewTimeBlock,
    },
    /// Moves, resizes or sets the outcome of a block. The result must still end after it
    /// starts.
    UpdateTimeBlock {
        id: Id,
        changes: Vec<TimeBlockChange>,
    },
    DeleteTimeBlock {
        id: Id,
    },
    /// Records a Claude Code run started on this device (docs/adr/017). Usually sent with
    /// [`crate::Store::execute_without_undo`]: sessions are not user edits.
    CreateAgentSession {
        session: NewAgentSession,
    },
    /// Only the device that started the session may update it. Leaving `running` sets
    /// `ended_at`; going back to `running` (a follow-up turn) clears it.
    UpdateAgentSession {
        id: Id,
        changes: Vec<AgentSessionChange>,
    },
    /// Removes a finished session (and its notes) from the task's history.
    DeleteAgentSession {
        id: Id,
    },
    /// A progress line from the agent, on its session's task.
    AddAgentNote {
        note: NewAgentNote,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NewAgentSession {
    pub id: Option<Id>,
    pub task_id: Id,
    /// A UUID, given to `claude --session-id`.
    pub claude_session_id: String,
    pub folder: String,
    pub runtime: AgentRuntime,
    /// One of [`PERMISSION_MODES`].
    pub permission_mode: String,
    /// Claude Code `--model`; `None` for the default.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub prompt: String,
}

/// Claude Code `--permission-mode` values a session may use.
pub const PERMISSION_MODES: &[&str] = &["default", "acceptEdits", "plan", "bypassPermissions"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionChange {
    State(SessionState),
    Summary(Option<String>),
    CostUsdMicros(Option<i64>),
    Turns(Option<i64>),
    DurationMs(Option<i64>),
    Error(Option<String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NewAgentNote {
    pub id: Option<Id>,
    pub session_id: Id,
    pub body: String,
}

/// Longest agent note, in characters.
pub const MAX_NOTE_CHARS: usize = 4000;

/// Fields for a new task. Only `title` is required; the rest have defaults.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(default)]
pub struct NewTask {
    /// Client-generated UUID (for optimistic UIs); generated when absent.
    pub id: Option<Id>,
    pub title: String,
    pub description: String,
    /// `agent` for an agent's own tasks; defaults to `me`.
    pub owner: TaskOwner,
    /// Defaults to the parent's project; `None` puts the task in the Inbox.
    pub project_id: Option<Id>,
    /// Defaults to the parent's epic.
    pub epic_id: Option<Id>,
    pub parent_id: Option<Id>,
    /// Defaults to the first status in the `todo` category.
    pub status_id: Option<Id>,
    pub priority: Priority,
    pub due_date: Option<IsoDate>,
    pub today_on: Option<IsoDate>,
    pub estimate_min: Option<i64>,
    /// Defaults to the end of its status column.
    pub rank: Option<String>,
    pub tag_ids: Vec<Id>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TaskChange {
    DependencyIds(Vec<Id>),
    /// Adopting an agent task: `agent` → `me`.
    Owner(TaskOwner),
    Title(String),
    Description(String),
    Priority(Priority),
    DueDate(Option<IsoDate>),
    TodayOn(Option<IsoDate>),
    EstimateMin(Option<i64>),
    /// Subtasks that shared the old project follow.
    ProjectId(Option<Id>),
    /// Subtasks that shared the old epic follow.
    EpicId(Option<Id>),
    StatusId(Id),
    Rank(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(default)]
pub struct NewProject {
    pub id: Option<Id>,
    pub name: String,
    /// The area this project sits in. Areas cannot themselves have a parent.
    pub parent_id: Option<Id>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub rank: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ProjectChange {
    Name(String),
    Color(Option<String>),
    Icon(Option<String>),
    ParentId(Option<Id>),
    Rank(String),
    Archived(bool),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(default)]
pub struct NewEpic {
    pub id: Option<Id>,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub project_id: Option<Id>,
    pub description: Option<String>,
    pub target_date: Option<IsoDate>,
    pub rank: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum EpicChange {
    Color(Option<String>),
    Icon(Option<String>),
    Name(String),
    Description(Option<String>),
    TargetDate(Option<IsoDate>),
    State(EpicState),
    ProjectId(Option<Id>),
    Rank(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(default)]
pub struct NewTag {
    pub id: Option<Id>,
    /// A leading `#` is stripped. No whitespace.
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NewStatus {
    pub id: Option<Id>,
    pub name: String,
    pub category: StatusCategory,
    pub color: Option<String>,
    pub rank: Option<String>,
    pub wip_limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum StatusChange {
    Name(String),
    /// Refused while tasks are in the column (their `completed_at` would no longer agree).
    Category(StatusCategory),
    Color(Option<String>),
    Rank(String),
    /// `None` removes the limit.
    WipLimit(Option<i64>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NewView {
    pub id: Option<Id>,
    pub name: String,
    pub spec: ViewSpec,
    pub rank: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ViewChange {
    Name(String),
    Spec(Box<ViewSpec>),
    Rank(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NewAttachment {
    pub id: Option<Id>,
    pub task_id: Id,
    /// From `FileStore::put_*`.
    pub hash: String,
    /// Folders are stripped.
    pub name: String,
    /// Guessed from the name when absent.
    pub mime: Option<String>,
    pub size: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum AttachmentChange {
    Name(String),
}

/// Longest time block: one day.
pub const MAX_BLOCK_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NewTimeBlock {
    pub id: Option<Id>,
    pub task_id: Id,
    /// Unix ms.
    pub start_at: Timestamp,
    /// Unix ms, after `start_at`, at most [`MAX_BLOCK_MS`] later.
    pub end_at: Timestamp,
    /// Defaults to `planned`.
    #[serde(default)]
    pub outcome: Option<BlockOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TimeBlockChange {
    StartAt(Timestamp),
    EndAt(Timestamp),
    Outcome(BlockOutcome),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TagChange {
    Name(String),
    Color(Option<String>),
}

pub(crate) fn run(b: &mut Batch<'_, '_>, command: Command) -> Result<()> {
    match command {
        Command::CreateTask { task } => create_task(b, task),
        Command::UpdateTask { id, changes } => update_task(b, &id, changes),
        Command::MoveTask {
            id,
            status_id,
            rank,
        } => update_task(
            b,
            &id,
            vec![TaskChange::StatusId(status_id), TaskChange::Rank(rank)],
        ),
        Command::SetParent { id, parent_id } => set_parent(b, &id, parent_id),
        Command::DeleteTask { id } => delete_task(b, &id),
        Command::TagTask { task_id, tag_id } => tag_task(b, &task_id, &tag_id, true),
        Command::UntagTask { task_id, tag_id } => tag_task(b, &task_id, &tag_id, false),
        Command::CreateProject { project } => create_project(b, project),
        Command::UpdateProject { id, changes } => update_project(b, &id, changes),
        Command::DeleteProject { id } => delete_project(b, &id),
        Command::CreateEpic { epic } => create_epic(b, epic),
        Command::UpdateEpic { id, changes } => update_epic(b, &id, changes),
        Command::DeleteEpic { id } => delete_epic(b, &id),
        Command::CreateTag { tag } => create_tag(b, tag),
        Command::UpdateTag { id, changes } => update_tag(b, &id, changes),
        Command::DeleteTag { id } => delete_tag(b, &id),
        Command::CreateStatus { status } => create_status(b, status),
        Command::UpdateStatus { id, changes } => update_status(b, &id, changes),
        Command::DeleteStatus { id } => delete_status(b, &id),
        Command::CreateView { view } => create_view(b, view),
        Command::UpdateView { id, changes } => update_view(b, &id, changes),
        Command::DeleteView { id } => delete_view(b, &id),
        Command::CreateAttachment { attachment } => create_attachment(b, attachment),
        Command::UpdateAttachment { id, changes } => update_attachment(b, &id, changes),
        Command::DeleteAttachment { id } => delete_attachment(b, &id),
        Command::CreateTimeBlock { block } => create_time_block(b, block),
        Command::UpdateTimeBlock { id, changes } => update_time_block(b, &id, changes),
        Command::DeleteTimeBlock { id } => delete_time_block(b, &id),
        Command::CreateAgentSession { session } => create_agent_session(b, session),
        Command::UpdateAgentSession { id, changes } => update_agent_session(b, &id, changes),
        Command::DeleteAgentSession { id } => delete_agent_session(b, &id),
        Command::AddAgentNote { note } => add_agent_note(b, note),
    }
}

// ---------------------------------------------------------------------------------------
// Tasks

fn create_task(b: &mut Batch<'_, '_>, n: NewTask) -> Result<()> {
    let id = client_id(n.id)?;
    let title = non_empty("title", &n.title)?;
    let parent = n
        .parent_id
        .as_deref()
        .map(|p| live_task(b, p))
        .transpose()?;
    let project_id = n
        .project_id
        .or_else(|| parent.as_ref().and_then(|p| p.project_id.clone()));
    let epic_id = n
        .epic_id
        .or_else(|| parent.as_ref().and_then(|p| p.epic_id.clone()));
    if let Some(p) = &project_id {
        live_project(b, p)?;
    }
    if let Some(e) = &epic_id {
        live_epic(b, e)?;
    }
    let status = match &n.status_id {
        Some(s) => live_status(b, s)?,
        None => default_status(b)?,
    };
    check_optional_date("due_date", n.due_date.as_deref())?;
    check_optional_date("today_on", n.today_on.as_deref())?;
    check_estimate(n.estimate_min)?;
    let rank = match n.rank {
        Some(r) => {
            rank::validate(&r)?;
            r
        }
        None => rank::key_between(last_task_rank(b, &status.id)?.as_deref(), None)?,
    };
    let mut tag_ids = n.tag_ids;
    tag_ids.sort();
    tag_ids.dedup();
    for tag in &tag_ids {
        live_tag(b, tag)?;
    }
    let completed_at = (status.category == StatusCategory::Done).then_some(b.now);

    b.apply(Change::new(
        Entity::Task,
        &id,
        OpKind::Create,
        json!({
            "project_id": project_id,
            "epic_id": epic_id,
            "parent_id": n.parent_id,
            "status_id": status.id,
            "title": title,
            "description": n.description,
            "owner": n.owner.as_str(),
            "priority": n.priority.to_db(),
            "due_date": n.due_date,
            "today_on": n.today_on,
            "estimate_min": n.estimate_min,
            "rank": rank,
            "created_at": b.now,
            "updated_at": b.now,
            "completed_at": completed_at,
            "deleted_at": null,
        }),
    ))?;
    rebalance_if_long(b, &status.id, &rank)?;
    for tag in tag_ids {
        b.apply(Change::new(
            Entity::TaskTag,
            &id,
            OpKind::Link,
            json!({ "tag_id": tag }),
        ))?;
    }
    Ok(())
}

fn update_task(b: &mut Batch<'_, '_>, id: &str, changes: Vec<TaskChange>) -> Result<()> {
    if changes.is_empty() {
        return Err(Error::invalid("update_task needs at least one change"));
    }
    let task = live_task(b, id)?;
    let mut patch = Map::new();
    let mut new_project = None;
    let mut new_epic = None;
    for change in changes {
        let (key, value) = match change {
            TaskChange::DependencyIds(mut ids) => {
                ids.sort();
                ids.dedup();
                for dependency in &ids {
                    if !task.dependency_ids.contains(dependency) {
                        live_task(b, dependency)?;
                    }
                    let cycle: bool = b.tx.query_row(
                        "WITH RECURSIVE ancestors(id) AS (
                            SELECT ?1 UNION
                            SELECT j.value FROM tasks t, json_each(t.dependency_ids) j
                            JOIN ancestors a ON t.id = a.id
                        ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = ?2)",
                        rusqlite::params![dependency, id],
                        |r| r.get(0),
                    )?;
                    if cycle {
                        return Err(Error::invalid("Dependencies cannot form a circular chain"));
                    }
                }
                ("dependency_ids", json!(serde_json::to_string(&ids)?))
            }
            TaskChange::Owner(o) => ("owner", json!(o.as_str())),
            TaskChange::Title(t) => ("title", json!(non_empty("title", &t)?)),
            TaskChange::Description(d) => ("description", json!(d)),
            TaskChange::Priority(p) => ("priority", json!(p.to_db())),
            TaskChange::DueDate(d) => {
                check_optional_date("due_date", d.as_deref())?;
                ("due_date", json!(d))
            }
            TaskChange::TodayOn(d) => {
                check_optional_date("today_on", d.as_deref())?;
                ("today_on", json!(d))
            }
            TaskChange::EstimateMin(m) => {
                check_estimate(m)?;
                ("estimate_min", json!(m))
            }
            TaskChange::ProjectId(p) => {
                if let Some(p) = &p {
                    live_project(b, p)?;
                }
                new_project = Some(p.clone());
                ("project_id", json!(p))
            }
            TaskChange::EpicId(e) => {
                if let Some(e) = &e {
                    live_epic(b, e)?;
                }
                new_epic = Some(e.clone());
                ("epic_id", json!(e))
            }
            TaskChange::StatusId(s) => {
                let new = live_status(b, &s)?;
                let old = query::status(b.tx, &task.status_id)?;
                let (was_done, is_done) = (
                    old.category == StatusCategory::Done,
                    new.category == StatusCategory::Done,
                );
                if is_done && !was_done {
                    patch.insert("completed_at".into(), json!(b.now));
                } else if was_done && !is_done {
                    patch.insert("completed_at".into(), Value::Null);
                }
                ("status_id", json!(new.id))
            }
            TaskChange::Rank(r) => {
                rank::validate(&r)?;
                ("rank", json!(r))
            }
        };
        patch.insert(key.into(), value);
    }
    patch.insert("updated_at".into(), json!(b.now));
    let status_id = patch
        .get("status_id")
        .and_then(Value::as_str)
        .unwrap_or(&task.status_id)
        .to_owned();
    let rank = patch.get("rank").and_then(Value::as_str).map(str::to_owned);
    b.apply(Change::new(
        Entity::Task,
        id,
        OpKind::Update,
        Value::Object(patch),
    ))?;
    if let Some(rank) = rank {
        rebalance_if_long(b, &status_id, &rank)?;
    }
    cascade_containers(b, &task, new_project.as_ref(), new_epic.as_ref())
}

/// Rank keys longer than this trigger a rebalance of their column (plan section 10).
pub const MAX_RANK_LEN: usize = 32;

/// Rewrites every rank in the column with short evenly spaced keys, keeping the order,
/// when `rank` (just written) is too long. Runs inside the caller's batch, so one undo
/// reverts the move and the rebalance together. The ops carry only `rank` (no
/// `updated_at`): bookkeeping, not an edit, so the activity feed skips them.
fn rebalance_if_long(b: &mut Batch<'_, '_>, status_id: &str, rank: &str) -> Result<()> {
    if rank.len() <= MAX_RANK_LEN {
        return Ok(());
    }
    let column: Vec<(Id, String)> = {
        let mut stmt = b.tx.prepare_cached(
            "SELECT id, rank FROM tasks WHERE status_id = ?1 AND deleted_at IS NULL
             ORDER BY rank, id",
        )?;
        let rows = stmt.query_map([status_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut prev: Option<String> = None;
    for (id, old) in column {
        let key = rank::key_between(prev.as_deref(), None)?;
        if key != old {
            b.apply(Change::new(
                Entity::Task,
                &id,
                OpKind::Update,
                json!({ "rank": key }),
            ))?;
        }
        prev = Some(key);
    }
    Ok(())
}

/// Moves subtasks along when a task changes project or epic: a subtask follows when its
/// value matched the task's old one (it was inherited, not set on purpose).
fn cascade_containers(
    b: &mut Batch<'_, '_>,
    task: &Task,
    new_project: Option<&Option<Id>>,
    new_epic: Option<&Option<Id>>,
) -> Result<()> {
    if new_project.is_none() && new_epic.is_none() {
        return Ok(());
    }
    for sub_id in descendants(b, &task.id)? {
        let sub = query::task(b.tx, &sub_id)?;
        let mut patch = Map::new();
        if let Some(p) = new_project
            && sub.project_id == task.project_id
        {
            patch.insert("project_id".into(), json!(p));
        }
        if let Some(e) = new_epic
            && sub.epic_id == task.epic_id
        {
            patch.insert("epic_id".into(), json!(e));
        }
        if !patch.is_empty() {
            patch.insert("updated_at".into(), json!(b.now));
            b.apply(Change::new(
                Entity::Task,
                &sub_id,
                OpKind::Update,
                Value::Object(patch),
            ))?;
        }
    }
    Ok(())
}

fn set_parent(b: &mut Batch<'_, '_>, id: &str, parent_id: Option<Id>) -> Result<()> {
    let task = live_task(b, id)?;
    let mut patch = Map::new();
    let mut containers = None;
    if let Some(p) = &parent_id {
        if p == id {
            return Err(Error::invalid("a task cannot be its own parent"));
        }
        let parent = live_task(b, p)?;
        if descendants(b, id)?.contains(p) {
            return Err(Error::invalid(
                "cannot move a task under one of its own subtasks",
            ));
        }
        patch.insert("project_id".into(), json!(parent.project_id));
        patch.insert("epic_id".into(), json!(parent.epic_id));
        containers = Some((parent.project_id, parent.epic_id));
    }
    patch.insert("parent_id".into(), json!(parent_id));
    patch.insert("updated_at".into(), json!(b.now));
    b.apply(Change::new(
        Entity::Task,
        id,
        OpKind::Update,
        Value::Object(patch),
    ))?;
    if let Some((project, epic)) = containers {
        cascade_containers(b, &task, Some(&project), Some(&epic))?;
    }
    Ok(())
}

fn delete_task(b: &mut Batch<'_, '_>, id: &str) -> Result<()> {
    live_task(b, id)?;
    let mut ids = vec![id.to_owned()];
    ids.extend(descendants(b, id)?);
    for task_id in ids {
        b.apply(Change::new(
            Entity::Task,
            &task_id,
            OpKind::Delete,
            json!({ "deleted_at": b.now, "updated_at": b.now }),
        ))?;
    }
    Ok(())
}

fn tag_task(b: &mut Batch<'_, '_>, task_id: &str, tag_id: &str, link: bool) -> Result<()> {
    let task = live_task(b, task_id)?;
    if link {
        live_tag(b, tag_id)?;
    }
    if task.tag_ids.iter().any(|t| t == tag_id) == link {
        return Ok(()); // already in the requested state
    }
    let kind = if link { OpKind::Link } else { OpKind::Unlink };
    b.apply(Change::new(
        Entity::TaskTag,
        task_id,
        kind,
        json!({ "tag_id": tag_id }),
    ))?;
    b.apply(Change::new(
        Entity::Task,
        task_id,
        OpKind::Update,
        json!({ "updated_at": b.now }),
    ))
}

// ---------------------------------------------------------------------------------------
// Projects

fn create_project(b: &mut Batch<'_, '_>, n: NewProject) -> Result<()> {
    let id = client_id(n.id)?;
    let name = non_empty("name", &n.name)?;
    if let Some(p) = &n.parent_id {
        check_area(b, p)?;
    }
    let rank = match n.rank {
        Some(r) => {
            rank::validate(&r)?;
            r
        }
        None => {
            let last: Option<String> = b.tx.query_row(
                "SELECT MAX(rank) FROM projects WHERE parent_id IS ?1 AND deleted_at IS NULL",
                [&n.parent_id],
                |r| r.get(0),
            )?;
            rank::key_between(last.as_deref(), None)?
        }
    };
    b.apply(Change::new(
        Entity::Project,
        &id,
        OpKind::Create,
        json!({
            "parent_id": n.parent_id,
            "name": name,
            "color": n.color,
            "icon": n.icon,
            "rank": rank,
            "archived_at": null,
            "created_at": b.now,
            "updated_at": b.now,
            "deleted_at": null,
        }),
    ))
}

/// Projects nest one level: the parent must be a top-level project (an area).
fn check_area(b: &Batch<'_, '_>, parent_id: &str) -> Result<()> {
    let parent = live_project(b, parent_id)?;
    if parent.parent_id.is_some() {
        return Err(Error::invalid(format!(
            "'{}' is already inside an area; projects nest one level only",
            parent.name
        )));
    }
    Ok(())
}

fn update_project(b: &mut Batch<'_, '_>, id: &str, changes: Vec<ProjectChange>) -> Result<()> {
    if changes.is_empty() {
        return Err(Error::invalid("update_project needs at least one change"));
    }
    let project = live_project(b, id)?;
    let mut patch = Map::new();
    for change in changes {
        let (key, value) = match change {
            ProjectChange::Name(n) => ("name", json!(non_empty("name", &n)?)),
            ProjectChange::Color(c) => ("color", json!(c)),
            ProjectChange::Icon(i) => ("icon", json!(i)),
            ProjectChange::Rank(r) => {
                rank::validate(&r)?;
                ("rank", json!(r))
            }
            ProjectChange::Archived(archived) => {
                let at = match (archived, project.archived_at) {
                    (true, Some(at)) => Some(at),
                    (true, None) => Some(b.now),
                    (false, _) => None,
                };
                ("archived_at", json!(at))
            }
            ProjectChange::ParentId(p) => {
                if let Some(p) = &p {
                    if p == id {
                        return Err(Error::invalid("a project cannot contain itself"));
                    }
                    check_area(b, p)?;
                    if count(
                        b,
                        "SELECT COUNT(*) FROM projects WHERE parent_id = ?1 AND deleted_at IS NULL",
                        id,
                    )? > 0
                    {
                        return Err(Error::invalid(format!(
                            "'{}' contains projects, so it cannot move into an area",
                            project.name
                        )));
                    }
                }
                ("parent_id", json!(p))
            }
        };
        patch.insert(key.into(), value);
    }
    patch.insert("updated_at".into(), json!(b.now));
    b.apply(Change::new(
        Entity::Project,
        id,
        OpKind::Update,
        Value::Object(patch),
    ))
}

fn delete_project(b: &mut Batch<'_, '_>, id: &str) -> Result<()> {
    let project = live_project(b, id)?;
    let tasks = count(
        b,
        "SELECT COUNT(*) FROM tasks WHERE project_id = ?1 AND deleted_at IS NULL",
        id,
    )?;
    let epics = count(
        b,
        "SELECT COUNT(*) FROM epics WHERE project_id = ?1 AND deleted_at IS NULL",
        id,
    )?;
    let children = count(
        b,
        "SELECT COUNT(*) FROM projects WHERE parent_id = ?1 AND deleted_at IS NULL",
        id,
    )?;
    if tasks + epics + children > 0 {
        return Err(Error::invalid(format!(
            "'{}' still has {tasks} task(s), {epics} epic(s) and {children} project(s); \
             move or delete them first, or archive the project",
            project.name
        )));
    }
    b.apply(Change::new(
        Entity::Project,
        id,
        OpKind::Delete,
        json!({ "deleted_at": b.now, "updated_at": b.now }),
    ))
}

// ---------------------------------------------------------------------------------------
// Epics

fn create_epic(b: &mut Batch<'_, '_>, n: NewEpic) -> Result<()> {
    let id = client_id(n.id)?;
    let name = non_empty("name", &n.name)?;
    if let Some(p) = &n.project_id {
        live_project(b, p)?;
    }
    check_optional_date("target_date", n.target_date.as_deref())?;
    let rank = match n.rank {
        Some(r) => {
            rank::validate(&r)?;
            r
        }
        None => {
            let last: Option<String> = b.tx.query_row(
                "SELECT MAX(rank) FROM epics WHERE deleted_at IS NULL",
                [],
                |r| r.get(0),
            )?;
            rank::key_between(last.as_deref(), None)?
        }
    };
    b.apply(Change::new(
        Entity::Epic,
        &id,
        OpKind::Create,
        json!({
            "project_id": n.project_id,
            "name": name,
            "color": n.color,
            "icon": n.icon,
            "description": n.description,
            "target_date": n.target_date,
            "state": EpicState::Active.as_str(),
            "rank": rank,
            "created_at": b.now,
            "updated_at": b.now,
            "deleted_at": null,
        }),
    ))
}

fn update_epic(b: &mut Batch<'_, '_>, id: &str, changes: Vec<EpicChange>) -> Result<()> {
    if changes.is_empty() {
        return Err(Error::invalid("update_epic needs at least one change"));
    }
    live_epic(b, id)?;
    let mut patch = Map::new();
    for change in changes {
        let (key, value) = match change {
            EpicChange::Color(c) => ("color", json!(c)),
            EpicChange::Icon(i) => ("icon", json!(i)),
            EpicChange::Name(n) => ("name", json!(non_empty("name", &n)?)),
            EpicChange::Description(d) => ("description", json!(d)),
            EpicChange::TargetDate(d) => {
                check_optional_date("target_date", d.as_deref())?;
                ("target_date", json!(d))
            }
            EpicChange::State(s) => ("state", json!(s.as_str())),
            EpicChange::ProjectId(p) => {
                if let Some(p) = &p {
                    live_project(b, p)?;
                }
                ("project_id", json!(p))
            }
            EpicChange::Rank(r) => {
                rank::validate(&r)?;
                ("rank", json!(r))
            }
        };
        patch.insert(key.into(), value);
    }
    patch.insert("updated_at".into(), json!(b.now));
    b.apply(Change::new(
        Entity::Epic,
        id,
        OpKind::Update,
        Value::Object(patch),
    ))
}

fn delete_epic(b: &mut Batch<'_, '_>, id: &str) -> Result<()> {
    live_epic(b, id)?;
    for task_id in ids(
        b,
        "SELECT id FROM tasks WHERE epic_id = ?1 AND deleted_at IS NULL",
        id,
    )? {
        b.apply(Change::new(
            Entity::Task,
            &task_id,
            OpKind::Update,
            json!({ "epic_id": null, "updated_at": b.now }),
        ))?;
    }
    b.apply(Change::new(
        Entity::Epic,
        id,
        OpKind::Delete,
        json!({ "deleted_at": b.now, "updated_at": b.now }),
    ))
}

// ---------------------------------------------------------------------------------------
// Tags

fn create_tag(b: &mut Batch<'_, '_>, n: NewTag) -> Result<()> {
    let id = client_id(n.id)?;
    let name = tag_name(b, &n.name, &id)?;
    b.apply(Change::new(
        Entity::Tag,
        &id,
        OpKind::Create,
        json!({
            "name": name,
            "color": n.color,
            "created_at": b.now,
            "updated_at": b.now,
            "deleted_at": null,
        }),
    ))
}

/// Normalizes a tag name and checks no other live tag has it (case-insensitive).
fn tag_name(b: &Batch<'_, '_>, raw: &str, own_id: &str) -> Result<String> {
    let name = non_empty("tag name", raw.trim().trim_start_matches('#'))?;
    if name.chars().any(char::is_whitespace) {
        return Err(Error::invalid(format!(
            "tag '{name}' cannot contain spaces"
        )));
    }
    let taken: i64 = b.tx.query_row(
        "SELECT COUNT(*) FROM tags
         WHERE name = ?1 COLLATE NOCASE AND deleted_at IS NULL AND id != ?2",
        [&name, own_id],
        |r| r.get(0),
    )?;
    if taken > 0 {
        return Err(Error::invalid(format!("tag '{name}' already exists")));
    }
    Ok(name)
}

fn update_tag(b: &mut Batch<'_, '_>, id: &str, changes: Vec<TagChange>) -> Result<()> {
    if changes.is_empty() {
        return Err(Error::invalid("update_tag needs at least one change"));
    }
    live_tag(b, id)?;
    let mut patch = Map::new();
    for change in changes {
        let (key, value) = match change {
            TagChange::Name(n) => ("name", json!(tag_name(b, &n, id)?)),
            TagChange::Color(c) => ("color", json!(c)),
        };
        patch.insert(key.into(), value);
    }
    patch.insert("updated_at".into(), json!(b.now));
    b.apply(Change::new(
        Entity::Tag,
        id,
        OpKind::Update,
        Value::Object(patch),
    ))
}

fn delete_tag(b: &mut Batch<'_, '_>, id: &str) -> Result<()> {
    live_tag(b, id)?;
    for task_id in ids(b, "SELECT task_id FROM task_tags WHERE tag_id = ?1", id)? {
        b.apply(Change::new(
            Entity::TaskTag,
            &task_id,
            OpKind::Unlink,
            json!({ "tag_id": id }),
        ))?;
        b.apply(Change::new(
            Entity::Task,
            &task_id,
            OpKind::Update,
            json!({ "updated_at": b.now }),
        ))?;
    }
    b.apply(Change::new(
        Entity::Tag,
        id,
        OpKind::Delete,
        json!({ "deleted_at": b.now, "updated_at": b.now }),
    ))
}

// ---------------------------------------------------------------------------------------
// Helpers

// ---------------------------------------------------------------------------------------
// Statuses

fn check_wip(limit: Option<i64>) -> Result<()> {
    match limit {
        Some(n) if !(1..=999).contains(&n) => Err(Error::invalid(format!(
            "WIP limit must be between 1 and 999, got {n}"
        ))),
        _ => Ok(()),
    }
}

fn status_name(b: &Batch<'_, '_>, raw: &str, own_id: &str) -> Result<String> {
    let name = non_empty("status name", raw)?;
    let taken: i64 = b.tx.query_row(
        "SELECT COUNT(*) FROM statuses
         WHERE name = ?1 COLLATE NOCASE AND deleted_at IS NULL AND id != ?2",
        [&name, own_id],
        |r| r.get(0),
    )?;
    if taken > 0 {
        return Err(Error::invalid(format!("status '{name}' already exists")));
    }
    Ok(name)
}

/// The app needs a `todo` column (new tasks) and a `done` column (the checkbox).
fn check_keeps_workflow(b: &Batch<'_, '_>, status: &Status) -> Result<()> {
    if !matches!(status.category, StatusCategory::Todo | StatusCategory::Done) {
        return Ok(());
    }
    let others: i64 = b.tx.query_row(
        "SELECT COUNT(*) FROM statuses WHERE category = ?1 AND deleted_at IS NULL AND id != ?2",
        [status.category.as_str(), &status.id],
        |r| r.get(0),
    )?;
    if others == 0 {
        return Err(Error::invalid(format!(
            "'{}' is the last {} column; add another one first",
            status.name,
            status.category.as_str()
        )));
    }
    Ok(())
}

fn tasks_in(b: &Batch<'_, '_>, status_id: &str) -> Result<i64> {
    count(
        b,
        "SELECT COUNT(*) FROM tasks WHERE status_id = ?1 AND deleted_at IS NULL",
        status_id,
    )
}

fn create_status(b: &mut Batch<'_, '_>, n: NewStatus) -> Result<()> {
    let id = client_id(n.id)?;
    let name = status_name(b, &n.name, &id)?;
    check_wip(n.wip_limit)?;
    let rank = match n.rank {
        Some(r) => {
            rank::validate(&r)?;
            r
        }
        None => {
            let last: Option<String> = b.tx.query_row(
                "SELECT MAX(rank) FROM statuses WHERE deleted_at IS NULL",
                [],
                |r| r.get(0),
            )?;
            rank::key_between(last.as_deref(), None)?
        }
    };
    b.apply(Change::new(
        Entity::Status,
        &id,
        OpKind::Create,
        json!({
            "name": name,
            "category": n.category.as_str(),
            "color": n.color,
            "rank": rank,
            "wip_limit": n.wip_limit,
            "created_at": b.now,
            "updated_at": b.now,
            "deleted_at": null,
        }),
    ))
}

fn update_status(b: &mut Batch<'_, '_>, id: &str, changes: Vec<StatusChange>) -> Result<()> {
    if changes.is_empty() {
        return Err(Error::invalid("update_status needs at least one change"));
    }
    let status = live_status(b, id)?;
    let mut patch = Map::new();
    for change in changes {
        let (key, value) = match change {
            StatusChange::Name(n) => ("name", json!(status_name(b, &n, id)?)),
            StatusChange::Category(c) => {
                if c != status.category {
                    let n = tasks_in(b, id)?;
                    if n > 0 {
                        return Err(Error::invalid(format!(
                            "'{}' holds {n} task(s); move them before changing its category",
                            status.name
                        )));
                    }
                    check_keeps_workflow(b, &status)?;
                }
                ("category", json!(c.as_str()))
            }
            StatusChange::Color(c) => ("color", json!(c)),
            StatusChange::Rank(r) => {
                rank::validate(&r)?;
                ("rank", json!(r))
            }
            StatusChange::WipLimit(l) => {
                check_wip(l)?;
                ("wip_limit", json!(l))
            }
        };
        patch.insert(key.into(), value);
    }
    patch.insert("updated_at".into(), json!(b.now));
    b.apply(Change::new(
        Entity::Status,
        id,
        OpKind::Update,
        Value::Object(patch),
    ))
}

fn delete_status(b: &mut Batch<'_, '_>, id: &str) -> Result<()> {
    let status = live_status(b, id)?;
    let n = tasks_in(b, id)?;
    if n > 0 {
        return Err(Error::invalid(format!(
            "'{}' still holds {n} task(s); move them to another column first",
            status.name
        )));
    }
    check_keeps_workflow(b, &status)?;
    b.apply(Change::new(
        Entity::Status,
        id,
        OpKind::Delete,
        json!({ "deleted_at": b.now, "updated_at": b.now }),
    ))
}

fn live_status(b: &Batch<'_, '_>, id: &str) -> Result<Status> {
    let status = query::status(b.tx, id)?;
    if status.deleted_at.is_some() {
        return Err(Error::not_found("status", id));
    }
    Ok(status)
}

// ---------------------------------------------------------------------------------------
// Saved views

/// Checks the version and that the scope and filters name live entities and statuses.
/// Stored as JSON text; the ops log keeps that text, so undo restores it byte for byte.
fn view_spec_json(b: &Batch<'_, '_>, spec: &ViewSpec) -> Result<String> {
    if spec.version != VIEW_SPEC_VERSION {
        return Err(Error::invalid(format!(
            "view spec version {} is not supported (expected {VIEW_SPEC_VERSION})",
            spec.version
        )));
    }
    match &spec.scope {
        ViewScope::Inbox | ViewScope::Today | ViewScope::All => {}
        ViewScope::Project { id } => drop(live_project(b, id)?),
        ViewScope::Epic { id } => drop(live_epic(b, id)?),
        ViewScope::Tag { id } => drop(live_tag(b, id)?),
    }
    let f = &spec.filter;
    for id in &f.status_ids {
        live_status(b, id)?;
    }
    for id in &f.project_ids {
        live_project(b, id)?;
    }
    for id in f.epic_ids.iter().filter(|id| *id != FILTER_NONE) {
        live_epic(b, id)?;
    }
    for id in f.tag_ids.iter().filter(|id| *id != FILTER_NONE) {
        live_tag(b, id)?;
    }
    if let Some(lineage) = &spec.lineage {
        // The Lineage page filters on one project at most, over every task.
        if spec.scope != ViewScope::All || f.project_ids.len() > 1 {
            return Err(Error::invalid("a lineage view covers all tasks and at most one project"));
        }
        if let Some(id) = &lineage.around {
            live_task(b, id)?;
        }
    }
    Ok(serde_json::to_string(spec)?)
}

fn create_view(b: &mut Batch<'_, '_>, n: NewView) -> Result<()> {
    let id = client_id(n.id)?;
    let name = non_empty("name", &n.name)?;
    let spec = view_spec_json(b, &n.spec)?;
    let rank = match n.rank {
        Some(r) => {
            rank::validate(&r)?;
            r
        }
        None => {
            let last: Option<String> = b.tx.query_row(
                "SELECT MAX(rank) FROM views WHERE deleted_at IS NULL",
                [],
                |r| r.get(0),
            )?;
            rank::key_between(last.as_deref(), None)?
        }
    };
    b.apply(Change::new(
        Entity::View,
        &id,
        OpKind::Create,
        json!({
            "name": name,
            "spec": spec,
            "rank": rank,
            "created_at": b.now,
            "updated_at": b.now,
            "deleted_at": null,
        }),
    ))
}

fn update_view(b: &mut Batch<'_, '_>, id: &str, changes: Vec<ViewChange>) -> Result<()> {
    if changes.is_empty() {
        return Err(Error::invalid("update_view needs at least one change"));
    }
    live_view(b, id)?;
    let mut patch = Map::new();
    for change in changes {
        let (key, value) = match change {
            ViewChange::Name(n) => ("name", json!(non_empty("name", &n)?)),
            ViewChange::Spec(spec) => ("spec", json!(view_spec_json(b, &spec)?)),
            ViewChange::Rank(r) => {
                rank::validate(&r)?;
                ("rank", json!(r))
            }
        };
        patch.insert(key.into(), value);
    }
    patch.insert("updated_at".into(), json!(b.now));
    b.apply(Change::new(
        Entity::View,
        id,
        OpKind::Update,
        Value::Object(patch),
    ))
}

fn delete_view(b: &mut Batch<'_, '_>, id: &str) -> Result<()> {
    live_view(b, id)?;
    b.apply(Change::new(
        Entity::View,
        id,
        OpKind::Delete,
        json!({ "deleted_at": b.now, "updated_at": b.now }),
    ))
}

fn live_view(b: &Batch<'_, '_>, id: &str) -> Result<crate::model::View> {
    let view = query::view(b.tx, id)?;
    if view.deleted_at.is_some() {
        return Err(Error::not_found("view", id));
    }
    Ok(view)
}

// ---------------------------------------------------------------------------------------
// Attachments

fn create_attachment(b: &mut Batch<'_, '_>, n: NewAttachment) -> Result<()> {
    let id = client_id(n.id)?;
    live_task(b, &n.task_id)?;
    if !files::is_hash(&n.hash) {
        return Err(Error::invalid(format!("'{}' is not a file hash", n.hash)));
    }
    if !(0..=files::MAX_ATTACHMENT_BYTES).contains(&n.size) {
        return Err(Error::invalid(format!(
            "attachments are limited to {} MB",
            files::MAX_ATTACHMENT_BYTES / 1_048_576
        )));
    }
    let name = files::clean_file_name(&n.name);
    let mime = match n.mime.as_deref().map(str::trim) {
        Some(m) if !m.is_empty() && m.contains('/') && !m.chars().any(char::is_whitespace) => {
            m.to_ascii_lowercase()
        }
        _ => files::mime_for(&name).to_owned(),
    };
    b.apply(Change::new(
        Entity::Attachment,
        &id,
        OpKind::Create,
        json!({
            "task_id": n.task_id,
            "hash": n.hash,
            "name": name,
            "mime": mime,
            "size": n.size,
            "created_at": b.now,
            "updated_at": b.now,
            "deleted_at": null,
        }),
    ))?;
    touch_task(b, &n.task_id)
}

/// Bumps the task's `updated_at`, as tag changes do, so views of it refresh.
fn touch_task(b: &mut Batch<'_, '_>, task_id: &str) -> Result<()> {
    b.apply(Change::new(
        Entity::Task,
        task_id,
        OpKind::Update,
        json!({ "updated_at": b.now }),
    ))
}

fn update_attachment(
    b: &mut Batch<'_, '_>,
    id: &str,
    changes: Vec<AttachmentChange>,
) -> Result<()> {
    if changes.is_empty() {
        return Err(Error::invalid(
            "update_attachment needs at least one change",
        ));
    }
    let task_id = live_attachment(b, id)?.task_id;
    let mut patch = Map::new();
    for change in changes {
        let (key, value) = match change {
            AttachmentChange::Name(n) => (
                "name",
                json!(files::clean_file_name(&non_empty("name", &n)?)),
            ),
        };
        patch.insert(key.into(), value);
    }
    patch.insert("updated_at".into(), json!(b.now));
    b.apply(Change::new(
        Entity::Attachment,
        id,
        OpKind::Update,
        Value::Object(patch),
    ))?;
    touch_task(b, &task_id)
}

fn delete_attachment(b: &mut Batch<'_, '_>, id: &str) -> Result<()> {
    let task_id = live_attachment(b, id)?.task_id;
    b.apply(Change::new(
        Entity::Attachment,
        id,
        OpKind::Delete,
        json!({ "deleted_at": b.now, "updated_at": b.now }),
    ))?;
    touch_task(b, &task_id)
}

fn live_attachment(b: &Batch<'_, '_>, id: &str) -> Result<crate::model::Attachment> {
    let attachment = query::attachment(b.tx, id)?;
    if attachment.deleted_at.is_some() {
        return Err(Error::not_found("attachment", id));
    }
    Ok(attachment)
}

// ---------------------------------------------------------------------------------------
// Time blocks

fn check_block_times(start_at: Timestamp, end_at: Timestamp) -> Result<()> {
    if start_at < 0 {
        return Err(Error::invalid("a time block cannot start before 1970"));
    }
    if end_at <= start_at {
        return Err(Error::invalid("a time block must end after it starts"));
    }
    if end_at - start_at > MAX_BLOCK_MS {
        return Err(Error::invalid("a time block can last at most 24 hours"));
    }
    Ok(())
}

fn create_time_block(b: &mut Batch<'_, '_>, n: NewTimeBlock) -> Result<()> {
    let id = client_id(n.id)?;
    live_task(b, &n.task_id)?;
    check_block_times(n.start_at, n.end_at)?;
    b.apply(Change::new(
        Entity::TimeBlock,
        &id,
        OpKind::Create,
        json!({
            "task_id": n.task_id,
            "start_at": n.start_at,
            "end_at": n.end_at,
            "outcome": n.outcome.unwrap_or_default().as_str(),
            "created_at": b.now,
            "updated_at": b.now,
            "deleted_at": null,
        }),
    ))?;
    touch_task(b, &n.task_id)
}

fn update_time_block(b: &mut Batch<'_, '_>, id: &str, changes: Vec<TimeBlockChange>) -> Result<()> {
    if changes.is_empty() {
        return Err(Error::invalid(
            "update_time_block needs at least one change",
        ));
    }
    let block = live_time_block(b, id)?;
    let (mut start_at, mut end_at) = (block.start_at, block.end_at);
    let mut patch = Map::new();
    for change in changes {
        match change {
            TimeBlockChange::StartAt(t) => {
                start_at = t;
                patch.insert("start_at".into(), json!(t));
            }
            TimeBlockChange::EndAt(t) => {
                end_at = t;
                patch.insert("end_at".into(), json!(t));
            }
            TimeBlockChange::Outcome(o) => {
                patch.insert("outcome".into(), json!(o.as_str()));
            }
        }
    }
    check_block_times(start_at, end_at)?;
    patch.insert("updated_at".into(), json!(b.now));
    b.apply(Change::new(
        Entity::TimeBlock,
        id,
        OpKind::Update,
        Value::Object(patch),
    ))?;
    touch_task(b, &block.task_id)
}

fn delete_time_block(b: &mut Batch<'_, '_>, id: &str) -> Result<()> {
    let task_id = live_time_block(b, id)?.task_id;
    b.apply(Change::new(
        Entity::TimeBlock,
        id,
        OpKind::Delete,
        json!({ "deleted_at": b.now, "updated_at": b.now }),
    ))?;
    touch_task(b, &task_id)
}

fn live_time_block(b: &Batch<'_, '_>, id: &str) -> Result<crate::model::TimeBlock> {
    let block = query::time_block(b.tx, id)?;
    if block.deleted_at.is_some() {
        return Err(Error::not_found("time block", id));
    }
    Ok(block)
}

// ---------------------------------------------------------------------------------------
// Agent sessions (docs/adr/017)

fn create_agent_session(b: &mut Batch<'_, '_>, n: NewAgentSession) -> Result<()> {
    let id = client_id(n.id)?;
    live_task(b, &n.task_id)?;
    check_id(&n.claude_session_id)?;
    let folder = non_empty("folder", &n.folder)?;
    check_permission_mode(&n.permission_mode)?;
    let model = n
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned);
    if model
        .as_deref()
        .is_some_and(|m| m.starts_with('-') || m.contains(char::is_whitespace))
    {
        return Err(Error::invalid("invalid model name"));
    }
    let device_id = b.device_id().to_owned();
    b.apply(Change::new(
        Entity::AgentSession,
        &id,
        OpKind::Create,
        json!({
            "task_id": n.task_id,
            "device_id": device_id,
            "claude_session_id": n.claude_session_id,
            "folder": folder,
            "runtime": n.runtime.as_str(),
            "permission_mode": n.permission_mode,
            "model": model,
            "prompt": n.prompt.trim(),
            "state": SessionState::Running.as_str(),
            "started_at": b.now,
            "ended_at": null,
            "summary": null,
            "cost_usd_micros": null,
            "turns": null,
            "duration_ms": null,
            "error": null,
            "created_at": b.now,
            "updated_at": b.now,
            "deleted_at": null,
        }),
    ))?;
    touch_task(b, &n.task_id)
}

fn check_permission_mode(mode: &str) -> Result<()> {
    if PERMISSION_MODES.contains(&mode) {
        Ok(())
    } else {
        Err(Error::invalid(format!(
            "unknown permission mode '{mode}' (expected one of {})",
            PERMISSION_MODES.join(", ")
        )))
    }
}

fn update_agent_session(
    b: &mut Batch<'_, '_>,
    id: &str,
    changes: Vec<AgentSessionChange>,
) -> Result<()> {
    if changes.is_empty() {
        return Err(Error::invalid(
            "update_agent_session needs at least one change",
        ));
    }
    let session = own_session(b, id)?;
    let mut patch = Map::new();
    let mut ended = false;
    for change in changes {
        let (key, value) = match change {
            AgentSessionChange::State(s) => {
                // `ended_at` is set when a session stops being active (running or in a
                // terminal) and cleared when it becomes active again.
                let active = s.is_active();
                if active != session.state.is_active() {
                    patch.insert(
                        "ended_at".into(),
                        if active { Value::Null } else { json!(b.now) },
                    );
                    ended = !active;
                }
                ("state", json!(s.as_str()))
            }
            AgentSessionChange::Summary(s) => ("summary", json!(trimmed(s))),
            AgentSessionChange::CostUsdMicros(c) => {
                if c.is_some_and(|c| c < 0) {
                    return Err(Error::invalid("cost cannot be negative"));
                }
                ("cost_usd_micros", json!(c))
            }
            AgentSessionChange::Turns(t) => {
                if t.is_some_and(|t| t < 0) {
                    return Err(Error::invalid("turns cannot be negative"));
                }
                ("turns", json!(t))
            }
            AgentSessionChange::DurationMs(d) => {
                if d.is_some_and(|d| d < 0) {
                    return Err(Error::invalid("duration cannot be negative"));
                }
                ("duration_ms", json!(d))
            }
            AgentSessionChange::Error(e) => ("error", json!(trimmed(e))),
        };
        patch.insert(key.into(), value);
    }
    patch.insert("updated_at".into(), json!(b.now));
    b.apply(Change::new(
        Entity::AgentSession,
        id,
        OpKind::Update,
        Value::Object(patch),
    ))?;
    if ended {
        touch_task(b, &session.task_id)?;
    }
    Ok(())
}

fn delete_agent_session(b: &mut Batch<'_, '_>, id: &str) -> Result<()> {
    let session = own_session(b, id)?;
    if session.state.is_active() {
        return Err(Error::invalid(
            "stop the session (or mark it done) before removing it",
        ));
    }
    for note_id in ids(
        b,
        "SELECT id FROM agent_notes WHERE session_id = ?1 AND deleted_at IS NULL",
        id,
    )? {
        b.apply(Change::new(
            Entity::AgentNote,
            &note_id,
            OpKind::Delete,
            json!({ "deleted_at": b.now, "updated_at": b.now }),
        ))?;
    }
    b.apply(Change::new(
        Entity::AgentSession,
        id,
        OpKind::Delete,
        json!({ "deleted_at": b.now, "updated_at": b.now }),
    ))?;
    touch_task(b, &session.task_id)
}

fn add_agent_note(b: &mut Batch<'_, '_>, n: NewAgentNote) -> Result<()> {
    let id = client_id(n.id)?;
    let session = own_session(b, &n.session_id)?;
    live_task(b, &session.task_id)?;
    let body = non_empty("note", &n.body)?;
    if body.chars().count() > MAX_NOTE_CHARS {
        return Err(Error::invalid(format!(
            "a note is limited to {MAX_NOTE_CHARS} characters"
        )));
    }
    b.apply(Change::new(
        Entity::AgentNote,
        &id,
        OpKind::Create,
        json!({
            "session_id": session.id,
            "task_id": session.task_id,
            "body": body,
            "created_at": b.now,
            "updated_at": b.now,
            "deleted_at": null,
        }),
    ))?;
    touch_task(b, &session.task_id)
}

/// A live session started by this device (only its device runs and updates it).
fn own_session(b: &Batch<'_, '_>, id: &str) -> Result<crate::model::AgentSession> {
    let session = query::agent_session(b.tx, id)?;
    if session.deleted_at.is_some() {
        return Err(Error::not_found("agent session", id));
    }
    if session.device_id != b.device_id() {
        return Err(Error::invalid(
            "this session runs on another device; only that device can change it",
        ));
    }
    Ok(session)
}

/// Trims an optional text; blank becomes `None`.
fn trimmed(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

fn client_id(id: Option<Id>) -> Result<Id> {
    match id {
        Some(id) => {
            check_id(&id)?;
            Ok(id)
        }
        None => Ok(new_id()),
    }
}

fn non_empty(field: &str, value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(Error::invalid(format!("{field} cannot be empty")));
    }
    Ok(trimmed.to_owned())
}

fn check_optional_date(field: &str, value: Option<&str>) -> Result<()> {
    value.map_or(Ok(()), |v| check_date(field, v))
}

fn check_estimate(minutes: Option<i64>) -> Result<()> {
    match minutes {
        Some(m) if m < 0 => Err(Error::invalid("estimate cannot be negative")),
        _ => Ok(()),
    }
}

fn live_task(b: &Batch<'_, '_>, id: &str) -> Result<Task> {
    let task = query::task(b.tx, id)?;
    if task.deleted_at.is_some() {
        return Err(Error::not_found("task", id));
    }
    Ok(task)
}

fn live_project(b: &Batch<'_, '_>, id: &str) -> Result<crate::model::Project> {
    let project = query::project(b.tx, id)?;
    if project.deleted_at.is_some() {
        return Err(Error::not_found("project", id));
    }
    Ok(project)
}

fn live_epic(b: &Batch<'_, '_>, id: &str) -> Result<crate::model::Epic> {
    let epic = query::epic(b.tx, id)?;
    if epic.deleted_at.is_some() {
        return Err(Error::not_found("epic", id));
    }
    Ok(epic)
}

fn live_tag(b: &Batch<'_, '_>, id: &str) -> Result<crate::model::Tag> {
    let tag = query::tag(b.tx, id)?;
    if tag.deleted_at.is_some() {
        return Err(Error::not_found("tag", id));
    }
    Ok(tag)
}

fn default_status(b: &Batch<'_, '_>) -> Result<crate::model::Status> {
    let id: String = b.tx.query_row(
        "SELECT id FROM statuses WHERE deleted_at IS NULL
         ORDER BY category != 'todo', rank LIMIT 1",
        [],
        |r| r.get(0),
    )?;
    query::status(b.tx, &id)
}

fn last_task_rank(b: &Batch<'_, '_>, status_id: &str) -> Result<Option<String>> {
    Ok(b.tx.query_row(
        "SELECT MAX(rank) FROM tasks WHERE status_id = ?1 AND deleted_at IS NULL",
        [status_id],
        |r| r.get(0),
    )?)
}

/// Ids of all live subtasks, at any depth.
fn descendants(b: &Batch<'_, '_>, id: &str) -> Result<Vec<Id>> {
    ids(
        b,
        "WITH RECURSIVE sub(id) AS (
           SELECT id FROM tasks WHERE parent_id = ?1 AND deleted_at IS NULL
           UNION
           SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id WHERE t.deleted_at IS NULL
         )
         SELECT id FROM sub",
        id,
    )
}

fn ids(b: &Batch<'_, '_>, sql: &str, param: &str) -> Result<Vec<Id>> {
    let mut stmt = b.tx.prepare_cached(sql)?;
    let rows = stmt.query_map([param], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn count(b: &Batch<'_, '_>, sql: &str, param: &str) -> Result<i64> {
    Ok(b.tx.query_row(sql, [param], |r| r.get(0))?)
}

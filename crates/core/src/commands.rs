//! Commands: the only way to change data. Each one validates against the current state and
//! compiles to row [`Change`]s applied through the op engine, inside the caller's batch.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::clock::{check_date, check_id, new_id};
use crate::error::{Error, Result};
use crate::model::{EpicState, Id, IsoDate, Priority, StatusCategory, Task};
use crate::ops::{Batch, Change, Entity, OpKind};
use crate::{query, rank};

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
}

/// Fields for a new task. Only `title` is required; the rest have defaults.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(default)]
pub struct NewTask {
    /// Client-generated UUID (for optimistic UIs); generated when absent.
    pub id: Option<Id>,
    pub title: String,
    pub description: String,
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
    pub project_id: Option<Id>,
    pub description: Option<String>,
    pub target_date: Option<IsoDate>,
    pub rank: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum EpicChange {
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
        Some(s) => query::status(b.tx, s)?,
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
                let new = query::status(b.tx, &s)?;
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
    b.apply(Change::new(
        Entity::Task,
        id,
        OpKind::Update,
        Value::Object(patch),
    ))?;
    cascade_containers(b, &task, new_project.as_ref(), new_epic.as_ref())
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
        "SELECT id FROM statuses ORDER BY category != 'todo', rank LIMIT 1",
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

//! Edits. Each call is one batch in the core, so one undo takes all of it back, and it
//! syncs like any edit made on a desktop.

use taskmaster_core::rank::key_between;
use taskmaster_core::{Command, NewTag, NewTask, TaskChange};

use crate::{AppError, AppResult, Core, Day, Priority, lock, not_found};

/// One field of a task to change.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum TaskEdit {
    Title {
        value: String,
    },
    /// Markdown.
    Description {
        value: String,
    },
    Priority {
        value: Priority,
    },
    /// `YYYY-MM-DD`, or none to clear it.
    DueDate {
        value: Option<String>,
    },
    /// Pick it for today (the `Day` given), or take it off today.
    Today {
        on: bool,
    },
    Estimate {
        minutes: Option<i64>,
    },
    Project {
        id: Option<String>,
    },
    Epic {
        id: Option<String>,
    },
    /// Any status; use `set_done` to just tick it.
    Status {
        id: String,
    },
}

/// A task made from a form (capture parses one line instead).
#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct NewTaskInput {
    pub title: String,
    pub description: String,
    /// Makes it a subtask; it takes the parent's project and epic unless given.
    pub parent_id: Option<String>,
    pub project_id: Option<String>,
    pub epic_id: Option<String>,
    pub status_id: Option<String>,
    pub priority: Option<Priority>,
    pub due_date: Option<String>,
    pub today: bool,
    pub tag_ids: Vec<String>,
}

/// Where a task goes in a list or a board column: between two neighbours (either may be
/// missing at an end), and into a status when it changes column.
#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct Placement {
    pub status_id: Option<String>,
    /// The task it lands after (above it on screen).
    pub after_id: Option<String>,
    /// The task it lands before (below it on screen).
    pub before_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct UndoState {
    pub can_undo: bool,
    pub can_redo: bool,
}

fn invalid(message: &str) -> AppError {
    AppError::Invalid {
        message: message.into(),
    }
}

#[uniffi::export]
impl Core {
    /// Changes fields of a task, all in one edit.
    pub fn edit_task(&self, task_id: String, edits: Vec<TaskEdit>, day: Day) -> AppResult<()> {
        if edits.is_empty() {
            return Ok(());
        }
        let changes = edits
            .into_iter()
            .map(|edit| match edit {
                TaskEdit::Title { value } => {
                    if value.trim().is_empty() {
                        return Err(invalid("a task needs a title"));
                    }
                    Ok(TaskChange::Title(value.trim().to_owned()))
                }
                TaskEdit::Description { value } => Ok(TaskChange::Description(value)),
                TaskEdit::Priority { value } => Ok(TaskChange::Priority(value.into())),
                TaskEdit::DueDate { value } => Ok(TaskChange::DueDate(value)),
                TaskEdit::Today { on } => Ok(TaskChange::TodayOn(on.then(|| day.today.clone()))),
                TaskEdit::Estimate { minutes } => Ok(TaskChange::EstimateMin(minutes)),
                TaskEdit::Project { id } => Ok(TaskChange::ProjectId(id)),
                TaskEdit::Epic { id } => Ok(TaskChange::EpicId(id)),
                TaskEdit::Status { id } => Ok(TaskChange::StatusId(id)),
            })
            .collect::<AppResult<Vec<_>>>()?;
        lock(&self.inner.store).execute(Command::UpdateTask {
            id: task_id,
            changes,
        })?;
        Ok(())
    }

    /// Gives a task exactly these tags (adds and removes the difference, as one edit).
    pub fn set_tags(&self, task_id: String, tag_ids: Vec<String>) -> AppResult<()> {
        let mut store = lock(&self.inner.store);
        let current = store
            .snapshot()?
            .tasks
            .into_iter()
            .find(|t| t.id == task_id)
            .ok_or_else(|| not_found("task"))?
            .tag_ids;
        let mut commands: Vec<Command> = current
            .iter()
            .filter(|id| !tag_ids.contains(id))
            .map(|id| Command::UntagTask {
                task_id: task_id.clone(),
                tag_id: id.clone(),
            })
            .collect();
        commands.extend(tag_ids.iter().filter(|id| !current.contains(id)).map(|id| {
            Command::TagTask {
                task_id: task_id.clone(),
                tag_id: id.clone(),
            }
        }));
        if !commands.is_empty() {
            store.execute_all(commands)?;
        }
        Ok(())
    }

    /// Makes a tag, or returns the one already named so (case does not matter).
    pub fn create_tag(&self, name: String) -> AppResult<String> {
        let name = name.trim().trim_start_matches('#').trim().to_owned();
        if name.is_empty() {
            return Err(invalid("a tag needs a name"));
        }
        let mut store = lock(&self.inner.store);
        if let Some(tag) = store
            .snapshot()?
            .tags
            .into_iter()
            .find(|t| t.name.eq_ignore_ascii_case(&name))
        {
            return Ok(tag.id);
        }
        let id = taskmaster_core::new_id();
        store.execute(Command::CreateTag {
            tag: NewTag {
                id: Some(id.clone()),
                name,
                color: None,
            },
        })?;
        Ok(id)
    }

    /// Adds a task (or a subtask) from a form. Returns its id.
    pub fn add_task(&self, input: NewTaskInput, day: Day) -> AppResult<String> {
        let title = input.title.trim().to_owned();
        if title.is_empty() {
            return Err(invalid("type what needs doing"));
        }
        let mut store = lock(&self.inner.store);
        let (mut project_id, mut epic_id) = (input.project_id, input.epic_id);
        if let Some(parent_id) = &input.parent_id {
            let parent = store
                .snapshot()?
                .tasks
                .into_iter()
                .find(|t| &t.id == parent_id)
                .ok_or_else(|| not_found("task"))?;
            project_id = project_id.or(parent.project_id);
            epic_id = epic_id.or(parent.epic_id);
        }
        let id = taskmaster_core::new_id();
        store.execute(Command::CreateTask {
            task: NewTask {
                id: Some(id.clone()),
                title,
                description: input.description,
                parent_id: input.parent_id,
                project_id,
                epic_id,
                status_id: input.status_id,
                priority: input.priority.map(Into::into).unwrap_or_default(),
                due_date: input.due_date,
                today_on: input.today.then_some(day.today),
                tag_ids: input.tag_ids,
                ..NewTask::default()
            },
        })?;
        Ok(id)
    }

    /// Moves a task between two neighbours, and into another status when given (a drag
    /// in a list or between board columns).
    pub fn move_task(&self, task_id: String, placement: Placement) -> AppResult<()> {
        let mut store = lock(&self.inner.store);
        let s = store.snapshot()?;
        let task = s
            .tasks
            .iter()
            .find(|t| t.id == task_id)
            .ok_or_else(|| not_found("task"))?;
        let rank_of = |id: &Option<String>| -> AppResult<Option<String>> {
            id.as_deref()
                .map(|id| {
                    s.tasks
                        .iter()
                        .find(|t| t.id == id)
                        .map(|t| t.rank.clone())
                        .ok_or_else(|| not_found("task"))
                })
                .transpose()
        };
        let (after, before) = (
            rank_of(&placement.after_id)?,
            rank_of(&placement.before_id)?,
        );
        // Neighbours given the wrong way round still land the task between them.
        let (low, high) = match (&after, &before) {
            (Some(a), Some(b)) if a > b => (before.as_deref(), after.as_deref()),
            _ => (after.as_deref(), before.as_deref()),
        };
        let rank = key_between(low, high)?;
        let command = match placement.status_id {
            Some(status_id) if status_id != task.status_id => Command::MoveTask {
                id: task_id,
                status_id,
                rank,
            },
            _ => Command::UpdateTask {
                id: task_id,
                changes: vec![TaskChange::Rank(rank)],
            },
        };
        store.execute(command)?;
        Ok(())
    }

    /// Makes a task a subtask of another, or a top-level task again (no parent).
    pub fn set_parent(&self, task_id: String, parent_id: Option<String>) -> AppResult<()> {
        lock(&self.inner.store).execute(Command::SetParent {
            id: task_id,
            parent_id,
        })?;
        Ok(())
    }

    /// Deletes a task (and its subtasks); undo brings them back.
    pub fn delete_task(&self, task_id: String) -> AppResult<()> {
        lock(&self.inner.store).execute(Command::DeleteTask { id: task_id })?;
        Ok(())
    }

    /// Makes again the last edit undone on this phone. False when there is none.
    pub fn redo(&self) -> AppResult<bool> {
        Ok(lock(&self.inner.store).redo()?.is_some())
    }

    /// Whether undo and redo have something to do (for the buttons and shake to undo).
    pub fn undo_state(&self) -> UndoState {
        let store = lock(&self.inner.store);
        UndoState {
            can_undo: store.can_undo(),
            can_redo: store.can_redo(),
        }
    }
}

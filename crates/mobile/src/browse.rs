//! Reading: the navigation, boards, one task in full, its history, and search. Every
//! answer is ready to draw; Swift does not filter, count or sort.

use taskmaster_core::{EpicState, Layout, Task, ViewScope};

use crate::team::Data;
use crate::{
    AppResult, Core, Day, ListRow, Scope, Stage, TaskRow, is_mine_open, not_found, spec_for,
    stage_of, task_row, view_options,
};

/// Open tasks in the fixed lists, for badges.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Counts {
    pub inbox: u32,
    pub today: u32,
    /// Open tasks due before today.
    pub overdue: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EpicStage {
    Active,
    Done,
    Dropped,
}

impl From<EpicState> for EpicStage {
    fn from(s: EpicState) -> Self {
        match s {
            EpicState::Active => Self::Active,
            EpicState::Done => Self::Done,
            EpicState::Dropped => Self::Dropped,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EpicItem {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub state: EpicStage,
    pub target_date: Option<String>,
    /// The user's open tasks in the epic.
    pub open: u32,
    /// Done tasks in the epic (for progress).
    pub done: u32,
    /// An epic of the team space.
    pub team: bool,
}

/// A project in the navigation, in tree order: a parent comes right before its children.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ProjectItem {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub parent_id: Option<String>,
    /// 0 for a top-level project (an area), 1 for its children, and so on.
    pub depth: u32,
    /// The user's open tasks directly in this project.
    pub open: u32,
    /// Its epics, in their order. Done and dropped ones come last.
    pub epics: Vec<EpicItem>,
    /// A project of the team space: its tasks, epics and tags are the team's.
    pub team: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TagItem {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub open: u32,
    /// A team tag: it goes on team tasks only (and a personal tag on personal ones).
    pub team: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ViewLayout {
    List,
    Board,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SavedView {
    pub id: String,
    pub name: String,
    /// How the desktop shows it; the phone can show either as a list.
    pub layout: ViewLayout,
}

/// A status, in board order.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StatusItem {
    pub id: String,
    pub name: String,
    pub stage: Stage,
    pub color: Option<String>,
    pub wip_limit: Option<i64>,
}

/// A member of the team, for the assignee picker.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MemberItem {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    /// The member this phone writes as.
    pub me: bool,
}

/// The team space, when this phone's token belongs to a member (ADR 033).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TeamNav {
    pub name: String,
    /// By name.
    pub members: Vec<MemberItem>,
    /// The team's workflow, in board order: a team task's status picker.
    pub statuses: Vec<StatusItem>,
}

/// Everything the navigation and the pickers (project, epic, tag, status) list.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Navigation {
    pub counts: Counts,
    /// Live, unarchived projects in tree order, personal ones first, then the team's
    /// (`team` set; a team project is never under a personal one).
    pub projects: Vec<ProjectItem>,
    /// Epics that belong to no project.
    pub loose_epics: Vec<EpicItem>,
    pub tags: Vec<TagItem>,
    pub views: Vec<SavedView>,
    /// The personal workflow, in board order.
    pub statuses: Vec<StatusItem>,
    pub team: Option<TeamNav>,
}

/// One board column: a status and its cards (all swimlanes merged, in order).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BoardColumn {
    pub status: StatusItem,
    pub count: u32,
    /// More cards than the status's work-in-progress limit.
    pub over_limit: bool,
    pub cards: Vec<TaskRow>,
}

/// Another task, named in a detail (parent, blocked by).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskRef {
    pub id: String,
    pub title: String,
    pub stage: Stage,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AttachmentItem {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
    /// The content is on this phone; otherwise `fetch_attachment` downloads it.
    pub on_device: bool,
}

/// A task in full, for its detail screen.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskDetail {
    /// The fields a row shows (title, stage, priority, dates, project, progress).
    pub row: TaskRow,
    /// Markdown.
    pub description: String,
    pub status_id: String,
    pub project_id: Option<String>,
    pub epic_id: Option<String>,
    pub epic_name: Option<String>,
    pub parent: Option<TaskRef>,
    /// The day it was picked for (`today` on the row says whether that is today).
    pub today_on: Option<String>,
    pub estimate_min: Option<i64>,
    pub tags: Vec<TagItem>,
    /// Direct subtasks, in order, done ones included.
    pub subtasks: Vec<TaskRow>,
    /// Tasks that must be done first.
    pub blocked_by: Vec<TaskRef>,
    pub attachments: Vec<AttachmentItem>,
    /// Its time blocks, by start.
    pub blocks: Vec<crate::BlockItem>,
    /// Created by an agent (shown on the desktop's Agents page).
    pub by_agent: bool,
    /// The team member it is assigned to (team tasks only; `row.assignee` is the name).
    pub assignee_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FieldEdit {
    pub field: String,
    pub before: String,
    pub after: String,
}

/// One recorded change to a task, newest first in a feed.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ActivityItem {
    pub at: i64,
    /// `create`, `update`, `delete`, `link` (tag added), `attach`, `schedule`… (see the
    /// core's `Activity`).
    pub kind: String,
    pub fields: Vec<FieldEdit>,
}

fn status_item(s: &taskmaster_core::Status) -> StatusItem {
    StatusItem {
        id: s.id.clone(),
        name: s.name.clone(),
        stage: s.category.into(),
        color: s.color.clone(),
        wip_limit: s.wip_limit,
    }
}

pub(crate) fn task_ref(task: &Task, s: &Data) -> TaskRef {
    TaskRef {
        id: task.id.clone(),
        title: task.title.clone(),
        stage: stage_of(task, s),
    }
}

fn by_rank<T>(mut items: Vec<&T>, rank: impl Fn(&T) -> &str) -> Vec<&T> {
    items.sort_by(|a, b| rank(a).cmp(rank(b)));
    items
}

fn epic_item(epic: &taskmaster_core::Epic, s: &Data) -> EpicItem {
    let tasks = s
        .tasks
        .iter()
        .filter(|t| t.epic_id.as_deref() == Some(&*epic.id));
    let (mut open, mut done) = (0, 0);
    for task in tasks {
        if is_mine_open(task, s) {
            open += 1;
        } else if stage_of(task, s) == Stage::Done {
            done += 1;
        }
    }
    EpicItem {
        id: epic.id.clone(),
        name: epic.name.clone(),
        color: epic.color.clone(),
        state: epic.state.into(),
        target_date: epic.target_date.clone(),
        open,
        done,
        team: s.is_team(&epic.id),
    }
}

fn epics_of(project_id: Option<&str>, s: &Data) -> Vec<EpicItem> {
    let mut epics = by_rank(
        s.epics
            .iter()
            .filter(|e| e.project_id.as_deref() == project_id)
            .collect(),
        |e| &e.rank,
    );
    // Active first, each kind keeping its order.
    epics.sort_by_key(|e| e.state != EpicState::Active);
    epics.into_iter().map(|e| epic_item(e, s)).collect()
}

fn push_projects(parent: Option<&str>, depth: u32, s: &Data, out: &mut Vec<ProjectItem>) {
    let mut children = by_rank(
        s.projects
            .iter()
            .filter(|p| p.parent_id.as_deref() == parent && p.archived_at.is_none())
            .collect(),
        |p| &p.rank,
    );
    // Personal projects first, then the team's, each keeping its order.
    children.sort_by_key(|p| s.is_team(&p.id));
    for project in children {
        out.push(ProjectItem {
            id: project.id.clone(),
            name: project.name.clone(),
            color: project.color.clone(),
            icon: project.icon.clone(),
            parent_id: project.parent_id.clone(),
            depth,
            open: s
                .tasks
                .iter()
                .filter(|t| t.project_id.as_deref() == Some(&*project.id) && is_mine_open(t, s))
                .count() as u32,
            epics: epics_of(Some(&project.id), s),
            team: s.is_team(&project.id),
        });
        // Depth is bounded by the tree the core accepts (it refuses cycles).
        push_projects(Some(&project.id), depth + 1, s, out);
    }
}

/// Top-level open tasks a fixed list shows.
fn count(core: &Core, scope: Scope, day: &Day) -> AppResult<u32> {
    Ok(core
        .list(scope, day.clone())?
        .iter()
        .filter(|row| {
            matches!(row, ListRow::Task { task } if task.depth == 0
                && !matches!(task.stage, Stage::Done | Stage::Cancelled))
        })
        .count() as u32)
}

fn row_of(task: &Task, s: &Data, today: &str) -> TaskRow {
    let children: Vec<&Task> = s
        .tasks
        .iter()
        .filter(|c| c.parent_id.as_deref() == Some(&*task.id))
        .collect();
    let done = children
        .iter()
        .filter(|c| stage_of(c, s) == Stage::Done)
        .count() as u32;
    task_row(task, 0, children.len() as u32, done, s, today)
}

#[uniffi::export]
impl Core {
    /// The navigation: list counts, projects with their epics, tags, saved views and
    /// statuses.
    pub fn navigation(&self, day: Day) -> AppResult<Navigation> {
        let counts = Counts {
            inbox: count(self, Scope::Inbox, &day)?,
            today: count(self, Scope::Today, &day)?,
            overdue: 0,
        };
        let s = self.inner.data()?;
        let overdue = s
            .tasks
            .iter()
            .filter(|t| {
                t.due_date
                    .as_deref()
                    .is_some_and(|d| d < day.today.as_str())
            })
            .filter(|t| is_mine_open(t, &s))
            .count() as u32;
        let mut projects = Vec::new();
        push_projects(None, 0, &s, &mut projects);
        let tags = {
            let mut tags: Vec<_> = s.tags.iter().collect();
            tags.sort_by_key(|t| t.name.to_lowercase());
            tags.into_iter()
                .map(|tag| TagItem {
                    id: tag.id.clone(),
                    name: tag.name.clone(),
                    color: tag.color.clone(),
                    open: s
                        .tasks
                        .iter()
                        .filter(|t| t.tag_ids.contains(&tag.id) && is_mine_open(t, &s))
                        .count() as u32,
                    team: s.is_team(&tag.id),
                })
                .collect()
        };
        let views = by_rank(s.views.iter().collect(), |v| &v.rank)
            .into_iter()
            .map(|v| SavedView {
                id: v.id.clone(),
                name: v.name.clone(),
                layout: match v.spec.layout {
                    Layout::List => ViewLayout::List,
                    Layout::Board => ViewLayout::Board,
                },
            })
            .collect();
        let statuses = by_rank(s.personal_statuses(), |st| &st.rank)
            .into_iter()
            .map(status_item)
            .collect();
        let team = s.team.as_ref().map(|info| {
            let mut members: Vec<_> = s.members.iter().collect();
            members.sort_by_key(|m| m.name.to_lowercase());
            TeamNav {
                name: info.name.clone(),
                members: members
                    .into_iter()
                    .map(|m| MemberItem {
                        id: m.id.clone(),
                        name: m.name.clone(),
                        color: m.color.clone(),
                        me: s.me() == Some(m.id.as_str()),
                    })
                    .collect(),
                statuses: by_rank(s.team_statuses.iter().collect(), |st| &st.rank)
                    .into_iter()
                    .map(status_item)
                    .collect(),
            }
        });
        Ok(Navigation {
            counts: Counts { overdue, ..counts },
            projects,
            loose_epics: epics_of(None, &s),
            tags,
            views,
            statuses,
            team,
        })
    }

    /// The scope as a board: one column per status, its cards in order.
    pub fn board(&self, scope: Scope, day: Day) -> AppResult<Vec<BoardColumn>> {
        let s = self.inner.data()?;
        let spec = spec_for(scope, &s)?;
        // A team project's (or epic's) board has the team's columns; any other board the
        // personal workflow's.
        let team_board = match &spec.scope {
            ViewScope::Project { id } | ViewScope::Epic { id } => s.is_team(id),
            _ => false,
        };
        let mut columns = s.snapshot.clone();
        columns.statuses = if team_board {
            s.team_statuses.clone()
        } else {
            s.personal_statuses().into_iter().cloned().collect()
        };
        let board = taskmaster_core::views::board(&columns, &spec, &view_options(&day, &s));
        Ok(board
            .columns
            .iter()
            .enumerate()
            .map(|(i, column)| BoardColumn {
                status: status_item(&column.status),
                count: column.count,
                over_limit: column.over_limit,
                cards: board
                    .lanes
                    .iter()
                    .filter_map(|lane| lane.cells.get(i))
                    .flatten()
                    .map(|card| {
                        task_row(
                            &card.task,
                            0,
                            card.child_count,
                            card.child_done,
                            &s,
                            &day.today,
                        )
                    })
                    .collect(),
            })
            .collect())
    }

    /// One task with everything its detail screen shows.
    pub fn task(&self, id: String, day: Day) -> AppResult<TaskDetail> {
        let s = self.inner.data()?;
        let task = s
            .tasks
            .iter()
            .find(|t| t.id == id)
            .ok_or_else(|| not_found("task"))?;
        let find = |id: &str| s.tasks.iter().find(|t| t.id == id);
        let team = s.is_team(&task.id);
        let files = self.inner.files(team);
        let subtasks = by_rank(
            s.tasks
                .iter()
                .filter(|t| t.parent_id.as_deref() == Some(&*task.id))
                .collect(),
            |t| &t.rank,
        );
        Ok(TaskDetail {
            row: row_of(task, &s, &day.today),
            description: task.description.clone(),
            status_id: task.status_id.clone(),
            project_id: task.project_id.clone(),
            epic_id: task.epic_id.clone(),
            epic_name: task
                .epic_id
                .as_deref()
                .and_then(|id| s.epics.iter().find(|e| e.id == id))
                .map(|e| e.name.clone()),
            parent: task
                .parent_id
                .as_deref()
                .and_then(find)
                .map(|p| task_ref(p, &s)),
            today_on: task.today_on.clone(),
            estimate_min: task.estimate_min,
            tags: task
                .tag_ids
                .iter()
                .filter_map(|id| s.tags.iter().find(|t| &t.id == id))
                .map(|tag| TagItem {
                    id: tag.id.clone(),
                    name: tag.name.clone(),
                    color: tag.color.clone(),
                    open: 0,
                    team: s.is_team(&tag.id),
                })
                .collect(),
            subtasks: subtasks
                .into_iter()
                .map(|t| row_of(t, &s, &day.today))
                .collect(),
            blocked_by: task
                .dependency_ids
                .iter()
                .filter_map(|id| find(id))
                .map(|t| task_ref(t, &s))
                .collect(),
            attachments: s
                .attachments
                .iter()
                .filter(|a| a.task_id.as_deref() == Some(&*task.id))
                .map(|a| AttachmentItem {
                    id: a.id.clone(),
                    name: a.name.clone(),
                    mime: a.mime.clone(),
                    size: a.size,
                    on_device: files.as_ref().is_some_and(|f| f.contains(&a.hash)),
                })
                .collect(),
            blocks: s
                .time_blocks
                .iter()
                .filter(|b| b.task_id == task.id)
                .map(|b| crate::plan::block_item(b, &s))
                .collect(),
            by_agent: task.owner == taskmaster_core::TaskOwner::Agent,
            assignee_id: task.assignee_id.clone(),
            created_at: task.created_at,
            updated_at: task.updated_at,
            completed_at: task.completed_at,
        })
    }

    /// A task's recorded changes, newest first.
    pub fn activity(&self, task_id: String, limit: u32) -> AppResult<Vec<ActivityItem>> {
        Ok(self
            .inner
            .with_spaces(|s| Ok(s.task_activity(&task_id, limit)?))?
            .into_iter()
            .map(|a| ActivityItem {
                at: a.at,
                kind: a.kind,
                fields: a
                    .fields
                    .into_iter()
                    .map(|f| FieldEdit {
                        field: f.field,
                        before: f.before,
                        after: f.after,
                    })
                    .collect(),
            })
            .collect())
    }

    /// Tasks matching every word (prefix match on title and description), best first.
    pub fn search(&self, text: String, day: Day) -> AppResult<Vec<TaskRow>> {
        let ids = self.inner.with_spaces(|s| Ok(s.search(&text, 50)?))?;
        let s = self.inner.data()?;
        Ok(ids
            .iter()
            .filter_map(|id| s.tasks.iter().find(|t| &t.id == id))
            .map(|t| row_of(t, &s, &day.today))
            .collect())
    }
}

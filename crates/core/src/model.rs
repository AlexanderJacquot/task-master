//! Domain types shared by every adapter. With the `specta` feature they are exported to
//! TypeScript through the desktop shell's generated bindings.

use serde::{Deserialize, Serialize};

/// UUIDv7 string.
pub type Id = String;
/// Unix milliseconds, UTC.
pub type Timestamp = i64;
/// Calendar date, `YYYY-MM-DD`.
pub type IsoDate = String;

/// Four levels; stored as 0 (urgent) to 3 (low).
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    Urgent,
    High,
    #[default]
    Normal,
    Low,
}

impl Priority {
    pub fn to_db(self) -> i64 {
        match self {
            Self::Urgent => 0,
            Self::High => 1,
            Self::Normal => 2,
            Self::Low => 3,
        }
    }

    pub fn from_db(value: i64) -> Option<Self> {
        Some(match value {
            0 => Self::Urgent,
            1 => Self::High,
            2 => Self::Normal,
            3 => Self::Low,
            _ => return None,
        })
    }
}

/// Drives behavior regardless of the status names a user picks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum StatusCategory {
    Backlog,
    Todo,
    InProgress,
    Done,
    Cancelled,
}

impl StatusCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Backlog => "backlog",
            Self::Todo => "todo",
            Self::InProgress => "in_progress",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "backlog" => Self::Backlog,
            "todo" => Self::Todo,
            "in_progress" => Self::InProgress,
            "done" => Self::Done,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum EpicState {
    #[default]
    Active,
    Done,
    Dropped,
}

impl EpicState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Done => "done",
            Self::Dropped => "dropped",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "active" => Self::Active,
            "done" => Self::Done,
            "dropped" => Self::Dropped,
            _ => return None,
        })
    }
}

/// A unit of work. A task with `parent_id` set is a subtask.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Task {
    pub id: Id,
    /// `None` means the task is in the Inbox.
    pub project_id: Option<Id>,
    pub epic_id: Option<Id>,
    pub parent_id: Option<Id>,
    pub status_id: Id,
    pub title: String,
    /// Markdown.
    pub description: String,
    pub priority: Priority,
    pub due_date: Option<IsoDate>,
    /// Picked for that day's Today view.
    pub today_on: Option<IsoDate>,
    pub estimate_min: Option<i64>,
    pub rank: String,
    /// Sorted.
    pub tag_ids: Vec<Id>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub completed_at: Option<Timestamp>,
    pub deleted_at: Option<Timestamp>,
}

/// Where work lives. One level of nesting: areas contain projects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Project {
    pub id: Id,
    pub parent_id: Option<Id>,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub rank: String,
    pub archived_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

/// An outcome that groups tasks, possibly across projects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Epic {
    pub id: Id,
    /// Optional home project.
    pub project_id: Option<Id>,
    pub name: String,
    pub description: Option<String>,
    pub target_date: Option<IsoDate>,
    pub state: EpicState,
    pub rank: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

/// A workflow column.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Status {
    pub id: Id,
    pub name: String,
    pub category: StatusCategory,
    pub color: Option<String>,
    pub rank: String,
    pub wip_limit: Option<i64>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Tag {
    pub id: Id,
    /// Stored without a leading `#`.
    pub name: String,
    pub color: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

/// A file attached to a task. The content is stored by hash outside the database (see
/// [`crate::FileStore`]); several rows may share one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Attachment {
    pub id: Id,
    pub task_id: Id,
    /// SHA-256 of the content, lowercase hex.
    pub hash: String,
    /// File name, without any folder.
    pub name: String,
    pub mime: String,
    /// Bytes.
    pub size: i64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

/// What became of a [`TimeBlock`]. Logged time is the sum of `done` and `worked` blocks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum BlockOutcome {
    #[default]
    Planned,
    /// The task was finished in this block.
    Done,
    /// Time spent on the task without finishing it.
    Worked,
    Cancelled,
}

impl BlockOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Done => "done",
            Self::Worked => "worked",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "planned" => Self::Planned,
            "done" => Self::Done,
            "worked" => Self::Worked,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }
}

/// A task placed on the calendar, from `start_at` to `end_at`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TimeBlock {
    pub id: Id,
    pub task_id: Id,
    pub start_at: Timestamp,
    /// After `start_at`.
    pub end_at: Timestamp,
    pub outcome: BlockOutcome,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

/// A saved board or list: a name plus a [`ViewSpec`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct View {
    pub id: Id,
    pub name: String,
    pub spec: ViewSpec,
    pub rank: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

/// Current [`ViewSpec::version`]. Bump it (and migrate stored specs) on a breaking change.
pub const VIEW_SPEC_VERSION: u32 = 1;

/// What a view shows and how. Stored as JSON in `views.spec`; every field but `scope`
/// has a default, so older specs keep loading when fields are added.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ViewSpec {
    pub version: u32,
    pub scope: ViewScope,
    #[serde(default)]
    pub filter: ViewFilter,
    #[serde(default)]
    pub group_by: GroupBy,
    #[serde(default)]
    pub sort: SortBy,
    #[serde(default)]
    pub layout: Layout,
    #[serde(default)]
    pub swimlane: Swimlane,
    #[serde(default)]
    pub show_subtasks: bool,
    #[serde(default)]
    pub show_cancelled: bool,
}

/// The base set of tasks, the same keys as the built-in routes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ViewScope {
    Inbox,
    Today,
    All,
    Project { id: Id },
    Epic { id: Id },
    Tag { id: Id },
}

/// Narrows the scope. Empty lists match everything; a task must match every non-empty
/// list (any value within a list).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ViewFilter {
    #[serde(default)]
    pub status_ids: Vec<Id>,
    #[serde(default)]
    pub priorities: Vec<Priority>,
    #[serde(default)]
    pub project_ids: Vec<Id>,
    #[serde(default)]
    pub epic_ids: Vec<Id>,
    /// Tasks carrying any of these tags.
    #[serde(default)]
    pub tag_ids: Vec<Id>,
    #[serde(default)]
    pub due: Option<DueFilter>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum DueFilter {
    /// Before today and still open.
    Overdue,
    /// Today or earlier.
    Today,
    /// Within the next 7 days, or earlier.
    Week,
    /// No due date.
    None,
}

/// List grouping (the board always has status columns).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum GroupBy {
    #[default]
    Status,
    Project,
    Epic,
    Priority,
    Due,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum SortBy {
    /// Today, overdue, priority, due date, then manual rank.
    #[default]
    Default,
    Manual,
    Due,
    Priority,
    Created,
    Updated,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum Layout {
    #[default]
    List,
    Board,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum Swimlane {
    #[default]
    None,
    Project,
    Epic,
    Priority,
}

/// Every live (non-deleted) entity, used to hydrate a front end.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Snapshot {
    pub tasks: Vec<Task>,
    pub projects: Vec<Project>,
    pub epics: Vec<Epic>,
    pub statuses: Vec<Status>,
    pub tags: Vec<Tag>,
    pub views: Vec<View>,
    /// Attachments of live tasks.
    pub attachments: Vec<Attachment>,
    /// Time blocks of live tasks, by start.
    pub time_blocks: Vec<TimeBlock>,
}

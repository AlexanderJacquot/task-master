//! Domain types shared by every adapter. With the `specta` feature they are exported to
//! TypeScript through the desktop shell's generated bindings.

use std::collections::BTreeMap;

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

/// The baseline Review status (migration 0011): where a task goes when an agent reports it
/// done, for the user to check.
pub const REVIEW_STATUS_ID: &str = "00000000-0000-7000-8000-000000000007";

/// The workflow's Review status: the seeded one, else a live status named "Review" (a
/// workflow that had one before the seed). `None` when the user removed it.
pub fn review_status(statuses: &[Status]) -> Option<&Status> {
    let live = || statuses.iter().filter(|s| s.deleted_at.is_none());
    live()
        .find(|s| s.id == REVIEW_STATUS_ID)
        .or_else(|| live().find(|s| s.name.trim().eq_ignore_ascii_case("review")))
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

/// Who a task is for. Agent tasks are an agent's own bookkeeping (docs/adr/017): hidden
/// from the user's views by default, adopted by setting the owner back to `me`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TaskOwner {
    #[default]
    Me,
    Agent,
}

impl TaskOwner {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Me => "me",
            Self::Agent => "agent",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "me" => Self::Me,
            "agent" => Self::Agent,
            _ => return None,
        })
    }
}

/// A unit of work. A task with `parent_id` set is a subtask.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Task {
    /// Prerequisites of this task, independent of subtask hierarchy.
    #[serde(default)]
    pub dependency_ids: Vec<Id>,
    pub id: Id,
    #[serde(default)]
    pub owner: TaskOwner,
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
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
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

/// How a device runs Claude Code.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntime {
    /// Directly on this operating system (macOS, Linux, or a Windows install).
    #[default]
    Native,
    /// Inside a WSL distribution, from the Windows app. Folders are WSL paths.
    Wsl,
}

impl AgentRuntime {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Wsl => "wsl",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "native" => Self::Native,
            "wsl" => Self::Wsl,
            _ => return None,
        })
    }
}

/// Where an [`AgentSession`] is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    #[default]
    Running,
    /// The run ended normally (Claude finished its turn).
    Done,
    Failed,
    /// Stopped by the user.
    Cancelled,
    /// The app quit or crashed while it ran.
    Interrupted,
    /// Continued by hand in a terminal (`claude --resume`), outside the app's control. Ends
    /// when the agent records its summary, the terminal closes, or the user marks it done.
    Terminal,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
            Self::Terminal => "terminal",
        }
    }

    /// Still going: a headless run of the app, or a conversation open in a terminal.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Running | Self::Terminal)
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "interrupted" => Self::Interrupted,
            "terminal" => Self::Terminal,
            _ => return None,
        })
    }
}

/// A Claude Code run started from a task (docs/adr/017).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AgentSession {
    pub id: Id,
    pub task_id: Id,
    /// The device running it; only that device can update it.
    pub device_id: String,
    /// Claude Code's own session id (`--session-id`, then `--resume`).
    pub claude_session_id: String,
    /// Working directory, as the runtime sees it.
    pub folder: String,
    pub runtime: AgentRuntime,
    /// Claude Code `--permission-mode`.
    pub permission_mode: String,
    /// Claude Code `--model` (an alias like `opus` or a full name); `None` for the default.
    #[serde(default)]
    pub model: Option<String>,
    /// The user's extra instructions (the brief itself is not stored).
    pub prompt: String,
    pub state: SessionState,
    pub started_at: Timestamp,
    /// Set when the state leaves `running`.
    pub ended_at: Option<Timestamp>,
    /// Claude's final message, or the agent's own summary.
    pub summary: Option<String>,
    /// Total cost reported by Claude Code, in millionths of a dollar.
    pub cost_usd_micros: Option<i64>,
    pub turns: Option<i64>,
    /// How long the agent worked, summed over its runs, in ms. Not start to end: a session
    /// can sit idle between follow-ups.
    #[serde(default)]
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

/// A progress line an agent wrote during a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AgentNote {
    pub id: Id,
    pub session_id: Id,
    pub task_id: Id,
    pub body: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

/// This device's working folder for a project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ProjectFolder {
    pub project_id: Id,
    pub path: String,
    pub runtime: AgentRuntime,
    pub updated_at: Timestamp,
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
    /// Agents' own tasks (ADR 017) are hidden unless set.
    #[serde(default)]
    pub show_agent_tasks: bool,
    /// Set for a saved Lineage canvas (ADR 022): it opens on the Lineage page instead of a
    /// list or board. Its project, epic and tag filters are `filter`'s (one project at
    /// most), "Show subtasks" is `show_subtasks`, and the scope is `All`.
    #[serde(default)]
    pub lineage: Option<LineageSpec>,
}

/// A saved Lineage canvas: the filters the page has beyond [`ViewFilter`], and where the
/// cards sit. The cards themselves are whatever the filters match when it opens.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LineageSpec {
    /// Only this task's lineage (its prerequisites and dependents, all the way).
    #[serde(default)]
    pub around: Option<Id>,
    #[serde(default)]
    pub completion: LineageCompletion,
    /// Only tasks with at least one link.
    #[serde(default)]
    pub linked_only: bool,
    #[serde(default)]
    pub arrange: LineageArrange,
    /// Freeform card positions by task id, in canvas pixels.
    #[serde(default)]
    pub positions: BTreeMap<Id, CanvasPoint>,
    /// Positions inside a lane (y from the lane's top), per arrangement.
    #[serde(default)]
    pub lanes: LanePositions,
    /// Cards that stay put: no dragging, and "Arrange" leaves them alone.
    #[serde(default)]
    pub pinned: Vec<Id>,
    /// Folded lanes (epic or project ids, or [`FILTER_NONE`]), per arrangement.
    #[serde(default)]
    pub collapsed: LaneKeys,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum LineageCompletion {
    #[default]
    All,
    Open,
    /// Open and not blocked by an open prerequisite.
    Ready,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum LineageArrange {
    #[default]
    Free,
    Epic,
    Project,
}

/// A point on the Lineage canvas, in whole pixels.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct CanvasPoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LanePositions {
    #[serde(default)]
    pub epic: BTreeMap<Id, CanvasPoint>,
    #[serde(default)]
    pub project: BTreeMap<Id, CanvasPoint>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LaneKeys {
    #[serde(default)]
    pub epic: Vec<String>,
    #[serde(default)]
    pub project: Vec<String>,
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

/// Stands for "no epic" in [`ViewFilter::epic_ids`] and "no tag" in [`ViewFilter::tag_ids`].
pub const FILTER_NONE: &str = "none";

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
    /// Epic ids; [`FILTER_NONE`] matches tasks without an epic.
    #[serde(default)]
    pub epic_ids: Vec<Id>,
    /// Tasks carrying any of these tags; [`FILTER_NONE`] matches tasks without tags.
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
    /// Agent sessions of live tasks, every device's, by start.
    pub agent_sessions: Vec<AgentSession>,
}

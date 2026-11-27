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
    /// The member a team task is assigned to (ADR 033). Never set on personal tasks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee_id: Option<Id>,
    /// The member who created a team task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reporter_id: Option<Id>,
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

/// A file attached to a task or a meeting (exactly one of the two). The content is stored
/// by hash outside the database (see [`crate::FileStore`]); several rows may share one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Attachment {
    pub id: Id,
    pub task_id: Option<Id>,
    pub meeting_id: Option<Id>,
    pub note_id: Option<Id>,
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
    /// Planned but not worked on: no time logged, and the task is back to be planned.
    Missed,
    Cancelled,
}

impl BlockOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Done => "done",
            Self::Worked => "worked",
            Self::Missed => "missed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "planned" => Self::Planned,
            "done" => Self::Done,
            "worked" => Self::Worked,
            "missed" => Self::Missed,
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

/// Where a [`Meeting`] is in its life (ADR 025). Only `scheduled` and `held` are set by
/// hand; the others belong to recording and transcription (M19, M20).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum MeetingState {
    /// Planned, not started.
    #[default]
    Scheduled,
    /// Took place, with notes but no transcript.
    Held,
    Recording,
    /// Recorded, being transcribed.
    Processing,
    /// Transcript ready, to be checked.
    Review,
    /// Transcript checked: the audio's retention period has started.
    Validated,
    /// Recording or transcription failed; can be retried.
    Failed,
}

impl MeetingState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Scheduled => "scheduled",
            Self::Held => "held",
            Self::Recording => "recording",
            Self::Processing => "processing",
            Self::Review => "review",
            Self::Validated => "validated",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "scheduled" => Self::Scheduled,
            "held" => Self::Held,
            "recording" => Self::Recording,
            "processing" => Self::Processing,
            "review" => Self::Review,
            "validated" => Self::Validated,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
}

/// How an event shows to people who look at the calendar, as Outlook's "Show as" (ADR
/// 038): the time is taken, maybe taken, or still open.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ShowAs {
    #[default]
    Busy,
    Tentative,
    Free,
}

impl ShowAs {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::Tentative => "tentative",
            Self::Free => "free",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "busy" => Self::Busy,
            "tentative" => Self::Tentative,
            "free" => Self::Free,
            _ => return None,
        })
    }
}

fn private_by_default() -> bool {
    true
}

/// A meeting (Scribe, ADR 025): on the calendar, optionally linked to a project, an epic
/// and a task, with participants and notes. Its audio never enters the database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Meeting {
    pub id: Id,
    pub title: String,
    pub started_at: Timestamp,
    /// After `started_at`; `None` while it is being recorded.
    pub ended_at: Option<Timestamp>,
    pub project_id: Option<Id>,
    pub epic_id: Option<Id>,
    pub task_id: Option<Id>,
    pub state: MeetingState,
    /// Names, as typed.
    pub participants: Vec<String>,
    /// Markdown.
    pub notes: String,
    /// Markdown.
    pub summary: Option<String>,
    pub transcribed_at: Option<Timestamp>,
    pub validated_at: Option<Timestamp>,
    /// Names given to the transcript's speaker keys (`"s1"` → `"Ada"`); a key without a
    /// name shows as "Speaker 1", and `"me"` as "Me".
    #[serde(default)]
    pub speakers: std::collections::BTreeMap<String, String>,
    /// How it shows in calendars it is pushed to (ADR 038).
    #[serde(default)]
    pub show_as: ShowAs,
    /// Others who can see the calendar see only taken time, not what it is (ADR 038).
    #[serde(default = "private_by_default")]
    pub private: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

/// One stretch of a meeting's transcript (Scribe, M20): who spoke from when to when, and
/// what they said. Times count from the start of the recording.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TranscriptSegment {
    pub id: Id,
    pub meeting_id: Id,
    pub start_ms: i64,
    pub end_ms: i64,
    /// `"me"` (this device's microphone) or `"s1"`, `"s2"`, … (voices on the computer's
    /// sound).
    pub speaker: String,
    pub text: String,
    /// The user corrected the text.
    pub edited: bool,
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

/// A Claude Code session run in a terminal, outside the app (M21, ADR 028), read from the
/// transcript Claude Code keeps. Counted with [`AgentSession`]s on the Agents page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TerminalSession {
    pub id: Id,
    /// Claude Code's session id (the transcript's file name).
    pub claude_session_id: String,
    /// The device whose transcript it is; only that device records it.
    pub device_id: String,
    /// Working directory, as Claude Code saw it.
    pub folder: String,
    /// From the folder (the project whose folder holds it), or set by hand.
    pub project_id: Option<Id>,
    /// Set by hand.
    pub task_id: Option<Id>,
    /// Claude Code's title for the conversation.
    pub title: Option<String>,
    /// The model that wrote most of it.
    pub model: Option<String>,
    pub started_at: Timestamp,
    /// The last message so far.
    pub ended_at: Timestamp,
    /// Claude Code's own total, in millionths of a dollar; `None` when it recorded none.
    pub cost_usd_micros: Option<i64>,
    /// Time Claude worked (its turns), in ms, not the time the session sat open.
    pub duration_ms: Option<i64>,
    /// Requests to the model.
    pub turns: Option<i64>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

/// Which database a row lives in (ADR 033). Every row lives in exactly one space; a
/// personal row may point at a team row, never the other way.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum Space {
    /// The user's own database: today's app.
    #[default]
    Personal,
    /// The team's shared database, when the server runs with `TM_TEAM=on`.
    Team,
}

impl Space {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Team => "team",
        }
    }
}

/// A comment on a task (ADR 033, T5). `@Name` in the body mentions a member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Comment {
    pub id: Id,
    pub task_id: Id,
    /// Markdown.
    pub body: String,
    /// The member who wrote it; `None` in a personal space.
    pub author_id: Option<Id>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

/// A person in the team space (ADR 033): written by the server from its users, so names
/// show offline. `id` is the server's user id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Member {
    pub id: Id,
    pub name: String,
    pub color: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

/// One person's marks on a task of the team space (ADR 033), kept in their personal
/// space: `id` is the task's id. Personal tasks keep their marks on the task itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TaskMark {
    pub id: Id,
    /// Picked for that day's Today view.
    pub today_on: Option<IsoDate>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

/// A folder of [`Note`]s (ADR 032). Folders nest (ADR 042).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NoteFolder {
    pub id: Id,
    pub name: String,
    /// The folder it is in; `None` at the top level.
    #[serde(default)]
    pub parent_id: Option<Id>,
    /// Order among its siblings.
    pub rank: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

/// A markdown page in the sidebar's Notes (ADR 032). Its body links tasks, projects, epics
/// and meetings with `task:<id>`, `project:<id>`, `epic:<id>` and `meeting:<id>` URLs
/// (ADR 042).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Note {
    pub id: Id,
    /// May be blank; shown as "Untitled".
    pub title: String,
    /// Markdown.
    pub body: String,
    /// `None`: at the top level.
    pub folder_id: Option<Id>,
    /// The task it is attached to.
    pub task_id: Option<Id>,
    /// Order within its folder.
    pub rank: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
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
    /// Opened in the Claude desktop app (M22, ADR 029): a conversation the app cannot
    /// follow. Ends when the agent records its summary or the user marks it done. Any
    /// device may record its notes and summary (the claude.ai connector runs on the sync
    /// server).
    Desktop,
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
            Self::Desktop => "desktop",
        }
    }

    /// Still going: a headless run of the app, or a conversation open in a terminal or the
    /// desktop app.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Running | Self::Terminal | Self::Desktop)
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "interrupted" => Self::Interrupted,
            "terminal" => Self::Terminal,
            "desktop" => Self::Desktop,
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
    /// Board swimlanes whose cards are all done or cancelled are hidden unless set.
    #[serde(default)]
    pub show_closed_lanes: bool,
    /// Set for a saved Lineage canvas (ADR 022): it opens on the Lineage page instead of a
    /// list or board. Its project, epic and tag filters are `filter`'s (one project at
    /// most), "Show subtasks" is `show_subtasks`, and the scope is `All`.
    #[serde(default)]
    pub lineage: Option<LineageSpec>,
    /// Set for a saved Roadmap (ADR 031): it opens on the Roadmap page, on the epics of
    /// `filter.project_ids` (any number of projects; none is every project), or on one
    /// epic's task timeline. The scope is `All`.
    /// Boxed: it keeps `ViewSpec` (and so `Command`) small.
    #[serde(default)]
    pub roadmap: Option<Box<RoadmapSpec>>,
}

/// A saved Roadmap: the epics across projects (their bars end on their target dates), or
/// one epic's tasks (their bars end on their due dates). Neither has a start date, so where
/// bars start is part of the roadmap. The bars are whatever the filters match when it opens.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RoadmapSpec {
    /// The epic whose task timeline this is; `None` for the roadmap of epics. Its tag
    /// filter and "Show subtasks" are the spec's.
    #[serde(default)]
    pub epic: Option<Id>,
    /// Epics: `All` also shows done and dropped epics. Tasks: as on the Lineage page.
    #[serde(default)]
    pub completion: LineageCompletion,
    /// How the roadmap of epics groups its rows.
    #[serde(default)]
    pub group: RoadmapGroup,
    #[serde(default)]
    pub zoom: RoadmapZoom,
    /// The first day of each bar, by epic or task id (`YYYY-MM-DD`).
    #[serde(default)]
    pub starts: BTreeMap<Id, IsoDate>,
    /// Folded groups: project ids, or [`FILTER_NONE`].
    #[serde(default)]
    pub collapsed: Vec<String>,
    /// Leave out epics without a target date, or tasks without a due date (they show as
    /// empty rows to draw a bar on).
    #[serde(default)]
    pub hide_unscheduled: bool,
}

/// The rows of the roadmap of epics: under their home project, or one list.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RoadmapGroup {
    #[default]
    Project,
    None,
}

/// How much time a roadmap's width shows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RoadmapZoom {
    Day,
    #[default]
    Week,
    Month,
    Quarter,
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
    /// Attachments of live tasks and live meetings.
    pub attachments: Vec<Attachment>,
    /// Time blocks of live tasks, by start.
    pub time_blocks: Vec<TimeBlock>,
    /// Agent sessions of live tasks, every device's, by start.
    pub agent_sessions: Vec<AgentSession>,
    /// Live meetings, by start.
    pub meetings: Vec<Meeting>,
    /// Live terminal sessions, every device's, by start.
    #[serde(default)]
    pub terminal_sessions: Vec<TerminalSession>,
    /// Live note folders, in order (ADR 032).
    #[serde(default)]
    pub note_folders: Vec<NoteFolder>,
    /// Live notes, by rank.
    #[serde(default)]
    pub notes: Vec<Note>,
    /// Live members of a team space, by name (ADR 033); empty in a personal space.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<Member>,
    /// Live comments of live tasks, oldest first (ADR 033).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<Comment>,
}

//! The phone's interface to task-master (ADR 040, docs/ios-plan.md).
//!
//! One [`Core`] object owns the local database (a replica like any desktop, ADR 015) and
//! the sync engine. Swift asks it for rows ready to draw and sends it edits; it never
//! filters, sorts or merges. Types here are the phone's own, shaped for its screens, and
//! are converted from the core's; this is the only crate that knows UniFFI.

use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use taskmaster_client::engine::{self, Engine, EngineError, Host, SyncAccount};
use taskmaster_client::{Client, Files};
use taskmaster_core::views::{ViewOptions, ViewRow};
use taskmaster_core::{
    ATTACHMENTS_DIR, Command, NewTag, NewTask, Snapshot, SpacesHistory, StatusCategory, Store,
    Task, TaskChange, TeamInfo, VIEW_SPEC_VERSION, ViewScope, ViewSpec, now_ms,
};

uniffi::setup_scaffolding!();

mod account;
mod browse;
mod calendar;
mod edit;
mod notes;
mod plan;
mod team;

pub use account::{AttachmentFile, SignIn};
pub use browse::{
    ActivityItem, AttachmentItem, BoardColumn, Counts, EpicItem, EpicStage, FieldEdit, Navigation,
    ProjectItem, SavedView, StatusItem, TagItem, TaskDetail, TaskRef, ViewLayout,
};
pub use calendar::{CalendarAvailability, CalendarInfo, EventItem};
pub use edit::{NewTaskInput, Placement, TaskEdit, UndoState};
pub use notes::{
    NewNoteInput, NewProjectInput, NoteDetail, NoteEdit, NoteFolderItem, NoteItem, NoteLink,
    NoteLinkKind, NotesOverview,
};
pub use plan::{BlockItem, Outcome, Reminder, ReminderKind};

use team::Data;

const DATABASE: &str = "tasks.sqlite";
const ACCOUNT: &str = "account.json";
const BACKUPS: &str = "backups";
/// Minutes between periodic rounds while the app is open.
const SYNC_MINUTES: u32 = 5;

/// What went wrong, in words the app can show.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Error)]
pub enum AppError {
    /// The user can fix it (bad input, wrong token, an app or server to update).
    Invalid {
        message: String,
    },
    NotFound {
        message: String,
    },
    Internal {
        message: String,
    },
}

impl AppError {
    fn new(kind: &str, message: String) -> Self {
        match kind {
            "invalid" => Self::Invalid { message },
            "not_found" => Self::NotFound { message },
            _ => Self::Internal { message },
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::Internal {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid { message } | Self::NotFound { message } | Self::Internal { message } => {
                f.write_str(message)
            }
        }
    }
}

impl std::error::Error for AppError {}

impl From<taskmaster_core::Error> for AppError {
    fn from(e: taskmaster_core::Error) -> Self {
        Self::new(e.kind(), e.to_string())
    }
}

impl From<EngineError> for AppError {
    fn from(e: EngineError) -> Self {
        Self::new(&e.kind, e.message)
    }
}

type AppResult<T> = Result<T, AppError>;

/// The user's calendar day, which "today" and "overdue" count from.
#[derive(Debug, Clone, uniffi::Record)]
pub struct Day {
    /// `YYYY-MM-DD` in the phone's time zone.
    pub today: String,
    /// Minutes east of UTC.
    pub utc_offset_min: i32,
}

/// The task set a list (or board) shows.
#[derive(Debug, Clone, uniffi::Enum)]
pub enum Scope {
    Inbox,
    Today,
    All,
    Project {
        id: String,
    },
    Epic {
        id: String,
    },
    Tag {
        id: String,
    },
    /// A view saved on the desktop: its scope, filters, grouping and order.
    View {
        id: String,
    },
}

/// What a scope shows: a saved view's own spec, else the default one (grouped by status,
/// default order, no subtasks unrolled beyond one level, no cancelled or agent tasks).
fn spec_for(scope: Scope, snapshot: &Snapshot) -> AppResult<ViewSpec> {
    let scope = match scope {
        Scope::Inbox => ViewScope::Inbox,
        Scope::Today => ViewScope::Today,
        Scope::All => ViewScope::All,
        Scope::Project { id } => ViewScope::Project { id },
        Scope::Epic { id } => ViewScope::Epic { id },
        Scope::Tag { id } => ViewScope::Tag { id },
        Scope::View { id } => {
            return snapshot
                .views
                .iter()
                .find(|v| v.id == id)
                .map(|v| v.spec.clone())
                .ok_or_else(|| AppError::NotFound {
                    message: "that view was deleted".into(),
                });
        }
    };
    Ok(ViewSpec {
        version: VIEW_SPEC_VERSION,
        scope,
        filter: Default::default(),
        group_by: Default::default(),
        sort: Default::default(),
        layout: Default::default(),
        swimlane: Default::default(),
        show_subtasks: false,
        show_cancelled: false,
        show_agent_tasks: false,
        lineage: None,
        show_closed_lanes: false,
        roadmap: None,
    })
}

fn view_options(day: &Day, data: &Data) -> ViewOptions {
    ViewOptions {
        today: day.today.clone(),
        utc_offset_min: day.utc_offset_min,
        team_tasks: data.team_ids.clone(),
        ..ViewOptions::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Priority {
    Urgent,
    High,
    Normal,
    Low,
}

impl From<Priority> for taskmaster_core::Priority {
    fn from(p: Priority) -> Self {
        match p {
            Priority::Urgent => Self::Urgent,
            Priority::High => Self::High,
            Priority::Normal => Self::Normal,
            Priority::Low => Self::Low,
        }
    }
}

impl From<taskmaster_core::Priority> for Priority {
    fn from(p: taskmaster_core::Priority) -> Self {
        match p {
            taskmaster_core::Priority::Urgent => Self::Urgent,
            taskmaster_core::Priority::High => Self::High,
            taskmaster_core::Priority::Normal => Self::Normal,
            taskmaster_core::Priority::Low => Self::Low,
        }
    }
}

/// Where a task stands, whatever its status is called.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Stage {
    Backlog,
    Todo,
    InProgress,
    Done,
    Cancelled,
}

impl From<StatusCategory> for Stage {
    fn from(c: StatusCategory) -> Self {
        match c {
            StatusCategory::Backlog => Self::Backlog,
            StatusCategory::Todo => Self::Todo,
            StatusCategory::InProgress => Self::InProgress,
            StatusCategory::Done => Self::Done,
            StatusCategory::Cancelled => Self::Cancelled,
        }
    }
}

/// A task as a list draws it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskRow {
    pub id: String,
    pub title: String,
    pub stage: Stage,
    pub status_name: String,
    pub priority: Priority,
    pub due_date: Option<String>,
    /// Due before today and still open.
    pub overdue: bool,
    /// Picked for today.
    pub today: bool,
    pub project_name: Option<String>,
    pub project_color: Option<String>,
    pub epic_id: Option<String>,
    pub epic_name: Option<String>,
    pub estimate_min: Option<i64>,
    /// Tag names, alphabetical.
    pub tags: Vec<String>,
    pub has_description: bool,
    /// When it was made (Unix ms): the Inbox shows when a capture came in.
    pub created_at: i64,
    /// 0, or 1 for a subtask shown under its parent (the phone's lists unroll one level).
    pub depth: u32,
    /// Subtask progress over all live subtasks.
    pub child_count: u32,
    pub child_done: u32,
    /// A task of the team space (ADR 033).
    pub team: bool,
    /// The team member it is assigned to, by name (team tasks only).
    pub assignee: Option<String>,
}

// Records cross to Swift by value either way; a box would only add an allocation here.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum ListRow {
    /// A heading; `key` identifies it within the list.
    Group {
        key: String,
        label: String,
        color: Option<String>,
        count: u32,
    },
    Task {
        task: TaskRow,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum AuthMode {
    None,
    Token,
    Oidc,
}

/// How this phone starts syncing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum JoinMode {
    /// Keep the phone's data and add the server's.
    Merge,
    /// Back up the phone's data, empty it, then take the server's.
    Replace,
}

/// Which side must be updated before syncing works again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum UpdateNeeded {
    /// The server runs a newer database version: update the app ("update to sync").
    App,
    /// The app is ahead: update the server.
    Server,
}

/// What the sync screen shows.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SyncStatus {
    pub configured: bool,
    pub url: String,
    pub device_name: String,
    /// What the server asks for; unknown until it was reached.
    pub auth: Option<AuthMode>,
    pub signed_in: bool,
    /// Whether the server held no data when this phone connected.
    pub server_empty: Option<bool>,
    pub joined: bool,
    pub syncing: bool,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    /// Local changes not on the server yet (counted up to 1000).
    pub pending: u32,
    /// The phone's clock is more than a minute off (sync corrects for it).
    pub clock_warning: bool,
    /// Set when the last round failed because the database versions differ. The phone
    /// keeps working offline meanwhile.
    pub update: Option<UpdateNeeded>,
    /// The team whose space this phone syncs too (ADR 033); `None` without one.
    pub team_name: Option<String>,
    /// Who this phone's token belongs to in that team.
    pub team_member: Option<String>,
}

impl SyncStatus {
    fn new(s: engine::SyncStatus, app_schema: u32) -> Self {
        let update = s.server_schema.map(|server| {
            if server > app_schema {
                UpdateNeeded::App
            } else {
                UpdateNeeded::Server
            }
        });
        Self {
            configured: s.configured,
            url: s.url,
            device_name: s.device_name,
            auth: s.auth.map(|a| match a {
                taskmaster_core::AuthMode::None => AuthMode::None,
                taskmaster_core::AuthMode::Token => AuthMode::Token,
                taskmaster_core::AuthMode::Oidc => AuthMode::Oidc,
            }),
            signed_in: s.signed_in,
            server_empty: s.server_empty,
            joined: s.joined,
            syncing: s.syncing,
            last_sync_at: s.last_sync_at,
            last_error: s.last_error,
            pending: s.pending,
            clock_warning: s.clock_warning,
            update,
            team_name: s.team.as_ref().map(|t| t.name.clone()),
            team_member: s.team.and_then(|t| t.me).map(|m| m.name),
        }
    }
}

/// Implemented in Swift. Called from background threads: hop to the main actor there.
#[uniffi::export(with_foreign)]
pub trait Listener: Send + Sync {
    /// Tasks changed (an edit here, or one that arrived by sync): reload what is shown.
    fn data_changed(&self);
    /// A round started or ended, or the account changed.
    fn sync_changed(&self, status: SyncStatus);
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Inner {
    /// Itself, for the threads it starts.
    this: Weak<Inner>,
    dir: PathBuf,
    device_name: String,
    /// This build's database version (fixed once migrations ran).
    app_schema: u32,
    store: Mutex<Store>,
    /// The team space, while this phone's token belongs to a member (ADR 033).
    team: Mutex<Option<Store>>,
    team_info: Mutex<Option<TeamInfo>>,
    /// One undo history across both spaces.
    history: Mutex<SpacesHistory>,
    /// The server's calendar events, as last fetched (ADR 014).
    calendar: Mutex<calendar::CalendarCache>,
    engine: Engine,
    /// Taken by the first [`Core::start`].
    kicks: Mutex<Option<Receiver<()>>>,
    account: Mutex<Option<SyncAccount>>,
    listener: Mutex<Option<Arc<dyn Listener>>>,
}

impl Inner {
    fn listener(&self) -> Option<Arc<dyn Listener>> {
        lock(&self.listener).clone()
    }

    fn status(&self, s: engine::SyncStatus) -> SyncStatus {
        SyncStatus::new(s, self.app_schema)
    }
}

impl Host for Inner {
    fn store(&self) -> &Mutex<Store> {
        &self.store
    }

    fn account(&self) -> Option<SyncAccount> {
        lock(&self.account).clone()
    }

    fn save_account(&self, account: Option<SyncAccount>) -> Result<(), String> {
        let path = self.dir.join(ACCOUNT);
        match &account {
            Some(a) => {
                let json = serde_json::to_vec_pretty(a).map_err(|e| e.to_string())?;
                // Written beside, then renamed: a crash never leaves half an account.
                let tmp = self.dir.join(format!("{ACCOUNT}.tmp"));
                std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
                std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
            }
            None => match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            },
        }
        *lock(&self.account) = account;
        Ok(())
    }

    fn sync_minutes(&self) -> u32 {
        SYNC_MINUTES
    }

    fn status_changed(&self, status: &engine::SyncStatus) {
        if let Some(listener) = self.listener() {
            listener.sync_changed(self.status(status.clone()));
        }
    }

    fn backup_before_replace(&self, store: &mut Store) -> taskmaster_core::Result<()> {
        let dir = self.dir.join(BACKUPS);
        std::fs::create_dir_all(&dir)?;
        store.backup_to(dir.join(format!("pre-replace-{}.sqlite", now_ms())))
    }

    fn device_name(&self) -> String {
        self.device_name.clone()
    }

    /// Attachments are fetched when opened, not with every round.
    fn files(&self) -> Files {
        Files::OnDemand
    }

    fn after_round(&self, client: &Client) -> Result<(), String> {
        let team = self.sync_team(client);
        self.refresh_calendar(client, false);
        team
    }

    fn pending_elsewhere(&self) -> u32 {
        self.team_pending()
    }
}

/// Where a task stands: its status's kind (to do when the status is gone).
fn stage_of(task: &Task, s: &Snapshot) -> Stage {
    s.statuses
        .iter()
        .find(|st| st.id == task.status_id)
        .map_or(Stage::Todo, |st| st.category.into())
}

/// Still to be done: neither done nor cancelled.
fn is_open(task: &Task, s: &Snapshot) -> bool {
    !matches!(stage_of(task, s), Stage::Done | Stage::Cancelled)
}

/// A user's own open task (agent tasks stay on the desktop's Agents page).
fn is_mine_open(task: &Task, s: &Snapshot) -> bool {
    task.owner == taskmaster_core::TaskOwner::Me && is_open(task, s)
}

fn not_found(what: &str) -> AppError {
    AppError::NotFound {
        message: format!("that {what} was deleted"),
    }
}

fn task_row(
    task: &Task,
    depth: u32,
    child_count: u32,
    child_done: u32,
    s: &Data,
    today: &str,
) -> TaskRow {
    let status = s.statuses.iter().find(|st| st.id == task.status_id);
    let stage = status.map_or(Stage::Todo, |st| st.category.into());
    let project = task
        .project_id
        .as_deref()
        .and_then(|id| s.projects.iter().find(|p| p.id == id));
    let epic = task
        .epic_id
        .as_deref()
        .and_then(|id| s.epics.iter().find(|e| e.id == id));
    let mut tags: Vec<String> = task
        .tag_ids
        .iter()
        .filter_map(|id| s.tags.iter().find(|t| &t.id == id))
        .map(|t| t.name.clone())
        .collect();
    tags.sort_by_key(|name| name.to_lowercase());
    TaskRow {
        id: task.id.clone(),
        title: task.title.clone(),
        stage,
        status_name: status.map(|st| st.name.clone()).unwrap_or_default(),
        priority: task.priority.into(),
        overdue: task.due_date.as_deref().is_some_and(|d| d < today)
            && !matches!(stage, Stage::Done | Stage::Cancelled),
        due_date: task.due_date.clone(),
        today: task.today_on.as_deref() == Some(today),
        project_name: project.map(|p| p.name.clone()),
        project_color: project.and_then(|p| p.color.clone()),
        epic_id: epic.map(|e| e.id.clone()),
        epic_name: epic.map(|e| e.name.clone()),
        estimate_min: task.estimate_min,
        tags,
        has_description: !task.description.trim().is_empty(),
        created_at: task.created_at,
        depth,
        child_count,
        child_done,
        team: s.is_team(&task.id),
        assignee: task.assignee_id.as_deref().and_then(|id| s.member_name(id)),
    }
}

/// A name a capture line gives, and whether something live is called that (an unknown
/// tag is created; an unknown project or epic is left off).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NameRef {
    pub name: String,
    pub known: bool,
}

/// A capture line as the composer previews it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CapturePreview {
    pub title: String,
    pub tags: Vec<NameRef>,
    pub project: Option<NameRef>,
    pub epic: Option<NameRef>,
    pub priority: Option<Priority>,
    pub due_date: Option<String>,
    /// Markers it could not read; they stay in the title.
    pub warnings: Vec<String>,
}

/// The app's data and sync. Create one per process and keep it.
#[derive(uniffi::Object)]
pub struct Core {
    inner: Arc<Inner>,
}

#[uniffi::export]
impl Core {
    /// Opens (or creates) the database in `dir`, a folder the app owns. `device_name`
    /// is how this phone appears in the server's token list.
    #[uniffi::constructor]
    pub fn open(dir: String, device_name: String) -> AppResult<Arc<Self>> {
        let dir = PathBuf::from(dir);
        std::fs::create_dir_all(&dir).map_err(|e| AppError::internal(e.to_string()))?;
        let mut store = Store::open(dir.join(DATABASE))?.with_files(dir.join(ATTACHMENTS_DIR));
        let changes = store.subscribe();
        let app_schema = store.schema_version()?;
        let account = match std::fs::read(dir.join(ACCOUNT)) {
            Ok(bytes) => Some(serde_json::from_slice(&bytes).map_err(|e| {
                AppError::internal(format!("the saved account is unreadable: {e}"))
            })?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(AppError::internal(e.to_string())),
        };
        let calendar = calendar::CalendarCache::load(&dir);
        let (engine, kicks) = Engine::new();
        let inner = Arc::new_cyclic(|this| Inner {
            this: this.clone(),
            dir,
            device_name,
            app_schema,
            store: Mutex::new(store),
            team: Mutex::new(None),
            team_info: Mutex::new(None),
            history: Mutex::new(SpacesHistory::default()),
            calendar: Mutex::new(calendar),
            engine,
            kicks: Mutex::new(Some(kicks)),
            account: Mutex::new(account),
            listener: Mutex::new(None),
        });
        // Every committed batch, local or pulled: tell the UI, and sync local edits soon.
        let weak: Weak<Inner> = Arc::downgrade(&inner);
        std::thread::Builder::new()
            .name("store-events".into())
            .spawn(move || {
                for _changed in changes {
                    let Some(inner) = weak.upgrade() else { return };
                    inner.engine.local_change();
                    if let Some(listener) = inner.listener() {
                        listener.data_changed();
                    }
                }
            })
            .map_err(|e| AppError::internal(e.to_string()))?;
        inner.open_saved_team();
        Ok(Arc::new(Self { inner }))
    }

    /// Who hears about changes. One listener; a new one replaces the last.
    pub fn set_listener(&self, listener: Option<Arc<dyn Listener>>) {
        *lock(&self.inner.listener) = listener;
    }

    /// Starts the background sync loops (a round after edits, when the server announces
    /// changes, and every few minutes). Call once after `open`; later calls do nothing.
    pub fn start(&self) -> AppResult<()> {
        let Some(kicks) = lock(&self.inner.kicks).take() else {
            return Ok(());
        };
        let spawn = |name: &str, f: Box<dyn FnOnce() + Send>| {
            std::thread::Builder::new()
                .name(name.into())
                .spawn(f)
                .map(|_| ())
                .map_err(|e| AppError::internal(e.to_string()))
        };
        let inner = self.inner.clone();
        spawn("sync", Box::new(move || inner.engine.run(&*inner, &kicks)))?;
        let inner = self.inner.clone();
        spawn("sync-events", Box::new(move || inner.engine.watch(&*inner)))?;
        let inner = self.inner.clone();
        spawn(
            "team-sync-events",
            Box::new(move || {
                let cursor = || {
                    lock(&inner.team)
                        .as_ref()
                        .map(|t| t.sync_cursor().unwrap_or(0))
                };
                inner.engine.watch_team(&*inner, cursor);
            }),
        )
    }

    // -----------------------------------------------------------------------------------
    // Reads

    /// The rows of a list: grouped and ordered as the scope says (by status in the default
    /// order unless a saved view says otherwise), subtasks under their parent.
    pub fn list(&self, scope: Scope, day: Day) -> AppResult<Vec<ListRow>> {
        let snapshot = self.inner.data()?;
        let spec = spec_for(scope, &snapshot)?;
        let rows =
            taskmaster_core::views::list_rows(&snapshot, &spec, &view_options(&day, &snapshot));
        Ok(rows
            .into_iter()
            .map(|row| match row {
                ViewRow::Group { group, count, .. } => ListRow::Group {
                    key: group.key,
                    label: group.label,
                    color: group.color,
                    count,
                },
                ViewRow::Task {
                    task,
                    depth,
                    child_count,
                    child_done,
                    ..
                } => ListRow::Task {
                    task: task_row(&task, depth, child_count, child_done, &snapshot, &day.today),
                },
            })
            .collect())
    }

    // -----------------------------------------------------------------------------------
    // Edits

    /// Adds a task from a quick-capture line (`Buy milk ^tomorrow !high #errand @Home`),
    /// as the desktop's capture window does. Returns the new task's id.
    pub fn capture(&self, text: String, day: Day) -> AppResult<String> {
        self.capture_to(text, day, false, None)
    }

    /// What a capture line will make, read as the user types: the markers it understood
    /// and the names they match. Never fails on a half-typed line.
    pub fn preview_capture(&self, text: String, day: Day) -> AppResult<CapturePreview> {
        let parsed = lock(&self.inner.store).parse_capture(&text, &day.today)?;
        let name = |m: taskmaster_core::NameMatch| NameRef {
            known: m.id.is_some(),
            name: m.name,
        };
        Ok(CapturePreview {
            title: parsed.title,
            tags: parsed.tags.into_iter().map(name).collect(),
            project: parsed.project.map(name),
            epic: parsed.epic.map(name),
            priority: parsed.priority.map(Into::into),
            due_date: parsed.due_date,
            warnings: parsed.warnings,
        })
    }

    /// [`Core::capture`], picked for today when `today` is set (the composer's Today
    /// switch), in the same undo step. `project_id` is the composer's project picker: it
    /// files the task there when the line names no project or epic of its own (a marker
    /// typed in the line is the more recent choice).
    pub fn capture_to(
        &self,
        text: String,
        day: Day,
        today: bool,
        project_id: Option<String>,
    ) -> AppResult<String> {
        // Names resolve against the personal space, as on the desktop.
        let parsed = lock(&self.inner.store).parse_capture(&text, &day.today)?;
        if parsed.title.trim().is_empty() {
            return Err(AppError::Invalid {
                message: "type what needs doing".into(),
            });
        }
        // A tag nobody has yet is created with the task, in the same batch (one undo).
        let mut commands = Vec::new();
        let mut tag_ids = Vec::new();
        for tag in parsed.tags {
            let id = tag.id.unwrap_or_else(|| {
                let id = taskmaster_core::new_id();
                commands.push(Command::CreateTag {
                    tag: NewTag {
                        id: Some(id.clone()),
                        name: tag.name,
                        color: None,
                    },
                });
                id
            });
            tag_ids.push(id);
        }
        let picked = if parsed.project.is_none() && parsed.epic.is_none() {
            project_id
        } else {
            None
        };
        let id = taskmaster_core::new_id();
        commands.push(Command::CreateTask {
            task: NewTask {
                id: Some(id.clone()),
                title: parsed.title,
                project_id: parsed.project.and_then(|p| p.id).or(picked),
                epic_id: parsed.epic.and_then(|e| e.id),
                priority: parsed.priority.unwrap_or_default(),
                due_date: parsed.due_date,
                today_on: today.then(|| day.today.clone()),
                tag_ids,
                ..NewTask::default()
            },
        });
        self.inner.execute(commands, None)?;
        Ok(id)
    }

    /// Marks a task done, or reopens it: it moves to the first status of the done (or
    /// to-do) kind.
    pub fn set_done(&self, task_id: String, done: bool) -> AppResult<()> {
        let wanted = if done {
            StatusCategory::Done
        } else {
            StatusCategory::Todo
        };
        // A team task takes the team's workflow (ordered as its board).
        let data = self.inner.data()?;
        let mut statuses = data.statuses_for(&task_id);
        statuses.sort_by(|a, b| a.rank.cmp(&b.rank));
        let status = statuses
            .into_iter()
            .find(|s| s.category == wanted)
            .ok_or_else(|| AppError::Invalid {
                message: "there is no status of that kind; add one on the desktop".into(),
            })?;
        self.inner.execute(
            vec![Command::UpdateTask {
                id: task_id,
                changes: vec![TaskChange::StatusId(status.id.clone())],
            }],
            None,
        )?;
        Ok(())
    }

    /// Takes back the last edit made on this phone. False when there is none.
    pub fn undo(&self) -> AppResult<bool> {
        self.inner.with_spaces(|s| Ok(s.undo()?.is_some()))
    }

    // -----------------------------------------------------------------------------------
    // Sync

    pub fn sync_status(&self) -> SyncStatus {
        self.inner.status(self.inner.engine.status(&*self.inner))
    }

    /// The status, after asking the server what it needs when that is not known yet
    /// (after a restart). Uses the network.
    pub fn sync_refresh(&self) -> SyncStatus {
        self.inner.status(self.inner.engine.refresh(&*self.inner))
    }

    /// Saves the server's address after asking it how it authenticates. Uses the network.
    pub fn sync_connect(&self, url: String) -> AppResult<SyncStatus> {
        Ok(self
            .inner
            .status(self.inner.engine.connect(&*self.inner, &url)?))
    }

    /// Saves a token made on the server, after checking it. Uses the network.
    pub fn sync_set_token(&self, token: String) -> AppResult<SyncStatus> {
        Ok(self
            .inner
            .status(self.inner.engine.set_token(&*self.inner, &token)?))
    }

    /// Starts syncing. Uses the network.
    pub fn sync_join(&self, mode: JoinMode) -> AppResult<SyncStatus> {
        let mode = match mode {
            JoinMode::Merge => engine::JoinMode::Merge,
            JoinMode::Replace => engine::JoinMode::Replace,
        };
        Ok(self
            .inner
            .status(self.inner.engine.join(&*self.inner, mode)?))
    }

    /// Asks the background loop for a round soon (the app came to the front).
    pub fn sync_kick(&self) {
        self.inner.engine.kick();
    }

    /// Syncs now and returns when done (pull to refresh, background refresh). Blocks on
    /// the network: never call it on the main thread.
    pub fn sync_now(&self) -> SyncStatus {
        self.inner.status(self.inner.engine.sync_now(&*self.inner))
    }

    /// Stops syncing and forgets the server. The phone's data stays.
    pub fn sync_disconnect(&self) -> AppResult<SyncStatus> {
        self.inner.close_team();
        self.inner.forget_calendar();
        Ok(self
            .inner
            .status(self.inner.engine.disconnect(&*self.inner)?))
    }
}

/// The version of this library (the workspace's), for the About screen and bug reports.
#[uniffi::export]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_older_side_is_the_one_to_update() {
        let status = |server| {
            SyncStatus::new(
                engine::SyncStatus {
                    server_schema: server,
                    ..engine::SyncStatus::default()
                },
                17,
            )
            .update
        };
        assert_eq!(status(None), None);
        assert_eq!(status(Some(18)), Some(UpdateNeeded::App));
        assert_eq!(status(Some(16)), Some(UpdateNeeded::Server));
    }
}

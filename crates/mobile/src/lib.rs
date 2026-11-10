//! The phone's interface to task-master (ADR 022, docs/ios-plan.md).
//!
//! One [`Core`] object owns the local database (a replica like any desktop, ADR 015) and
//! the sync engine. Swift asks it for rows ready to draw and sends it edits; it never
//! filters, sorts or merges. Types here are the phone's own, shaped for its screens, and
//! are converted from the core's; this is the only crate that knows UniFFI.

use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use taskmaster_client::Files;
use taskmaster_client::engine::{self, Engine, EngineError, Host, SyncAccount};
use taskmaster_core::views::{ViewOptions, ViewRow};
use taskmaster_core::{
    ATTACHMENTS_DIR, Command, NewTag, NewTask, Snapshot, StatusCategory, Store, Task, TaskChange,
    VIEW_SPEC_VERSION, ViewScope, ViewSpec, now_ms,
};

uniffi::setup_scaffolding!();

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

/// The task set a list shows.
#[derive(Debug, Clone, uniffi::Enum)]
pub enum Scope {
    Inbox,
    Today,
    All,
    Project { id: String },
    Epic { id: String },
    Tag { id: String },
}

impl From<Scope> for ViewScope {
    fn from(scope: Scope) -> Self {
        match scope {
            Scope::Inbox => Self::Inbox,
            Scope::Today => Self::Today,
            Scope::All => Self::All,
            Scope::Project { id } => Self::Project { id },
            Scope::Epic { id } => Self::Epic { id },
            Scope::Tag { id } => Self::Tag { id },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Priority {
    Urgent,
    High,
    Normal,
    Low,
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
    pub has_description: bool,
    /// 0, or 1 for a subtask shown under its parent.
    pub depth: u8,
    /// Subtask progress over all live subtasks.
    pub child_count: u32,
    pub child_done: u32,
}

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
}

impl From<engine::SyncStatus> for SyncStatus {
    fn from(s: engine::SyncStatus) -> Self {
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
    dir: PathBuf,
    device_name: String,
    store: Mutex<Store>,
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
            listener.sync_changed(status.clone().into());
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
}

fn task_row(
    task: &Task,
    depth: u8,
    child_count: u32,
    child_done: u32,
    s: &Snapshot,
    today: &str,
) -> TaskRow {
    let status = s.statuses.iter().find(|st| st.id == task.status_id);
    let stage = status.map_or(Stage::Todo, |st| st.category.into());
    let project = task
        .project_id
        .as_deref()
        .and_then(|id| s.projects.iter().find(|p| p.id == id));
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
        has_description: !task.description.trim().is_empty(),
        depth,
        child_count,
        child_done,
    }
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
        let account = match std::fs::read(dir.join(ACCOUNT)) {
            Ok(bytes) => Some(serde_json::from_slice(&bytes).map_err(|e| {
                AppError::internal(format!("the saved account is unreadable: {e}"))
            })?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(AppError::internal(e.to_string())),
        };
        let (engine, kicks) = Engine::new();
        let inner = Arc::new(Inner {
            dir,
            device_name,
            store: Mutex::new(store),
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
        spawn("sync-events", Box::new(move || inner.engine.watch(&*inner)))
    }

    // -----------------------------------------------------------------------------------
    // Reads

    /// The rows of a list: grouped by status, in the default order, subtasks under their
    /// parent.
    pub fn list(&self, scope: Scope, day: Day) -> AppResult<Vec<ListRow>> {
        let spec: ViewSpec = ViewSpec {
            version: VIEW_SPEC_VERSION,
            scope: scope.into(),
            filter: Default::default(),
            group_by: Default::default(),
            sort: Default::default(),
            layout: Default::default(),
            swimlane: Default::default(),
            show_subtasks: false,
            show_cancelled: false,
            show_agent_tasks: false,
        };
        let options = ViewOptions {
            today: day.today.clone(),
            utc_offset_min: day.utc_offset_min,
            ..ViewOptions::default()
        };
        let snapshot = lock(&self.inner.store).snapshot()?;
        let rows = taskmaster_core::views::list_rows(&snapshot, &spec, &options);
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
        let mut store = lock(&self.inner.store);
        let parsed = store.parse_capture(&text, &day.today)?;
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
        let id = taskmaster_core::new_id();
        commands.push(Command::CreateTask {
            task: NewTask {
                id: Some(id.clone()),
                title: parsed.title,
                project_id: parsed.project.and_then(|p| p.id),
                epic_id: parsed.epic.and_then(|e| e.id),
                priority: parsed.priority.unwrap_or_default(),
                due_date: parsed.due_date,
                tag_ids,
                ..NewTask::default()
            },
        });
        store.execute_all(commands)?;
        Ok(id)
    }

    /// Marks a task done, or reopens it: it moves to the first status of the done (or
    /// to-do) kind.
    pub fn set_done(&self, task_id: String, done: bool) -> AppResult<()> {
        let mut store = lock(&self.inner.store);
        let wanted = if done {
            StatusCategory::Done
        } else {
            StatusCategory::Todo
        };
        let status = store
            .snapshot()?
            .statuses
            .into_iter()
            .find(|s| s.category == wanted)
            .ok_or_else(|| AppError::Invalid {
                message: "there is no status of that kind; add one on the desktop".into(),
            })?;
        store.execute(Command::UpdateTask {
            id: task_id,
            changes: vec![TaskChange::StatusId(status.id)],
        })?;
        Ok(())
    }

    /// Takes back the last edit made on this phone. False when there is none.
    pub fn undo(&self) -> AppResult<bool> {
        Ok(lock(&self.inner.store).undo()?.is_some())
    }

    // -----------------------------------------------------------------------------------
    // Sync

    pub fn sync_status(&self) -> SyncStatus {
        self.inner.engine.status(&*self.inner).into()
    }

    /// The status, after asking the server what it needs when that is not known yet
    /// (after a restart). Uses the network.
    pub fn sync_refresh(&self) -> SyncStatus {
        self.inner.engine.refresh(&*self.inner).into()
    }

    /// Saves the server's address after asking it how it authenticates. Uses the network.
    pub fn sync_connect(&self, url: String) -> AppResult<SyncStatus> {
        Ok(self.inner.engine.connect(&*self.inner, &url)?.into())
    }

    /// Saves a token made on the server, after checking it. Uses the network.
    pub fn sync_set_token(&self, token: String) -> AppResult<SyncStatus> {
        Ok(self.inner.engine.set_token(&*self.inner, &token)?.into())
    }

    /// Starts syncing. Uses the network.
    pub fn sync_join(&self, mode: JoinMode) -> AppResult<SyncStatus> {
        let mode = match mode {
            JoinMode::Merge => engine::JoinMode::Merge,
            JoinMode::Replace => engine::JoinMode::Replace,
        };
        Ok(self.inner.engine.join(&*self.inner, mode)?.into())
    }

    /// Asks the background loop for a round soon (the app came to the front).
    pub fn sync_kick(&self) {
        self.inner.engine.kick();
    }

    /// Syncs now and returns when done (pull to refresh, background refresh). Blocks on
    /// the network: never call it on the main thread.
    pub fn sync_now(&self) -> SyncStatus {
        self.inner.engine.sync_now(&*self.inner).into()
    }

    /// Stops syncing and forgets the server. The phone's data stays.
    pub fn sync_disconnect(&self) -> AppResult<SyncStatus> {
        Ok(self.inner.engine.disconnect(&*self.inner)?.into())
    }
}

/// The version of this library (the workspace's), for the About screen and bug reports.
#[uniffi::export]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

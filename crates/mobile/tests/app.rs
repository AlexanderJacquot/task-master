//! The phone's `Core` as Swift uses it: local edits and lists, then sync with a real
//! server on a local port.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use taskmaster_core::Store;
use taskmaster_mobile::{
    AppError, AuthMode, Core, Day, JoinMode, ListRow, Listener, Priority, Scope, Stage, SyncStatus,
};
use taskmaster_server::auth::{Scope as TokenScope, Tokens};
use taskmaster_server::config::Config;
use taskmaster_server::{AppState, router};

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tm-mobile-{label}-{}", taskmaster_core::new_id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn day() -> Day {
    Day {
        today: "2026-11-10".into(),
        utc_offset_min: 60,
    }
}

fn open(dir: &std::path::Path, name: &str) -> Arc<Core> {
    Core::open(dir.to_string_lossy().into_owned(), name.into()).unwrap()
}

fn server(config: Config) -> (String, Arc<AppState>) {
    let dir = temp_dir("server");
    let store = Store::open(dir.join("tasks.sqlite")).unwrap();
    let state = AppState::new(
        Config {
            data_dir: dir,
            ..config
        },
        store,
        Tokens::open_in_memory().unwrap(),
    );
    let app = router(state.clone());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap()).unwrap();
            axum::serve(listener, app).await.unwrap();
        });
    });
    (format!("http://{}", rx.recv().unwrap()), state)
}

fn titles(app: &Core, scope: Scope) -> Vec<String> {
    app.list(scope, day())
        .unwrap()
        .into_iter()
        .filter_map(|row| match row {
            ListRow::Task { task } => Some(task.title),
            ListRow::Group { .. } => None,
        })
        .collect()
}

#[derive(Default)]
struct Counter {
    data: AtomicU32,
    sync: Mutex<Vec<SyncStatus>>,
}

impl Listener for Counter {
    fn data_changed(&self) {
        self.data.fetch_add(1, Ordering::SeqCst);
    }
    fn sync_changed(&self, status: SyncStatus) {
        self.sync.lock().unwrap().push(status);
    }
}

fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn capture_list_complete_and_undo() {
    let dir = temp_dir("local");
    let app = open(&dir, "Phone");
    let listener = Arc::new(Counter::default());
    app.set_listener(Some(listener.clone()));

    assert!(app.list(Scope::Inbox, day()).unwrap().is_empty());
    let milk = app
        .capture("Buy milk ^tomorrow !high #errand".into(), day())
        .unwrap();
    app.capture("Call the plumber".into(), day()).unwrap();
    let taxes = app.capture("File taxes ^2026-11-09".into(), day()).unwrap();
    let empty = app.capture("   ".into(), day()).unwrap_err();
    assert!(matches!(empty, AppError::Invalid { .. }));

    let rows = app.list(Scope::Inbox, day()).unwrap();
    let ListRow::Group { label, count, .. } = &rows[0] else {
        panic!("a list starts with its group: {rows:?}");
    };
    assert_eq!((label.as_str(), *count), ("To do", 3));
    let tasks: Vec<_> = rows
        .iter()
        .filter_map(|r| match r {
            ListRow::Task { task } => Some(task),
            ListRow::Group { .. } => None,
        })
        .collect();
    // Default order: overdue first, then priority.
    assert_eq!(tasks[0].id, taxes);
    assert!(tasks[0].overdue);
    assert_eq!(tasks[1].id, milk);
    assert_eq!(tasks[1].title, "Buy milk");
    assert_eq!(tasks[1].priority, Priority::High);
    assert_eq!(tasks[1].due_date.as_deref(), Some("2026-11-11"));
    assert!(!tasks[1].overdue && tasks[1].stage == Stage::Todo);
    assert_eq!(tasks[2].title, "Call the plumber");
    // Overdue shows in Today.
    assert_eq!(titles(&app, Scope::Today), ["File taxes"]);

    // Done leaves the Inbox; undo brings it back.
    app.set_done(milk.clone(), true).unwrap();
    assert_eq!(
        titles(&app, Scope::Inbox),
        ["File taxes", "Call the plumber"]
    );
    assert!(titles(&app, Scope::All).contains(&"Buy milk".to_owned()));
    assert!(app.undo().unwrap());
    assert_eq!(titles(&app, Scope::Inbox).len(), 3);
    app.set_done(milk.clone(), true).unwrap();
    app.set_done(milk, false).unwrap();
    assert_eq!(titles(&app, Scope::Inbox).len(), 3);
    let missing = app.set_done(taskmaster_core::new_id(), true).unwrap_err();
    assert!(matches!(missing, AppError::NotFound { .. }), "{missing:?}");

    wait_for("change notifications", || {
        listener.data.load(Ordering::SeqCst) >= 7
    });

    // Everything is on disk: a fresh Core over the same folder shows it.
    drop(app);
    let again = open(&dir, "Phone");
    assert_eq!(titles(&again, Scope::Inbox).len(), 3);
    assert!(!again.undo().unwrap(), "undo does not cross a restart");
}

#[test]
fn two_phones_sync_through_a_token_server_and_remember_the_account() {
    let (url, state) = server(Config {
        auth: taskmaster_core::AuthMode::Token,
        ..Config::default()
    });
    let (dir_a, dir_b) = (temp_dir("a"), temp_dir("b"));
    let (a, b) = (open(&dir_a, "Phone A"), open(&dir_b, "Phone B"));
    let heard = Arc::new(Counter::default());
    b.set_listener(Some(heard.clone()));

    for (app, name) in [(&a, "a"), (&b, "b")] {
        let status = app.sync_connect(url.clone()).unwrap();
        assert_eq!(status.auth, Some(AuthMode::Token));
        let refused = app.sync_set_token("tm_wrong".into()).unwrap_err();
        assert!(matches!(refused, AppError::Invalid { .. }), "{refused:?}");
        let token = state.tokens.add(name, TokenScope::Sync).unwrap();
        assert!(app.sync_set_token(token).unwrap().signed_in);
        assert!(app.sync_join(JoinMode::Merge).unwrap().joined);
        app.start().unwrap();
        app.start().unwrap();
    }

    // An edit on a reaches b by itself: a's loop pushes, the server announces, b pulls.
    a.capture("Written on a".into(), day()).unwrap();
    wait_for("the task on b", || {
        titles(&b, Scope::Inbox) == ["Written on a"]
    });
    assert!(heard.data.load(Ordering::SeqCst) >= 1, "b's UI was told");
    wait_for("b's round to end", || {
        heard
            .sync
            .lock()
            .unwrap()
            .last()
            .is_some_and(|s| !s.syncing)
    });
    assert!(heard.sync.lock().unwrap().iter().any(|s| s.syncing));

    // A round the app waits on (pull to refresh).
    b.capture("Written on b".into(), day()).unwrap();
    let status = b.sync_now();
    assert_eq!((status.pending, status.last_error), (0, None));
    a.sync_now();
    assert_eq!(titles(&a, Scope::Inbox).len(), 2);

    // The account survives a restart, with its token.
    drop(b);
    let b = open(&dir_b, "Phone B");
    let status = b.sync_status();
    assert!(status.configured && status.signed_in && status.joined);
    assert_eq!(status.url, url);
    assert_eq!(status.auth, None, "not asked yet");
    assert_eq!(b.sync_refresh().auth, Some(AuthMode::Token));

    let status = b.sync_disconnect().unwrap();
    assert!(!status.configured);
    assert!(!dir_b.join("account.json").exists());
    assert_eq!(titles(&b, Scope::Inbox).len(), 2, "the data stays");
}

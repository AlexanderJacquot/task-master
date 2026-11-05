//! End to end: the real server on a local port, desktop-like stores syncing through
//! `taskmaster_client`, and a fake OpenID provider for sign-in.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use taskmaster_client::{Client, Error as ClientError, sync};
use taskmaster_core::*;
use taskmaster_server::auth::{Scope, Tokens};
use taskmaster_server::config::Config;
use taskmaster_server::{AppState, router};

/// A throwaway Ed25519 key for the fake provider (tests only).
/// PKCS#8 DER of `MC4CAQAwBQYDK2VwBCIEIPxEEwQa3utR2MdSoLU2YrEbhPM5cIVr288M6Ib4g+4n`.
const TEST_KEY: &[u8] = &[
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    0xfc, 0x44, 0x13, 0x04, 0x1a, 0xde, 0xeb, 0x51, 0xd8, 0xc7, 0x52, 0xa0, 0xb5, 0x36, 0x62, 0xb1,
    0x1b, 0x84, 0xf3, 0x39, 0x70, 0x85, 0x6b, 0xdb, 0xcf, 0x0c, 0xe8, 0x86, 0xf8, 0x83, 0xee, 0x27,
];
const TEST_KEY_X: &str = "LYbn8iymhGTR8x_Hr0137BqXp6T9nSZtku3zkSwS1f8";

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tm-server-{label}-{}", new_id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Serves `app` on a free local port from its own thread; returns its base URL.
fn spawn_app(app: axum::Router) -> String {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap()).unwrap();
            axum::serve(listener, app).await.unwrap();
        });
    });
    format!("http://{}", rx.recv().unwrap())
}

fn server(config: Config) -> (String, Arc<AppState>) {
    let dir = temp_dir("data");
    let store = Store::open(dir.join("tasks.sqlite")).unwrap();
    let state = AppState::new(
        Config {
            data_dir: dir,
            ..config
        },
        store,
        Tokens::open_in_memory().unwrap(),
    );
    (spawn_app(router(state.clone())), state)
}

/// A device: an in-memory store with an attachment folder, as the desktop holds it.
fn device() -> Mutex<Store> {
    Mutex::new(
        Store::open_in_memory()
            .unwrap()
            .with_files(temp_dir("files")),
    )
}

fn add_task(device: &Mutex<Store>, title: &str) -> String {
    let task = NewTask {
        title: title.into(),
        ..NewTask::default()
    };
    device
        .lock()
        .unwrap()
        .execute(Command::CreateTask { task })
        .unwrap()
        .tasks[0]
        .id
        .clone()
}

fn titles(device: &Mutex<Store>) -> Vec<String> {
    let mut t: Vec<String> = device
        .lock()
        .unwrap()
        .snapshot()
        .unwrap()
        .tasks
        .into_iter()
        .map(|t| t.title)
        .collect();
    t.sort();
    t
}

#[test]
fn two_devices_sync_through_the_server() {
    let (url, state) = server(Config::default());
    let client = Client::new(&url, None);
    let (a, b) = (device(), device());

    add_task(&a, "from a");
    let report = sync(&client, &a).unwrap();
    assert!(report.pushed > 0);
    add_task(&b, "from b");
    taskmaster_client::sync(&client, &b).unwrap();
    taskmaster_client::sync(&client, &a).unwrap();

    assert_eq!(titles(&a), ["from a", "from b"]);
    assert_eq!(titles(&b), ["from a", "from b"]);
    assert_eq!(
        state.store().snapshot().unwrap().tasks.len(),
        2,
        "the server holds both"
    );

    // Nothing new: a round moves nothing.
    let quiet = sync(&client, &a).unwrap();
    assert_eq!((quiet.pushed, quiet.pulled), (0, 0));
}

#[test]
fn a_server_that_lost_its_data_is_refilled_by_the_devices() {
    let (old_url, _) = server(Config::default());
    let a = device();
    add_task(&a, "kept safe on a");
    sync(&Client::new(&old_url, None), &a).unwrap();

    // The server is replaced by an empty one (lost disk, restore from an old backup).
    let (new_url, state) = server(Config::default());
    let report = sync(&Client::new(&new_url, None), &a).unwrap();
    assert!(report.server_reset);
    assert!(report.pushed > 0);
    assert_eq!(state.store().snapshot().unwrap().tasks.len(), 1);

    let b = device();
    sync(&Client::new(&new_url, None), &b).unwrap();
    assert_eq!(titles(&b), ["kept safe on a"]);
    assert!(!sync(&Client::new(&new_url, None), &a).unwrap().server_reset);
}

#[test]
fn many_ops_go_in_pages() {
    let (url, _) = server(Config::default());
    let client = Client::new(&url, None);
    let (a, b) = (device(), device());
    for i in 0..(taskmaster_client::PAGE + 20) {
        add_task(&a, &format!("t{i}"));
    }
    taskmaster_client::sync(&client, &a).unwrap();
    let report = sync(&client, &b).unwrap();
    assert!(report.pulled > taskmaster_client::PAGE);
    assert_eq!(titles(&b).len(), taskmaster_client::PAGE as usize + 20);
}

#[test]
fn attachments_travel_by_hash() {
    let (url, _) = server(Config::default());
    let client = Client::new(&url, None);
    let (a, b) = (device(), device());
    let task_id = add_task(&a, "with a file");
    {
        let mut store = a.lock().unwrap();
        let stored = store
            .files()
            .unwrap()
            .put_bytes(b"hello attachments")
            .unwrap();
        store
            .execute(Command::CreateAttachment {
                attachment: NewAttachment {
                    id: None,
                    task_id,
                    hash: stored.hash.clone(),
                    name: "hello.txt".into(),
                    mime: None,
                    size: stored.size,
                },
            })
            .unwrap();
    }
    let up = sync(&client, &a).unwrap();
    assert_eq!(up.files_up, 1);
    let down = sync(&client, &b).unwrap();
    assert_eq!(down.files_down, 1);
    let store = b.lock().unwrap();
    let attachment = &store.snapshot().unwrap().attachments[0];
    let path = store.files().unwrap().path(&attachment.hash).unwrap();
    assert_eq!(std::fs::read(path).unwrap(), b"hello attachments");
    drop(store);

    // A wrong body for a hash is refused.
    let err = client
        .put_blob(&attachment_hash_of(b"something else"), b"not that")
        .unwrap_err();
    assert!(matches!(err, ClientError::Http(400, _)), "{err}");
}

fn attachment_hash_of(bytes: &[u8]) -> String {
    let files = FileStore::new(temp_dir("hash"));
    files.put_bytes(bytes).unwrap().hash
}

#[test]
fn token_mode_checks_tokens_and_scopes() {
    let (url, state) = server(Config {
        auth: AuthMode::Token,
        ..Config::default()
    });
    let info = Client::new(&url, None).info().unwrap();
    assert_eq!(info.auth, AuthMode::Token);
    assert!(info.oidc_issuer.is_none());

    let a = device();
    add_task(&a, "secret");
    let err = sync(&Client::new(&url, None), &a).unwrap_err();
    assert!(matches!(err, ClientError::Unauthorized(_)), "{err}");
    let err = sync(&Client::new(&url, Some("tm_wrong".into())), &a).unwrap_err();
    assert!(matches!(err, ClientError::Unauthorized(_)), "{err}");

    let read_only = state.tokens.add("dashboard", Scope::ApiRead).unwrap();
    let err = sync(&Client::new(&url, Some(read_only)), &a).unwrap_err();
    assert!(matches!(err, ClientError::Unauthorized(m) if m.contains("api:read")));

    let laptop = state.tokens.add("laptop", Scope::Sync).unwrap();
    sync(&Client::new(&url, Some(laptop.clone())), &a).unwrap();
    state.tokens.revoke("laptop").unwrap();
    let err = sync(&Client::new(&url, Some(laptop)), &a).unwrap_err();
    assert!(matches!(err, ClientError::Unauthorized(_)));
}

#[test]
fn a_different_schema_is_refused() {
    let (url, _) = server(Config::default());
    let client = Client::new(&url, None);
    let a = device();
    add_task(&a, "x");
    let ops = a.lock().unwrap().outbox(10).unwrap().ops;
    let schema = a.lock().unwrap().schema_version().unwrap();
    let err = client
        .push(&PushRequest {
            schema_version: schema + 1,
            ops,
        })
        .unwrap_err();
    assert!(
        matches!(err, ClientError::Schema(ref m) if m.contains("update")),
        "{err}"
    );
}

#[test]
fn events_announce_new_ops() {
    let (url, _) = server(Config::default());
    let client = Client::new(&url, None);
    let (heads_tx, heads_rx) = std::sync::mpsc::channel();
    let watcher = client.clone();
    std::thread::spawn(move || {
        let _ = watcher.watch(|head| heads_tx.send(head).is_ok());
    });
    let first = heads_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(first, 0, "the current head on connect");

    let a = device();
    add_task(&a, "ping");
    let report = sync(&client, &a).unwrap();
    let next = heads_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(next, report.head);
    assert!(next > 0);
}

#[test]
fn the_device_clock_is_corrected_from_the_server() {
    let (url, _) = server(Config::default());
    let a = device();
    // Pretend this device runs a minute behind: sync measures the real offset (~0) and
    // resets it.
    a.lock().unwrap().set_clock_offset(-60_000);
    let report = sync(&Client::new(&url, None), &a).unwrap();
    assert_eq!(report.clock_offset_ms, 0);
    let created = a.lock().unwrap().execute(Command::CreateTask {
        task: NewTask {
            title: "now".into(),
            ..NewTask::default()
        },
    });
    let at = created.unwrap().tasks[0].created_at;
    assert!((now_ms() - at).abs() < 5_000);
}

// ---------------------------------------------------------------------------------------
// OpenID Connect

/// A provider that publishes the test key; returns its issuer URL.
fn fake_provider() -> String {
    let issuer = Arc::new(Mutex::new(String::new()));
    let for_routes = issuer.clone();
    let app = axum::Router::new()
        .route(
            "/.well-known/openid-configuration",
            axum::routing::get(move || {
                let issuer = for_routes.lock().unwrap().clone();
                async move {
                    axum::Json(json!({ "issuer": issuer, "jwks_uri": format!("{issuer}/jwks") }))
                }
            }),
        )
        .route(
            "/jwks",
            axum::routing::get(|| async {
                axum::Json(json!({ "keys": [{
                    "kty": "OKP", "crv": "Ed25519", "x": TEST_KEY_X,
                    "kid": "test", "alg": "EdDSA", "use": "sig"
                }]}))
            }),
        );
    let url = spawn_app(app);
    *issuer.lock().unwrap() = url.clone();
    url
}

fn id_token(issuer: &str, audience: &str, groups: &[&str], expires_in: i64) -> String {
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::EdDSA);
    header.kid = Some("test".into());
    let now = now_ms() / 1000;
    let claims = json!({
        "iss": issuer, "aud": audience, "sub": "u-123", "preferred_username": "alex",
        "groups": groups, "iat": now, "exp": now + expires_in,
    });
    let key = jsonwebtoken::EncodingKey::from_ed_der(TEST_KEY);
    jsonwebtoken::encode(&header, &claims, &key).unwrap()
}

#[test]
fn oidc_sign_in_gives_a_device_token() {
    let issuer = fake_provider();
    let (url, state) = server(Config {
        auth: AuthMode::Oidc,
        oidc_issuer: Some(issuer.clone()),
        oidc_allowed_groups: vec!["family".into()],
        ..Config::default()
    });
    let anonymous = Client::new(&url, None);
    let info = anonymous.info().unwrap();
    assert_eq!(info.auth, AuthMode::Oidc);
    assert_eq!(info.oidc_issuer.as_deref(), Some(issuer.as_str()));
    assert_eq!(info.oidc_client_id.as_deref(), Some("task-master"));

    let issued = anonymous
        .oidc_exchange(
            &id_token(&issuer, "task-master", &["family"], 300),
            "Laptop",
        )
        .unwrap();
    assert_eq!(issued.name, "alex@Laptop");
    assert_eq!(state.tokens.check(&issued.token), Some(Scope::Sync));
    let a = device();
    add_task(&a, "signed in");
    sync(&Client::new(&url, Some(issued.token)), &a).unwrap();

    // Refused: another audience, an expired token, a group not allowed, a bad signature.
    for (token, why) in [
        (
            id_token(&issuer, "someone-else", &["family"], 300),
            "audience",
        ),
        (
            id_token(&issuer, "task-master", &["family"], -3_600),
            "expired",
        ),
        (id_token(&issuer, "task-master", &["guests"], 300), "group"),
        (
            id_token("https://evil.example", "task-master", &["family"], 300),
            "issuer",
        ),
    ] {
        let err = anonymous.oidc_exchange(&token, "x").unwrap_err();
        assert!(matches!(err, ClientError::Unauthorized(_)), "{why}: {err}");
    }
    let mut forged = id_token(&issuer, "task-master", &["family"], 300);
    forged.replace_range(forged.len() - 4.., "AAAA");
    assert!(anonymous.oidc_exchange(&forged, "x").is_err());
}

#[test]
fn oidc_exchange_is_off_in_other_modes() {
    let (url, _) = server(Config::default());
    let err = Client::new(&url, None)
        .oidc_exchange("whatever", "x")
        .unwrap_err();
    assert!(matches!(err, ClientError::Http(404, _)));
}

#[test]
fn backup_cycle_writes_a_daily_copy() {
    let (_, state) = server(Config::default());
    let uploaded = taskmaster_server::backup::cycle(&state).unwrap();
    assert!(uploaded.is_empty(), "no bucket configured");
    let names: Vec<String> = std::fs::read_dir(state.backup_dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(names.iter().any(|n| n.starts_with("daily-")), "{names:?}");
}

#[test]
fn backups_and_attachment_content_upload_to_the_bucket_once() {
    // A fake S3 endpoint that records the keys PUT to it.
    let keys = Arc::new(Mutex::new(Vec::<String>::new()));
    let recorded = keys.clone();
    let s3 = spawn_app(axum::Router::new().route(
        "/{*key}",
        axum::routing::put(
            // Reads the whole body, as S3 does (replying early breaks the upload's pipe).
            move |axum::extract::Path(key): axum::extract::Path<String>,
                  body: axum::body::Bytes| {
                assert!(!body.is_empty());
                recorded.lock().unwrap().push(key);
                async { axum::http::StatusCode::OK }
            },
        ),
    ));
    let (_, state) = server(Config {
        backup: Some(taskmaster_server::config::S3Backup {
            endpoint: s3,
            region: "garage".into(),
            bucket: "tm".into(),
            access_key: "GK1".into(),
            secret_key: "secret".into(),
            prefix: "nightly".into(),
        }),
        ..Config::default()
    });
    let hash = state
        .store()
        .files()
        .unwrap()
        .put_bytes(b"photo")
        .unwrap()
        .hash;

    let first = taskmaster_server::backup::cycle(&state).unwrap();
    assert_eq!(first.len(), 2, "{first:?}");
    assert!(first.iter().any(|k| k.starts_with("nightly/server/daily-")));
    assert!(first.contains(&format!("nightly/attachments/{hash}")));
    let stored = keys.lock().unwrap().clone();
    assert!(
        stored.iter().all(|k| k.starts_with("tm/nightly/")),
        "{stored:?}"
    );

    assert!(
        taskmaster_server::backup::cycle(&state).unwrap().is_empty(),
        "uploaded once"
    );
}

#[test]
fn health_answers() {
    let (url, _) = server(Config::default());
    let started = Instant::now();
    let agent: ureq::Agent = ureq::Agent::config_builder().build().into();
    let body = agent
        .get(format!("{url}/health"))
        .call()
        .unwrap()
        .body_mut()
        .read_to_string()
        .unwrap();
    assert_eq!(body, "ok");
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn a_surviving_replica_restores_other_devices_work() {
    let (url, _) = server(Config::default());
    let a = device();
    let b = device();
    let task_id = add_task(&a, "created on a");
    sync(&Client::new(&url, None), &a).unwrap();
    sync(&Client::new(&url, None), &b).unwrap();
    b.lock()
        .unwrap()
        .execute(Command::UpdateTask {
            id: task_id,
            changes: vec![TaskChange::Title("edited on b".into())],
        })
        .unwrap();
    sync(&Client::new(&url, None), &b).unwrap();

    // Only b survives. Its received create must precede its own update on the new server.
    let (url, state) = server(Config::default());
    sync(&Client::new(&url, None), &b).unwrap();
    assert_eq!(
        state.store().snapshot().unwrap().tasks[0].title,
        "edited on b"
    );
    let c = device();
    sync(&Client::new(&url, None), &c).unwrap();
    assert_eq!(titles(&c), ["edited on b"]);
}

#[test]
fn skipped_pushes_remain_pending() {
    let (url, _) = server(Config::default());
    let server_client = Client::new(&url, None);
    let schema = device().lock().unwrap().schema_version().unwrap();
    let fake = spawn_app(
        axum::Router::new()
            .route(
                "/info",
                axum::routing::get(move || {
                    let info = server_client.info().unwrap();
                    async move { axum::Json(info) }
                }),
            )
            .route(
                "/sync/push",
                axum::routing::post(|| async {
                    axum::Json(PushResult {
                        skipped: 1,
                        ..PushResult::default()
                    })
                }),
            ),
    );
    let a = device();
    add_task(&a, "must stay pending");
    assert_eq!(a.lock().unwrap().schema_version().unwrap(), schema);
    let err = sync(&Client::new(&fake, None), &a).unwrap_err();
    assert!(matches!(err, ClientError::Protocol(_)));
    assert_eq!(a.lock().unwrap().outbox(10).unwrap().ops.len(), 1);
}

#[allow(dead_code)]
#[path = "../../core/tests/support/calendar.rs"]
mod calendar_fake;

#[test]
fn calendar_handoff_relinks_without_duplicates_and_google_edits_sync_back() {
    use taskmaster_core::calendar::*;
    let (url, state) = server(Config::default());
    let client = Client::new(&url, None);
    let a = device();
    let b = device();
    let id = add_task(&a, "calendar handoff");
    let now = now_ms();
    a.lock()
        .unwrap()
        .execute(Command::CreateTimeBlock {
            block: NewTimeBlock {
                id: None,
                task_id: id,
                start_at: now + 3_600_000,
                end_at: now + 7_200_000,
                outcome: None,
            },
        })
        .unwrap();
    let mut google = calendar_fake::FakeServer::with_primary();
    taskmaster_core::calendar::sync(&a, &mut google, now, &utc_date(now)).unwrap();
    let target = google.target();
    let event_id = google.live(&target)[0].id.clone();
    taskmaster_client::sync(&client, &a).unwrap();
    let a_id = a.lock().unwrap().device_id().to_owned();
    let credentials = GoogleCredentials {
        client_id: "client".into(),
        client_secret: "secret".into(),
        refresh_token: "refresh".into(),
    };
    assert!(client.calendar_lease(&a_id, false).unwrap());
    let transfer = client
        .calendar_runner(&RunnerRequest {
            runner: CalendarRunner::Server,
            device_id: a_id.clone(),
            credentials: Some(credentials.clone()),
        })
        .unwrap();
    assert!(
        transfer.credentials.is_none(),
        "server selection never returns credentials"
    );
    assert!(!client.calendar_lease(&a_id, false).unwrap());
    google.writes.clear();
    taskmaster_server::calendar::cycle_with(&state, &mut google).unwrap();
    assert!(
        !google
            .writes
            .iter()
            .any(|w| w.starts_with("insert") || w.starts_with("create_calendar")),
        "handoff relinks existing events: {:?}",
        google.writes
    );
    assert_eq!(google.live(&target).len(), 1);

    google.user_edit(&target, &event_id, |event| {
        event.when = Some(When::Timed {
            start_at: now + 10_800_000,
            end_at: now + 14_400_000,
        })
    });
    taskmaster_server::calendar::cycle_with(&state, &mut google).unwrap();
    taskmaster_client::sync(&client, &b).unwrap();
    assert_eq!(
        b.lock().unwrap().snapshot().unwrap().time_blocks[0].start_at,
        now + 10_800_000
    );
    assert!(client.calendar_status().unwrap().last_sync_at.is_some());
    google.user_add(
        "me@example.com",
        "External meeting",
        When::Timed {
            start_at: now + 1000,
            end_at: now + 2000,
        },
    );
    client.calendar_shown("me@example.com", true).unwrap();
    taskmaster_server::calendar::cycle_with(&state, &mut google).unwrap();
    let visible = client
        .calendar_events(&EventRange {
            from: now,
            to: now + 86_400_000,
            from_date: utc_date(now),
            to_date: utc_date(now + 86_400_000),
        })
        .unwrap();
    assert!(
        visible
            .iter()
            .any(|event| event.title == "External meeting")
    );

    // The selection and credentials survive a server restart, with owner-only file mode.
    let reopened = AppState::open(state.config.clone()).unwrap();
    let reopened_client = Client::new(&spawn_app(router(reopened)), None);
    assert_eq!(
        reopened_client.calendar_status().unwrap().runner,
        CalendarRunner::Server
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(state.config.data_dir.join("calendar.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let b_id = b.lock().unwrap().device_id().to_owned();
    let transfer = client
        .calendar_runner(&RunnerRequest {
            runner: CalendarRunner::ThisDevice,
            device_id: b_id.clone(),
            credentials: None,
        })
        .unwrap();
    assert!(transfer.credentials == Some(credentials));
    assert!(client.calendar_lease(&b_id, false).unwrap());
    assert!(!client.calendar_lease(&a_id, false).unwrap());
    assert!(
        client
            .calendar_runner(&RunnerRequest {
                runner: CalendarRunner::Server,
                device_id: a_id.clone(),
                credentials: None
            })
            .is_err()
    );
    google.writes.clear();
    taskmaster_server::calendar::cycle_with(&state, &mut google).unwrap();
    assert!(
        google.writes.is_empty(),
        "server stops after transfer to a desktop"
    );
    taskmaster_core::calendar::sync(&b, &mut google, now_ms(), &utc_date(now_ms())).unwrap();
    assert_eq!(google.live(&target).len(), 1);
    assert!(client.calendar_lease(&b_id, true).unwrap());
    assert!(client.calendar_lease(&a_id, false).unwrap());
}

#[test]
fn calendar_controls_require_a_sync_token_and_do_not_expose_credentials() {
    use taskmaster_core::calendar::*;
    let (url, state) = server(Config {
        auth: AuthMode::Token,
        ..Config::default()
    });
    let anonymous = Client::new(&url, None);
    assert!(matches!(
        anonymous.calendar_status(),
        Err(ClientError::Unauthorized(_))
    ));
    assert!(matches!(
        anonymous.calendar_lease("device", false),
        Err(ClientError::Unauthorized(_))
    ));
    let read = state.tokens.add("read", Scope::ApiRead).unwrap();
    assert!(Client::new(&url, Some(read)).calendar_status().is_err());
    let token = state.tokens.add("device", Scope::Sync).unwrap();
    let client = Client::new(&url, Some(token));
    client
        .calendar_runner(&RunnerRequest {
            runner: CalendarRunner::Server,
            device_id: "device".into(),
            credentials: Some(GoogleCredentials {
                client_id: "id".into(),
                client_secret: "private-secret".into(),
                refresh_token: "private-refresh".into(),
            }),
        })
        .unwrap();
    let status = serde_json::to_string(&client.calendar_status().unwrap()).unwrap();
    assert!(!status.contains("private-secret") && !status.contains("private-refresh"));
    assert!(
        client
            .calendar_lease("other", false)
            .is_ok_and(|granted| !granted)
    );
}

#[test]
fn calendar_handoff_waits_for_the_active_google_round() {
    use taskmaster_core::calendar::*;
    let (url, state) = server(Config::default());
    let client = Client::new(&url, None);
    client
        .calendar_runner(&RunnerRequest {
            runner: CalendarRunner::Server,
            device_id: "a".into(),
            credentials: Some(GoogleCredentials {
                client_id: "id".into(),
                client_secret: "secret".into(),
                refresh_token: "refresh".into(),
            }),
        })
        .unwrap();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (continue_tx, continue_rx) = std::sync::mpsc::channel();
    let mut google = calendar_fake::FakeServer::with_primary();
    google.before_calendars = Some(Box::new(move || {
        started_tx.send(()).unwrap();
        continue_rx.recv().unwrap();
    }));
    let running = state.clone();
    let round = std::thread::spawn(move || {
        taskmaster_server::calendar::cycle_with(&running, &mut google).unwrap()
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let transfer = std::thread::spawn(move || {
        let result = client.calendar_runner(&RunnerRequest {
            runner: CalendarRunner::ThisDevice,
            device_id: "b".into(),
            credentials: None,
        });
        done_tx.send(result.is_ok()).unwrap();
    });
    assert!(
        done_rx.recv_timeout(Duration::from_millis(100)).is_err(),
        "handoff must wait for the active provider"
    );
    continue_tx.send(()).unwrap();
    assert!(done_rx.recv_timeout(Duration::from_secs(5)).unwrap());
    round.join().unwrap();
    transfer.join().unwrap();
}

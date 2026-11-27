//! Team spaces on the server (ADR 033, T3): `TM_TEAM`, users and their tokens, the team
//! space shared by members, a personal space per member, and the checks on team pushes.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use taskmaster_client::{Client, Error as ClientError, sync};
use taskmaster_core::*;
use taskmaster_server::auth::{Scope, Tokens};
use taskmaster_server::config::Config;
use taskmaster_server::{AppState, router};

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tm-team-{label}-{}", new_id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

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

struct Team {
    url: String,
    state: Arc<AppState>,
    ada: (String, String),
    bob: (String, String),
}

/// A team server with two members, Ada and Bob, each with a device token.
fn team_server() -> Team {
    let dir = temp_dir("data");
    let tokens = Tokens::open_in_memory().unwrap();
    let ada = tokens.add_user("Ada").unwrap();
    let bob = tokens.add_user("Bob").unwrap();
    let ada_token = tokens
        .add_for("ada-laptop", Scope::Sync, Some(&ada.id))
        .unwrap();
    let bob_token = tokens
        .add_for("bob-laptop", Scope::Sync, Some(&bob.id))
        .unwrap();
    let state = AppState::new(
        Config {
            data_dir: dir.clone(),
            auth: AuthMode::Token,
            team: true,
            team_name: "Platform".into(),
            ..Config::default()
        },
        Store::open(dir.join("tasks.sqlite")).unwrap(),
        tokens,
    );
    Team {
        url: spawn_app(router(state.clone())),
        state,
        ada: (ada.id, ada_token),
        bob: (bob.id, bob_token),
    }
}

/// A device's copy of the team space, as the desktop keeps it.
fn team_device(member: &str) -> Mutex<Store> {
    let mut store = Store::open_in_memory()
        .unwrap()
        .with_files(temp_dir("files"));
    store.set_author(Some(member.into()));
    store.set_repairs(false);
    Mutex::new(store)
}

fn personal_device() -> Mutex<Store> {
    Mutex::new(
        Store::open_in_memory()
            .unwrap()
            .with_files(temp_dir("files")),
    )
}

fn add_task(device: &Mutex<Store>, title: &str) -> Task {
    device
        .lock()
        .unwrap()
        .execute(Command::CreateTask {
            task: NewTask {
                title: title.into(),
                ..NewTask::default()
            },
        })
        .unwrap()
        .tasks
        .remove(0)
}

fn titles(device: &Mutex<Store>) -> Vec<String> {
    let mut out: Vec<String> = device
        .lock()
        .unwrap()
        .snapshot()
        .unwrap()
        .tasks
        .into_iter()
        .map(|t| t.title)
        .collect();
    out.sort();
    out
}

#[test]
fn a_personal_server_says_nothing_of_teams() {
    let dir = temp_dir("plain");
    let state = AppState::new(
        Config {
            data_dir: dir.clone(),
            ..Config::default()
        },
        Store::open(dir.join("tasks.sqlite")).unwrap(),
        Tokens::open_in_memory().unwrap(),
    );
    let url = spawn_app(router(state));
    let client = Client::new(&url, None);
    assert_eq!(client.info().unwrap().team, None);
    match client.team().pull(0, 10) {
        Err(ClientError::Http(404, _)) => {}
        other => panic!("expected no team routes, got {other:?}"),
    }
}

#[test]
fn team_mode_needs_tokens() {
    let err = Config::from_vars(|k| (k == "TM_TEAM").then(|| "on".to_owned())).unwrap_err();
    assert!(err.contains("TM_AUTH=token"), "{err}");
    let config = Config::from_vars(|k| match k {
        "TM_TEAM" => Some("on".into()),
        "TM_AUTH" => Some("token".into()),
        "TM_TEAM_NAME" => Some("Platform".into()),
        _ => None,
    })
    .unwrap();
    assert!(config.team);
    assert_eq!(config.team_name, "Platform");
}

#[test]
fn info_names_the_team_and_the_caller() {
    let t = team_server();
    let info = Client::new(&t.url, Some(t.ada.1.clone())).info().unwrap();
    let team = info.team.expect("a team");
    assert_eq!(team.name, "Platform");
    assert_eq!(team.me.map(|m| m.name).as_deref(), Some("Ada"));
    let anonymous = Client::new(&t.url, None).info().unwrap().team.unwrap();
    assert_eq!(anonymous.me, None);
}

#[test]
fn members_share_the_team_space_and_keep_their_own() {
    let t = team_server();
    let ada = Client::new(&t.url, Some(t.ada.1.clone()));
    let bob = Client::new(&t.url, Some(t.bob.1.clone()));

    let ada_team = team_device(&t.ada.0);
    let bob_team = team_device(&t.bob.0);
    let ada_mine = personal_device();
    let bob_mine = personal_device();

    let shared = add_task(&ada_team, "Ship the API");
    add_task(&ada_mine, "Ada's errand");
    add_task(&bob_mine, "Bob's errand");
    for (client, store) in [
        (ada.team(), &ada_team),
        (ada.clone(), &ada_mine),
        (bob.clone(), &bob_mine),
        (bob.team(), &bob_team),
    ] {
        sync(&client, store).unwrap();
    }

    // Bob sees Ada's team task, made by her, and both members.
    assert_eq!(titles(&bob_team), ["Ship the API"]);
    let snapshot = bob_team.lock().unwrap().snapshot().unwrap();
    assert_eq!(
        snapshot.tasks[0].reporter_id.as_deref(),
        Some(t.ada.0.as_str())
    );
    let names: Vec<String> = snapshot.members.into_iter().map(|m| m.name).collect();
    assert_eq!(names, ["Ada", "Bob"]);

    // Personal spaces stay apart, on separate databases.
    assert_eq!(titles(&ada_mine), ["Ada's errand"]);
    assert_eq!(titles(&bob_mine), ["Bob's errand"]);
    assert!(t.state.store().snapshot().unwrap().tasks.is_empty());

    // Bob assigns it to himself; Ada gets the change, by Bob.
    bob_team
        .lock()
        .unwrap()
        .execute(Command::UpdateTask {
            id: shared.id.clone(),
            changes: vec![TaskChange::AssigneeId(Some(t.bob.0.clone()))],
        })
        .unwrap();
    sync(&bob.team(), &bob_team).unwrap();
    sync(&ada.team(), &ada_team).unwrap();
    let task = ada_team.lock().unwrap().task(&shared.id).unwrap();
    assert_eq!(task.assignee_id.as_deref(), Some(t.bob.0.as_str()));
    let activity = ada_team
        .lock()
        .unwrap()
        .task_activity(&shared.id, 5)
        .unwrap();
    assert_eq!(activity[0].author_id.as_deref(), Some(t.bob.0.as_str()));
}

#[test]
fn nobody_pushes_in_someone_elses_name() {
    let t = team_server();
    let ada = Client::new(&t.url, Some(t.ada.1.clone()));
    // A device that writes as Bob but holds Ada's token.
    let forged = team_device(&t.bob.0);
    add_task(&forged, "Not mine");
    match sync(&ada.team(), &forged) {
        Err(ClientError::Unauthorized(message)) => {
            assert!(message.contains("another author"), "{message}");
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    // Members are the server's.
    let rogue = team_device(&t.ada.0);
    rogue
        .lock()
        .unwrap()
        .execute(Command::CreateMember {
            member: NewMember {
                id: new_id(),
                name: "Mallory".into(),
                color: None,
            },
        })
        .unwrap();
    assert!(matches!(
        sync(&ada.team(), &rogue),
        Err(ClientError::Unauthorized(_))
    ));
}

#[test]
fn a_token_of_no_member_stays_out_of_the_team() {
    let t = team_server();
    let service = t.state.tokens.add("dashboard", Scope::Sync).unwrap();
    let client = Client::new(&t.url, Some(service));
    assert!(matches!(
        client.team().pull(0, 10),
        Err(ClientError::Unauthorized(_))
    ));
    // Its personal routes are the server's own space, as on a personal server.
    let device = personal_device();
    add_task(&device, "Server's own");
    sync(&client, &device).unwrap();
    assert_eq!(t.state.store().snapshot().unwrap().tasks.len(), 1);
}

#[test]
fn a_removed_member_loses_the_team() {
    let t = team_server();
    let bob = Client::new(&t.url, Some(t.bob.1.clone()));
    let device = team_device(&t.bob.0);
    sync(&bob.team(), &device).unwrap();
    assert_eq!(device.lock().unwrap().snapshot().unwrap().members.len(), 2);

    t.state.tokens.remove_user(&t.bob.0).unwrap();
    assert!(matches!(
        sync(&bob.team(), &device),
        Err(ClientError::Unauthorized(_))
    ));
    // Ada's next sync learns Bob left; his tasks would keep naming him.
    let ada = Client::new(&t.url, Some(t.ada.1.clone()));
    let ada_device = team_device(&t.ada.0);
    sync(&ada.team(), &ada_device).unwrap();
    let names: Vec<String> = ada_device
        .lock()
        .unwrap()
        .snapshot()
        .unwrap()
        .members
        .into_iter()
        .map(|m| m.name)
        .collect();
    assert_eq!(names, ["Ada"]);
}

#[test]
fn team_attachments_move_through_the_team_routes() {
    let t = team_server();
    let ada = Client::new(&t.url, Some(t.ada.1.clone()));
    let bob = Client::new(&t.url, Some(t.bob.1.clone()));
    let ada_team = team_device(&t.ada.0);
    let task = add_task(&ada_team, "Spec");
    {
        let mut store = ada_team.lock().unwrap();
        let stored = store.files().unwrap().put_bytes(b"the spec").unwrap();
        store
            .execute(Command::CreateAttachment {
                attachment: NewAttachment {
                    id: None,
                    task_id: Some(task.id.clone()),
                    meeting_id: None,
                    note_id: None,
                    hash: stored.hash,
                    name: "spec.txt".into(),
                    mime: None,
                    size: 8,
                },
            })
            .unwrap();
    }
    let up = sync(&ada.team(), &ada_team).unwrap();
    assert_eq!(up.files_up, 1);
    let bob_team = team_device(&t.bob.0);
    let down = sync(&bob.team(), &bob_team).unwrap();
    assert_eq!(down.files_down, 1);
    let team = t.state.team.as_ref().unwrap();
    assert_eq!(team.store().files().unwrap().hashes().unwrap().len(), 1);
    assert!(
        t.state
            .store()
            .files()
            .unwrap()
            .hashes()
            .unwrap()
            .is_empty()
    );
}

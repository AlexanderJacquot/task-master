//! The team space on the phone (ADR 033, ADR 040): a phone whose token belongs to a team
//! member syncs the team's space next to its own, shows both as one, writes each edit to
//! the space that owns it, and drops the team's copy when its token no longer belongs to
//! a member.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use taskmaster_client::{Client, sync};
use taskmaster_core::{AuthMode, Command, NewProject, NewTask, Store, Task, TaskChange};
use taskmaster_mobile::{
    Core, Day, JoinMode, ListRow, NewTaskInput, Scope, Stage, TaskEdit, TaskRow,
};
use taskmaster_server::auth::{Scope as TokenScope, Tokens};
use taskmaster_server::config::Config;
use taskmaster_server::{AppState, router};

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tm-mobile-team-{label}-{}",
        taskmaster_core::new_id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn day() -> Day {
    Day {
        today: "2026-11-22".into(),
        utc_offset_min: 60,
    }
}

fn serve(app: axum::Router) -> String {
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
    /// Member id and device token.
    ada: (String, String),
    bob: (String, String),
}

/// A team server ("Platform") with two members, Ada and Bob, each with a device token.
fn team_server() -> Team {
    let dir = temp_dir("server");
    let tokens = Tokens::open_in_memory().unwrap();
    let ada = tokens.add_user("Ada").unwrap();
    let bob = tokens.add_user("Bob").unwrap();
    let ada_token = tokens
        .add_for("ada-phone", TokenScope::Sync, Some(&ada.id))
        .unwrap();
    let bob_token = tokens
        .add_for("bob-laptop", TokenScope::Sync, Some(&bob.id))
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
        url: serve(router(state.clone())),
        state,
        ada: (ada.id, ada_token),
        bob: (bob.id, bob_token),
    }
}

/// Bob's desktop copy of the team space.
fn bob_team(member: &str) -> Mutex<Store> {
    let mut store = Store::open_in_memory()
        .unwrap()
        .with_files(temp_dir("bob-files"));
    store.set_author(Some(member.into()));
    store.set_repairs(false);
    Mutex::new(store)
}

fn open(dir: &Path) -> Arc<Core> {
    Core::open(dir.to_string_lossy().into_owned(), "Ada's phone".into()).unwrap()
}

/// A phone signed in with `token`, joined and synced once.
fn phone(dir: &Path, url: &str, token: &str) -> Arc<Core> {
    let app = open(dir);
    app.sync_connect(url.into()).unwrap();
    app.sync_set_token(token.into()).unwrap();
    app.sync_join(JoinMode::Merge).unwrap();
    let status = app.sync_now();
    assert_eq!(status.last_error, None);
    app
}

fn rows(app: &Core, scope: Scope) -> Vec<TaskRow> {
    app.list(scope, day())
        .unwrap()
        .into_iter()
        .filter_map(|row| match row {
            ListRow::Task { task } => Some(task),
            ListRow::Group { .. } => None,
        })
        .collect()
}

fn titles(app: &Core, scope: Scope) -> Vec<String> {
    let mut out: Vec<String> = rows(app, scope).into_iter().map(|t| t.title).collect();
    out.sort();
    out
}

fn task_in(store: &Mutex<Store>, id: &str) -> Task {
    store.lock().unwrap().task(id).unwrap()
}

#[test]
fn a_member_phone_syncs_the_team_space_beside_its_own() {
    let t = team_server();
    let bob = Client::new(&t.url, Some(t.bob.1.clone()));
    let bob_team = bob_team(&t.bob.0);

    // Bob's desktop (members come from the server, with the first round): a team project
    // with a task for Ada, one for himself, and a team task in no project.
    sync(&bob.team(), &bob_team).unwrap();
    let project = bob_team
        .lock()
        .unwrap()
        .execute(Command::CreateProject {
            project: NewProject {
                name: "API".into(),
                ..NewProject::default()
            },
        })
        .unwrap()
        .projects
        .remove(0);
    let add = |title: &str, project: Option<&str>, assignee: Option<&str>, due: Option<&str>| {
        bob_team
            .lock()
            .unwrap()
            .execute(Command::CreateTask {
                task: NewTask {
                    title: title.into(),
                    project_id: project.map(Into::into),
                    assignee_id: assignee.map(Into::into),
                    due_date: due.map(Into::into),
                    ..NewTask::default()
                },
            })
            .unwrap()
            .tasks
            .remove(0)
    };
    let ship = add(
        "Ship the API",
        Some(&project.id),
        Some(&t.ada.0),
        Some("2026-11-22"),
    );
    add(
        "Review the schema",
        Some(&project.id),
        Some(&t.bob.0),
        Some("2026-11-22"),
    );
    add("Team offsite idea", None, None, None);
    sync(&bob.team(), &bob_team).unwrap();

    // Ada's phone: her own task, then she joins.
    let dir = temp_dir("ada");
    let pre = open(&dir);
    pre.capture("Buy stamps".into(), day()).unwrap();
    drop(pre);
    let app = phone(&dir, &t.url, &t.ada.1);

    let status = app.sync_status();
    assert_eq!(status.team_name.as_deref(), Some("Platform"));
    assert_eq!(status.team_member.as_deref(), Some("Ada"));
    assert_eq!(status.pending, 0);

    // Both spaces in one list; the team's Inbox task is not in hers.
    assert_eq!(
        titles(&app, Scope::All),
        [
            "Buy stamps",
            "Review the schema",
            "Ship the API",
            "Team offsite idea"
        ]
    );
    assert_eq!(titles(&app, Scope::Inbox), ["Buy stamps"]);
    let shown = rows(
        &app,
        Scope::Project {
            id: project.id.clone(),
        },
    );
    let mine = shown.iter().find(|r| r.id == ship.id).unwrap();
    assert!(mine.team);
    assert_eq!(mine.assignee.as_deref(), Some("Ada"));
    assert!(!rows(&app, Scope::Inbox)[0].team);

    let nav = app.navigation(day()).unwrap();
    let team = nav.team.expect("a team section");
    assert_eq!(team.name, "Platform");
    let members: Vec<(&str, bool)> = team
        .members
        .iter()
        .map(|m| (m.name.as_str(), m.me))
        .collect();
    assert_eq!(members, [("Ada", true), ("Bob", false)]);
    assert!(!team.statuses.is_empty());
    let api = nav.projects.iter().find(|p| p.id == project.id).unwrap();
    assert!(api.team);
    assert_eq!(nav.counts.inbox, 1);

    // The team project's board has the team's columns and its cards.
    let board = app
        .board(
            Scope::Project {
                id: project.id.clone(),
            },
            day(),
        )
        .unwrap();
    let cards: usize = board.iter().map(|c| c.cards.len()).sum();
    assert_eq!(cards, 2);
    assert_eq!(
        board.len(),
        team.statuses.len() - 1,
        "cancelled is left out"
    );

    // A team task's due date reminds its assignee only.
    let from = 0;
    let to = i64::MAX;
    let reminded: Vec<String> = app
        .reminders(from, to, 9 * 60, day())
        .unwrap()
        .into_iter()
        .map(|r| r.title)
        .collect();
    assert_eq!(reminded, ["Ship the API"]);

    // Edits on the phone land in the team space: done, a picked Today (personal: Bob's
    // copy is not picked), a team tag, a new task in the team project.
    app.set_done(ship.id.clone(), true).unwrap();
    app.edit_task(ship.id.clone(), vec![TaskEdit::Today { on: true }], day())
        .unwrap();
    let tag = app
        .create_tag("backend".into(), Some(ship.id.clone()))
        .unwrap();
    let detail_tags = |app: &Core| {
        app.task(ship.id.clone(), day())
            .unwrap()
            .tags
            .into_iter()
            .map(|t| (t.name, t.team))
            .collect::<Vec<_>>()
    };
    app.set_tags(ship.id.clone(), vec![tag.clone()]).unwrap();
    assert_eq!(detail_tags(&app), [("backend".to_owned(), true)]);
    let docs = app
        .add_task(
            NewTaskInput {
                title: "Write the docs".into(),
                project_id: Some(project.id.clone()),
                ..NewTaskInput::default()
            },
            day(),
        )
        .unwrap();
    assert!(titles(&app, Scope::Today).contains(&"Ship the API".to_owned()));
    assert!(app.sync_status().pending > 0);
    assert_eq!(app.sync_now().last_error, None);
    assert_eq!(app.sync_status().pending, 0);

    sync(&bob.team(), &bob_team).unwrap();
    let on_bob = task_in(&bob_team, &ship.id);
    let done = bob_team
        .lock()
        .unwrap()
        .snapshot()
        .unwrap()
        .statuses
        .into_iter()
        .find(|s| s.id == on_bob.status_id)
        .unwrap();
    assert_eq!(done.category, taskmaster_core::StatusCategory::Done);
    assert_eq!(on_bob.today_on, None, "Ada's Today pick stays hers");
    assert_eq!(on_bob.tag_ids, std::slice::from_ref(&tag));
    assert_eq!(
        task_in(&bob_team, &docs).project_id.as_deref(),
        Some(&*project.id)
    );
    // Her own task never went to the team.
    assert!(
        bob_team
            .lock()
            .unwrap()
            .snapshot()
            .unwrap()
            .tasks
            .iter()
            .all(|t| t.title != "Buy stamps")
    );

    // Undo reaches the team space too.
    assert!(app.undo().unwrap());
    assert!(!titles(&app, Scope::All).contains(&"Write the docs".to_owned()));
    assert!(app.redo().unwrap());

    // Bob reassigns; the phone gets it.
    bob_team
        .lock()
        .unwrap()
        .execute(Command::UpdateTask {
            id: ship.id.clone(),
            changes: vec![TaskChange::AssigneeId(Some(t.bob.0.clone()))],
        })
        .unwrap();
    sync(&bob.team(), &bob_team).unwrap();
    app.sync_now();
    let detail = app.task(ship.id.clone(), day()).unwrap();
    assert_eq!(detail.row.assignee.as_deref(), Some("Bob"));
    assert_eq!(detail.row.stage, Stage::Done);
    // And she can hand it back from the phone.
    app.edit_task(
        ship.id.clone(),
        vec![TaskEdit::Assignee {
            member_id: Some(t.ada.0.clone()),
        }],
        day(),
    )
    .unwrap();
    app.sync_now();
    sync(&bob.team(), &bob_team).unwrap();
    assert_eq!(
        task_in(&bob_team, &ship.id).assignee_id.as_deref(),
        Some(&*t.ada.0)
    );

    // Offline after a restart, the team's work is still there.
    drop(app);
    let again = open(&dir);
    assert!(titles(&again, Scope::All).contains(&"Ship the API".to_owned()));
    assert!(again.navigation(day()).unwrap().team.is_some());

    // With the background loops running, Bob's next edit arrives by the team's event
    // stream alone.
    again.start().unwrap();
    bob_team
        .lock()
        .unwrap()
        .execute(Command::UpdateTask {
            id: ship.id.clone(),
            changes: vec![TaskChange::Title("Ship the API v2".into())],
        })
        .unwrap();
    sync(&bob.team(), &bob_team).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !titles(&again, Scope::All).contains(&"Ship the API v2".to_owned()) {
        assert!(Instant::now() < deadline, "the team edit never arrived");
        std::thread::sleep(Duration::from_millis(50));
    }

    // A token of no member: the team space closes and its copy goes.
    let service = t.state.tokens.add("ada-other", TokenScope::Sync).unwrap();
    again.sync_set_token(service).unwrap();
    assert_eq!(again.sync_now().last_error, None);
    assert_eq!(titles(&again, Scope::All), ["Buy stamps"]);
    assert!(again.navigation(day()).unwrap().team.is_none());
    assert_eq!(again.sync_status().team_name, None);
    assert!(!dir.join("team").exists());
}

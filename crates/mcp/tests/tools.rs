//! The MCP server end to end: an rmcp client calls the tools over an in-memory pipe.

use rmcp::model::{CallToolRequestParams, ClientConfig};
use rmcp::service::RunningService;
use rmcp::{ClientHandler, RoleClient, ServiceExt};
use serde_json::{Value, json};
use taskmaster_core::*;
use taskmaster_mcp::TaskServer;

const IN_PROGRESS: &str = "00000000-0000-7000-8000-000000000003";
const DONE: &str = "00000000-0000-7000-8000-000000000005";

#[derive(Clone, Default)]
struct Client;

impl ClientHandler for Client {
    fn get_info(&self) -> ClientConfig {
        ClientConfig::default()
    }
}

/// A store with a project, the user's task (the session's), another user task, and a
/// running session on the first.
struct Fixture {
    store: Store,
    project: Id,
    task: Id,
    other: Id,
    session: Id,
}

fn fixture() -> Fixture {
    let mut store = Store::open_in_memory().unwrap();
    let project = store
        .execute(Command::CreateProject {
            project: NewProject {
                name: "task-master".into(),
                ..NewProject::default()
            },
        })
        .unwrap()
        .projects
        .remove(0)
        .id;
    let mut add = |title: &str| {
        store
            .execute(Command::CreateTask {
                task: NewTask {
                    title: title.into(),
                    project_id: Some(project.clone()),
                    ..NewTask::default()
                },
            })
            .unwrap()
            .tasks
            .remove(0)
            .id
    };
    let task = add("Spawn Claude sessions");
    let other = add("Pay the rent");
    let session = store
        .execute_without_undo(vec![Command::CreateAgentSession {
            session: NewAgentSession {
                id: None,
                task_id: task.clone(),
                claude_session_id: new_id(),
                folder: "/home/alex/Code/task-master".into(),
                runtime: AgentRuntime::Wsl,
                permission_mode: "acceptEdits".into(),
                model: None,
                prompt: String::new(),
            },
        }])
        .unwrap()
        .agent_sessions
        .remove(0)
        .id;
    Fixture {
        store,
        project,
        task,
        other,
        session,
    }
}

async fn connect(server: TaskServer) -> RunningService<RoleClient, Client> {
    let (server_io, client_io) = tokio::io::duplex(1 << 16);
    tokio::spawn(async move {
        server
            .serve(server_io)
            .await
            .unwrap()
            .waiting()
            .await
            .unwrap();
    });
    Client.serve(client_io).await.unwrap()
}

/// Calls a tool; returns its text and whether it is an error result.
async fn call(
    client: &RunningService<RoleClient, Client>,
    name: &str,
    args: Value,
) -> (String, bool) {
    let mut params = CallToolRequestParams::new(name.to_owned());
    if let Value::Object(map) = args {
        params = params.with_arguments(map);
    }
    let result = client.call_tool(params).await.unwrap();
    let text = result
        .content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect::<Vec<_>>()
        .join("\n");
    (text, result.is_error == Some(true))
}

async fn ok(client: &RunningService<RoleClient, Client>, name: &str, args: Value) -> String {
    let (text, error) = call(client, name, args).await;
    assert!(!error, "{name} failed: {text}");
    text
}

async fn refused(client: &RunningService<RoleClient, Client>, name: &str, args: Value) -> String {
    let (text, error) = call(client, name, args).await;
    assert!(error, "{name} should have been refused, got: {text}");
    text
}

/// The id in a "Created …(`id`)" line.
fn id_in(text: &str) -> String {
    let end = text.rfind('`').unwrap();
    let start = text[..end].rfind('`').unwrap();
    text[start + 1..end].to_owned()
}

#[tokio::test(flavor = "current_thread")]
async fn lists_its_tools_and_names_the_session_task() {
    let f = fixture();
    let client = connect(TaskServer::new(f.store, Some(&f.session)).unwrap()).await;
    let info = client.peer_info().unwrap();
    assert_eq!(info.server_info.as_ref().unwrap().name, "task-master");
    assert!(info.instructions.as_deref().unwrap().contains(&f.task));
    let tools = client.list_all_tools().await.unwrap();
    let mut names: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "add_note",
            "complete_session",
            "create_task",
            "get_task",
            "list_projects",
            "list_tasks",
            "search",
            "update_task"
        ]
    );
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn get_task_defaults_to_the_session_task() {
    let f = fixture();
    let other = f.other.clone();
    let client = connect(TaskServer::new(f.store, Some(&f.session)).unwrap()).await;
    let brief = ok(&client, "get_task", json!({})).await;
    assert!(
        brief.starts_with("# Task: Spawn Claude sessions"),
        "{brief}"
    );
    let brief = ok(&client, "get_task", json!({ "task_id": other })).await;
    assert!(brief.starts_with("# Task: Pay the rent"));
    refused(&client, "get_task", json!({ "task_id": new_id() })).await;
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn agent_tasks_are_steps_of_the_session_task() {
    let f = fixture();
    let (task, project) = (f.task.clone(), f.project.clone());
    let server = TaskServer::new(f.store, Some(&f.session)).unwrap();
    let client = connect(server.clone()).await;

    let first = id_in(
        &ok(
            &client,
            "create_task",
            json!({ "title": "Write the migration" }),
        )
        .await,
    );
    let created = ok(
        &client,
        "create_task",
        json!({
            "title": "Parse the stream",
            "status": "in_progress",
            "priority": "high",
            "depends_on": [first],
        }),
    )
    .await;
    assert!(
        created.contains("(In progress, agent, subtask of"),
        "{created}"
    );
    let second = id_in(&created);
    let top = id_in(
        &ok(
            &client,
            "create_task",
            json!({ "title": "Follow-up", "top_level": true }),
        )
        .await,
    );

    let listed = ok(&client, "list_tasks", json!({ "owner": "agent" })).await;
    assert_eq!(listed.lines().count(), 3, "{listed}");
    let steps = ok(&client, "list_tasks", json!({ "parent_id": task })).await;
    assert_eq!(steps.lines().count(), 2, "{steps}");
    client.cancel().await.unwrap();

    let snapshot = server_snapshot(&server);
    let find = |id: &str| snapshot.tasks.iter().find(|t| t.id == id).unwrap().clone();
    let second = find(&second);
    assert_eq!(second.owner, TaskOwner::Agent);
    assert_eq!(second.parent_id.as_deref(), Some(task.as_str()));
    assert_eq!(second.project_id.as_deref(), Some(project.as_str()));
    assert_eq!(second.status_id, IN_PROGRESS);
    assert_eq!(second.priority, Priority::High);
    assert_eq!(second.dependency_ids, vec![first]);
    let top = find(&top);
    assert_eq!(top.parent_id, None);
    assert_eq!(
        top.project_id.as_deref(),
        Some(project.as_str()),
        "session task's project"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn the_users_tasks_are_mostly_off_limits() {
    let f = fixture();
    let (task, other) = (f.task.clone(), f.other.clone());
    let server = TaskServer::new(f.store, Some(&f.session)).unwrap();
    let client = connect(server.clone()).await;

    // The session's task: its status only.
    ok(
        &client,
        "update_task",
        json!({ "task_id": task, "status": "In progress" }),
    )
    .await;
    let message = refused(
        &client,
        "update_task",
        json!({ "task_id": task, "title": "Renamed" }),
    )
    .await;
    assert!(message.contains("only its status"), "{message}");
    // The user's own subtask of it is in scope too.
    let sub = with_store(&server, |s| {
        s.execute(Command::CreateTask {
            task: NewTask {
                title: "User's step".into(),
                parent_id: Some(task.clone()),
                ..NewTask::default()
            },
        })
    })
    .tasks
    .remove(0)
    .id;
    ok(
        &client,
        "update_task",
        json!({ "task_id": sub, "status": "in_progress" }),
    )
    .await;
    // Closing them is the user's call, after review.
    for status in ["done", "Cancelled"] {
        let message = refused(
            &client,
            "update_task",
            json!({ "task_id": sub, "status": status }),
        )
        .await;
        assert!(message.contains("Review"), "{message}");
    }
    // Another task of the user's is not.
    let message = refused(
        &client,
        "update_task",
        json!({ "task_id": other, "status": "done" }),
    )
    .await;
    assert!(message.contains("outside this session"), "{message}");
    refused(
        &client,
        "update_task",
        json!({ "task_id": task, "status": "someday" }),
    )
    .await;

    // Agent tasks: anything.
    let mine = id_in(&ok(&client, "create_task", json!({ "title": "Step" })).await);
    ok(
        &client,
        "update_task",
        json!({ "task_id": mine, "title": "Step 1", "description": "First." }),
    )
    .await;
    ok(
        &client,
        "update_task",
        json!({ "task_id": mine, "append_description": "Then." }),
    )
    .await;
    ok(
        &client,
        "update_task",
        json!({ "task_id": mine, "status": "done" }),
    )
    .await;
    client.cancel().await.unwrap();

    let snapshot = server_snapshot(&server);
    let find = |id: &str| snapshot.tasks.iter().find(|t| t.id == id).unwrap().clone();
    assert_eq!(find(&task).status_id, IN_PROGRESS);
    assert_eq!(find(&sub).status_id, IN_PROGRESS, "not closed by the agent");
    assert_eq!(
        find(&other).status_id,
        "00000000-0000-7000-8000-000000000002"
    );
    let mine = find(&mine);
    assert_eq!(mine.title, "Step 1");
    assert_eq!(mine.description, "First.\n\nThen.");
    assert_eq!(mine.status_id, DONE);
}

#[tokio::test(flavor = "current_thread")]
async fn notes_and_the_summary_land_on_the_session() {
    let f = fixture();
    let (task, session) = (f.task.clone(), f.session.clone());
    let server = TaskServer::new(f.store, Some(&f.session)).unwrap();
    let client = connect(server.clone()).await;
    ok(
        &client,
        "add_note",
        json!({ "body": "Found the bug in sync.rs" }),
    )
    .await;
    refused(&client, "add_note", json!({ "body": "  " })).await;
    ok(
        &client,
        "complete_session",
        json!({ "summary": "Fixed and tested." }),
    )
    .await;
    refused(&client, "complete_session", json!({ "summary": "" })).await;
    client.cancel().await.unwrap();

    let (notes, stored) = with_store(&server, |s| {
        Ok((s.agent_notes(&task, None, 10)?, s.agent_session(&session)?))
    });
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].body, "Found the bug in sync.rs");
    assert_eq!(stored.summary.as_deref(), Some("Fixed and tested."));
    assert_eq!(stored.state, SessionState::Running, "the shell ends it");
}

#[tokio::test(flavor = "current_thread")]
async fn a_session_the_app_is_not_running_ends_with_its_summary() {
    // Resumed in a terminal, or still going after the app quit (then marked interrupted):
    // nothing else would record its end.
    for state in [SessionState::Terminal, SessionState::Interrupted] {
        let mut f = fixture();
        f.store
            .execute_without_undo(vec![Command::UpdateAgentSession {
                id: f.session.clone(),
                changes: vec![AgentSessionChange::State(state)],
            }])
            .unwrap();
        let session = f.session.clone();
        let server = TaskServer::new(f.store, Some(&f.session)).unwrap();
        let client = connect(server.clone()).await;
        let reply = ok(
            &client,
            "complete_session",
            json!({ "summary": "Finished." }),
        )
        .await;
        assert!(reply.contains("marked done"), "{reply}");
        client.cancel().await.unwrap();
        let stored = with_store(&server, |s| s.agent_session(&session));
        assert_eq!(stored.state, SessionState::Done, "from {state:?}");
        assert_eq!(stored.summary.as_deref(), Some("Finished."));
        assert!(stored.ended_at.is_some());
    }
}

#[tokio::test(flavor = "current_thread")]
async fn reporting_done_moves_the_users_task_to_review() {
    let f = fixture();
    let (task, session) = (f.task.clone(), f.session.clone());
    let server = TaskServer::new(f.store, Some(&f.session)).unwrap();
    let client = connect(server.clone()).await;
    let reply = ok(
        &client,
        "complete_session",
        json!({ "summary": "Implemented; check the migration." }),
    )
    .await;
    assert!(reply.contains("moved to Review"), "{reply}");
    let (snapshot, stored) =
        with_store(&server, |s| Ok((s.snapshot()?, s.agent_session(&session)?)));
    let moved = snapshot.tasks.iter().find(|t| t.id == task).unwrap();
    assert_eq!(moved.status_id, REVIEW_STATUS_ID);
    // A running session still ends when the run does.
    assert_eq!(stored.state, SessionState::Running);

    // Reporting again (a follow-up) leaves it in Review, without a second move.
    let again = ok(
        &client,
        "complete_session",
        json!({ "summary": "Also docs." }),
    )
    .await;
    assert!(!again.contains("moved"), "{again}");
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn reporting_done_moves_the_task_to_the_picked_status() {
    let mut f = fixture();
    let picked = f
        .store
        .execute(Command::CreateStatus {
            status: NewStatus {
                id: None,
                name: "To check".into(),
                category: StatusCategory::Todo,
                color: None,
                rank: None,
                wip_limit: None,
            },
        })
        .unwrap()
        .statuses
        .remove(0);
    let task = f.task.clone();
    let server = TaskServer::new(f.store, Some(&f.session))
        .unwrap()
        .with_workflow(AgentWorkflow {
            started_status_id: None,
            done_status_id: Some(picked.id.clone()),
        });
    let client = connect(server.clone()).await;
    let reply = ok(&client, "complete_session", json!({ "summary": "Done." })).await;
    assert!(reply.contains("moved to To check"), "{reply}");
    client.cancel().await.unwrap();
    let snapshot = server_snapshot(&server);
    let moved = snapshot.tasks.iter().find(|t| t.id == task).unwrap();
    assert_eq!(moved.status_id, picked.id);
}

#[tokio::test(flavor = "current_thread")]
async fn a_task_the_user_already_closed_stays_closed() {
    let mut f = fixture();
    f.store
        .execute(Command::UpdateTask {
            id: f.task.clone(),
            changes: vec![TaskChange::StatusId(DONE.into())],
        })
        .unwrap();
    let task = f.task.clone();
    let server = TaskServer::new(f.store, Some(&f.session)).unwrap();
    let client = connect(server.clone()).await;
    let reply = ok(&client, "complete_session", json!({ "summary": "Done." })).await;
    assert!(!reply.contains("Review"), "{reply}");
    client.cancel().await.unwrap();
    let snapshot = server_snapshot(&server);
    let kept = snapshot.tasks.iter().find(|t| t.id == task).unwrap();
    assert_eq!(kept.status_id, DONE);
}

#[tokio::test(flavor = "current_thread")]
async fn without_a_session_it_reads_and_tracks_only_agent_tasks() {
    let f = fixture();
    let task = f.task.clone();
    let client = connect(TaskServer::new(f.store, None).unwrap()).await;
    refused(&client, "get_task", json!({})).await;
    refused(&client, "add_note", json!({ "body": "hi" })).await;
    refused(
        &client,
        "update_task",
        json!({ "task_id": task, "status": "done" }),
    )
    .await;
    let created = ok(&client, "create_task", json!({ "title": "Loose end" })).await;
    assert!(!created.contains("subtask of"), "{created}");
    let found = ok(&client, "search", json!({ "query": "spawn" })).await;
    assert!(found.contains("Spawn Claude sessions"), "{found}");
    let projects = ok(&client, "list_projects", json!({})).await;
    assert!(projects.contains("task-master"), "{projects}");
    assert_eq!(
        ok(&client, "search", json!({ "query": "zzz" })).await,
        "No tasks match."
    );
    client.cancel().await.unwrap();
}

#[test]
fn a_missing_session_is_refused_at_start() {
    let f = fixture();
    assert!(TaskServer::new(f.store, Some(&new_id())).is_err());
}

fn server_snapshot(server: &TaskServer) -> Snapshot {
    with_store(server, |s| s.snapshot())
}

fn with_store<T>(server: &TaskServer, f: impl FnOnce(&mut Store) -> Result<T>) -> T {
    server.with_store_for_tests(f).unwrap()
}

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
            "attach_file",
            "complete_session",
            "create_epic",
            "create_project",
            "create_task",
            "delete_epic",
            "delete_project",
            "delete_tag",
            "delete_task",
            "get_calendar",
            "get_lineage",
            "get_meeting",
            "get_task",
            "link_tasks",
            "list_agent_sessions",
            "list_attachments",
            "list_meetings",
            "list_projects",
            "list_tags",
            "list_tasks",
            "read_attachment",
            "remove_agent_session",
            "remove_attachment",
            "rename_attachment",
            "schedule_block",
            "search",
            "undo",
            "update_block",
            "update_epic",
            "update_project",
            "update_tag",
            "update_task"
        ]
    );
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn creates_projects_in_areas_without_duplicates() {
    let f = fixture();
    let server = TaskServer::new(f.store, None).unwrap();
    let client = connect(server.clone()).await;
    let area = id_in(&ok(&client, "create_project", json!({ "name": "Work" })).await);
    let made = ok(
        &client,
        "create_project",
        json!({ "name": "Billing", "area_id": area, "color": "#7a5cff" }),
    )
    .await;
    assert!(
        made.starts_with("Created project Billing in Work"),
        "{made}"
    );
    let billing = id_in(&made);
    // Same name, same area, any case: the existing one comes back.
    let again = ok(
        &client,
        "create_project",
        json!({ "name": " billing ", "area_id": area }),
    )
    .await;
    assert!(again.contains("already exists"), "{again}");
    assert_eq!(id_in(&again), billing);
    // The same name elsewhere is another project.
    let top = id_in(&ok(&client, "create_project", json!({ "name": "Billing" })).await);
    assert_ne!(top, billing);
    // One level of nesting only, and the area must exist.
    refused(
        &client,
        "create_project",
        json!({ "name": "Invoices", "area_id": billing }),
    )
    .await;
    refused(
        &client,
        "create_project",
        json!({ "name": "Invoices", "area_id": new_id() }),
    )
    .await;
    refused(&client, "create_project", json!({ "name": "  " })).await;
    let listed = ok(&client, "list_projects", json!({})).await;
    assert!(
        listed.contains(&format!("Work / Billing (`{billing}`)")),
        "{listed}"
    );
    let stored = server
        .with_store_for_tests(|s| s.snapshot())
        .unwrap()
        .projects
        .into_iter()
        .find(|p| p.id == billing)
        .unwrap();
    assert_eq!(stored.parent_id.as_deref(), Some(area.as_str()));
    assert_eq!(stored.color.as_deref(), Some("#7a5cff"));
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn creates_epics_in_the_session_project_by_default() {
    let f = fixture();
    let server = TaskServer::new(f.store, Some(&f.session)).unwrap();
    let client = connect(server.clone()).await;
    let made = ok(
        &client,
        "create_epic",
        json!({
            "name": "AI Integration",
            "description": "Agents can plan work.",
            "target_date": "2026-12-31",
        }),
    )
    .await;
    assert!(
        made.starts_with("Created epic AI Integration in task-master"),
        "{made}"
    );
    let epic = id_in(&made);
    let again = ok(&client, "create_epic", json!({ "name": "ai integration" })).await;
    assert!(again.contains("already exists (active"), "{again}");
    assert_eq!(id_in(&again), epic);
    // Without a project it is another epic.
    let loose = ok(
        &client,
        "create_epic",
        json!({ "name": "AI Integration", "no_project": true }),
    )
    .await;
    assert!(
        loose.starts_with("Created epic AI Integration (`"),
        "{loose}"
    );
    let loose = id_in(&loose);
    refused(
        &client,
        "create_epic",
        json!({ "name": "Later", "project_id": new_id() }),
    )
    .await;
    refused(
        &client,
        "create_epic",
        json!({ "name": "Later", "target_date": "next week" }),
    )
    .await;
    let epics = server.with_store_for_tests(|s| s.snapshot()).unwrap().epics;
    let stored = epics.iter().find(|e| e.id == epic).unwrap();
    assert_eq!(stored.project_id.as_deref(), Some(f.project.as_str()));
    assert_eq!(stored.description.as_deref(), Some("Agents can plan work."));
    assert_eq!(stored.target_date.as_deref(), Some("2026-12-31"));
    assert_eq!(
        epics.iter().find(|e| e.id == loose).unwrap().project_id,
        None
    );
    // Tasks can go in it straight away.
    let task = ok(
        &client,
        "create_task",
        json!({ "title": "Wire the tool", "epic_id": epic }),
    )
    .await;
    let listed = ok(&client, "list_tasks", json!({ "epic_id": epic })).await;
    assert!(listed.contains(&id_in(&task)), "{listed}");
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn task_listing_can_continue_past_its_limit() {
    let f = fixture();
    let client = connect(TaskServer::new(f.store, None).unwrap()).await;
    let first = ok(&client, "list_tasks", json!({ "limit": 1 })).await;
    let cursor = first
        .lines()
        .find_map(|line| line.strip_prefix("next_cursor: `")?.strip_suffix('`'))
        .expect("first page has a cursor");
    let second = ok(
        &client,
        "list_tasks",
        json!({ "limit": 1, "cursor": cursor }),
    )
    .await;
    assert_ne!(first.lines().next(), second.lines().next());
    assert!(!second.contains("next_cursor:"));
    refused(&client, "list_tasks", json!({ "cursor": new_id() })).await;
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn session_listing_filters_latest_outcome_and_paginates() {
    let mut f = fixture();
    f.store
        .execute_without_undo(vec![Command::UpdateAgentSession {
            id: f.session.clone(),
            changes: vec![
                AgentSessionChange::State(SessionState::Failed),
                AgentSessionChange::Error(Some("First attempt failed".into())),
            ],
        }])
        .unwrap();
    let newer = f
        .store
        .execute_without_undo(vec![Command::CreateAgentSession {
            session: NewAgentSession {
                id: None,
                task_id: f.task.clone(),
                claude_session_id: new_id(),
                folder: "/work".into(),
                runtime: AgentRuntime::Native,
                permission_mode: "default".into(),
                model: None,
                prompt: String::new(),
            },
        }])
        .unwrap()
        .agent_sessions
        .remove(0)
        .id;
    f.store
        .execute_without_undo(vec![Command::UpdateAgentSession {
            id: newer.clone(),
            changes: vec![
                AgentSessionChange::State(SessionState::Done),
                AgentSessionChange::Summary(Some("Recovered on retry".into())),
            ],
        }])
        .unwrap();
    let other_failed = f
        .store
        .execute_without_undo(vec![Command::CreateAgentSession {
            session: NewAgentSession {
                id: None,
                task_id: f.other.clone(),
                claude_session_id: new_id(),
                folder: "/work".into(),
                runtime: AgentRuntime::Native,
                permission_mode: "default".into(),
                model: None,
                prompt: String::new(),
            },
        }])
        .unwrap()
        .agent_sessions
        .remove(0)
        .id;
    f.store
        .execute_without_undo(vec![Command::UpdateAgentSession {
            id: other_failed.clone(),
            changes: vec![
                AgentSessionChange::State(SessionState::Failed),
                AgentSessionChange::Summary(Some("Rate limit reached".into())),
            ],
        }])
        .unwrap();
    let client = connect(TaskServer::new(f.store, None).unwrap()).await;

    let all: Value = serde_json::from_str(
        &ok(&client, "list_agent_sessions", json!({ "state": "failed" })).await,
    )
    .unwrap();
    assert_eq!(all["sessions"].as_array().unwrap().len(), 2);
    assert!(all["sessions"].to_string().contains("First attempt failed"));
    assert!(all["sessions"].to_string().contains("Rate limit reached"));

    let latest: Value = serde_json::from_str(
        &ok(
            &client,
            "list_agent_sessions",
            json!({ "state": "failed", "latest_only": true }),
        )
        .await,
    )
    .unwrap();
    assert_eq!(latest["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(latest["sessions"][0]["session_id"], other_failed);
    assert_eq!(latest["sessions"][0]["task_title"], "Pay the rent");
    assert_eq!(latest["sessions"][0]["summary"], "Rate limit reached");
    assert!(latest["sessions"][0]["started_at_ms"].is_number());

    let task_runs: Value = serde_json::from_str(
        &ok(
            &client,
            "list_agent_sessions",
            json!({ "task_id": f.task, "project_id": f.project }),
        )
        .await,
    )
    .unwrap();
    assert_eq!(task_runs["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(task_runs["sessions"][0]["session_id"], newer);
    let no_project: Value = serde_json::from_str(
        &ok(
            &client,
            "list_agent_sessions",
            json!({ "project_id": new_id() }),
        )
        .await,
    )
    .unwrap();
    assert!(no_project["sessions"].as_array().unwrap().is_empty());

    let first: Value = serde_json::from_str(
        &ok(
            &client,
            "list_agent_sessions",
            json!({ "state": "failed", "limit": 1 }),
        )
        .await,
    )
    .unwrap();
    let cursor = first["next_cursor"].as_str().unwrap();
    let second: Value = serde_json::from_str(
        &ok(
            &client,
            "list_agent_sessions",
            json!({ "state": "failed", "limit": 1, "cursor": cursor }),
        )
        .await,
    )
    .unwrap();
    assert_ne!(
        first["sessions"][0]["session_id"],
        second["sessions"][0]["session_id"]
    );
    assert!(second["next_cursor"].is_null());
    refused(&client, "list_agent_sessions", json!({ "state": "broken" })).await;
    refused(
        &client,
        "list_agent_sessions",
        json!({ "cursor": new_id() }),
    )
    .await;
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
async fn the_users_tasks_can_be_edited_within_limits() {
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
    // The user's tasks can be edited too.
    ok(
        &client,
        "update_task",
        json!({ "task_id": task, "title": "Renamed", "priority": "low" }),
    )
    .await;
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
    // A finished step of the work is marked done; cancelling is the user's call.
    let message = refused(
        &client,
        "update_task",
        json!({ "task_id": sub, "status": "Cancelled" }),
    )
    .await;
    assert!(message.contains("only the user cancels"), "{message}");
    ok(
        &client,
        "update_task",
        json!({ "task_id": sub, "status": "done" }),
    )
    .await;
    // The session's task itself waits for the user's review.
    for status in ["done", "Cancelled"] {
        let message = refused(
            &client,
            "update_task",
            json!({ "task_id": task, "status": status }),
        )
        .await;
        assert!(message.contains("Review"), "{message}");
    }
    // Another task of the user's outside the session can be edited and closed.
    ok(
        &client,
        "update_task",
        json!({ "task_id": other, "append_description": "More.", "status": "done" }),
    )
    .await;
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
    let edited = find(&task);
    assert_eq!(edited.status_id, IN_PROGRESS);
    assert_eq!(edited.title, "Renamed");
    assert_eq!(find(&sub).status_id, DONE, "a finished subtask");
    let other = find(&other);
    assert_eq!(other.status_id, DONE, "the user's task outside the session");
    assert!(
        other.description.ends_with("More."),
        "{}",
        other.description
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
async fn a_server_without_a_session_records_a_desktop_session_named_by_id() {
    let f = fixture();
    let (task, session) = (f.task.clone(), f.session.clone());
    let before = f.store.agent_session(&session).unwrap().claude_session_id;
    // Running headless: not one a session-less server may name.
    let server = TaskServer::new(f.store, None).unwrap();
    let client = connect(server.clone()).await;
    let message = refused(
        &client,
        "add_note",
        json!({ "body": "Hi", "session_id": session }),
    )
    .await;
    assert!(message.contains("desktop app"), "{message}");
    let message = refused(&client, "add_note", json!({ "body": "Hi" })).await;
    assert!(message.contains("session_id"), "{message}");

    with_store(&server, |s| {
        s.execute_without_undo(vec![Command::UpdateAgentSession {
            id: session.clone(),
            changes: vec![AgentSessionChange::State(SessionState::Desktop)],
        }])
    });
    ok(
        &client,
        "add_note",
        json!({ "body": "Header drafted", "session_id": session }),
    )
    .await;
    ok(
        &client,
        "complete_session",
        json!({ "summary": "Header redesigned.", "session_id": session }),
    )
    .await;
    client.cancel().await.unwrap();

    let (notes, stored) = with_store(&server, |s| {
        Ok((s.agent_notes(&task, None, 10)?, s.agent_session(&session)?))
    });
    assert_eq!(notes[0].body, "Header drafted");
    assert_eq!(stored.summary.as_deref(), Some("Header redesigned."));
    assert_eq!(stored.state, SessionState::Done);
    // Inside Claude Code (as when these tests run in it), the conversation's id is kept.
    match std::env::var("CLAUDE_CODE_SESSION_ID") {
        Ok(id) if id.len() == 36 => assert_eq!(stored.claude_session_id, id),
        _ => assert_eq!(stored.claude_session_id, before),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn completing_needs_every_subtask_done_or_left_open_on_purpose() {
    let mut f = fixture();
    let task = f.task.clone();
    // The user's subtask, with a nested one of its own.
    let users = f
        .store
        .execute(Command::CreateTask {
            task: NewTask {
                title: "Write the docs".into(),
                parent_id: Some(task.clone()),
                ..NewTask::default()
            },
        })
        .unwrap()
        .tasks
        .remove(0)
        .id;
    let nested = f
        .store
        .execute(Command::CreateTask {
            task: NewTask {
                title: "Screenshot".into(),
                parent_id: Some(users.clone()),
                ..NewTask::default()
            },
        })
        .unwrap()
        .tasks
        .remove(0)
        .id;
    let session = f.session.clone();
    let server = TaskServer::new(f.store, Some(&f.session)).unwrap();
    let client = connect(server.clone()).await;
    let step = id_in(&ok(&client, "create_task", json!({ "title": "Implement" })).await);

    // All three are open: refused, and each is named.
    let message = refused(
        &client,
        "complete_session",
        json!({ "summary": "Implemented." }),
    )
    .await;
    for id in [&users, &nested, &step] {
        assert!(message.contains(id.as_str()), "{message}");
    }
    assert!(message.contains("left_open"), "{message}");

    // The agent's step and the user's nested one are done; the docs are left on purpose.
    for id in [&step, &nested] {
        ok(
            &client,
            "update_task",
            json!({ "task_id": id, "status": "done" }),
        )
        .await;
    }
    let message = refused(
        &client,
        "complete_session",
        json!({ "summary": "Implemented.", "left_open": [users, step] }),
    )
    .await;
    assert!(message.contains("not an open subtask"), "{message}");
    let reply = ok(
        &client,
        "complete_session",
        json!({ "summary": "Implemented; docs left for you.", "left_open": [users] }),
    )
    .await;
    assert!(reply.contains("moved to Review"), "{reply}");
    client.cancel().await.unwrap();

    let (snapshot, stored) =
        with_store(&server, |s| Ok((s.snapshot()?, s.agent_session(&session)?)));
    let find = |id: &str| snapshot.tasks.iter().find(|t| t.id == id).unwrap().clone();
    assert_eq!(find(&nested).status_id, DONE);
    assert_ne!(find(&users).status_id, DONE);
    assert_eq!(find(&task).status_id, REVIEW_STATUS_ID);
    assert_eq!(
        stored.summary.as_deref(),
        Some("Implemented; docs left for you.")
    );
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
async fn with_editing_turned_off_the_users_tasks_keep_to_their_status() {
    let f = fixture();
    let (task, other) = (f.task.clone(), f.other.clone());
    let server = TaskServer::new(f.store, Some(&f.session))
        .unwrap()
        .with_edit_user_tasks(false);
    let client = connect(server).await;
    let instructions = client.peer_info().unwrap().instructions.clone().unwrap();
    assert!(instructions.contains("read-only"), "{instructions}");
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
    assert!(message.contains("turned off"), "{message}");
    let message = refused(
        &client,
        "update_task",
        json!({ "task_id": other, "status": "done" }),
    )
    .await;
    assert!(message.contains("turned off"), "{message}");
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn without_a_session_it_reads_and_tracks_only_agent_tasks() {
    let f = fixture();
    let task = f.task.clone();
    let client = connect(TaskServer::new(f.store, None).unwrap()).await;
    // Added to Claude by hand: no session to report on, the user's tasks editable.
    let instructions = client.peer_info().unwrap().instructions.clone().unwrap();
    assert!(!instructions.contains("complete_session"), "{instructions}");
    assert!(
        instructions.contains("anything the user can do"),
        "{instructions}"
    );
    refused(&client, "get_task", json!({})).await;
    refused(&client, "add_note", json!({ "body": "hi" })).await;
    ok(
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

/// `2026-11-12T09:00:00Z` as Unix ms.
fn at(text: &str) -> Timestamp {
    calendar::parse_rfc3339(text).unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn the_calendar_shows_blocks_and_days_and_plans_in_scope_with_editing_off() {
    let mut f = fixture();
    let (task, other) = (f.task.clone(), f.other.clone());
    f.store
        .execute(Command::CreateTimeBlock {
            block: NewTimeBlock {
                id: None,
                task_id: other.clone(),
                start_at: at("2026-11-12T08:00:00Z"),
                end_at: at("2026-11-12T09:00:00Z"),
                outcome: None,
            },
        })
        .unwrap();
    f.store
        .execute(Command::UpdateTask {
            id: task.clone(),
            changes: vec![TaskChange::DueDate(Some("2026-11-13".into()))],
        })
        .unwrap();
    // With editing the user's tasks turned off: the session's task tree only.
    let server = TaskServer::new(f.store, Some(&f.session))
        .unwrap()
        .with_edit_user_tasks(false);
    let client = connect(server.clone()).await;

    let week = json!({ "from": "2026-11-12", "to": "2026-11-14", "utc_offset": "+01:00" });
    let shown = ok(&client, "get_calendar", week.clone()).await;
    assert!(shown.contains("times in +01:00"), "{shown}");
    assert!(shown.contains("## 2026-11-12"), "{shown}");
    assert!(
        shown.contains("- 09:00–10:00 planned: Pay the rent"),
        "local time: {shown}"
    );
    assert!(
        shown.contains("## 2026-11-13\nDue:\n- [ ] Spawn Claude sessions"),
        "{shown}"
    );
    refused(&client, "get_calendar", json!({ "utc_offset": "CET" })).await;
    refused(
        &client,
        "get_calendar",
        json!({ "from": "2026-01-01", "to": "2026-12-31" }),
    )
    .await;

    // The session's task can be planned; the user's other tasks cannot.
    let planned = ok(
        &client,
        "schedule_block",
        json!({
            "task_id": task,
            "start": "2026-11-12T14:00",
            "end": "2026-11-12T15:30",
            "utc_offset": "+01:00",
        }),
    )
    .await;
    let block = id_in(&planned);
    refused(
        &client,
        "schedule_block",
        json!({ "task_id": other, "start": "2026-11-12T16:00Z", "end": "2026-11-12T17:00Z" }),
    )
    .await;
    refused(
        &client,
        "schedule_block",
        json!({ "task_id": task, "start": "2026-11-12T16:00Z", "end": "2026-11-12T15:00Z" }),
    )
    .await;
    let shown = ok(&client, "get_calendar", week).await;
    assert!(
        shown.contains("- 14:00–15:30 planned: Spawn Claude sessions"),
        "{shown}"
    );

    ok(
        &client,
        "update_block",
        json!({ "block_id": block, "end": "2026-11-12T15:00:00Z", "outcome": "worked" }),
    )
    .await;
    let theirs = server_snapshot(&server)
        .time_blocks
        .iter()
        .find(|b| b.task_id == other)
        .unwrap()
        .id
        .clone();
    refused(
        &client,
        "update_block",
        json!({ "block_id": theirs, "remove": true }),
    )
    .await;
    let snapshot = server_snapshot(&server);
    let mine = snapshot.time_blocks.iter().find(|b| b.id == block).unwrap();
    assert_eq!(mine.start_at, at("2026-11-12T13:00:00Z"));
    assert_eq!(mine.end_at, at("2026-11-12T15:00:00Z"));
    assert_eq!(mine.outcome, BlockOutcome::Worked);

    ok(
        &client,
        "update_block",
        json!({ "block_id": block, "remove": true }),
    )
    .await;
    let live = server_snapshot(&server)
        .time_blocks
        .iter()
        .filter(|b| b.deleted_at.is_none())
        .count();
    assert_eq!(live, 1);
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn the_lineage_shows_chains_and_links_in_scope_with_editing_off() {
    let mut f = fixture();
    let (task, other, project) = (f.task.clone(), f.other.clone(), f.project.clone());
    let upstream = f
        .store
        .execute(Command::CreateTask {
            task: NewTask {
                title: "Design the schema".into(),
                project_id: Some(project.clone()),
                ..NewTask::default()
            },
        })
        .unwrap()
        .tasks
        .remove(0)
        .id;
    // task waits on upstream; other waits on task.
    for (id, dep) in [(&task, &upstream), (&other, &task)] {
        f.store
            .execute(Command::UpdateTask {
                id: id.clone(),
                changes: vec![TaskChange::DependencyIds(vec![dep.clone()])],
            })
            .unwrap();
    }
    // With editing the user's tasks turned off: links of the session's task tree only.
    let server = TaskServer::new(f.store, Some(&f.session))
        .unwrap()
        .with_edit_user_tasks(false);
    let client = connect(server.clone()).await;

    let lineage = ok(&client, "get_lineage", json!({})).await;
    assert!(
        lineage.starts_with("# Lineage: [ ] Spawn Claude sessions"),
        "{lineage}"
    );
    assert!(
        lineage.contains("Waiting: 1 of 1 prerequisites open."),
        "{lineage}"
    );
    assert!(
        lineage
            .contains("## Prerequisites (finished first; nested: theirs)\n- [ ] Design the schema"),
        "{lineage}"
    );
    assert!(
        lineage.contains("## Dependents (waiting on it; nested: theirs)\n- [ ] Pay the rent"),
        "{lineage}"
    );
    let scope = ok(&client, "get_lineage", json!({ "project_id": project })).await;
    let ready = scope.find("## Ready").unwrap();
    let waiting = scope.find("## Waiting").unwrap();
    let design = scope.find("- [ ] Design the schema").unwrap();
    assert!(ready < design && design < waiting, "{scope}");
    assert!(scope.contains("unblocks: Spawn Claude sessions"), "{scope}");
    refused(
        &client,
        "get_lineage",
        json!({ "task_id": task, "project_id": project }),
    )
    .await;

    // An agent step the session's task waits on.
    let step = id_in(&ok(&client, "create_task", json!({ "title": "Spike" })).await);
    let linked = ok(
        &client,
        "link_tasks",
        json!({ "task_id": task, "prerequisite_id": step }),
    )
    .await;
    assert!(linked.contains("now waits on Spike"), "{linked}");
    // The user's task outside the session keeps its links.
    refused(
        &client,
        "link_tasks",
        json!({ "task_id": other, "prerequisite_id": step }),
    )
    .await;
    // No circles: the session's task already waits on the step.
    refused(
        &client,
        "link_tasks",
        json!({ "task_id": step, "prerequisite_id": task }),
    )
    .await;
    let find = |s: &Snapshot, id: &str| s.tasks.iter().find(|t| t.id == id).unwrap().clone();
    assert_eq!(
        find(&server_snapshot(&server), &task).dependency_ids,
        vec![upstream.clone(), step.clone()]
    );
    ok(
        &client,
        "link_tasks",
        json!({ "task_id": task, "prerequisite_id": upstream, "remove": true }),
    )
    .await;
    assert_eq!(
        find(&server_snapshot(&server), &task).dependency_ids,
        vec![step]
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

// ---------------------------------------------------------------------------------------
// Everything the user can do in the app (audit of 2026-11-14)

/// The change id in a write's result.
fn change_in(text: &str) -> String {
    let start = text.find("change_id: ").expect("a change id") + "change_id: ".len();
    text[start..].split_whitespace().next().unwrap().to_owned()
}

fn task_of(server: &TaskServer, id: &str) -> Option<Task> {
    server_snapshot(server)
        .tasks
        .into_iter()
        .find(|t| t.id == id)
}

/// A folder of its own under the system temp folder, for attachment content.
fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("tm-mcp-{name}-{}", new_id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test(flavor = "current_thread")]
async fn the_users_tasks_move_between_projects_epics_and_parents() {
    let f = fixture();
    let (task, other, project) = (f.task.clone(), f.other.clone(), f.project.clone());
    let server = TaskServer::new(f.store, None).unwrap();
    let client = connect(server.clone()).await;
    let home = id_in(&ok(&client, "create_project", json!({ "name": "Home" })).await);
    let epic = id_in(
        &ok(
            &client,
            "create_epic",
            json!({ "name": "Move out", "project_id": home }),
        )
        .await,
    );

    // A task of the user's own, when they ask for one, with everything the app sets.
    let made = ok(
        &client,
        "create_task",
        json!({
            "title": "Book the van",
            "owner": "me",
            "project_id": home,
            "epic_id": epic,
            "due_date": "2026-12-01",
            "today_on": "2026-11-14",
            "estimate_min": 30,
            "tags": ["#errand", "errand", "Phone"],
        }),
    )
    .await;
    assert!(!made.contains("[agent]"), "{made}");
    let van = task_of(&server, &id_in(&made)).unwrap();
    assert_eq!(van.owner, TaskOwner::Me);
    assert_eq!(van.epic_id.as_deref(), Some(epic.as_str()));
    assert_eq!(
        (
            van.due_date.as_deref(),
            van.today_on.as_deref(),
            van.estimate_min
        ),
        (Some("2026-12-01"), Some("2026-11-14"), Some(30))
    );
    assert_eq!(van.tag_ids.len(), 2, "the same tag named twice is one tag");

    // Into another project and epic, with its subtask following.
    let sub = id_in(
        &ok(
            &client,
            "create_task",
            json!({ "title": "Measure boxes", "owner": "me", "parent_id": other }),
        )
        .await,
    );
    let moved = ok(
        &client,
        "update_task",
        json!({ "task_id": other, "project_id": home, "epic_id": epic }),
    )
    .await;
    assert!(moved.contains("1 subtasks followed"), "{moved}");
    let rent = task_of(&server, &other).unwrap();
    assert_eq!(
        (rent.project_id.as_deref(), rent.epic_id.as_deref()),
        (Some(home.as_str()), Some(epic.as_str()))
    );
    assert_eq!(
        task_of(&server, &sub).unwrap().epic_id.as_deref(),
        Some(epic.as_str())
    );

    // Out of the epic, to the Inbox, a subtask of another task and back to the top level.
    ok(
        &client,
        "update_task",
        json!({ "task_id": other, "epic_id": "", "project_id": "", "due_date": "2026-11-30",
                "estimate_min": 45, "add_tags": ["errand"], "remove_tags": [] }),
    )
    .await;
    let rent = task_of(&server, &other).unwrap();
    assert_eq!((rent.project_id, rent.epic_id), (None, None));
    assert_eq!(rent.due_date.as_deref(), Some("2026-11-30"));
    assert_eq!(rent.tag_ids, van.tag_ids[..1].to_vec());
    ok(
        &client,
        "update_task",
        json!({ "task_id": other, "parent_id": task }),
    )
    .await;
    let rent = task_of(&server, &other).unwrap();
    assert_eq!(rent.parent_id.as_deref(), Some(task.as_str()));
    assert_eq!(
        rent.project_id.as_deref(),
        Some(project.as_str()),
        "takes its parent's"
    );
    ok(
        &client,
        "update_task",
        json!({ "task_id": other, "parent_id": "", "remove_tags": ["#errand"],
                "estimate_min": 0, "due_date": "" }),
    )
    .await;
    let rent = task_of(&server, &other).unwrap();
    assert_eq!(rent.parent_id, None);
    assert!(rent.tag_ids.is_empty());
    assert_eq!((rent.estimate_min, rent.due_date), (None, None));
    refused(
        &client,
        "update_task",
        json!({ "task_id": other, "remove_tags": ["nope"] }),
    )
    .await;

    // Reordering within the column.
    ok(
        &client,
        "update_task",
        json!({ "task_id": other, "position": "top" }),
    )
    .await;
    let snapshot = server_snapshot(&server);
    let rank = |id: &str| {
        snapshot
            .tasks
            .iter()
            .find(|t| t.id == id)
            .unwrap()
            .rank
            .clone()
    };
    assert!(rank(&other) < rank(&task), "top of the column");
    ok(
        &client,
        "update_task",
        json!({ "task_id": other, "position": task }),
    )
    .await;
    let snapshot = server_snapshot(&server);
    let rank = |id: &str| {
        snapshot
            .tasks
            .iter()
            .find(|t| t.id == id)
            .unwrap()
            .rank
            .clone()
    };
    assert!(rank(&other) > rank(&task), "right after it");
    refused(
        &client,
        "update_task",
        json!({ "task_id": other, "position": "middle" }),
    )
    .await;

    // An agent task is adopted; the user's tasks never become an agent's.
    let step = id_in(&ok(&client, "create_task", json!({ "title": "Spike" })).await);
    ok(
        &client,
        "update_task",
        json!({ "task_id": step, "owner": "me" }),
    )
    .await;
    assert_eq!(task_of(&server, &step).unwrap().owner, TaskOwner::Me);
    refused(
        &client,
        "update_task",
        json!({ "task_id": other, "owner": "agent" }),
    )
    .await;
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn deletes_and_undo_follow_the_setting_and_spare_the_session_task() {
    let f = fixture();
    let (task, other, session) = (f.task.clone(), f.other.clone(), f.session.clone());
    let server = TaskServer::new(f.store, Some(&session)).unwrap();
    let client = connect(server.clone()).await;

    // The user's task, with an agent step under it.
    let step = id_in(
        &ok(
            &client,
            "create_task",
            json!({ "title": "Check", "parent_id": other }),
        )
        .await,
    );
    let deleted = ok(&client, "delete_task", json!({ "task_id": other })).await;
    assert!(
        deleted.starts_with("Deleted Pay the rent and its subtask."),
        "{deleted}"
    );
    assert!(task_of(&server, &other).is_none() && task_of(&server, &step).is_none());
    let undone = ok(&client, "undo", json!({ "change_id": change_in(&deleted) })).await;
    assert!(undone.contains("2 tasks"), "{undone}");
    assert!(task_of(&server, &other).is_some() && task_of(&server, &step).is_some());
    // Undoing it again is refused; undoing the undo deletes them again.
    refused(&client, "undo", json!({ "change_id": change_in(&deleted) })).await;
    ok(&client, "undo", json!({ "change_id": change_in(&undone) })).await;
    assert!(task_of(&server, &other).is_none());

    // The session's task, or a task above it, is never deleted by its agent.
    let message = refused(&client, "delete_task", json!({ "task_id": task })).await;
    assert!(message.contains("this session works on"), "{message}");
    refused(&client, "undo", json!({ "change_id": "nonsense" })).await;
    client.cancel().await.unwrap();

    // Turned off: the agent's own tasks and changes only.
    let mut store = Store::open_in_memory().unwrap();
    let theirs = store
        .execute(Command::CreateTask {
            task: NewTask {
                title: "Theirs".into(),
                ..NewTask::default()
            },
        })
        .unwrap();
    let theirs_change = theirs.batch_id.clone().unwrap();
    let theirs = theirs.tasks[0].id.clone();
    let server = TaskServer::new(store, None)
        .unwrap()
        .with_edit_user_tasks(false);
    let client = connect(server.clone()).await;
    let message = refused(&client, "delete_task", json!({ "task_id": theirs })).await;
    assert!(message.contains("turned off"), "{message}");
    refused(&client, "undo", json!({ "change_id": theirs_change })).await;
    refused(
        &client,
        "create_task",
        json!({ "title": "Mine", "owner": "me" }),
    )
    .await;
    let mine = ok(&client, "create_task", json!({ "title": "Scratch" })).await;
    let deleted = ok(&client, "delete_task", json!({ "task_id": id_in(&mine) })).await;
    ok(&client, "undo", json!({ "change_id": change_in(&deleted) })).await;
    assert!(task_of(&server, &id_in(&mine)).is_some());
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn projects_epics_and_tags_are_edited_and_deleted() {
    let f = fixture();
    let (other, project) = (f.other.clone(), f.project.clone());
    let server = TaskServer::new(f.store, None).unwrap();
    let client = connect(server.clone()).await;
    let area = id_in(&ok(&client, "create_project", json!({ "name": "Work" })).await);

    let updated = ok(
        &client,
        "update_project",
        json!({ "project_id": project, "name": "Task Master", "color": "#7a5cff",
                "area_id": area, "archived": true }),
    )
    .await;
    assert!(updated.contains("Task Master (archived)"), "{updated}");
    let p = server_snapshot(&server)
        .projects
        .into_iter()
        .find(|p| p.id == project)
        .unwrap();
    assert_eq!(p.parent_id.as_deref(), Some(area.as_str()));
    assert!(p.archived_at.is_some());
    let listed = ok(&client, "list_projects", json!({})).await;
    assert!(
        !listed.contains("Task Master"),
        "archived ones are hidden: {listed}"
    );
    let listed = ok(
        &client,
        "list_projects",
        json!({ "include_archived": true }),
    )
    .await;
    assert!(listed.contains("Work / Task Master (archived"), "{listed}");
    ok(
        &client,
        "update_project",
        json!({ "project_id": project, "archived": false, "area_id": "", "color": "" }),
    )
    .await;
    // Not while it holds tasks.
    refused(&client, "delete_project", json!({ "project_id": project })).await;
    let gone = ok(&client, "delete_project", json!({ "project_id": area })).await;
    assert!(gone.starts_with("Deleted project Work."), "{gone}");

    let epic = id_in(
        &ok(
            &client,
            "create_epic",
            json!({ "name": "Launch", "project_id": project }),
        )
        .await,
    );
    ok(
        &client,
        "update_task",
        json!({ "task_id": other, "epic_id": epic }),
    )
    .await;
    let done = ok(
        &client,
        "update_epic",
        json!({ "epic_id": epic, "name": "Launch 1.0", "state": "done",
                "target_date": "2026-12-24", "description": "Ship it", "project_id": "" }),
    )
    .await;
    assert!(done.starts_with("Updated epic Launch 1.0 (done"), "{done}");
    let listed = ok(&client, "list_projects", json!({})).await;
    assert!(listed.contains("Launch 1.0 (done, no project"), "{listed}");
    refused(
        &client,
        "update_epic",
        json!({ "epic_id": epic, "state": "finished" }),
    )
    .await;
    ok(&client, "delete_epic", json!({ "epic_id": epic })).await;
    assert_eq!(
        task_of(&server, &other).unwrap().epic_id,
        None,
        "its tasks stay"
    );

    ok(
        &client,
        "update_task",
        json!({ "task_id": other, "add_tags": ["bills"] }),
    )
    .await;
    let tags = ok(&client, "list_tags", json!({})).await;
    assert!(
        tags.contains("#bills") && tags.contains("1 open tasks"),
        "{tags}"
    );
    ok(
        &client,
        "update_tag",
        json!({ "tag": "#bills", "name": "money", "color": "#00aa00" }),
    )
    .await;
    assert!(ok(&client, "list_tags", json!({})).await.contains("#money"));
    let deleted = ok(&client, "delete_tag", json!({ "tag": "money" })).await;
    assert!(task_of(&server, &other).unwrap().tag_ids.is_empty());
    ok(&client, "undo", json!({ "change_id": change_in(&deleted) })).await;
    assert_eq!(
        task_of(&server, &other).unwrap().tag_ids.len(),
        1,
        "undo re-tags it"
    );
    client.cancel().await.unwrap();

    // Turned off: the user's projects, epics and tags stay as they are.
    let server = server.with_edit_user_tasks(false);
    let client = connect(server).await;
    for (tool, args) in [
        (
            "update_project",
            json!({ "project_id": project, "name": "X" }),
        ),
        ("delete_project", json!({ "project_id": project })),
        ("update_tag", json!({ "tag": "money", "name": "x" })),
        ("delete_tag", json!({ "tag": "money" })),
    ] {
        let message = refused(&client, tool, args).await;
        assert!(message.contains("turned off"), "{tool}: {message}");
    }
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn the_users_calendar_and_links_are_editable_by_default() {
    let f = fixture();
    let (task, other) = (f.task.clone(), f.other.clone());
    let server = TaskServer::new(f.store, Some(&f.session)).unwrap();
    let client = connect(server.clone()).await;
    let logged = ok(
        &client,
        "schedule_block",
        json!({ "task_id": other, "start": "2026-11-12T16:00Z", "end": "2026-11-12T17:00Z",
                "outcome": "worked" }),
    )
    .await;
    assert!(logged.starts_with("Logged"), "{logged}");
    let block = id_in(&logged);
    assert_eq!(
        server_snapshot(&server).time_blocks[0].outcome,
        BlockOutcome::Worked
    );
    ok(
        &client,
        "link_tasks",
        json!({ "task_id": other, "prerequisite_id": task }),
    )
    .await;
    assert_eq!(task_of(&server, &other).unwrap().dependency_ids, vec![task]);
    ok(
        &client,
        "update_block",
        json!({ "block_id": block, "remove": true }),
    )
    .await;
    assert!(server_snapshot(&server).time_blocks.is_empty());
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn attachments_are_added_read_renamed_and_removed() {
    let f = fixture();
    let other = f.other.clone();
    let store = f.store.with_files(temp_dir("files"));
    let server = TaskServer::new(store, None).unwrap();
    let client = connect(server.clone()).await;

    let made = ok(
        &client,
        "attach_file",
        json!({ "task_id": other, "name": "lease.md", "text": "# Lease\nDue on the 1st." }),
    )
    .await;
    assert!(
        made.starts_with("Attached lease.md (23 B) to Pay the rent"),
        "{made}"
    );
    let id = id_in(&made);
    let listed = ok(&client, "list_attachments", json!({ "task_id": other })).await;
    assert!(listed.contains("lease.md (text/markdown"), "{listed}");
    assert_eq!(
        ok(&client, "read_attachment", json!({ "attachment_id": id })).await,
        "# Lease\nDue on the 1st."
    );
    ok(
        &client,
        "rename_attachment",
        json!({ "attachment_id": id, "name": "lease-2026.md" }),
    )
    .await;

    // Binary content, and a file on this device.
    let png = ok(
        &client,
        "attach_file",
        json!({ "task_id": other, "name": "dot.png", "base64": "iVBORw0KGgo=" }),
    )
    .await;
    let shown = ok(
        &client,
        "read_attachment",
        json!({ "attachment_id": id_in(&png) }),
    )
    .await;
    assert!(
        shown.contains("image/png") && shown.contains("The file is at"),
        "{shown}"
    );
    let source = temp_dir("source").join("notes.txt");
    std::fs::write(&source, "hello").unwrap();
    let from_path = ok(
        &client,
        "attach_file",
        json!({ "task_id": other, "path": source.display().to_string() }),
    )
    .await;
    assert!(
        from_path.starts_with("Attached notes.txt (5 B)"),
        "{from_path}"
    );
    refused(
        &client,
        "attach_file",
        json!({ "task_id": other, "name": "x", "text": "a", "base64": "YQ==" }),
    )
    .await;

    ok(&client, "remove_attachment", json!({ "attachment_id": id })).await;
    let names: Vec<String> = server_snapshot(&server)
        .attachments
        .iter()
        .map(|a| a.name.clone())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(!names.contains(&"lease-2026.md".to_owned()));
    client.cancel().await.unwrap();

    // The sync server's MCP never reads its own files by path.
    let store = Store::open_in_memory()
        .unwrap()
        .with_files(temp_dir("shared"));
    let shared = TaskServer::shared(std::sync::Arc::new(std::sync::Mutex::new(store)));
    let client = connect(shared).await;
    let made = ok(&client, "create_task", json!({ "title": "Remote" })).await;
    let message = refused(
        &client,
        "attach_file",
        json!({ "task_id": id_in(&made), "path": source.display().to_string() }),
    )
    .await;
    assert!(message.contains("cannot read files by path"), "{message}");
    ok(
        &client,
        "attach_file",
        json!({ "task_id": id_in(&made), "name": "a.txt", "base64": "YQ==" }),
    )
    .await;
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn ended_agent_sessions_can_be_removed() {
    let f = fixture();
    let session = f.session.clone();
    let server = TaskServer::new(f.store, None).unwrap();
    let client = connect(server.clone()).await;
    let message = refused(
        &client,
        "remove_agent_session",
        json!({ "session_id": session }),
    )
    .await;
    assert!(message.contains("has not ended"), "{message}");
    with_store(&server, |s| {
        s.execute_without_undo(vec![Command::UpdateAgentSession {
            id: session.clone(),
            changes: vec![AgentSessionChange::State(SessionState::Done)],
        }])
    });
    ok(
        &client,
        "remove_agent_session",
        json!({ "session_id": session }),
    )
    .await;
    assert!(server_snapshot(&server).agent_sessions.is_empty());
    client.cancel().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn meetings_are_listed_read_in_full_and_on_the_calendar() {
    let mut f = fixture();
    let mut add = |title: &str, start: &str, participants: &[&str], task: Option<Id>| {
        f.store
            .execute(Command::CreateMeeting {
                meeting: NewMeeting {
                    title: title.into(),
                    started_at: at(start),
                    ended_at: Some(at(start) + 3_600_000),
                    project_id: Some(f.project.clone()),
                    task_id: task,
                    participants: participants.iter().map(|p| (*p).to_owned()).collect(),
                    notes: format!("Notes of {title}"),
                    ..NewMeeting::default()
                },
            })
            .unwrap()
            .meetings
            .remove(0)
            .id
    };
    let kickoff = add(
        "Kick-off",
        "2026-11-12T08:00:00Z",
        &["Ada", "Grace"],
        Some(f.task.clone()),
    );
    let retro = add("Retro", "2026-11-13T15:00:00Z", &["Bob"], None);
    let server = TaskServer::new(f.store, Some(&f.session)).unwrap();
    let client = connect(server).await;

    let all = ok(&client, "list_meetings", json!({ "utc_offset": "+01:00" })).await;
    let lines: Vec<&str> = all.lines().collect();
    assert_eq!(lines.len(), 2, "{all}");
    assert!(lines[0].contains("Retro"), "newest first: {all}");
    assert!(
        lines[1].contains("2026-11-12 09:00–10:00: Kick-off (scheduled, with Ada, Grace"),
        "{all}"
    );

    let by_name = ok(&client, "list_meetings", json!({ "participant": "grace" })).await;
    assert!(
        by_name.contains(&kickoff) && !by_name.contains(&retro),
        "{by_name}"
    );
    let by_task = ok(&client, "list_meetings", json!({ "task_id": f.task })).await;
    assert!(by_task.contains(&kickoff) && !by_task.contains(&retro));
    let none = ok(&client, "list_meetings", json!({ "participant": "Zed" })).await;
    assert_eq!(none, "No meetings match.");

    let page = ok(&client, "list_meetings", json!({ "limit": 1 })).await;
    assert!(page.contains("next_cursor"), "{page}");
    let next = ok(
        &client,
        "list_meetings",
        json!({ "limit": 1, "cursor": retro }),
    )
    .await;
    assert!(next.contains(&kickoff), "{next}");

    let full = ok(&client, "get_meeting", json!({ "meeting_id": kickoff })).await;
    assert!(full.contains("# Meeting: Kick-off"), "{full}");
    assert!(full.contains("- Project: task-master"), "{full}");
    assert!(full.contains("- Task: Spawn Claude sessions"), "{full}");
    assert!(full.contains("- Participants: Ada, Grace"), "{full}");
    assert!(full.contains("Notes of Kick-off"), "{full}");
    refused(&client, "get_meeting", json!({ "meeting_id": new_id() })).await;

    let week = json!({ "from": "2026-11-12", "to": "2026-11-14" });
    let shown = ok(&client, "get_calendar", week).await;
    assert!(
        shown.contains(&format!(
            "- 08:00–09:00 meeting: Kick-off (meeting `{kickoff}`)"
        )),
        "{shown}"
    );
    client.cancel().await.unwrap();
}

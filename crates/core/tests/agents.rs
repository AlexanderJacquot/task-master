//! Agent sessions (ADR 017): task owners, sessions and notes through commands, kept out
//! of the undo history, synced to other devices but changed only by their own, project
//! folders as device configuration, and the context brief.

use taskmaster_core::*;

const DONE: &str = "00000000-0000-7000-8000-000000000005";
const IN_PROGRESS: &str = "00000000-0000-7000-8000-000000000003";

fn store() -> Store {
    Store::open_in_memory().unwrap()
}

fn add_task(s: &mut Store, task: NewTask) -> Task {
    s.execute(Command::CreateTask { task })
        .unwrap()
        .tasks
        .remove(0)
}

fn titled(title: &str) -> NewTask {
    NewTask {
        title: title.into(),
        ..NewTask::default()
    }
}

fn new_session(task_id: &str) -> NewAgentSession {
    NewAgentSession {
        id: None,
        task_id: task_id.into(),
        claude_session_id: new_id(),
        folder: "/home/alex/Code/task-master".into(),
        runtime: AgentRuntime::Wsl,
        permission_mode: "acceptEdits".into(),
        prompt: "  Keep it small.  ".into(),
    }
}

fn start(s: &mut Store, task_id: &str) -> AgentSession {
    s.execute_without_undo(vec![Command::CreateAgentSession {
        session: new_session(task_id),
    }])
    .unwrap()
    .agent_sessions
    .remove(0)
}

fn update(s: &mut Store, id: &str, changes: Vec<AgentSessionChange>) -> Result<Changes> {
    s.execute_without_undo(vec![Command::UpdateAgentSession {
        id: id.into(),
        changes,
    }])
}

fn note(s: &mut Store, session_id: &str, body: &str) -> Result<Changes> {
    s.execute_without_undo(vec![Command::AddAgentNote {
        note: NewAgentNote {
            id: None,
            session_id: session_id.into(),
            body: body.into(),
        },
    }])
}

fn invalid(result: Result<Changes>) -> String {
    match result {
        Err(Error::Invalid(message)) => message,
        other => panic!("expected an invalid-input error, got {other:?}"),
    }
}

/// Sends the device's unpushed ops to the server, then pulls everything new.
fn sync(device: &mut Store, server: &mut Store) {
    let page = device.outbox(1000).unwrap();
    if !page.ops.is_empty() {
        server.apply_remote(page.ops, None).unwrap();
    }
    device.mark_pushed(page.last_seq).unwrap();
    let page = server
        .ops_after(device.sync_cursor().unwrap(), 1000)
        .unwrap();
    device.apply_remote(page.ops, Some(page.last_seq)).unwrap();
}

#[test]
fn tasks_belong_to_me_unless_made_for_an_agent() {
    let mut s = store();
    let mine = add_task(&mut s, titled("Mine"));
    assert_eq!(mine.owner, TaskOwner::Me);
    let theirs = add_task(
        &mut s,
        NewTask {
            owner: TaskOwner::Agent,
            parent_id: Some(mine.id.clone()),
            ..titled("Agent step")
        },
    );
    assert_eq!(theirs.owner, TaskOwner::Agent);
    assert_eq!(theirs.parent_id.as_deref(), Some(mine.id.as_str()));

    // Adopting an agent task is an ordinary, undoable edit.
    let adopted = s
        .execute(Command::UpdateTask {
            id: theirs.id.clone(),
            changes: vec![TaskChange::Owner(TaskOwner::Me)],
        })
        .unwrap()
        .tasks
        .remove(0);
    assert_eq!(adopted.owner, TaskOwner::Me);
    s.undo().unwrap().unwrap();
    let snapshot = s.snapshot().unwrap();
    let back = snapshot.tasks.iter().find(|t| t.id == theirs.id).unwrap();
    assert_eq!(back.owner, TaskOwner::Agent);
}

#[test]
fn a_session_runs_ends_and_resumes_outside_the_undo_history() {
    let mut s = store();
    let task = add_task(&mut s, titled("Fix the sync bug"));
    s.undo().unwrap(); // nothing of the user's left to undo afterwards...
    s.redo().unwrap();
    assert!(s.can_undo());
    let undo_before = s.can_undo();

    let session = start(&mut s, &task.id);
    assert_eq!(session.state, SessionState::Running);
    assert_eq!(session.device_id, s.device_id());
    assert_eq!(session.prompt, "Keep it small.");
    assert_eq!(session.ended_at, None);
    assert_eq!(s.snapshot().unwrap().agent_sessions, vec![session.clone()]);

    let changes = update(
        &mut s,
        &session.id,
        vec![
            AgentSessionChange::State(SessionState::Done),
            AgentSessionChange::Summary(Some(" Fixed it. \n".into())),
            AgentSessionChange::CostUsdMicros(Some(123_456)),
            AgentSessionChange::Turns(Some(7)),
        ],
    )
    .unwrap();
    let done = &changes.agent_sessions[0];
    assert_eq!(done.state, SessionState::Done);
    assert_eq!(done.summary.as_deref(), Some("Fixed it."));
    assert_eq!(done.cost_usd_micros, Some(123_456));
    assert_eq!(done.turns, Some(7));
    assert!(done.ended_at.is_some());
    // The task is touched so its views and activity refresh.
    assert_eq!(changes.tasks.len(), 1);

    // A follow-up turn runs it again.
    let again = update(
        &mut s,
        &session.id,
        vec![AgentSessionChange::State(SessionState::Running)],
    )
    .unwrap()
    .agent_sessions
    .remove(0);
    assert_eq!(again.ended_at, None);

    // Undo still reaches the user's own last edit, not the session bookkeeping.
    assert_eq!(s.can_undo(), undo_before);
    let undone = s.undo().unwrap().unwrap();
    assert_eq!(undone.tasks[0].id, task.id);
    assert!(undone.tasks[0].deleted_at.is_some());
}

#[test]
fn notes_are_recorded_on_the_session_task_and_listed_oldest_first() {
    let mut s = store();
    let task = add_task(&mut s, titled("Write docs"));
    let session = start(&mut s, &task.id);
    for body in ["Read the plan", "Drafted the outline", "Wrote section 1"] {
        note(&mut s, &session.id, body).unwrap();
    }
    let notes = s.agent_notes(&task.id, None, 2).unwrap();
    let bodies: Vec<&str> = notes.iter().map(|n| n.body.as_str()).collect();
    assert_eq!(bodies, ["Drafted the outline", "Wrote section 1"]);
    assert!(
        notes
            .iter()
            .all(|n| n.task_id == task.id && n.session_id == session.id)
    );
    assert_eq!(
        s.agent_notes(&task.id, Some(&session.id), 10)
            .unwrap()
            .len(),
        3
    );

    assert!(invalid(note(&mut s, &session.id, "   ")).contains("cannot be empty"));
    let long = "x".repeat(MAX_NOTE_CHARS + 1);
    assert!(invalid(note(&mut s, &session.id, &long)).contains("limited"));
}

#[test]
fn bad_sessions_are_refused() {
    let mut s = store();
    let task = add_task(&mut s, titled("Task"));
    let mut bad = new_session(&task.id);
    bad.permission_mode = "yolo".into();
    let create = |s: &mut Store, session| {
        s.execute_without_undo(vec![Command::CreateAgentSession { session }])
    };
    assert!(invalid(create(&mut s, bad)).contains("permission mode"));
    let mut bad = new_session(&task.id);
    bad.claude_session_id = "not-a-uuid".into();
    assert!(invalid(create(&mut s, bad)).contains("UUID"));
    let mut bad = new_session(&task.id);
    bad.folder = " ".into();
    assert!(invalid(create(&mut s, bad)).contains("folder"));
    assert!(matches!(
        create(&mut s, new_session(&new_id())),
        Err(Error::NotFound { .. })
    ));

    let session = start(&mut s, &task.id);
    assert!(
        invalid(update(
            &mut s,
            &session.id,
            vec![AgentSessionChange::Turns(Some(-1))]
        ))
        .contains("negative")
    );
    assert!(invalid(update(&mut s, &session.id, vec![])).contains("at least one"));
    // A running session cannot be removed.
    let removed = s.execute_without_undo(vec![Command::DeleteAgentSession {
        id: session.id.clone(),
    }]);
    assert!(invalid(removed).contains("stop the session"));
}

#[test]
fn removing_a_session_removes_its_notes() {
    let mut s = store();
    let task = add_task(&mut s, titled("Task"));
    let session = start(&mut s, &task.id);
    note(&mut s, &session.id, "progress").unwrap();
    update(
        &mut s,
        &session.id,
        vec![AgentSessionChange::State(SessionState::Failed)],
    )
    .unwrap();
    let changes = s
        .execute(Command::DeleteAgentSession {
            id: session.id.clone(),
        })
        .unwrap();
    assert!(changes.agent_sessions[0].deleted_at.is_some());
    assert!(changes.agent_notes[0].deleted_at.is_some());
    assert!(s.snapshot().unwrap().agent_sessions.is_empty());
    assert!(s.agent_notes(&task.id, None, 10).unwrap().is_empty());

    // Removing it was the user's choice, so it undoes.
    s.undo().unwrap().unwrap();
    assert_eq!(s.snapshot().unwrap().agent_sessions.len(), 1);
    assert_eq!(s.agent_notes(&task.id, None, 10).unwrap().len(), 1);
}

#[test]
fn a_deleted_task_hides_its_sessions() {
    let mut s = store();
    let task = add_task(&mut s, titled("Task"));
    start(&mut s, &task.id);
    s.execute(Command::DeleteTask {
        id: task.id.clone(),
    })
    .unwrap();
    assert!(s.snapshot().unwrap().agent_sessions.is_empty());
    s.undo().unwrap();
    assert_eq!(s.snapshot().unwrap().agent_sessions.len(), 1);
}

#[test]
fn start_up_interrupts_this_devices_running_sessions_only() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let task = add_task(&mut a, titled("Shared"));
    let on_a = start(&mut a, &task.id);
    sync(&mut a, &mut server);
    sync(&mut b, &mut server);
    let on_b = start(&mut b, &task.id);
    let finished = start(&mut b, &task.id);
    update(
        &mut b,
        &finished.id,
        vec![AgentSessionChange::State(SessionState::Done)],
    )
    .unwrap();

    let changes = b.interrupt_running_sessions().unwrap();
    assert_eq!(changes.agent_sessions.len(), 1);
    assert_eq!(changes.agent_sessions[0].id, on_b.id);
    assert_eq!(changes.agent_sessions[0].state, SessionState::Interrupted);
    assert_eq!(
        b.agent_session(&on_a.id).unwrap().state,
        SessionState::Running
    );
    assert_eq!(
        b.agent_session(&finished.id).unwrap().state,
        SessionState::Done
    );
    assert!(b.interrupt_running_sessions().unwrap().is_empty());
}

#[test]
fn sessions_sync_but_only_their_device_changes_them() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let task = add_task(&mut a, titled("Shared"));
    let session = start(&mut a, &task.id);
    note(&mut a, &session.id, "halfway").unwrap();
    sync(&mut a, &mut server);
    sync(&mut b, &mut server);

    assert_eq!(b.snapshot().unwrap().agent_sessions, vec![session.clone()]);
    assert_eq!(
        b.agent_notes(&task.id, None, 10).unwrap()[0].body,
        "halfway"
    );
    let refused = update(
        &mut b,
        &session.id,
        vec![AgentSessionChange::State(SessionState::Cancelled)],
    );
    assert!(invalid(refused).contains("another device"));
    assert!(invalid(note(&mut b, &session.id, "hi")).contains("another device"));

    update(
        &mut a,
        &session.id,
        vec![
            AgentSessionChange::State(SessionState::Done),
            AgentSessionChange::Summary(Some("All done".into())),
        ],
    )
    .unwrap();
    sync(&mut a, &mut server);
    sync(&mut b, &mut server);
    let seen = b.agent_session(&session.id).unwrap();
    assert_eq!(seen.state, SessionState::Done);
    assert_eq!(seen.summary.as_deref(), Some("All done"));
    assert_eq!(seen, a.agent_session(&session.id).unwrap());
}

#[test]
fn agent_work_shows_in_the_task_activity() {
    let mut s = store();
    let task = add_task(&mut s, titled("Task"));
    let session = start(&mut s, &task.id);
    note(&mut s, &session.id, "Found the cause").unwrap();
    update(
        &mut s,
        &session.id,
        vec![AgentSessionChange::Turns(Some(3))],
    )
    .unwrap();
    update(
        &mut s,
        &session.id,
        vec![
            AgentSessionChange::State(SessionState::Done),
            AgentSessionChange::Summary(Some("Fixed".into())),
        ],
    )
    .unwrap();
    let activity = s.task_activity(&task.id, 20).unwrap();
    let kinds: Vec<&str> = activity.iter().map(|a| a.kind.as_str()).collect();
    assert_eq!(kinds, ["agent_end", "agent_note", "agent_start", "create"]);
    let field = |kind: &str, name: &str| {
        activity
            .iter()
            .find(|a| a.kind == kind)
            .and_then(|a| a.fields.iter().find(|f| f.field == name))
            .map(|f| f.after.clone())
    };
    assert_eq!(
        field("agent_start", "folder").unwrap(),
        "\"/home/alex/Code/task-master\""
    );
    assert_eq!(field("agent_note", "body").unwrap(), "\"Found the cause\"");
    assert_eq!(field("agent_end", "state").unwrap(), "\"done\"");
    assert_eq!(field("agent_end", "summary").unwrap(), "\"Fixed\"");
}

#[test]
fn project_folders_are_device_configuration() {
    let mut s = store();
    let project = s
        .execute(Command::CreateProject {
            project: NewProject {
                name: "task-master".into(),
                ..NewProject::default()
            },
        })
        .unwrap()
        .projects
        .remove(0);
    s.set_project_folder(
        &project.id,
        Some((" /home/alex/Code/task-master ".into(), AgentRuntime::Wsl)),
    )
    .unwrap();
    s.set_project_folder(
        &project.id,
        Some(("/home/alex/Code/tm".into(), AgentRuntime::Wsl)),
    )
    .unwrap();
    let folders = s.project_folders().unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].path, "/home/alex/Code/tm");
    assert_eq!(folders[0].runtime, AgentRuntime::Wsl);
    assert!(!s.can_redo());

    // Not exported, so an import (or replacing with the server's data) keeps it.
    let export = s.export().unwrap();
    assert!(!export.tables.contains_key("project_folders"));
    s.import(&export).unwrap();
    assert_eq!(s.project_folders().unwrap().len(), 1);
    s.clear_for_replace().unwrap();
    assert!(s.project_folders().unwrap().is_empty(), "project is gone");

    assert!(matches!(
        s.set_project_folder(&project.id, Some(("/x".into(), AgentRuntime::Native))),
        Err(Error::NotFound { .. })
    ));
    s.set_project_folder(&project.id, None).unwrap();
}

#[test]
fn export_and_import_carry_sessions_and_notes() {
    let mut s = store();
    let task = add_task(&mut s, titled("Task"));
    let session = start(&mut s, &task.id);
    note(&mut s, &session.id, "note").unwrap();
    let export = s.export().unwrap();
    let mut other = store();
    let summary = other.import(&export).unwrap();
    assert_eq!(summary.tasks, 1);
    assert_eq!(other.snapshot().unwrap().agent_sessions, vec![session]);
    assert_eq!(other.agent_notes(&task.id, None, 5).unwrap().len(), 1);
}

#[test]
fn the_brief_gathers_what_an_agent_needs() {
    const AREA: &str = "0190f0a0-0000-7000-8000-000000000001";
    const PROJECT: &str = "0190f0a0-0000-7000-8000-000000000002";
    const EPIC: &str = "0190f0a0-0000-7000-8000-000000000003";
    const TASK: &str = "0190f0a0-0000-7000-8000-000000000010";
    const SUB_DONE: &str = "0190f0a0-0000-7000-8000-000000000011";
    const SUB_OPEN: &str = "0190f0a0-0000-7000-8000-000000000012";
    const PREREQ: &str = "0190f0a0-0000-7000-8000-000000000013";
    const DEPENDENT: &str = "0190f0a0-0000-7000-8000-000000000014";
    const TAG: &str = "0190f0a0-0000-7000-8000-000000000020";

    let mut s = store();
    let project = |id: &str, name: &str, parent: Option<&str>| Command::CreateProject {
        project: NewProject {
            id: Some(id.into()),
            name: name.into(),
            parent_id: parent.map(Into::into),
            ..NewProject::default()
        },
    };
    s.execute_all(vec![
        project(AREA, "Code", None),
        project(PROJECT, "task-master", Some(AREA)),
        Command::CreateEpic {
            epic: NewEpic {
                id: Some(EPIC.into()),
                name: "AI integration".into(),
                project_id: Some(PROJECT.into()),
                description: Some("Let Claude work from tasks.".into()),
                target_date: Some("2026-12-01".into()),
                ..NewEpic::default()
            },
        },
        Command::CreateTag {
            tag: NewTag {
                id: Some(TAG.into()),
                name: "deep-work".into(),
                color: None,
            },
        },
    ])
    .unwrap();
    add_task(
        &mut s,
        NewTask {
            id: Some(PREREQ.into()),
            project_id: Some(PROJECT.into()),
            status_id: Some(DONE.into()),
            ..titled("Design the data model")
        },
    );
    add_task(
        &mut s,
        NewTask {
            id: Some(TASK.into()),
            description: "Add `Send to Claude` on tasks.\n\nSee ADR 017.".into(),
            project_id: Some(PROJECT.into()),
            epic_id: Some(EPIC.into()),
            status_id: Some(IN_PROGRESS.into()),
            priority: Priority::High,
            due_date: Some("2026-11-20".into()),
            estimate_min: Some(240),
            tag_ids: vec![TAG.into()],
            ..titled("Spawn Claude sessions")
        },
    );
    add_task(
        &mut s,
        NewTask {
            id: Some(SUB_DONE.into()),
            parent_id: Some(TASK.into()),
            status_id: Some(DONE.into()),
            ..titled("Migration")
        },
    );
    add_task(
        &mut s,
        NewTask {
            id: Some(SUB_OPEN.into()),
            parent_id: Some(TASK.into()),
            owner: TaskOwner::Agent,
            ..titled("Stream parser")
        },
    );
    add_task(
        &mut s,
        NewTask {
            id: Some(DEPENDENT.into()),
            ..titled("Ship v0.6")
        },
    );
    for (id, deps) in [
        (TASK, vec![PREREQ.to_owned()]),
        (DEPENDENT, vec![TASK.to_owned()]),
    ] {
        s.execute(Command::UpdateTask {
            id: id.into(),
            changes: vec![TaskChange::DependencyIds(deps)],
        })
        .unwrap();
    }
    let earlier = start(&mut s, TASK);
    note(&mut s, &earlier.id, "Core tables done").unwrap();
    update(
        &mut s,
        &earlier.id,
        vec![
            AgentSessionChange::State(SessionState::Done),
            AgentSessionChange::Summary(Some("Added migration 0010.\nTests pass.".into())),
        ],
    )
    .unwrap();
    start(&mut s, TASK); // running: not an "earlier" session

    insta::assert_snapshot!(s.agent_brief(TASK).unwrap());
}

#[test]
fn the_brief_of_a_bare_task_is_short() {
    let mut s = store();
    let task = add_task(
        &mut s,
        NewTask {
            id: Some("0190f0a0-0000-7000-8000-000000000099".into()),
            ..titled("Tidy up")
        },
    );
    insta::assert_snapshot!(s.agent_brief(&task.id).unwrap());
    s.execute(Command::DeleteTask {
        id: task.id.clone(),
    })
    .unwrap();
    assert!(matches!(
        s.agent_brief(&task.id),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn an_agent_writing_elsewhere_keeps_the_users_undo_history() {
    let dir = std::env::temp_dir().join(format!("tm-agent-undo-{}", new_id()));
    let path = dir.join("tasks.sqlite");
    let mut desktop = Store::open(&path).unwrap();
    let mut mcp = Store::open(&path).unwrap();
    let other = add_task(&mut desktop, titled("Other"));
    let mine = add_task(&mut desktop, titled("Mine"));
    desktop.refresh_external_changes().unwrap();

    // The agent adds its own task and a note (which touches the session task).
    let session = start(&mut desktop, &mine.id);
    add_task(
        &mut mcp,
        NewTask {
            owner: TaskOwner::Agent,
            parent_id: Some(mine.id.clone()),
            ..titled("Agent step")
        },
    );
    note(&mut mcp, &session.id, "working").unwrap();
    // A write of the desktop's own between two checks is not an outside write.
    note(&mut desktop, &session.id, "from the desktop").unwrap();
    assert!(desktop.refresh_external_changes().unwrap());
    assert!(
        desktop.can_undo(),
        "unrelated outside writes keep the history"
    );

    // Undoing the task's creation only deletes it, so a rename does not conflict.
    mcp.execute(Command::UpdateTask {
        id: mine.id.clone(),
        changes: vec![TaskChange::Title("Renamed by the agent".into())],
    })
    .unwrap();
    assert!(desktop.refresh_external_changes().unwrap());
    assert!(desktop.can_undo());

    // An outside edit to a field the user's undo would write back clears the history.
    desktop
        .execute(Command::UpdateTask {
            id: other.id.clone(),
            changes: vec![TaskChange::Title("Other, renamed".into())],
        })
        .unwrap();
    mcp.execute(Command::UpdateTask {
        id: other.id.clone(),
        changes: vec![TaskChange::Title("Changed by the agent".into())],
    })
    .unwrap();
    assert!(desktop.refresh_external_changes().unwrap());
    assert!(!desktop.can_undo(), "undo would revert the agent's edit");
    drop((desktop, mcp));
    let _ = std::fs::remove_dir_all(dir);
}

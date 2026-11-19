//! Terminal sessions (M21, ADR 028): Claude Code sessions run outside the app, recorded
//! from their transcripts. Recording again updates them; the project comes from this
//! device's project folders unless set by hand; the app's own runs and removed sessions
//! are skipped; they sync and export like the rest.

use taskmaster_core::*;

fn store() -> Store {
    Store::open_in_memory().unwrap()
}

fn project(s: &mut Store, name: &str) -> Project {
    s.execute(Command::CreateProject {
        project: NewProject {
            name: name.into(),
            ..NewProject::default()
        },
    })
    .unwrap()
    .projects
    .remove(0)
}

fn transcript(claude_session_id: &str, folder: &str) -> TerminalSessionRecord {
    TerminalSessionRecord {
        id: None,
        claude_session_id: claude_session_id.into(),
        folder: folder.into(),
        title: Some("  Fix the build ".into()),
        model: Some("claude-opus-5-5".into()),
        started_at: 1_000,
        ended_at: 61_000,
        cost_usd_micros: Some(1_250_000),
        duration_ms: Some(40_000),
        turns: Some(12),
    }
}

fn record(s: &mut Store, sessions: Vec<TerminalSessionRecord>) -> Changes {
    s.execute_without_undo(vec![Command::RecordTerminalSessions { sessions }])
        .unwrap()
}

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
fn a_transcript_becomes_a_session_of_the_project_whose_folder_holds_it() {
    let mut s = store();
    let tm = project(&mut s, "Task Master");
    s.set_project_folder(
        &tm.id,
        Some(("/home/alex/Code/task-master".into(), AgentRuntime::Wsl)),
    )
    .unwrap();
    let id = new_id();
    let other = new_id();
    let changes = record(
        &mut s,
        vec![
            transcript(&id, "/home/alex/Code/task-master/.claude/worktrees/fix"),
            transcript(&other, "/home/alex"),
        ],
    );
    assert_eq!(changes.terminal_sessions.len(), 2);
    let sessions = s.snapshot().unwrap().terminal_sessions;
    let mine = sessions.iter().find(|t| t.claude_session_id == id).unwrap();
    assert_eq!(mine.project_id.as_deref(), Some(tm.id.as_str()));
    assert_eq!(mine.title.as_deref(), Some("Fix the build"));
    assert_eq!(mine.cost_usd_micros, Some(1_250_000));
    assert_eq!(mine.device_id, s.device_id());
    let home = sessions
        .iter()
        .find(|t| t.claude_session_id == other)
        .unwrap();
    assert_eq!(home.project_id, None);
    // Bookkeeping, not an edit of the user's: undo reverts the project, not the import.
    let undone = s.undo().unwrap().unwrap();
    assert!(undone.terminal_sessions.is_empty());
    assert_eq!(undone.projects[0].id, tm.id);
    assert_eq!(s.snapshot().unwrap().terminal_sessions.len(), 2);
}

#[test]
fn recording_again_updates_only_what_changed() {
    let mut s = store();
    let id = new_id();
    let first = record(&mut s, vec![transcript(&id, "/work")]).terminal_sessions[0].clone();

    // Nothing new in the transcript: no op at all.
    assert!(record(&mut s, vec![transcript(&id, "/work")]).is_empty());

    let later = TerminalSessionRecord {
        ended_at: 120_000,
        cost_usd_micros: Some(2_000_000),
        turns: Some(20),
        ..transcript(&id, "/work")
    };
    let changes = record(&mut s, vec![later]);
    let updated = &changes.terminal_sessions[0];
    assert_eq!(updated.id, first.id);
    assert_eq!(updated.ended_at, 120_000);
    assert_eq!(updated.cost_usd_micros, Some(2_000_000));
    assert_eq!(s.snapshot().unwrap().terminal_sessions.len(), 1);
}

#[test]
fn a_folder_given_a_project_later_brings_its_sessions_unless_set_by_hand() {
    let mut s = store();
    let site = project(&mut s, "Site");
    let (a, b) = (new_id(), new_id());
    let changes = record(
        &mut s,
        vec![
            transcript(&a, "/code/site"),
            transcript(&b, "/code/site/docs"),
        ],
    );
    let b_row = changes
        .terminal_sessions
        .iter()
        .find(|t| t.claude_session_id == b)
        .unwrap()
        .clone();
    // The user says `b` has no project, on purpose.
    s.execute(Command::UpdateTerminalSession {
        id: b_row.id.clone(),
        changes: vec![TerminalSessionChange::ProjectId(None)],
    })
    .unwrap();

    s.set_project_folder(&site.id, Some(("/code/site".into(), AgentRuntime::Native)))
        .unwrap();
    record(
        &mut s,
        vec![
            transcript(&a, "/code/site"),
            transcript(&b, "/code/site/docs"),
        ],
    );
    let sessions = s.snapshot().unwrap().terminal_sessions;
    let project_of = |cid: &str| {
        sessions
            .iter()
            .find(|t| t.claude_session_id == cid)
            .unwrap()
            .project_id
            .clone()
    };
    assert_eq!(project_of(&a), Some(site.id.clone()));
    assert_eq!(project_of(&b), None);
}

#[test]
fn the_apps_own_runs_and_removed_sessions_are_skipped() {
    let mut s = store();
    let task = s
        .execute(Command::CreateTask {
            task: NewTask {
                title: "Agent work".into(),
                ..NewTask::default()
            },
        })
        .unwrap()
        .tasks
        .remove(0);
    let run = s
        .execute_without_undo(vec![Command::CreateAgentSession {
            session: NewAgentSession {
                id: None,
                task_id: task.id.clone(),
                claude_session_id: new_id(),
                folder: "/work".into(),
                runtime: AgentRuntime::Native,
                permission_mode: "acceptEdits".into(),
                model: None,
                prompt: String::new(),
            },
        }])
        .unwrap()
        .agent_sessions
        .remove(0);
    assert!(record(&mut s, vec![transcript(&run.claude_session_id, "/work")]).is_empty());

    let id = new_id();
    let row = record(&mut s, vec![transcript(&id, "/work")]).terminal_sessions[0].clone();
    s.execute(Command::DeleteTerminalSession { id: row.id.clone() })
        .unwrap();
    assert!(s.snapshot().unwrap().terminal_sessions.is_empty());
    let later = TerminalSessionRecord {
        ended_at: 999_000,
        ..transcript(&id, "/work")
    };
    assert!(record(&mut s, vec![later]).is_empty());
    assert!(s.snapshot().unwrap().terminal_sessions.is_empty());

    // Undo brings a removed session back.
    s.undo().unwrap();
    assert_eq!(s.snapshot().unwrap().terminal_sessions.len(), 1);
}

#[test]
fn bad_records_are_refused_and_end_never_precedes_start() {
    let mut s = store();
    let refused = s.execute_without_undo(vec![Command::RecordTerminalSessions {
        sessions: vec![transcript("not-a-uuid", "/work")],
    }]);
    assert!(matches!(refused, Err(Error::Invalid(_))));
    let negative = s.execute_without_undo(vec![Command::RecordTerminalSessions {
        sessions: vec![TerminalSessionRecord {
            cost_usd_micros: Some(-1),
            ..transcript(&new_id(), "/work")
        }],
    }]);
    assert!(matches!(negative, Err(Error::Invalid(_))));
    let backwards = TerminalSessionRecord {
        started_at: 5_000,
        ended_at: 1_000,
        ..transcript(&new_id(), "/work")
    };
    let row = &record(&mut s, vec![backwards]).terminal_sessions[0];
    assert_eq!(row.ended_at, 5_000);
}

#[test]
fn a_task_and_project_can_be_set_by_hand_and_undone() {
    let mut s = store();
    let p = project(&mut s, "Ops");
    let task = s
        .execute(Command::CreateTask {
            task: NewTask {
                title: "Rotate keys".into(),
                project_id: Some(p.id.clone()),
                ..NewTask::default()
            },
        })
        .unwrap()
        .tasks
        .remove(0);
    let row = record(&mut s, vec![transcript(&new_id(), "/tmp")]).terminal_sessions[0].clone();
    let changed = s
        .execute(Command::UpdateTerminalSession {
            id: row.id.clone(),
            changes: vec![
                TerminalSessionChange::ProjectId(Some(p.id.clone())),
                TerminalSessionChange::TaskId(Some(task.id.clone())),
            ],
        })
        .unwrap()
        .terminal_sessions
        .remove(0);
    assert_eq!(changed.project_id.as_deref(), Some(p.id.as_str()));
    assert_eq!(changed.task_id.as_deref(), Some(task.id.as_str()));
    let undone = s.undo().unwrap().unwrap().terminal_sessions.remove(0);
    assert_eq!(undone.project_id, None);
    assert_eq!(undone.task_id, None);

    let missing = s.execute(Command::UpdateTerminalSession {
        id: row.id,
        changes: vec![TerminalSessionChange::TaskId(Some(new_id()))],
    });
    assert!(missing.is_err());
}

#[test]
fn terminal_sessions_sync_and_export() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let row = record(&mut a, vec![transcript(&new_id(), "/work")]).terminal_sessions[0].clone();
    sync(&mut a, &mut server);
    sync(&mut b, &mut server);
    assert_eq!(b.snapshot().unwrap().terminal_sessions, vec![row.clone()]);

    let file = a.export().unwrap();
    let mut target = store();
    target.import(&file).unwrap();
    assert_eq!(target.snapshot().unwrap().terminal_sessions, vec![row]);
}

fn desktop_session(s: &mut Store) -> AgentSession {
    let task = s
        .execute(Command::CreateTask {
            task: NewTask {
                title: "Redesign".into(),
                ..NewTask::default()
            },
        })
        .unwrap()
        .tasks
        .remove(0);
    let session = s
        .execute_without_undo(vec![Command::CreateAgentSession {
            session: NewAgentSession {
                id: None,
                task_id: task.id,
                claude_session_id: new_id(),
                folder: "/work".into(),
                runtime: AgentRuntime::Native,
                permission_mode: "acceptEdits".into(),
                model: None,
                prompt: String::new(),
            },
        }])
        .unwrap()
        .agent_sessions
        .remove(0);
    s.execute_without_undo(vec![Command::UpdateAgentSession {
        id: session.id,
        changes: vec![AgentSessionChange::State(SessionState::Desktop)],
    }])
    .unwrap()
    .agent_sessions
    .remove(0)
}

#[test]
fn a_desktop_session_takes_its_conversation_id_and_any_device_records_it() {
    let (mut a, mut server) = (store(), store());
    let session = desktop_session(&mut a);
    assert!(session.state.is_active());
    sync(&mut a, &mut server);

    // The claude.ai connector writes from the sync server, another device.
    let desktop_id = new_id();
    server
        .execute_without_undo(vec![
            Command::AddAgentNote {
                note: NewAgentNote {
                    id: None,
                    session_id: session.id.clone(),
                    body: "Header drafted".into(),
                },
            },
            Command::UpdateAgentSession {
                id: session.id.clone(),
                changes: vec![
                    AgentSessionChange::ClaudeSessionId(desktop_id.clone()),
                    AgentSessionChange::Summary(Some("Done".into())),
                    AgentSessionChange::State(SessionState::Done),
                ],
            },
        ])
        .unwrap();
    sync(&mut a, &mut server);
    let after = a.agent_session(&session.id).unwrap();
    assert_eq!(after.state, SessionState::Done);
    assert_eq!(after.claude_session_id, desktop_id);
    assert!(after.ended_at.is_some());

    // Once ended, it is the starting device's again.
    let refused = server.execute_without_undo(vec![Command::UpdateAgentSession {
        id: session.id,
        changes: vec![AgentSessionChange::Summary(None)],
    }]);
    assert!(matches!(refused, Err(Error::Invalid(_))));
    let bad = a.execute_without_undo(vec![Command::UpdateAgentSession {
        id: after.id,
        changes: vec![AgentSessionChange::ClaudeSessionId("nope".into())],
    }]);
    assert!(matches!(bad, Err(Error::Invalid(_))));
}

#[test]
fn a_desktop_session_gets_its_cost_from_the_transcript_but_a_reported_cost_stays() {
    let mut s = store();
    let session = desktop_session(&mut s);
    let changes = record(
        &mut s,
        vec![transcript(&session.claude_session_id, "/work")],
    );
    assert!(changes.terminal_sessions.is_empty());
    let filled = &changes.agent_sessions[0];
    assert_eq!(filled.cost_usd_micros, Some(1_250_000));
    assert_eq!(filled.duration_ms, Some(40_000));
    assert_eq!(filled.turns, Some(12));

    // A headless run that reported its cost keeps it.
    let run = s
        .execute_without_undo(vec![Command::UpdateAgentSession {
            id: session.id.clone(),
            changes: vec![AgentSessionChange::State(SessionState::Done)],
        }])
        .unwrap()
        .agent_sessions
        .remove(0);
    let later = TerminalSessionRecord {
        cost_usd_micros: Some(9_000_000),
        ..transcript(&run.claude_session_id, "/work")
    };
    assert!(record(&mut s, vec![later]).is_empty());
    assert_eq!(
        s.agent_session(&run.id).unwrap().cost_usd_micros,
        Some(1_250_000)
    );
    assert!(s.snapshot().unwrap().terminal_sessions.is_empty());
}

#[test]
fn a_desktop_transcript_without_a_cost_still_gives_its_turns_and_time() {
    // The desktop app writes its cost now and then: often not yet, or not at all.
    let mut s = store();
    let session = desktop_session(&mut s);
    let early = TerminalSessionRecord {
        cost_usd_micros: None,
        ..transcript(&session.claude_session_id, "/work")
    };
    let changes = record(&mut s, vec![early]);
    assert!(changes.terminal_sessions.is_empty());
    let filled = &changes.agent_sessions[0];
    assert_eq!(filled.cost_usd_micros, None);
    assert_eq!(filled.duration_ms, Some(40_000));
    assert_eq!(filled.turns, Some(12));

    // Ended (the agent's summary) with no cost yet: the cost arrives with a later scan.
    s.execute_without_undo(vec![Command::UpdateAgentSession {
        id: session.id.clone(),
        changes: vec![AgentSessionChange::State(SessionState::Done)],
    }])
    .unwrap();
    let later = TerminalSessionRecord {
        turns: Some(14),
        ..transcript(&session.claude_session_id, "/work")
    };
    let changes = record(&mut s, vec![later]);
    let filled = &changes.agent_sessions[0];
    assert_eq!(filled.cost_usd_micros, Some(1_250_000));
    assert_eq!(filled.turns, Some(14));
}

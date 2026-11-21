//! Meetings (Scribe M18, ADR 025): commands with undo, validation, links, attachments,
//! sync between replicas, export/import, and the migration of existing attachments.

use std::path::PathBuf;

use taskmaster_core::*;

const HOUR: i64 = 60 * 60 * 1000;
/// 2026-11-05 09:00 UTC.
const NINE: i64 = 1_793_869_200_000;

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("taskmaster-meetings-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn store() -> Store {
    Store::open_in_memory().unwrap()
}

fn add_task(s: &mut Store, title: &str) -> Task {
    let task = NewTask {
        title: title.into(),
        ..NewTask::default()
    };
    s.execute(Command::CreateTask { task })
        .unwrap()
        .tasks
        .remove(0)
}

fn add_project(s: &mut Store, name: &str) -> Project {
    let project = NewProject {
        name: name.into(),
        ..NewProject::default()
    };
    s.execute(Command::CreateProject { project })
        .unwrap()
        .projects
        .remove(0)
}

fn add_epic(s: &mut Store, name: &str) -> Epic {
    let epic = NewEpic {
        name: name.into(),
        ..NewEpic::default()
    };
    s.execute(Command::CreateEpic { epic })
        .unwrap()
        .epics
        .remove(0)
}

fn new_meeting(title: &str) -> NewMeeting {
    NewMeeting {
        title: title.into(),
        started_at: NINE,
        ended_at: Some(NINE + HOUR),
        ..NewMeeting::default()
    }
}

fn add_meeting(s: &mut Store, meeting: NewMeeting) -> Meeting {
    s.execute(Command::CreateMeeting { meeting })
        .unwrap()
        .meetings
        .remove(0)
}

fn invalid<T: std::fmt::Debug>(result: Result<T>) -> String {
    match result {
        Err(Error::Invalid(message)) => message,
        other => panic!("expected an invalid error, got {other:?}"),
    }
}

/// Runs a command, then checks undo restores the exact prior state and redo the result.
fn roundtrip(s: &mut Store, command: Command) -> Changes {
    let before = s.snapshot().unwrap();
    let changes = s.execute(command.clone()).unwrap();
    let after = s.snapshot().unwrap();
    s.undo().unwrap().expect("something to undo");
    assert_eq!(s.snapshot().unwrap(), before, "undo of {command:?}");
    s.redo().unwrap().expect("something to redo");
    assert_eq!(s.snapshot().unwrap(), after, "redo of {command:?}");
    changes
}

#[test]
fn create_update_and_delete_roundtrip() {
    let mut s = store();
    let project = add_project(&mut s, "Client");
    let epic = add_epic(&mut s, "Launch");
    let task = add_task(&mut s, "Prepare slides");

    let created = roundtrip(
        &mut s,
        Command::CreateMeeting {
            meeting: NewMeeting {
                project_id: Some(project.id.clone()),
                participants: vec![" Ada  Lovelace ".into(), "ada lovelace".into(), "".into()],
                notes: "- agenda".into(),
                ..new_meeting("  Kick-off  ")
            },
        },
    );
    let meeting = &created.meetings[0];
    assert_eq!(meeting.title, "Kick-off");
    assert_eq!(meeting.state, MeetingState::Scheduled);
    assert_eq!(
        meeting.participants,
        ["Ada Lovelace"],
        "spaces tidied, blanks and repeats dropped"
    );
    assert_eq!(meeting.project_id.as_deref(), Some(project.id.as_str()));
    assert_eq!(s.snapshot().unwrap().meetings, vec![meeting.clone()]);

    let updated = roundtrip(
        &mut s,
        Command::UpdateMeeting {
            id: meeting.id.clone(),
            changes: vec![
                MeetingChange::Title("Kick-off call".into()),
                MeetingChange::StartedAt(NINE + HOUR),
                MeetingChange::EndedAt(Some(NINE + 2 * HOUR)),
                MeetingChange::EpicId(Some(epic.id.clone())),
                MeetingChange::TaskId(Some(task.id.clone())),
                MeetingChange::Participants(vec!["Ada".into(), "Grace".into()]),
                MeetingChange::Notes("Decided: ship Friday".into()),
                MeetingChange::State(MeetingState::Held),
            ],
        },
    );
    let m = &updated.meetings[0];
    assert_eq!(
        (m.title.as_str(), m.started_at, m.ended_at),
        ("Kick-off call", NINE + HOUR, Some(NINE + 2 * HOUR))
    );
    assert_eq!(m.epic_id.as_deref(), Some(epic.id.as_str()));
    assert_eq!(m.task_id.as_deref(), Some(task.id.as_str()));
    assert_eq!(m.participants, ["Ada", "Grace"]);
    assert_eq!(m.state, MeetingState::Held);

    roundtrip(
        &mut s,
        Command::DeleteMeeting {
            id: meeting.id.clone(),
        },
    );
    assert!(s.snapshot().unwrap().meetings.is_empty());
    assert!(s.meeting(&meeting.id).unwrap().deleted_at.is_some());
}

#[test]
fn validating_records_when_and_leaving_it_clears() {
    let mut s = store();
    let meeting = add_meeting(&mut s, new_meeting("Review"));
    let state = |s: &mut Store, state| {
        s.execute(Command::UpdateMeeting {
            id: meeting.id.clone(),
            changes: vec![MeetingChange::State(state)],
        })
        .unwrap()
        .meetings
        .remove(0)
    };
    let validated = state(&mut s, MeetingState::Validated);
    assert!(validated.validated_at.is_some());
    let again = state(&mut s, MeetingState::Validated);
    assert_eq!(
        again.validated_at, validated.validated_at,
        "kept when re-set"
    );
    assert_eq!(state(&mut s, MeetingState::Review).validated_at, None);
}

#[test]
fn rejects_bad_meetings() {
    let mut s = store();
    let create = |s: &mut Store, meeting: NewMeeting| s.execute(Command::CreateMeeting { meeting });
    assert!(invalid(create(&mut s, new_meeting("  "))).contains("title"));
    assert!(
        invalid(create(
            &mut s,
            NewMeeting {
                ended_at: Some(NINE),
                ..new_meeting("M")
            }
        ))
        .contains("end after")
    );
    assert!(
        invalid(create(
            &mut s,
            NewMeeting {
                ended_at: Some(NINE + 25 * HOUR),
                ..new_meeting("M")
            }
        ))
        .contains("24 hours")
    );
    assert!(matches!(
        create(
            &mut s,
            NewMeeting {
                project_id: Some(new_id()),
                ..new_meeting("M")
            }
        ),
        Err(Error::NotFound { .. })
    ));
    assert!(
        invalid(create(
            &mut s,
            NewMeeting {
                participants: vec!["x".repeat(201)],
                ..new_meeting("M")
            }
        ))
        .contains("200")
    );
    assert!(
        invalid(create(
            &mut s,
            NewMeeting {
                participants: (0..=MAX_PARTICIPANTS).map(|i| format!("P{i}")).collect(),
                ..new_meeting("M")
            }
        ))
        .contains("at most")
    );

    // A recording meeting has no end yet.
    let open = add_meeting(
        &mut s,
        NewMeeting {
            ended_at: None,
            state: Some(MeetingState::Recording),
            ..new_meeting("Live")
        },
    );
    assert_eq!(open.ended_at, None);
    let move_start_after_end = Command::UpdateMeeting {
        id: add_meeting(&mut s, new_meeting("M")).id,
        changes: vec![MeetingChange::StartedAt(NINE + 2 * HOUR)],
    };
    assert!(invalid(s.execute(move_start_after_end)).contains("end after"));
    let empty = Command::UpdateMeeting {
        id: open.id,
        changes: vec![],
    };
    assert!(s.execute(empty).is_err());
}

#[test]
fn meetings_outlive_their_links_and_are_listed_by_link() {
    let mut s = store();
    let task = add_task(&mut s, "T");
    let linked = add_meeting(
        &mut s,
        NewMeeting {
            task_id: Some(task.id.clone()),
            ..new_meeting("About T")
        },
    );
    add_meeting(&mut s, new_meeting("Other"));
    let by_task = s.meetings(Some(("task", &task.id))).unwrap();
    assert_eq!(by_task, vec![linked.clone()]);
    assert_eq!(s.meetings(None).unwrap().len(), 2);
    assert!(s.meetings(Some(("tag", &task.id))).is_err());

    s.execute(Command::DeleteTask {
        id: task.id.clone(),
    })
    .unwrap();
    assert_eq!(
        s.snapshot().unwrap().meetings.len(),
        2,
        "deleting the task keeps the meeting"
    );
}

#[test]
fn meetings_take_attachments_hidden_with_them() {
    let dir = TempDir::new();
    let mut s = Store::open_in_memory()
        .unwrap()
        .with_files(dir.0.join("attachments"));
    let meeting = add_meeting(&mut s, new_meeting("Demo"));
    let stored = s.files().unwrap().put_bytes(b"slides").unwrap();
    let attach = |meeting_id: Option<String>, task_id: Option<String>| Command::CreateAttachment {
        attachment: NewAttachment {
            id: None,
            task_id,
            meeting_id,
            note_id: None,
            hash: stored.hash.clone(),
            name: "slides.pdf".into(),
            mime: None,
            size: stored.size,
        },
    };
    let created = roundtrip(&mut s, attach(Some(meeting.id.clone()), None));
    let attachment = created.attachments[0].clone();
    assert_eq!(attachment.meeting_id.as_deref(), Some(meeting.id.as_str()));
    assert_eq!(attachment.task_id, None);
    assert_eq!(attachment.mime, "application/pdf");
    assert!(
        created.meetings[0].updated_at >= meeting.updated_at,
        "the meeting is touched"
    );
    assert!(s.file_in_use(&stored.hash).unwrap());

    let task = add_task(&mut s, "T");
    assert!(
        invalid(s.execute(attach(Some(meeting.id.clone()), Some(task.id)))).contains("exactly one")
    );
    assert!(invalid(s.execute(attach(None, None))).contains("exactly one"));

    s.execute(Command::DeleteMeeting {
        id: meeting.id.clone(),
    })
    .unwrap();
    assert!(s.snapshot().unwrap().attachments.is_empty());
    assert!(
        !s.file_in_use(&stored.hash).unwrap(),
        "purgeable once hidden"
    );
    s.undo().unwrap();
    assert_eq!(s.snapshot().unwrap().attachments, vec![attachment.clone()]);

    roundtrip(
        &mut s,
        Command::UpdateAttachment {
            id: attachment.id.clone(),
            changes: vec![AttachmentChange::Name("deck.pdf".into())],
        },
    );
    roundtrip(&mut s, Command::DeleteAttachment { id: attachment.id });
}

#[test]
fn meetings_sync_between_replicas() {
    let mut server = store();
    let mut a = store();
    let mut b = store();
    let project = add_project(&mut a, "P");
    let meeting = add_meeting(
        &mut a,
        NewMeeting {
            project_id: Some(project.id.clone()),
            participants: vec!["Ada".into()],
            ..new_meeting("Sync")
        },
    );
    for device in [&mut a, &mut b] {
        sync(device, &mut server);
    }
    assert_eq!(b.snapshot().unwrap().meetings, vec![meeting.clone()]);

    // Concurrent edits of different fields both land.
    a.execute(Command::UpdateMeeting {
        id: meeting.id.clone(),
        changes: vec![MeetingChange::Notes("from a".into())],
    })
    .unwrap();
    b.execute(Command::UpdateMeeting {
        id: meeting.id.clone(),
        changes: vec![MeetingChange::Participants(vec![
            "Ada".into(),
            "Bob".into(),
        ])],
    })
    .unwrap();
    sync(&mut a, &mut server);
    sync(&mut b, &mut server);
    sync(&mut a, &mut server);
    for replica in [&a, &b] {
        let m = replica.meeting(&meeting.id).unwrap();
        assert_eq!(m.notes, "from a");
        assert_eq!(m.participants, ["Ada", "Bob"]);
    }
}

/// Sends the device's unpushed ops to the server, then pulls everything new.
fn sync(device: &mut Store, server: &mut Store) {
    loop {
        let page = device.outbox(50).unwrap();
        if !page.ops.is_empty() {
            server.apply_remote(page.ops, None).unwrap();
        }
        device.mark_pushed(page.last_seq).unwrap();
        if !page.more {
            break;
        }
    }
    loop {
        let page = server.ops_after(device.sync_cursor().unwrap(), 50).unwrap();
        device.apply_remote(page.ops, Some(page.last_seq)).unwrap();
        if !page.more {
            break;
        }
    }
}

#[test]
fn export_and_import_carry_meetings() {
    let mut source = store();
    let meeting = add_meeting(&mut source, new_meeting("Export me"));
    let file = source.export().unwrap();

    let mut target = store();
    let summary = target.import(&file).unwrap();
    assert_eq!(summary.meetings, 1);
    assert_eq!(target.snapshot().unwrap().meetings, vec![meeting]);
}

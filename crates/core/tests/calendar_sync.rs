//! Calendar sync (M10, ADR 014) against an in-memory calendar server.

use std::cell::RefCell;

use taskmaster_core::calendar::{
    CalendarProvider, EventBody, EventRange, RemoteEvent, TARGET_CALENDAR, When, linked_event, sync,
};
use taskmaster_core::*;

const HOUR: i64 = 3_600_000;
/// 2026-11-05 09:00 UTC.
const NOW: i64 = 1_793_869_200_000;
const TODAY: &str = "2026-11-05";

#[path = "support/calendar.rs"]
mod fake;
use fake::FakeServer;

fn add_task(s: &RefCell<Store>, title: &str, today_on: Option<&str>) -> Task {
    let task = NewTask {
        title: title.into(),
        today_on: today_on.map(Into::into),
        ..NewTask::default()
    };
    s.borrow_mut()
        .execute(Command::CreateTask { task })
        .unwrap()
        .tasks
        .remove(0)
}

fn schedule(s: &RefCell<Store>, task_id: &str, start_at: i64, end_at: i64) -> TimeBlock {
    let block = NewTimeBlock {
        id: None,
        task_id: task_id.into(),
        start_at,
        end_at,
        outcome: None,
    };
    s.borrow_mut()
        .execute(Command::CreateTimeBlock { block })
        .unwrap()
        .time_blocks
        .remove(0)
}

fn run(s: &RefCell<Store>, server: &mut FakeServer) -> calendar::SyncReport {
    server.writes.clear();
    sync(s, server, NOW, TODAY).unwrap()
}

fn block_of(s: &RefCell<Store>, id: &str) -> Option<TimeBlock> {
    s.borrow()
        .snapshot()
        .unwrap()
        .time_blocks
        .into_iter()
        .find(|b| b.id == id)
}

fn event_of(s: &RefCell<Store>, server: &FakeServer, key: &str) -> RemoteEvent {
    let id = linked_event(&s.borrow(), key).unwrap().expect("linked");
    server.event(&server.target(), &id)
}

fn setup() -> (RefCell<Store>, FakeServer) {
    (
        RefCell::new(Store::open_in_memory().unwrap()),
        FakeServer::with_primary(),
    )
}

#[test]
fn first_sync_creates_the_calendar_and_pushes_blocks_and_plans() {
    let (s, mut server) = setup();
    let task = add_task(&s, "Write report", Some(TODAY));
    let block = schedule(&s, &task.id, NOW, NOW + HOUR);
    let _old = schedule(
        &s,
        &task.id,
        NOW - 40 * 24 * HOUR,
        NOW - 40 * 24 * HOUR + HOUR,
    );

    let report = run(&s, &mut server);
    assert_eq!(
        report.created, 2,
        "the block and the plan; not the 40-day-old block"
    );
    assert!(
        server
            .writes
            .contains(&format!("create_calendar {TARGET_CALENDAR}"))
    );

    let event = event_of(&s, &server, &format!("block:{}", block.id));
    assert_eq!(event.title, "Write report");
    assert_eq!(
        event.when,
        Some(When::Timed {
            start_at: NOW,
            end_at: NOW + HOUR
        })
    );
    let plan = event_of(&s, &server, &format!("plan:{}", task.id));
    assert_eq!(
        plan.when,
        Some(When::AllDay {
            start: TODAY.into(),
            end: "2026-11-06".into()
        })
    );

    // Nothing changed: the next sync writes nothing (its own pushes come back unchanged).
    let report = run(&s, &mut server);
    assert_eq!(server.writes, Vec::<String>::new());
    assert_eq!(report.pulled, 0);

    let sources = s.borrow().calendar_sources().unwrap();
    assert!(
        sources
            .iter()
            .any(|c| c.target && c.name == TARGET_CALENDAR && !c.shown)
    );
    assert!(
        sources.iter().any(|c| c.primary && c.shown),
        "primary shown at first"
    );
}

#[test]
fn deadlines_sync_without_a_plan_and_stay_separate_from_scheduled_work() {
    let (s, mut server) = setup();
    let task = add_task(&s, "Submit report", None);
    let update = |changes| {
        s.borrow_mut()
            .execute(Command::UpdateTask {
                id: task.id.clone(),
                changes,
            })
            .unwrap();
    };
    update(vec![TaskChange::DueDate(Some("2026-11-30".into()))]);
    assert_eq!(run(&s, &mut server).created, 1);
    let key = format!("due:{}", task.id);
    let deadline = event_of(&s, &server, &key);
    assert_eq!(deadline.title, "Due: Submit report");
    assert_eq!(
        deadline.when,
        Some(When::AllDay {
            start: "2026-11-30".into(),
            end: "2026-12-01".into(),
        })
    );
    run(&s, &mut server);
    assert!(
        server.writes.is_empty(),
        "unchanged deadlines are not rewritten"
    );

    update(vec![TaskChange::TodayOn(Some(TODAY.into()))]);
    let block = schedule(&s, &task.id, NOW, NOW + HOUR);
    assert_eq!(run(&s, &mut server).created, 2);
    assert_eq!(server.live(&server.target()).len(), 3);
    let plan = event_of(&s, &server, &format!("plan:{}", task.id));
    let timed = event_of(&s, &server, &format!("block:{}", block.id));

    let done = s
        .borrow()
        .snapshot()
        .unwrap()
        .statuses
        .into_iter()
        .find(|status| status.category == StatusCategory::Done)
        .unwrap();
    update(vec![
        TaskChange::DueDate(Some("2026-12-31".into())),
        TaskChange::Title("Send report".into()),
        TaskChange::StatusId(done.id),
    ]);
    run(&s, &mut server);
    let changed = event_of(&s, &server, &key);
    assert_eq!(
        changed.id, deadline.id,
        "update the existing deadline event"
    );
    assert_eq!(changed.title, "✓ Due: Send report");
    assert_eq!(
        changed.when,
        Some(When::AllDay {
            start: "2026-12-31".into(),
            end: "2027-01-01".into(),
        })
    );
    assert_eq!(
        event_of(&s, &server, &format!("plan:{}", task.id)).when,
        plan.when
    );
    assert_eq!(
        event_of(&s, &server, &format!("block:{}", block.id)).when,
        timed.when
    );

    update(vec![TaskChange::DueDate(None)]);
    assert_eq!(run(&s, &mut server).deleted, 1);
    assert!(server.event(&server.target(), &deadline.id).cancelled);
    assert_eq!(
        server.live(&server.target()).len(),
        2,
        "keep the plan and block"
    );

    update(vec![TaskChange::DueDate(Some(TODAY.into()))]);
    assert_eq!(run(&s, &mut server).created, 1);
    let deadline = event_of(&s, &server, &key);
    s.borrow_mut()
        .execute(Command::DeleteTask {
            id: task.id.clone(),
        })
        .unwrap();
    assert_eq!(run(&s, &mut server).deleted, 3);
    assert!(server.event(&server.target(), &deadline.id).cancelled);
}

#[test]
fn calendar_deadline_moves_and_deletions_only_change_the_due_date_and_support_undo() {
    let (s, mut server) = setup();
    let task = add_task(&s, "Submit report", Some(TODAY));
    s.borrow_mut()
        .execute(Command::UpdateTask {
            id: task.id.clone(),
            changes: vec![TaskChange::DueDate(Some("2026-11-06".into()))],
        })
        .unwrap();
    run(&s, &mut server);
    let target = server.target();
    let key = format!("due:{}", task.id);
    let deadline = event_of(&s, &server, &key);
    server.user_edit(&target, &deadline.id, |event| {
        event.when = Some(When::AllDay {
            start: "2026-11-07".into(),
            end: "2026-11-08".into(),
        });
    });
    assert_eq!(run(&s, &mut server).pulled, 1);
    let moved = s.borrow().snapshot().unwrap().tasks.remove(0);
    assert_eq!(moved.due_date.as_deref(), Some("2026-11-07"));
    assert_eq!(moved.today_on.as_deref(), Some(TODAY));
    assert!(server.writes.is_empty());

    s.borrow_mut().undo().unwrap();
    run(&s, &mut server);
    assert_eq!(event_of(&s, &server, &key).when, deadline.when);

    server.delete(&target, &deadline.id).unwrap();
    assert_eq!(run(&s, &mut server).pulled, 1);
    let cleared = s.borrow().snapshot().unwrap().tasks.remove(0);
    assert_eq!(cleared.due_date, None);
    assert_eq!(cleared.today_on.as_deref(), Some(TODAY));
    assert_eq!(server.live(&target).len(), 1, "keep the plan");
    s.borrow_mut().undo().unwrap();
    assert_eq!(run(&s, &mut server).created, 1);

    // A local deadline change wins over a simultaneous move in Google.
    let deadline = event_of(&s, &server, &key);
    server.user_edit(&target, &deadline.id, |event| {
        event.when = Some(When::AllDay {
            start: "2026-11-08".into(),
            end: "2026-11-09".into(),
        });
    });
    s.borrow_mut()
        .execute(Command::UpdateTask {
            id: task.id.clone(),
            changes: vec![TaskChange::DueDate(Some("2026-11-09".into()))],
        })
        .unwrap();
    let report = run(&s, &mut server);
    assert_eq!((report.pulled, report.updated), (0, 1));
    assert_eq!(
        event_of(&s, &server, &key).when,
        Some(When::AllDay {
            start: "2026-11-09".into(),
            end: "2026-11-10".into(),
        })
    );
}

#[test]
fn deadlines_use_the_existing_history_window_but_linked_deadlines_keep_syncing() {
    let (s, mut server) = setup();
    for date in ["2026-10-05", "2026-10-06"] {
        s.borrow_mut()
            .execute(Command::CreateTask {
                task: NewTask {
                    title: date.into(),
                    due_date: Some(date.into()),
                    ..NewTask::default()
                },
            })
            .unwrap();
    }
    assert_eq!(run(&s, &mut server).created, 1, "only the last 30 days");
    let task = s
        .borrow()
        .snapshot()
        .unwrap()
        .tasks
        .into_iter()
        .find(|task| task.title == "2026-10-06")
        .unwrap();
    s.borrow_mut()
        .execute(Command::UpdateTask {
            id: task.id.clone(),
            changes: vec![TaskChange::DueDate(Some("2026-10-01".into()))],
        })
        .unwrap();
    assert_eq!(run(&s, &mut server).updated, 1);
    assert_eq!(
        event_of(&s, &server, &format!("due:{}", task.id)).when,
        Some(When::AllDay {
            start: "2026-10-01".into(),
            end: "2026-10-02".into(),
        })
    );
}

#[test]
fn local_changes_are_pushed() {
    let (s, mut server) = setup();
    let task = add_task(&s, "Deep work", None);
    let block = schedule(&s, &task.id, NOW, NOW + HOUR);
    let other = schedule(&s, &task.id, NOW + 3 * HOUR, NOW + 4 * HOUR);
    run(&s, &mut server);
    let key = format!("block:{}", block.id);

    s.borrow_mut()
        .execute(Command::UpdateTimeBlock {
            id: block.id.clone(),
            changes: vec![TimeBlockChange::EndAt(NOW + 2 * HOUR)],
        })
        .unwrap();
    s.borrow_mut()
        .execute(Command::UpdateTimeBlock {
            id: other.id.clone(),
            changes: vec![TimeBlockChange::Outcome(BlockOutcome::Done)],
        })
        .unwrap();
    let report = run(&s, &mut server);
    assert_eq!(report.updated, 2);
    assert_eq!(
        event_of(&s, &server, &key).when,
        Some(When::Timed {
            start_at: NOW,
            end_at: NOW + 2 * HOUR
        })
    );
    assert_eq!(
        event_of(&s, &server, &format!("block:{}", other.id)).title,
        "✓ Deep work"
    );

    // Cancelling or deleting takes the event away.
    let event_id = linked_event(&s.borrow(), &key).unwrap().unwrap();
    s.borrow_mut()
        .execute(Command::UpdateTimeBlock {
            id: block.id.clone(),
            changes: vec![TimeBlockChange::Outcome(BlockOutcome::Cancelled)],
        })
        .unwrap();
    s.borrow_mut()
        .execute(Command::DeleteTimeBlock { id: other.id })
        .unwrap();
    let report = run(&s, &mut server);
    assert_eq!(report.deleted, 2);
    assert!(server.event(&server.target(), &event_id).cancelled);
    assert!(server.live(&server.target()).is_empty());

    // Planned again, it comes back; missed (not worked on), it goes away like cancelled.
    s.borrow_mut()
        .execute(Command::UpdateTimeBlock {
            id: block.id.clone(),
            changes: vec![TimeBlockChange::Outcome(BlockOutcome::Planned)],
        })
        .unwrap();
    run(&s, &mut server);
    assert_eq!(server.live(&server.target()).len(), 1);
    s.borrow_mut()
        .execute(Command::UpdateTimeBlock {
            id: block.id.clone(),
            changes: vec![TimeBlockChange::Outcome(BlockOutcome::Missed)],
        })
        .unwrap();
    assert_eq!(run(&s, &mut server).deleted, 1);
    assert!(server.live(&server.target()).is_empty());

    // Renaming the task updates its events.
    s.borrow_mut()
        .execute(Command::UpdateTimeBlock {
            id: block.id.clone(),
            changes: vec![TimeBlockChange::Outcome(BlockOutcome::Planned)],
        })
        .unwrap();
    run(&s, &mut server);
    s.borrow_mut()
        .execute(Command::UpdateTask {
            id: task.id.clone(),
            changes: vec![TaskChange::Title("Deeper work".into())],
        })
        .unwrap();
    run(&s, &mut server);
    assert_eq!(event_of(&s, &server, &key).title, "Deeper work");
}

#[test]
fn moves_and_deletions_made_in_the_calendar_come_back() {
    let (s, mut server) = setup();
    let task = add_task(&s, "Dentist", Some(TODAY));
    let block = schedule(&s, &task.id, NOW, NOW + HOUR);
    run(&s, &mut server);
    let target = server.target();
    let block_event = linked_event(&s.borrow(), &format!("block:{}", block.id))
        .unwrap()
        .unwrap();
    let plan_event = linked_event(&s.borrow(), &format!("plan:{}", task.id))
        .unwrap()
        .unwrap();

    server.user_edit(&target, &block_event, |e| {
        e.when = Some(When::Timed {
            start_at: NOW + 2 * HOUR,
            end_at: NOW + 4 * HOUR,
        });
        e.title = "Renamed in the calendar".into();
    });
    server.user_edit(&target, &plan_event, |e| {
        e.when = Some(When::AllDay {
            start: "2026-11-07".into(),
            end: "2026-11-08".into(),
        });
    });
    let report = run(&s, &mut server);
    assert_eq!(report.pulled, 2);
    let moved = block_of(&s, &block.id).unwrap();
    assert_eq!(
        (moved.start_at, moved.end_at),
        (NOW + 2 * HOUR, NOW + 4 * HOUR)
    );
    let replanned = s.borrow().snapshot().unwrap().tasks[0].clone();
    assert_eq!(replanned.today_on.as_deref(), Some("2026-11-07"));
    assert_eq!(server.writes, Vec::<String>::new(), "nothing pushed back");

    // The pulled edits are one undoable step.
    s.borrow_mut().undo().unwrap();
    assert_eq!(block_of(&s, &block.id).unwrap().start_at, NOW);

    // A deletion in the calendar removes the block (the undo above is pushed first).
    run(&s, &mut server);
    let block_event = linked_event(&s.borrow(), &format!("block:{}", block.id))
        .unwrap()
        .unwrap();
    server.delete(&target, &block_event).unwrap();
    run(&s, &mut server);
    assert!(block_of(&s, &block.id).is_none());
}

#[test]
fn the_app_wins_when_both_sides_changed() {
    let (s, mut server) = setup();
    let task = add_task(&s, "Review", None);
    let block = schedule(&s, &task.id, NOW, NOW + HOUR);
    run(&s, &mut server);
    let target = server.target();
    let key = format!("block:{}", block.id);
    let event_id = linked_event(&s.borrow(), &key).unwrap().unwrap();

    server.user_edit(&target, &event_id, |e| {
        e.when = Some(When::Timed {
            start_at: NOW + 5 * HOUR,
            end_at: NOW + 6 * HOUR,
        });
    });
    s.borrow_mut()
        .execute(Command::UpdateTimeBlock {
            id: block.id.clone(),
            changes: vec![TimeBlockChange::EndAt(NOW + 2 * HOUR)],
        })
        .unwrap();
    run(&s, &mut server);
    assert_eq!(block_of(&s, &block.id).unwrap().start_at, NOW);
    assert_eq!(
        event_of(&s, &server, &key).when,
        Some(When::Timed {
            start_at: NOW,
            end_at: NOW + 2 * HOUR
        })
    );

    // Deleted there, changed here: the event comes back.
    server.delete(&target, &event_id).unwrap();
    s.borrow_mut()
        .execute(Command::UpdateTimeBlock {
            id: block.id.clone(),
            changes: vec![TimeBlockChange::EndAt(NOW + 3 * HOUR)],
        })
        .unwrap();
    run(&s, &mut server);
    assert!(block_of(&s, &block.id).is_some());
    assert_eq!(server.live(&target).len(), 1);
}

#[test]
fn other_calendars_are_kept_read_only_and_can_be_hidden() {
    let (s, mut server) = setup();
    server.user_add(
        "me@example.com",
        "Standup",
        When::Timed {
            start_at: NOW + HOUR,
            end_at: NOW + HOUR + 900_000,
        },
    );
    server.user_add(
        "me@example.com",
        "Holiday",
        When::AllDay {
            start: "2026-11-06".into(),
            end: "2026-11-08".into(),
        },
    );
    server.user_add(
        "me@example.com",
        "Far future",
        When::Timed {
            start_at: NOW + 400 * 24 * HOUR,
            end_at: NOW + 400 * 24 * HOUR + HOUR,
        },
    );
    let report = run(&s, &mut server);
    assert_eq!(report.events, 2, "the window ends 180 days ahead");
    // An event added by hand to the app's own calendar shows too.
    let target = server.target();
    server.user_add(
        &target,
        "Added in Google",
        When::Timed {
            start_at: NOW + 2 * HOUR,
            end_at: NOW + 3 * HOUR,
        },
    );
    run(&s, &mut server);

    let range = EventRange {
        from: NOW,
        to: NOW + 24 * HOUR,
        from_date: TODAY.into(),
        to_date: "2026-11-07".into(),
    };
    let titles = |s: &RefCell<Store>| -> Vec<String> {
        s.borrow()
            .calendar_events(&range)
            .unwrap()
            .into_iter()
            .map(|e| e.title)
            .collect()
    };
    let shown = titles(&s);
    assert!(shown.contains(&"Standup".into()), "{shown:?}");
    assert!(shown.contains(&"Holiday".into()), "{shown:?}");
    assert!(shown.contains(&"Added in Google".into()), "{shown:?}");
    assert_eq!(
        s.borrow().calendar_events(&range).unwrap()[0]
            .color
            .as_deref(),
        Some("#0b8043")
    );

    s.borrow()
        .set_calendar_shown("me@example.com", false)
        .unwrap();
    assert_eq!(titles(&s), vec!["Added in Google".to_string()]);
    assert!(s.borrow().set_calendar_shown(&target, false).is_err());
    run(&s, &mut server);
    assert_eq!(titles(&s), vec!["Added in Google".to_string()]);
}

#[test]
fn an_expired_token_or_lost_links_never_duplicate_events() {
    let (s, mut server) = setup();
    let task = add_task(&s, "Plan", Some(TODAY));
    s.borrow_mut()
        .execute(Command::UpdateTask {
            id: task.id.clone(),
            changes: vec![TaskChange::DueDate(Some(TODAY.into()))],
        })
        .unwrap();
    schedule(&s, &task.id, NOW, NOW + HOUR);
    run(&s, &mut server);
    let target = server.target();
    assert_eq!(server.live(&target).len(), 3);

    server.expire_token = true;
    run(&s, &mut server);
    assert_eq!(server.live(&target).len(), 3);
    assert!(
        server.writes.iter().all(|w| !w.starts_with("insert")),
        "{:?}",
        server.writes
    );

    // An import forgets links: events are matched again by their stored keys.
    let file = s.borrow().export().unwrap();
    s.borrow_mut().import(&file).unwrap();
    run(&s, &mut server);
    assert_eq!(server.live(&target).len(), 3);
    assert!(
        server.writes.iter().all(|w| !w.starts_with("insert")),
        "{:?}",
        server.writes
    );

    // An event pushed from an item that no longer exists here is removed.
    let stray = server.put(
        &target,
        "stray".into(),
        &EventBody {
            title: "Gone".into(),
            description: String::new(),
            when: When::Timed {
                start_at: NOW,
                end_at: NOW + HOUR,
            },
            key: format!("block:{}", new_id()),
        },
    );
    run(&s, &mut server);
    assert!(server.event(&target, &stray.id).cancelled);
}

#[test]
fn reconnecting_reuses_the_existing_calendar() {
    let (s, mut server) = setup();
    let task = add_task(&s, "Plan", Some(TODAY));
    run(&s, &mut server);
    let target = server.target();

    s.borrow().clear_calendar_sync().unwrap();
    assert!(s.borrow().calendar_sources().unwrap().is_empty());
    run(&s, &mut server);
    assert_eq!(
        server
            .calendars
            .iter()
            .filter(|c| c.name == TARGET_CALENDAR)
            .count(),
        1
    );
    assert_eq!(
        server.live(&target).len(),
        1,
        "the plan event was matched, not copied"
    );
    assert!(
        linked_event(&s.borrow(), &format!("plan:{}", task.id))
            .unwrap()
            .is_some()
    );
}

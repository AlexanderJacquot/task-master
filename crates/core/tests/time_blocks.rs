//! Time blocks (M9, ADR 013): commands with undo, validation, the snapshot of deleted
//! tasks, the activity feed and export/import.

use taskmaster_core::*;

const HOUR: i64 = 60 * 60 * 1000;
/// 2026-11-05 09:00 UTC.
const NINE: i64 = 1_793_869_200_000;

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

fn new_block(task_id: &str, start_at: i64, end_at: i64) -> NewTimeBlock {
    NewTimeBlock {
        id: None,
        task_id: task_id.into(),
        start_at,
        end_at,
        outcome: None,
    }
}

fn schedule(s: &mut Store, task_id: &str, start_at: i64, end_at: i64) -> TimeBlock {
    let block = new_block(task_id, start_at, end_at);
    s.execute(Command::CreateTimeBlock { block })
        .unwrap()
        .time_blocks
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
fn create_move_resize_outcome_and_delete_roundtrip() {
    let mut s = store();
    let task = add_task(&mut s, "Write report");
    let id = new_id();

    let mut block = new_block(&task.id, NINE, NINE + HOUR);
    block.id = Some(id.clone());
    let changes = roundtrip(&mut s, Command::CreateTimeBlock { block });
    let created = &changes.time_blocks[0];
    assert_eq!(created.id, id, "the client id is kept");
    assert_eq!(created.outcome, BlockOutcome::Planned);
    assert_eq!(
        changes.tasks.len(),
        1,
        "the task is touched so its views refresh"
    );
    assert_eq!(s.snapshot().unwrap().time_blocks, changes.time_blocks);

    // Move by an hour and a half, keeping the length.
    let changes = roundtrip(
        &mut s,
        Command::UpdateTimeBlock {
            id: id.clone(),
            changes: vec![
                TimeBlockChange::StartAt(NINE + 3 * HOUR / 2),
                TimeBlockChange::EndAt(NINE + 5 * HOUR / 2),
            ],
        },
    );
    assert_eq!(changes.time_blocks[0].start_at, NINE + 3 * HOUR / 2);

    // Resize: only the end.
    let changes = roundtrip(
        &mut s,
        Command::UpdateTimeBlock {
            id: id.clone(),
            changes: vec![TimeBlockChange::EndAt(NINE + 4 * HOUR)],
        },
    );
    assert_eq!(
        changes.time_blocks[0].end_at - changes.time_blocks[0].start_at,
        5 * HOUR / 2
    );

    let changes = roundtrip(
        &mut s,
        Command::UpdateTimeBlock {
            id: id.clone(),
            changes: vec![TimeBlockChange::Outcome(BlockOutcome::Worked)],
        },
    );
    assert_eq!(changes.time_blocks[0].outcome, BlockOutcome::Worked);

    let changes = roundtrip(&mut s, Command::DeleteTimeBlock { id: id.clone() });
    assert!(changes.time_blocks[0].deleted_at.is_some());
    assert!(s.snapshot().unwrap().time_blocks.is_empty());
}

#[test]
fn snapshot_orders_blocks_by_start() {
    let mut s = store();
    let task = add_task(&mut s, "Task");
    let late = schedule(&mut s, &task.id, NINE + 5 * HOUR, NINE + 6 * HOUR);
    let early = schedule(&mut s, &task.id, NINE, NINE + HOUR);
    let ids: Vec<Id> = s
        .snapshot()
        .unwrap()
        .time_blocks
        .into_iter()
        .map(|b| b.id)
        .collect();
    assert_eq!(ids, vec![early.id, late.id]);
}

#[test]
fn rejects_bad_blocks() {
    let mut s = store();
    let task = add_task(&mut s, "Task");

    let backwards = new_block(&task.id, NINE, NINE);
    assert!(
        invalid(s.execute(Command::CreateTimeBlock { block: backwards })).contains("end after")
    );
    let too_long = new_block(&task.id, NINE, NINE + MAX_BLOCK_MS + 1);
    assert!(invalid(s.execute(Command::CreateTimeBlock { block: too_long })).contains("24 hours"));
    let negative = new_block(&task.id, -HOUR, HOUR);
    assert!(invalid(s.execute(Command::CreateTimeBlock { block: negative })).contains("1970"));
    let mut bad_id = new_block(&task.id, NINE, NINE + HOUR);
    bad_id.id = Some("not-a-uuid".into());
    assert!(
        s.execute(Command::CreateTimeBlock { block: bad_id })
            .is_err()
    );
    let orphan = new_block(&new_id(), NINE, NINE + HOUR);
    assert!(matches!(
        s.execute(Command::CreateTimeBlock { block: orphan }),
        Err(Error::NotFound { .. })
    ));

    let block = schedule(&mut s, &task.id, NINE, NINE + HOUR);
    // An update is checked against the block's other end.
    let past_end = Command::UpdateTimeBlock {
        id: block.id.clone(),
        changes: vec![TimeBlockChange::StartAt(NINE + 2 * HOUR)],
    };
    assert!(invalid(s.execute(past_end)).contains("end after"));
    let nothing = Command::UpdateTimeBlock {
        id: block.id.clone(),
        changes: vec![],
    };
    assert!(invalid(s.execute(nothing)).contains("at least one"));

    s.execute(Command::DeleteTimeBlock {
        id: block.id.clone(),
    })
    .unwrap();
    assert!(matches!(
        s.execute(Command::DeleteTimeBlock { id: block.id }),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn deleting_a_task_hides_its_blocks_and_undo_brings_them_back() {
    let mut s = store();
    let task = add_task(&mut s, "Task");
    let block = schedule(&mut s, &task.id, NINE, NINE + HOUR);

    s.execute(Command::DeleteTask {
        id: task.id.clone(),
    })
    .unwrap();
    assert!(s.snapshot().unwrap().time_blocks.is_empty());
    let block_on_deleted_task = new_block(&task.id, NINE, NINE + HOUR);
    assert!(
        s.execute(Command::CreateTimeBlock {
            block: block_on_deleted_task
        })
        .is_err(),
        "a deleted task cannot be scheduled"
    );

    s.undo().unwrap();
    assert_eq!(s.snapshot().unwrap().time_blocks, vec![block]);
}

#[test]
fn block_changes_show_in_the_task_activity() {
    let mut s = store();
    let task = add_task(&mut s, "Task");
    let block = schedule(&mut s, &task.id, NINE, NINE + HOUR);
    s.execute(Command::UpdateTimeBlock {
        id: block.id.clone(),
        changes: vec![
            TimeBlockChange::StartAt(NINE + HOUR),
            TimeBlockChange::EndAt(NINE + 2 * HOUR),
        ],
    })
    .unwrap();
    s.execute(Command::UpdateTimeBlock {
        id: block.id.clone(),
        changes: vec![TimeBlockChange::Outcome(BlockOutcome::Done)],
    })
    .unwrap();
    s.execute(Command::DeleteTimeBlock {
        id: block.id.clone(),
    })
    .unwrap();

    let activity = s.task_activity(&task.id, 20).unwrap();
    let kinds: Vec<&str> = activity.iter().map(|a| a.kind.as_str()).collect();
    assert_eq!(
        kinds,
        vec![
            "unschedule",
            "block_outcome",
            "reschedule",
            "schedule",
            "create"
        ]
    );
    let field = |entry: &Activity, name: &str| -> (String, String) {
        let f = entry.fields.iter().find(|f| f.field == name).unwrap();
        (f.before.clone(), f.after.clone())
    };
    assert_eq!(
        field(&activity[3], "start_at"),
        ("null".into(), NINE.to_string())
    );
    assert_eq!(
        field(&activity[2], "start_at"),
        (NINE.to_string(), (NINE + HOUR).to_string())
    );
    assert_eq!(
        field(&activity[2], "end_at"),
        ((NINE + HOUR).to_string(), (NINE + 2 * HOUR).to_string())
    );
    assert_eq!(
        field(&activity[1], "outcome"),
        ("\"planned\"".into(), "\"done\"".into())
    );
    assert_eq!(
        field(&activity[0], "start_at").1,
        (NINE + HOUR).to_string(),
        "an unschedule entry names the block's last times"
    );
}

#[test]
fn export_and_import_carry_blocks() {
    let mut source = store();
    let task = add_task(&mut source, "Task");
    let block = schedule(&mut source, &task.id, NINE, NINE + HOUR);
    let file = source.export().unwrap();

    let mut target = store();
    let summary = target.import(&file).unwrap();
    assert_eq!(summary.time_blocks, 1);
    assert_eq!(target.snapshot().unwrap().time_blocks, vec![block]);
}

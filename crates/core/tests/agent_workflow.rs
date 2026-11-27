//! Where a user's task goes when an agent starts and reports it done (ADR 017): the
//! statuses picked in Settings → Agents, else In progress and Review.

use taskmaster_core::*;

const TODO: &str = "00000000-0000-7000-8000-000000000002";
const WAITING: &str = "00000000-0000-7000-8000-000000000004";
const DONE: &str = "00000000-0000-7000-8000-000000000005";
const CANCELLED: &str = "00000000-0000-7000-8000-000000000006";

fn store() -> Store {
    Store::open_in_memory().unwrap()
}

fn add_task(s: &mut Store, status: &str, owner: TaskOwner) -> Task {
    s.execute(Command::CreateTask {
        task: NewTask {
            title: "Fix the sync".into(),
            owner,
            status_id: Some(status.into()),
            ..NewTask::default()
        },
    })
    .unwrap()
    .tasks
    .remove(0)
}

fn add_status(s: &mut Store, name: &str, category: StatusCategory) -> Status {
    s.execute(Command::CreateStatus {
        status: NewStatus {
            id: None,
            name: name.into(),
            category,
            color: None,
            rank: None,
            wip_limit: None,
        },
    })
    .unwrap()
    .statuses
    .remove(0)
}

fn statuses(s: &Store) -> Vec<Status> {
    s.snapshot().unwrap().statuses
}

/// Applies `command` and returns the task's status afterwards.
fn apply(s: &mut Store, task: &Task, command: Option<Command>) -> Id {
    if let Some(command) = command {
        s.execute_without_undo(vec![command]).unwrap();
    }
    s.snapshot()
        .unwrap()
        .tasks
        .into_iter()
        .find(|t| t.id == task.id)
        .unwrap()
        .status_id
}

#[test]
fn defaults_are_in_progress_then_review() {
    let mut s = store();
    let task = add_task(&mut s, TODO, TaskOwner::Me);
    let flow = AgentWorkflow::default();

    let started = flow.on_start(&statuses(&s), &task);
    assert_eq!(apply(&mut s, &task, started), IN_PROGRESS_STATUS_ID);

    let task = s.snapshot().unwrap().tasks.remove(0);
    let done = flow.on_done(&statuses(&s), &task);
    assert_eq!(apply(&mut s, &task, done), REVIEW_STATUS_ID);

    // Already there: nothing to write.
    let task = s.snapshot().unwrap().tasks.remove(0);
    assert_eq!(flow.on_done(&statuses(&s), &task), None);
}

#[test]
fn picked_statuses_win() {
    let mut s = store();
    let doing = add_status(&mut s, "Agent working", StatusCategory::InProgress);
    let checked = add_status(&mut s, "To check", StatusCategory::Todo);
    let task = add_task(&mut s, TODO, TaskOwner::Me);
    let flow = AgentWorkflow {
        started_status_id: Some(doing.id.clone()),
        done_status_id: Some(checked.id.clone()),
    };

    let started = flow.on_start(&statuses(&s), &task);
    assert_eq!(apply(&mut s, &task, started), doing.id);
    let task = s.snapshot().unwrap().tasks.remove(0);
    let done = flow.on_done(&statuses(&s), &task);
    assert_eq!(apply(&mut s, &task, done), checked.id);
}

#[test]
fn a_pick_that_is_gone_falls_back_to_the_default() {
    let mut s = store();
    let gone = add_status(&mut s, "Old lane", StatusCategory::InProgress);
    s.execute(Command::DeleteStatus {
        id: gone.id.clone(),
    })
    .unwrap();
    let flow = AgentWorkflow {
        started_status_id: Some(gone.id.clone()),
        done_status_id: Some("no-such-status".into()),
    };
    let all = statuses(&s);
    assert_eq!(flow.started_status(&all).unwrap().id, IN_PROGRESS_STATUS_ID);
    assert_eq!(flow.done_status(&all).unwrap().id, REVIEW_STATUS_ID);
}

#[test]
fn without_in_progress_the_first_open_status_that_is_not_review() {
    let mut s = store();
    s.execute(Command::DeleteStatus {
        id: IN_PROGRESS_STATUS_ID.into(),
    })
    .unwrap();
    let flow = AgentWorkflow::default();
    // Waiting (a3) comes before Review (a3V); Review is never the started status.
    assert_eq!(flow.started_status(&statuses(&s)).unwrap().id, WAITING);
}

#[test]
fn a_closed_task_stays_closed_when_the_agent_reports_done() {
    let mut s = store();
    let flow = AgentWorkflow::default();
    for closed in [DONE, CANCELLED] {
        let task = add_task(&mut s, closed, TaskOwner::Me);
        assert_eq!(flow.on_done(&statuses(&s), &task), None);
        // Sending it to an agent again reopens it: it is being worked on.
        let started = flow.on_start(&statuses(&s), &task);
        assert_eq!(apply(&mut s, &task, started), IN_PROGRESS_STATUS_ID);
    }
}

#[test]
fn a_follow_up_from_review_goes_back_to_in_progress() {
    let mut s = store();
    let task = add_task(&mut s, REVIEW_STATUS_ID, TaskOwner::Me);
    let started = AgentWorkflow::default().on_start(&statuses(&s), &task);
    assert_eq!(apply(&mut s, &task, started), IN_PROGRESS_STATUS_ID);
}

#[test]
fn agent_tasks_are_left_alone() {
    let mut s = store();
    let task = add_task(&mut s, TODO, TaskOwner::Agent);
    let flow = AgentWorkflow::default();
    assert_eq!(flow.on_start(&statuses(&s), &task), None);
    assert_eq!(flow.on_done(&statuses(&s), &task), None);
}

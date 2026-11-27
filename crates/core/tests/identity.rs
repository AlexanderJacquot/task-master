//! Identity (ADR 033, T2): the author of every op, assignee and reporter on team tasks,
//! and the team's members, through the spaces layer and across replicas.

use taskmaster_core::*;

const ADA: &str = "01a1fe00-0000-7000-8000-00000000ada0";
const BOB: &str = "01a1fe00-0000-7000-8000-00000000b0b0";

fn team_store(author: &str) -> Store {
    let mut store = Store::open_in_memory().unwrap();
    store.set_author(Some(author.into()));
    store
}

fn add_member(s: &mut Store, id: &str, name: &str) {
    s.execute(Command::CreateMember {
        member: NewMember {
            id: id.into(),
            name: name.into(),
            color: None,
        },
    })
    .unwrap();
}

fn new_task(title: &str) -> NewTask {
    NewTask {
        title: title.into(),
        ..NewTask::default()
    }
}

#[test]
fn ops_name_their_author_and_travel_with_it() {
    let mut ada = team_store(ADA);
    add_member(&mut ada, ADA, "Ada");
    add_member(&mut ada, BOB, "Bob");
    let task = ada
        .execute(Command::CreateTask {
            task: NewTask {
                assignee_id: Some(BOB.into()),
                ..new_task("Ship")
            },
        })
        .unwrap()
        .tasks
        .remove(0);
    assert_eq!(task.reporter_id.as_deref(), Some(ADA));
    assert_eq!(task.assignee_id.as_deref(), Some(BOB));
    let page = ada.ops_after(0, 100).unwrap();
    assert!(
        page.ops
            .iter()
            .all(|op| op.author_id.as_deref() == Some(ADA))
    );

    // Another replica keeps the author of what it receives.
    let mut bob = team_store(BOB);
    bob.apply_remote(page.ops, Some(page.last_seq)).unwrap();
    bob.execute(Command::UpdateTask {
        id: task.id.clone(),
        changes: vec![TaskChange::Title("Ship v2".into())],
    })
    .unwrap();
    let authors: Vec<Option<String>> = bob
        .task_activity(&task.id, 10)
        .unwrap()
        .into_iter()
        .map(|a| a.author_id)
        .collect();
    assert_eq!(authors, [Some(BOB.to_owned()), Some(ADA.to_owned())]);
    let snapshot = bob.snapshot().unwrap();
    assert_eq!(snapshot.members.len(), 2);
    assert_eq!(snapshot.tasks[0].assignee_id.as_deref(), Some(BOB));
}

#[test]
fn a_personal_space_has_no_author_or_reporter() {
    let mut s = Store::open_in_memory().unwrap();
    let task = s
        .execute(Command::CreateTask {
            task: new_task("Mine"),
        })
        .unwrap()
        .tasks
        .remove(0);
    assert_eq!(task.reporter_id, None);
    assert!(
        s.ops_after(0, 10)
            .unwrap()
            .ops
            .iter()
            .all(|op| op.author_id.is_none())
    );
    // Its JSON is the same as before: no empty identity fields.
    let json = serde_json::to_value(&task).unwrap();
    assert!(json.get("assignee_id").is_none() && json.get("reporter_id").is_none());
    assert!(
        serde_json::to_value(s.snapshot().unwrap())
            .unwrap()
            .get("members")
            .is_none()
    );
}

#[test]
fn assignees_must_be_live_members() {
    let mut s = team_store(ADA);
    add_member(&mut s, ADA, "Ada");
    let err = s.execute(Command::CreateTask {
        task: NewTask {
            assignee_id: Some(BOB.into()),
            ..new_task("Ship")
        },
    });
    assert!(err.is_err(), "Bob is not a member");
    let task = s
        .execute(Command::CreateTask {
            task: new_task("Ship"),
        })
        .unwrap()
        .tasks
        .remove(0);
    s.execute(Command::UpdateTask {
        id: task.id.clone(),
        changes: vec![TaskChange::AssigneeId(Some(ADA.into()))],
    })
    .unwrap();
    s.undo().unwrap().expect("undo");
    assert_eq!(s.task(&task.id).unwrap().assignee_id, None);

    // A removed member keeps their tasks, but takes no new ones.
    add_member(&mut s, BOB, "Bob");
    s.execute(Command::UpdateTask {
        id: task.id.clone(),
        changes: vec![TaskChange::AssigneeId(Some(BOB.into()))],
    })
    .unwrap();
    s.execute(Command::DeleteMember { id: BOB.into() }).unwrap();
    assert_eq!(s.task(&task.id).unwrap().assignee_id.as_deref(), Some(BOB));
    assert_eq!(s.snapshot().unwrap().members.len(), 1);
    let again = s.execute(Command::UpdateTask {
        id: task.id,
        changes: vec![TaskChange::AssigneeId(Some(BOB.into()))],
    });
    assert!(again.is_err());
    // Adding them back restores the member.
    add_member(&mut s, BOB, "Robert");
    let names: Vec<String> = s
        .snapshot()
        .unwrap()
        .members
        .into_iter()
        .map(|m| m.name)
        .collect();
    assert_eq!(names, ["Ada", "Robert"]);
}

#[test]
fn members_live_in_the_team_space() {
    let mut s = Spaces::new(Store::open_in_memory().unwrap());
    let member = Command::CreateMember {
        member: NewMember {
            id: ADA.into(),
            name: "Ada".into(),
            color: None,
        },
    };
    assert!(
        s.execute(vec![member.clone()], None).is_err(),
        "no team yet"
    );
    s.attach_team(team_store(ADA));
    s.execute(vec![member], None).unwrap();
    assert_eq!(s.team_snapshot().unwrap().unwrap().members.len(), 1);
    assert!(s.snapshot().unwrap().members.is_empty());
}

#[test]
fn team_undo_leaves_a_teammates_later_edit() {
    let mut ada = team_store(ADA);
    let task = ada
        .execute(Command::CreateTask {
            task: new_task("Ship"),
        })
        .unwrap()
        .tasks
        .remove(0);
    let mut bob = team_store(BOB);
    let page = ada.ops_after(0, 100).unwrap();
    bob.apply_remote(page.ops, None).unwrap();
    let mark = ada.last_seq().unwrap();

    // Ada renames it and raises its priority; then Bob renames it again.
    ada.execute(Command::UpdateTask {
        id: task.id.clone(),
        changes: vec![
            TaskChange::Title("Ship v2".into()),
            TaskChange::Priority(Priority::High),
        ],
    })
    .unwrap();
    let ada_ops = ada.ops_after(mark, 100).unwrap();
    bob.apply_remote(ada_ops.ops, None).unwrap();
    let bob_mark = bob.last_seq().unwrap();
    bob.execute(Command::UpdateTask {
        id: task.id.clone(),
        changes: vec![TaskChange::Title("Ship v3".into())],
    })
    .unwrap();
    let bob_ops: Vec<SyncOp> = bob
        .ops_after(bob_mark, 100)
        .unwrap()
        .ops
        .into_iter()
        .filter(|op| op.author_id.as_deref() == Some(BOB))
        .collect();
    ada.apply_remote(bob_ops, None).unwrap();

    // Ada's undo takes back her priority, not Bob's title.
    ada.undo().unwrap().expect("undo");
    let now = ada.task(&task.id).unwrap();
    assert_eq!(now.title, "Ship v3");
    assert_eq!(now.priority, task.priority);

    // A personal space undoes as before: the last edit wins back.
    let mut mine = Store::open_in_memory().unwrap();
    let t = mine
        .execute(Command::CreateTask {
            task: new_task("Mine"),
        })
        .unwrap()
        .tasks
        .remove(0);
    mine.execute(Command::UpdateTask {
        id: t.id.clone(),
        changes: vec![TaskChange::Title("Mine 2".into())],
    })
    .unwrap();
    mine.undo().unwrap().expect("undo");
    assert_eq!(mine.task(&t.id).unwrap().title, "Mine");
}

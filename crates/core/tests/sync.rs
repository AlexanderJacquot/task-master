//! Replication (ADR 015): devices and a server, each a `Store`, exchanging ops. Latest edit
//! wins per field whatever the sync order, a delete wins over a later edit, merged states
//! are repaired, and random concurrent edits converge to identical rows everywhere.

use serde_json::Value;
use taskmaster_core::*;

const TODO: &str = "00000000-0000-7000-8000-000000000002";
const IN_PROGRESS: &str = "00000000-0000-7000-8000-000000000003";
const DONE: &str = "00000000-0000-7000-8000-000000000005";

/// One minute: an edit made with this offset is clearly later than one made without.
const LATER: i64 = 60_000;

fn store() -> Store {
    Store::open_in_memory().unwrap()
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

/// Syncs every device until nothing new moves (repairs are ops too, so it can take a few
/// rounds), then checks all replicas hold the same rows.
fn settle(devices: &mut [&mut Store], server: &mut Store) {
    for _ in 0..10 {
        for device in devices.iter_mut() {
            sync(device, server);
        }
        let head = server.ops_after(0, u32::MAX).unwrap().last_seq;
        let quiet = devices
            .iter()
            .all(|d| d.outbox(1).unwrap().ops.is_empty() && d.sync_cursor().unwrap() == head);
        if quiet {
            let expected = rows(server);
            for device in devices.iter() {
                assert_eq!(rows(device), expected, "replicas differ");
            }
            return;
        }
    }
    panic!("sync did not settle");
}

/// Every user row (deleted ones too), sorted, without the ops log.
fn rows(s: &Store) -> Value {
    let mut tables = s.export().unwrap().tables;
    tables.remove("ops");
    for list in tables.values_mut() {
        if let Value::Array(rows) = list {
            rows.sort_by_key(Value::to_string);
        }
    }
    Value::Object(tables)
}

fn row(s: &Store, table: &str, id: &str) -> Value {
    s.export().unwrap().tables[table]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("no {table} row {id}"))
}

fn add_task(s: &mut Store, title: &str, parent_id: Option<&str>) -> String {
    let task = NewTask {
        title: title.into(),
        parent_id: parent_id.map(Into::into),
        ..NewTask::default()
    };
    s.execute(Command::CreateTask { task }).unwrap().tasks[0]
        .id
        .clone()
}

fn update(s: &mut Store, id: &str, change: TaskChange) {
    s.execute(Command::UpdateTask {
        id: id.into(),
        changes: vec![change],
    })
    .unwrap();
}

fn add_tag(s: &mut Store, name: &str) -> String {
    let tag = NewTag {
        name: name.into(),
        ..NewTag::default()
    };
    s.execute(Command::CreateTag { tag }).unwrap().tags[0]
        .id
        .clone()
}

fn live_tasks(s: &Store) -> Vec<Task> {
    s.snapshot().unwrap().tasks
}

fn task(s: &Store, id: &str) -> Task {
    live_tasks(s)
        .into_iter()
        .find(|t| t.id == id)
        .unwrap_or_else(|| panic!("task {id} is not live"))
}

#[test]
fn edits_reach_other_devices() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let id = add_task(&mut a, "Buy milk", None);
    sync(&mut a, &mut server);
    sync(&mut b, &mut server);
    assert_eq!(task(&b, &id).title, "Buy milk");

    update(&mut b, &id, TaskChange::Title("Buy oat milk".into()));
    settle(&mut [&mut a, &mut b], &mut server);
    assert_eq!(task(&a, &id).title, "Buy oat milk");
}

#[test]
fn edits_to_different_fields_both_survive() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let id = add_task(&mut a, "Report", None);
    settle(&mut [&mut a, &mut b], &mut server);

    update(&mut a, &id, TaskChange::Title("Quarterly report".into()));
    b.set_clock_offset(LATER);
    update(&mut b, &id, TaskChange::Priority(Priority::Urgent));
    settle(&mut [&mut a, &mut b], &mut server);

    let t = task(&a, &id);
    assert_eq!(t.title, "Quarterly report");
    assert_eq!(t.priority, Priority::Urgent);
}

#[test]
fn latest_edit_wins_whatever_the_sync_order() {
    for later_syncs_first in [true, false] {
        let (mut a, mut b, mut server) = (store(), store(), store());
        let id = add_task(&mut a, "Draft", None);
        settle(&mut [&mut a, &mut b], &mut server);

        update(&mut a, &id, TaskChange::Title("earlier".into()));
        b.set_clock_offset(LATER);
        update(&mut b, &id, TaskChange::Title("later".into()));
        if later_syncs_first {
            settle(&mut [&mut b, &mut a], &mut server);
        } else {
            settle(&mut [&mut a, &mut b], &mut server);
        }
        assert_eq!(
            task(&a, &id).title,
            "later",
            "later_syncs_first={later_syncs_first}"
        );
        assert_eq!(task(&server, &id).title, "later");
    }
}

#[test]
fn an_edit_made_after_seeing_another_is_later_even_with_a_slow_clock() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    a.set_clock_offset(LATER); // a's clock runs a minute fast
    let id = add_task(&mut a, "one", None);
    settle(&mut [&mut a, &mut b], &mut server);
    update(&mut b, &id, TaskChange::Title("two".into())); // b saw a's edit first
    settle(&mut [&mut a, &mut b], &mut server);
    assert_eq!(task(&a, &id).title, "two");
}

#[test]
fn delete_wins_over_a_later_edit() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let id = add_task(&mut a, "Old idea", None);
    settle(&mut [&mut a, &mut b], &mut server);

    a.execute(Command::DeleteTask { id: id.clone() }).unwrap();
    b.set_clock_offset(LATER);
    update(&mut b, &id, TaskChange::Title("Old idea, edited".into()));
    settle(&mut [&mut b, &mut a], &mut server);

    for s in [&a, &b, &server] {
        let r = row(s, "tasks", &id);
        assert!(r["deleted_at"].is_i64(), "still deleted");
        assert_eq!(
            r["title"], "Old idea, edited",
            "the edit is kept on the deleted row"
        );
    }
}

#[test]
fn undoing_a_delete_restores_everywhere() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let id = add_task(&mut a, "Keep me", None);
    a.execute(Command::DeleteTask { id: id.clone() }).unwrap();
    settle(&mut [&mut a, &mut b], &mut server);
    assert!(live_tasks(&b).is_empty());

    a.undo().unwrap().unwrap();
    settle(&mut [&mut a, &mut b], &mut server);
    assert_eq!(task(&b, &id).title, "Keep me");
}

#[test]
fn applying_ops_twice_changes_nothing() {
    let (mut a, mut b) = (store(), store());
    add_task(&mut a, "Once", None);
    let ops = a.ops_after(0, 100).unwrap().ops;
    let first = b.apply_remote(ops.clone(), None).unwrap();
    assert_eq!((first.applied, first.duplicates), (ops.len() as u32, 0));
    assert_eq!(first.changes.tasks.len(), 1);

    let before = rows(&b);
    let again = b.apply_remote(ops.clone(), None).unwrap();
    assert_eq!((again.applied, again.duplicates), (0, ops.len() as u32));
    assert!(again.changes.is_empty());
    assert_eq!(rows(&b), before);

    // A replica's own ops coming back are duplicates too.
    let own = a.apply_remote(ops, None).unwrap();
    assert_eq!(own.applied, 0);
}

#[test]
fn outbox_holds_only_unpushed_local_ops() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    add_task(&mut a, "Offline work", None);
    add_task(&mut a, "More offline work", None);
    let page = a.outbox(100).unwrap();
    assert!(page.ops.len() >= 2);
    assert!(page.ops.iter().all(|op| op.device_id == a.device_id()));

    sync(&mut a, &mut server);
    assert!(a.outbox(100).unwrap().ops.is_empty(), "pushed");
    sync(&mut b, &mut server);
    assert!(
        b.outbox(100).unwrap().ops.is_empty(),
        "received ops are not pushed back"
    );
    assert_eq!(
        b.sync_cursor().unwrap(),
        server.ops_after(0, 1000).unwrap().last_seq
    );

    let limited = {
        add_task(&mut b, "x", None);
        add_task(&mut b, "y", None);
        b.outbox(1).unwrap()
    };
    assert_eq!(limited.ops.len(), 1);
    assert!(limited.more);
}

#[test]
fn remote_changes_are_broadcast() {
    let (mut a, mut b) = (store(), store());
    let events = b.subscribe();
    let id = add_task(&mut a, "Ping", None);
    b.apply_remote(a.ops_after(0, 100).unwrap().ops, None)
        .unwrap();
    let event = events.try_recv().unwrap();
    assert!(event.entities.iter().any(|e| e.id == id));
}

#[test]
fn a_tag_made_on_two_devices_becomes_one() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let ta = add_task(&mut a, "on a", None);
    let tb = add_task(&mut b, "on b", None);
    let tag_a = add_tag(&mut a, "work");
    let tag_b = add_tag(&mut b, "Work");
    a.execute(Command::TagTask {
        task_id: ta.clone(),
        tag_id: tag_a.clone(),
    })
    .unwrap();
    b.execute(Command::TagTask {
        task_id: tb.clone(),
        tag_id: tag_b.clone(),
    })
    .unwrap();
    settle(&mut [&mut a, &mut b], &mut server);

    let keep = tag_a.clone().min(tag_b.clone());
    for s in [&a, &b, &server] {
        let tags = s.snapshot().unwrap().tags;
        assert_eq!(tags.len(), 1, "one live tag");
        assert_eq!(tags[0].id, keep, "the first-created tag stays");
        assert_eq!(task(s, &ta).tag_ids, vec![keep.clone()]);
        assert_eq!(task(s, &tb).tag_ids, vec![keep.clone()]);
    }
}

#[test]
fn latest_link_or_unlink_wins() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let id = add_task(&mut a, "Tagged", None);
    let tag = add_tag(&mut a, "home");
    a.execute(Command::TagTask {
        task_id: id.clone(),
        tag_id: tag.clone(),
    })
    .unwrap();
    settle(&mut [&mut a, &mut b], &mut server);

    a.execute(Command::UntagTask {
        task_id: id.clone(),
        tag_id: tag.clone(),
    })
    .unwrap();
    // b relinks later (after unlinking it itself, as the UI would only toggle).
    b.set_clock_offset(LATER);
    b.execute(Command::UntagTask {
        task_id: id.clone(),
        tag_id: tag.clone(),
    })
    .unwrap();
    b.execute(Command::TagTask {
        task_id: id.clone(),
        tag_id: tag.clone(),
    })
    .unwrap();
    settle(&mut [&mut b, &mut a], &mut server);
    assert_eq!(task(&a, &id).tag_ids, vec![tag]);
}

#[test]
fn a_subtask_added_under_a_deleted_task_is_deleted() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let parent = add_task(&mut a, "Parent", None);
    settle(&mut [&mut a, &mut b], &mut server);

    a.execute(Command::DeleteTask { id: parent.clone() })
        .unwrap();
    let child = add_task(&mut b, "New subtask", Some(&parent));
    let grandchild = add_task(&mut b, "Deeper", Some(&child));
    settle(&mut [&mut a, &mut b], &mut server);

    for s in [&a, &b, &server] {
        assert!(live_tasks(s).is_empty());
        assert!(row(s, "tasks", &grandchild)["deleted_at"].is_i64());
    }
}

#[test]
fn a_parent_cycle_keeps_the_latest_move() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let x = add_task(&mut a, "X", None);
    let y = add_task(&mut a, "Y", None);
    settle(&mut [&mut a, &mut b], &mut server);

    a.execute(Command::SetParent {
        id: x.clone(),
        parent_id: Some(y.clone()),
    })
    .unwrap();
    b.set_clock_offset(LATER);
    b.execute(Command::SetParent {
        id: y.clone(),
        parent_id: Some(x.clone()),
    })
    .unwrap();
    settle(&mut [&mut a, &mut b], &mut server);

    for s in [&a, &b, &server] {
        assert_eq!(
            task(s, &y).parent_id.as_deref(),
            Some(x.as_str()),
            "latest move kept"
        );
        assert_eq!(task(s, &x).parent_id, None, "earlier move undone");
    }
}

#[test]
fn a_task_added_to_a_deleted_project_moves_to_the_inbox() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let project = a
        .execute(Command::CreateProject {
            project: NewProject {
                name: "Garden".into(),
                ..NewProject::default()
            },
        })
        .unwrap()
        .projects[0]
        .id
        .clone();
    settle(&mut [&mut a, &mut b], &mut server);

    a.execute(Command::DeleteProject {
        id: project.clone(),
    })
    .unwrap();
    let id = add_task(&mut b, "Plant tulips", None);
    update(&mut b, &id, TaskChange::ProjectId(Some(project.clone())));
    settle(&mut [&mut a, &mut b], &mut server);

    for s in [&a, &b, &server] {
        assert_eq!(task(s, &id).project_id, None);
        assert!(s.snapshot().unwrap().projects.is_empty(), "the delete wins");
    }
}

#[test]
fn completed_at_follows_the_latest_status() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let id = add_task(&mut a, "Ship it", None);
    settle(&mut [&mut a, &mut b], &mut server);
    assert_eq!(task(&a, &id).status_id, TODO);

    update(&mut a, &id, TaskChange::StatusId(DONE.into()));
    b.set_clock_offset(LATER);
    update(&mut b, &id, TaskChange::Title("Ship it (v2)".into()));
    update(&mut b, &id, TaskChange::StatusId(IN_PROGRESS.into()));
    settle(&mut [&mut a, &mut b], &mut server);
    for s in [&a, &b, &server] {
        let t = task(s, &id);
        assert_eq!(t.status_id, IN_PROGRESS);
        assert_eq!(t.completed_at, None);
    }

    // And the other way: done last.
    a.set_clock_offset(2 * LATER);
    update(&mut a, &id, TaskChange::StatusId(DONE.into()));
    settle(&mut [&mut b, &mut a], &mut server);
    assert!(task(&b, &id).completed_at.is_some());
}

#[test]
fn import_resets_sync_and_pushes_everything_again() {
    let (mut a, mut c, mut server) = (store(), store(), store());
    let id = add_task(&mut a, "Moved machines", None);
    sync(&mut a, &mut server);

    c.import(&a.export().unwrap()).unwrap();
    assert_eq!(c.sync_cursor().unwrap(), 0);
    assert!(!c.outbox(1000).unwrap().ops.is_empty());
    sync(&mut c, &mut server);
    // The server already had those ops: nothing duplicated.
    assert_eq!(live_tasks(&server).len(), 1);

    // Field clocks came back with the import: a stale op loses.
    update(&mut a, &id, TaskChange::Title("newer".into()));
    let newer = a.outbox(10).unwrap().ops;
    let mut stale = newer[0].clone();
    stale.op_id = new_id();
    stale.hlc = "0000000000001-00000-x".into();
    stale.patch.insert("title".into(), "stale".into());
    c.apply_remote(newer, None).unwrap();
    c.apply_remote(vec![stale], None).unwrap();
    assert_eq!(task(&c, &id).title, "newer");
}

#[test]
fn replacing_a_device_with_the_server_copy() {
    let (mut a, mut b, mut server) = (store(), store(), store());
    let id = add_task(&mut a, "on the server", None);
    update(&mut a, &id, TaskChange::Priority(Priority::High));
    sync(&mut a, &mut server);

    // b has its own tasks, then chooses "replace with the server's tasks".
    add_task(&mut b, "only on b", None);
    add_tag(&mut b, "local");
    b.clear_for_replace().unwrap();
    assert!(live_tasks(&b).is_empty());
    assert!(b.snapshot().unwrap().tags.is_empty());
    assert!(!b.snapshot().unwrap().statuses.is_empty(), "statuses stay");
    assert_eq!(b.sync_cursor().unwrap(), 0);
    assert!(
        b.outbox(10).unwrap().ops.is_empty(),
        "nothing of b's is pushed"
    );

    sync(&mut b, &mut server);
    assert_eq!(rows(&b), rows(&server));
    assert_eq!(task(&b, &id).priority, Priority::High);
}

#[test]
fn bad_ops_are_refused_without_changing_anything() {
    let (mut a, mut b) = (store(), store());
    add_task(&mut a, "ok", None);
    let good = a.ops_after(0, 100).unwrap().ops;
    let before = rows(&b);

    let mut bad_column = good[0].clone();
    bad_column.op_id = new_id();
    bad_column
        .patch
        .insert("1; DROP TABLE tasks".into(), Value::Null);
    let mut ops = good.clone();
    ops.push(bad_column);
    assert!(b.apply_remote(ops, Some(99)).is_err());

    let mut bad_clock = good[0].clone();
    bad_clock.op_id = new_id();
    bad_clock.hlc = "yesterday".into();
    assert!(b.apply_remote(vec![bad_clock], None).is_err());

    assert_eq!(rows(&b), before, "the whole page is refused");
    assert_eq!(b.sync_cursor().unwrap(), 0);
}

// ---------------------------------------------------------------------------------------
// Random concurrent edits converge.

/// xorshift64*: a deterministic stream, so a failing seed can be replayed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn pick<T: Clone>(&mut self, items: &[T]) -> Option<T> {
        (!items.is_empty()).then(|| items[self.below(items.len())].clone())
    }
}

const STATUSES: [&str; 3] = [TODO, IN_PROGRESS, DONE];
const TAG_NAMES: [&str; 3] = ["home", "Home", "work"];

/// One random user action. Commands a device's rules refuse are simply skipped.
fn random_edit(s: &mut Store, rng: &mut Rng) {
    let snap = s.snapshot().unwrap();
    let tasks: Vec<String> = snap.tasks.iter().map(|t| t.id.clone()).collect();
    let tags: Vec<String> = snap.tags.iter().map(|t| t.id.clone()).collect();
    let projects: Vec<String> = snap.projects.iter().map(|p| p.id.clone()).collect();
    let task_id = rng.pick(&tasks);
    let command = match (rng.below(12), task_id) {
        (0 | 1, _) | (_, None) => Command::CreateTask {
            task: NewTask {
                title: format!("t{}", rng.below(1000)),
                parent_id: if rng.below(3) == 0 {
                    rng.pick(&tasks)
                } else {
                    None
                },
                ..NewTask::default()
            },
        },
        (2, Some(id)) => Command::UpdateTask {
            id,
            changes: vec![TaskChange::Title(format!("title {}", rng.below(1000)))],
        },
        (3, Some(id)) => Command::UpdateTask {
            id,
            changes: vec![TaskChange::StatusId(rng.pick(&STATUSES).unwrap().into())],
        },
        (4, Some(id)) => Command::SetParent {
            id,
            parent_id: if rng.below(2) == 0 {
                rng.pick(&tasks)
            } else {
                None
            },
        },
        (5, Some(id)) => Command::DeleteTask { id },
        (6, Some(_)) => Command::CreateTag {
            tag: NewTag {
                name: rng.pick(&TAG_NAMES).unwrap().into(),
                ..NewTag::default()
            },
        },
        (7, Some(id)) => match rng.pick(&tags) {
            Some(tag_id) if rng.below(3) > 0 => Command::TagTask {
                task_id: id,
                tag_id,
            },
            Some(tag_id) => Command::UntagTask {
                task_id: id,
                tag_id,
            },
            None => return,
        },
        (8, Some(_)) => match rng.pick(&tags) {
            Some(id) => Command::DeleteTag { id },
            None => return,
        },
        (9, Some(_)) => Command::CreateProject {
            project: NewProject {
                name: format!("p{}", rng.below(100)),
                parent_id: rng.pick(&projects).filter(|_| rng.below(2) == 0),
                ..NewProject::default()
            },
        },
        (10, Some(id)) => Command::UpdateTask {
            id,
            changes: vec![TaskChange::ProjectId(rng.pick(&projects))],
        },
        (_, Some(_)) => match rng.pick(&projects) {
            Some(id) => Command::DeleteProject { id },
            None => return,
        },
    };
    let _ = s.execute(command); // refused by a local rule: fine
}

fn check_rules(s: &Store) {
    let snap = s.snapshot().unwrap();
    let live: std::collections::BTreeMap<_, _> =
        snap.tasks.iter().map(|t| (t.id.clone(), t)).collect();
    for t in &snap.tasks {
        if let Some(p) = &t.parent_id {
            assert!(
                live.contains_key(p),
                "live task {} under a deleted parent",
                t.id
            );
        }
        // Walking up always ends: no cycles.
        let mut node = t;
        for _ in 0..=snap.tasks.len() {
            match node.parent_id.as_ref().and_then(|p| live.get(p)) {
                Some(parent) => node = parent,
                None => break,
            }
        }
        assert!(node.parent_id.is_none(), "cycle through {}", t.id);
        assert_eq!(
            t.status_id == DONE,
            t.completed_at.is_some(),
            "completed_at of {}",
            t.id
        );
        if let Some(p) = &t.project_id {
            assert!(
                snap.projects.iter().any(|x| &x.id == p),
                "task in a deleted project"
            );
        }
        for tag in &t.tag_ids {
            assert!(
                snap.tags.iter().any(|x| &x.id == tag),
                "link to a deleted tag"
            );
        }
    }
    for p in &snap.projects {
        if let Some(parent) = snap
            .projects
            .iter()
            .find(|x| Some(&x.id) == p.parent_id.as_ref())
        {
            assert!(parent.parent_id.is_none(), "projects nested two levels");
        }
    }
    let mut names: Vec<String> = snap.tags.iter().map(|t| t.name.to_lowercase()).collect();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), snap.tags.len(), "duplicate live tag names");
}

#[test]
fn random_concurrent_edits_converge() {
    for seed in 1..=25_u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let mut server = store();
        let mut devices = [store(), store(), store()];
        for d in &mut devices {
            // Skewed clocks, up to five seconds either way.
            d.set_clock_offset(rng.below(10_001) as i64 - 5_000);
        }
        for _ in 0..150 {
            let i = rng.below(devices.len());
            random_edit(&mut devices[i], &mut rng);
            if rng.below(4) == 0 {
                let j = rng.below(devices.len());
                sync(&mut devices[j], &mut server);
            }
        }
        let [a, b, c] = &mut devices;
        settle(&mut [a, b, c], &mut server);
        for s in devices.iter().chain([&server]) {
            check_rules(s);
        }
    }
}

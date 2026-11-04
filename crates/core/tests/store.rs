//! End-to-end tests of the public API: every command, undo/redo of each, validation,
//! atomicity, the ops log and migrations on fresh and existing database files.

use std::path::PathBuf;

use taskmaster_core::*;

const BACKLOG: &str = "00000000-0000-7000-8000-000000000001";
const TODO: &str = "00000000-0000-7000-8000-000000000002";
const IN_PROGRESS: &str = "00000000-0000-7000-8000-000000000003";
const DONE: &str = "00000000-0000-7000-8000-000000000005";

fn store() -> Store {
    Store::open_in_memory().unwrap()
}

fn new_task(title: &str) -> NewTask {
    NewTask {
        title: title.into(),
        ..NewTask::default()
    }
}

fn add_task(s: &mut Store, task: NewTask) -> Task {
    let changes = s.execute(Command::CreateTask { task }).unwrap();
    changes.tasks.into_iter().next().unwrap()
}

fn add_project(s: &mut Store, name: &str, parent_id: Option<&str>) -> Project {
    let project = NewProject {
        name: name.into(),
        parent_id: parent_id.map(Into::into),
        ..NewProject::default()
    };
    let changes = s.execute(Command::CreateProject { project }).unwrap();
    changes.projects.into_iter().next().unwrap()
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

fn add_tag(s: &mut Store, name: &str) -> Tag {
    let tag = NewTag {
        name: name.into(),
        ..NewTag::default()
    };
    s.execute(Command::CreateTag { tag })
        .unwrap()
        .tags
        .remove(0)
}

fn task(s: &Store, id: &str) -> Task {
    s.snapshot()
        .unwrap()
        .tasks
        .into_iter()
        .find(|t| t.id == id)
        .unwrap_or_else(|| panic!("task {id} not live"))
}

/// Runs a command, then checks undo restores the exact prior state and redo the exact
/// post state.
fn roundtrip(s: &mut Store, command: Command) -> Changes {
    let before = s.snapshot().unwrap();
    let changes = s.execute(command.clone()).unwrap();
    assert!(!changes.is_empty(), "{command:?} changed nothing");
    let after = s.snapshot().unwrap();
    assert_ne!(before, after, "{command:?} left the snapshot unchanged");

    s.undo().unwrap().expect("something to undo");
    assert_eq!(s.snapshot().unwrap(), before, "undo of {command:?}");
    s.redo().unwrap().expect("something to redo");
    assert_eq!(s.snapshot().unwrap(), after, "redo of {command:?}");
    s.undo().unwrap();
    assert_eq!(s.snapshot().unwrap(), before, "second undo of {command:?}");
    s.redo().unwrap();
    changes
}

fn invalid(result: Result<Changes>) -> String {
    match result {
        Err(Error::Invalid(message)) => message,
        other => panic!("expected Invalid, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------------------
// Tasks

#[test]
fn new_task_defaults_to_inbox_todo_normal_and_end_of_column() {
    let mut s = store();
    let a = add_task(&mut s, new_task("  Buy milk  "));
    let b = add_task(&mut s, new_task("Second"));
    assert_eq!(a.title, "Buy milk");
    assert_eq!(a.project_id, None);
    assert_eq!(a.status_id, TODO);
    assert_eq!(a.priority, Priority::Normal);
    assert_eq!(a.description, "");
    assert_eq!(a.completed_at, None);
    assert!(a.rank < b.rank);
    uuid_v7(&a.id);
}

fn uuid_v7(id: &str) {
    assert_eq!(id.len(), 36);
    assert_eq!(&id[14..15], "7", "{id} is not a v7 UUID");
}

#[test]
fn create_task_with_everything_roundtrips() {
    let mut s = store();
    let project = add_project(&mut s, "Homelab", None);
    let epic = add_epic(&mut s, "IaC");
    let tag = add_tag(&mut s, "#quick");
    let id = new_id();
    let changes = roundtrip(
        &mut s,
        Command::CreateTask {
            task: NewTask {
                id: Some(id.clone()),
                title: "Fix DNS".into(),
                description: "**watch** it".into(),
                project_id: Some(project.id.clone()),
                epic_id: Some(epic.id.clone()),
                status_id: Some(IN_PROGRESS.into()),
                priority: Priority::High,
                due_date: Some("2026-11-06".into()),
                today_on: Some("2026-11-04".into()),
                estimate_min: Some(30),
                tag_ids: vec![tag.id.clone(), tag.id.clone()],
                ..NewTask::default()
            },
        },
    );
    let t = &changes.tasks[0];
    assert_eq!(t.id, id);
    assert_eq!(t.tag_ids, vec![tag.id]);
    assert_eq!(t.project_id, Some(project.id));
    assert_eq!(t.epic_id, Some(epic.id));
    assert_eq!(task(&s, &id), *t);
}

#[test]
fn update_task_roundtrips() {
    let mut s = store();
    let t = add_task(&mut s, new_task("Old"));
    let changes = roundtrip(
        &mut s,
        Command::UpdateTask {
            id: t.id.clone(),
            changes: vec![
                TaskChange::Title("New".into()),
                TaskChange::Description("desc".into()),
                TaskChange::Priority(Priority::Urgent),
                TaskChange::DueDate(Some("2026-12-01".into())),
                TaskChange::TodayOn(Some("2026-11-04".into())),
                TaskChange::EstimateMin(Some(90)),
            ],
        },
    );
    let u = &changes.tasks[0];
    assert_eq!(
        (u.title.as_str(), u.priority, u.estimate_min),
        ("New", Priority::Urgent, Some(90))
    );
    assert!(u.updated_at >= t.updated_at);
}

#[test]
fn move_task_to_done_sets_and_clears_completed_at() {
    let mut s = store();
    let t = add_task(&mut s, new_task("Ship"));
    let done = roundtrip(
        &mut s,
        Command::MoveTask {
            id: t.id.clone(),
            status_id: DONE.into(),
            rank: "a5".into(),
        },
    );
    assert_eq!(done.tasks[0].status_id, DONE);
    assert_eq!(done.tasks[0].rank, "a5");
    assert!(done.tasks[0].completed_at.is_some());

    let reopened = s
        .execute(Command::MoveTask {
            id: t.id.clone(),
            status_id: BACKLOG.into(),
            rank: "a0".into(),
        })
        .unwrap();
    assert_eq!(reopened.tasks[0].completed_at, None);
}

#[test]
fn set_parent_inherits_containers_and_roundtrips() {
    let mut s = store();
    let project = add_project(&mut s, "Chaumet", None);
    let epic = add_epic(&mut s, "Go freelance");
    let parent = add_task(
        &mut s,
        NewTask {
            project_id: Some(project.id.clone()),
            epic_id: Some(epic.id.clone()),
            ..new_task("Parent")
        },
    );
    let child = add_task(&mut s, new_task("Child"));
    let grandchild = add_task(
        &mut s,
        NewTask {
            parent_id: Some(child.id.clone()),
            ..new_task("Grandchild")
        },
    );

    roundtrip(
        &mut s,
        Command::SetParent {
            id: child.id.clone(),
            parent_id: Some(parent.id.clone()),
        },
    );
    let child = task(&s, &child.id);
    assert_eq!(child.parent_id.as_deref(), Some(parent.id.as_str()));
    assert_eq!(child.project_id.as_deref(), Some(project.id.as_str()));
    assert_eq!(child.epic_id.as_deref(), Some(epic.id.as_str()));
    let grandchild = task(&s, &grandchild.id);
    assert_eq!(grandchild.project_id.as_deref(), Some(project.id.as_str()));

    // Promote back to a top-level task.
    roundtrip(
        &mut s,
        Command::SetParent {
            id: child.id.clone(),
            parent_id: None,
        },
    );
    assert_eq!(task(&s, &child.id).parent_id, None);
}

#[test]
fn subtask_inherits_parent_containers_on_create() {
    let mut s = store();
    let project = add_project(&mut s, "Perso", None);
    let parent = add_task(
        &mut s,
        NewTask {
            project_id: Some(project.id.clone()),
            ..new_task("Parent")
        },
    );
    let child = add_task(
        &mut s,
        NewTask {
            parent_id: Some(parent.id.clone()),
            ..new_task("Child")
        },
    );
    assert_eq!(child.project_id, Some(project.id));
}

#[test]
fn changing_project_moves_inherited_subtasks_only() {
    let mut s = store();
    let a = add_project(&mut s, "A", None);
    let b = add_project(&mut s, "B", None);
    let other = add_project(&mut s, "Other", None);
    let parent = add_task(
        &mut s,
        NewTask {
            project_id: Some(a.id.clone()),
            ..new_task("Parent")
        },
    );
    let inherited = add_task(
        &mut s,
        NewTask {
            parent_id: Some(parent.id.clone()),
            ..new_task("Inherited")
        },
    );
    let overridden = add_task(
        &mut s,
        NewTask {
            parent_id: Some(parent.id.clone()),
            project_id: Some(other.id.clone()),
            ..new_task("Overridden")
        },
    );

    roundtrip(
        &mut s,
        Command::UpdateTask {
            id: parent.id.clone(),
            changes: vec![TaskChange::ProjectId(Some(b.id.clone()))],
        },
    );
    assert_eq!(task(&s, &inherited.id).project_id, Some(b.id));
    assert_eq!(task(&s, &overridden.id).project_id, Some(other.id));
}

#[test]
fn delete_task_cascades_to_subtasks_and_undo_restores_them() {
    let mut s = store();
    let parent = add_task(&mut s, new_task("Parent"));
    let child = add_task(
        &mut s,
        NewTask {
            parent_id: Some(parent.id.clone()),
            ..new_task("Child")
        },
    );
    let changes = roundtrip(
        &mut s,
        Command::DeleteTask {
            id: parent.id.clone(),
        },
    );
    assert_eq!(changes.tasks.len(), 2);
    assert!(changes.tasks.iter().all(|t| t.deleted_at.is_some()));
    assert!(s.snapshot().unwrap().tasks.is_empty());
    s.undo().unwrap();
    assert_eq!(task(&s, &child.id).parent_id, Some(parent.id));
}

#[test]
fn tag_and_untag_roundtrip_and_are_idempotent() {
    let mut s = store();
    let t = add_task(&mut s, new_task("Task"));
    let tag = add_tag(&mut s, "waiting");
    roundtrip(
        &mut s,
        Command::TagTask {
            task_id: t.id.clone(),
            tag_id: tag.id.clone(),
        },
    );
    assert_eq!(task(&s, &t.id).tag_ids, vec![tag.id.clone()]);

    let again = s
        .execute(Command::TagTask {
            task_id: t.id.clone(),
            tag_id: tag.id.clone(),
        })
        .unwrap();
    assert!(again.is_empty(), "tagging twice writes nothing");

    roundtrip(
        &mut s,
        Command::UntagTask {
            task_id: t.id.clone(),
            tag_id: tag.id.clone(),
        },
    );
    assert!(task(&s, &t.id).tag_ids.is_empty());
}

// ---------------------------------------------------------------------------------------
// Projects, epics, tags

#[test]
fn project_commands_roundtrip() {
    let mut s = store();
    let area = add_project(&mut s, "Work", None);
    let id = new_id();
    roundtrip(
        &mut s,
        Command::CreateProject {
            project: NewProject {
                id: Some(id.clone()),
                name: "Chaumet".into(),
                parent_id: Some(area.id.clone()),
                color: Some("#ff0000".into()),
                ..NewProject::default()
            },
        },
    );
    let changes = roundtrip(
        &mut s,
        Command::UpdateProject {
            id: id.clone(),
            changes: vec![
                ProjectChange::Name("Chaumet SA".into()),
                ProjectChange::Icon(Some("briefcase".into())),
                ProjectChange::Archived(true),
                ProjectChange::ParentId(None),
            ],
        },
    );
    let p = &changes.projects[0];
    assert_eq!(p.name, "Chaumet SA");
    assert!(p.archived_at.is_some());
    assert_eq!(p.parent_id, None);
    roundtrip(&mut s, Command::DeleteProject { id });
}

#[test]
fn epic_commands_roundtrip_and_delete_detaches_tasks() {
    let mut s = store();
    let project = add_project(&mut s, "Homelab", None);
    let id = new_id();
    roundtrip(
        &mut s,
        Command::CreateEpic {
            epic: NewEpic {
                id: Some(id.clone()),
                name: "Migrate to IaC".into(),
                project_id: Some(project.id.clone()),
                target_date: Some("2027-01-31".into()),
                ..NewEpic::default()
            },
        },
    );
    roundtrip(
        &mut s,
        Command::UpdateEpic {
            id: id.clone(),
            changes: vec![
                EpicChange::State(EpicState::Done),
                EpicChange::Description(Some("All hosts".into())),
                EpicChange::ProjectId(None),
            ],
        },
    );
    let t = add_task(
        &mut s,
        NewTask {
            epic_id: Some(id.clone()),
            ..new_task("Write playbook")
        },
    );
    roundtrip(&mut s, Command::DeleteEpic { id });
    assert_eq!(task(&s, &t.id).epic_id, None);
}

#[test]
fn tag_commands_roundtrip_and_delete_unlinks() {
    let mut s = store();
    let id = new_id();
    roundtrip(
        &mut s,
        Command::CreateTag {
            tag: NewTag {
                id: Some(id.clone()),
                name: "#deep-work".into(),
                color: None,
            },
        },
    );
    assert_eq!(s.snapshot().unwrap().tags[0].name, "deep-work");
    roundtrip(
        &mut s,
        Command::UpdateTag {
            id: id.clone(),
            changes: vec![
                TagChange::Name("focus".into()),
                TagChange::Color(Some("#00f".into())),
            ],
        },
    );
    let t = add_task(
        &mut s,
        NewTask {
            tag_ids: vec![id.clone()],
            ..new_task("Think")
        },
    );
    roundtrip(&mut s, Command::DeleteTag { id: id.clone() });
    assert!(task(&s, &t.id).tag_ids.is_empty());

    // The name of a deleted tag can be reused.
    add_tag(&mut s, "focus");
}

// ---------------------------------------------------------------------------------------
// Validation

#[test]
fn rejects_invalid_input() {
    let mut s = store();
    let t = add_task(&mut s, new_task("Task"));
    let area = add_project(&mut s, "Area", None);
    let inner = add_project(&mut s, "Inner", Some(&area.id));
    add_tag(&mut s, "Quick");

    let create = |task: NewTask| Command::CreateTask { task };
    let update = |change: TaskChange| Command::UpdateTask {
        id: t.id.clone(),
        changes: vec![change],
    };

    invalid(s.execute(create(new_task("   "))));
    invalid(s.execute(create(NewTask {
        due_date: Some("2026-02-30".into()),
        ..new_task("x")
    })));
    invalid(s.execute(create(NewTask {
        id: Some("not-a-uuid".into()),
        ..new_task("x")
    })));
    invalid(s.execute(create(NewTask {
        id: Some(t.id.clone()),
        ..new_task("duplicate id")
    })));
    invalid(s.execute(create(NewTask {
        rank: Some("a00".into()),
        ..new_task("x")
    })));
    invalid(s.execute(update(TaskChange::EstimateMin(Some(-5)))));
    invalid(s.execute(update(TaskChange::Title(String::new()))));
    invalid(s.execute(Command::UpdateTask {
        id: t.id.clone(),
        changes: vec![],
    }));
    invalid(s.execute(Command::SetParent {
        id: t.id.clone(),
        parent_id: Some(t.id.clone()),
    }));
    invalid(s.execute(Command::CreateProject {
        project: NewProject {
            name: "Too deep".into(),
            parent_id: Some(inner.id.clone()),
            ..NewProject::default()
        },
    }));
    invalid(s.execute(Command::CreateTag {
        tag: NewTag {
            name: "#quick".into(),
            ..NewTag::default()
        },
    }));
    invalid(s.execute(Command::CreateTag {
        tag: NewTag {
            name: "two words".into(),
            ..NewTag::default()
        },
    }));
    invalid(s.execute(Command::DeleteProject {
        id: area.id.clone(),
    }));

    let missing = new_id();
    assert!(matches!(
        s.execute(create(NewTask {
            project_id: Some(missing.clone()),
            ..new_task("x")
        })),
        Err(Error::NotFound {
            entity: "project",
            ..
        })
    ));
    assert!(matches!(
        s.execute(Command::DeleteTask { id: missing }),
        Err(Error::NotFound { entity: "task", .. })
    ));
}

#[test]
fn set_parent_refuses_cycles() {
    let mut s = store();
    let a = add_task(&mut s, new_task("A"));
    let b = add_task(
        &mut s,
        NewTask {
            parent_id: Some(a.id.clone()),
            ..new_task("B")
        },
    );
    let c = add_task(
        &mut s,
        NewTask {
            parent_id: Some(b.id.clone()),
            ..new_task("C")
        },
    );
    let message = invalid(s.execute(Command::SetParent {
        id: a.id.clone(),
        parent_id: Some(c.id.clone()),
    }));
    assert!(message.contains("subtasks"), "{message}");
}

#[test]
fn deleted_entities_cannot_be_used() {
    let mut s = store();
    let t = add_task(&mut s, new_task("Gone"));
    s.execute(Command::DeleteTask { id: t.id.clone() }).unwrap();
    assert!(matches!(
        s.execute(Command::UpdateTask {
            id: t.id.clone(),
            changes: vec![TaskChange::Title("x".into())],
        }),
        Err(Error::NotFound { .. })
    ));
}

// ---------------------------------------------------------------------------------------
// Batches, history, events, search

#[test]
fn a_batch_is_atomic() {
    let mut s = store();
    let before = s.snapshot().unwrap();
    let result = s.execute_all(vec![
        Command::CreateTask {
            task: new_task("Valid"),
        },
        Command::CreateTask { task: new_task("") },
    ]);
    assert!(result.is_err());
    assert_eq!(s.snapshot().unwrap(), before);
    assert!(!s.can_undo(), "a failed batch is not undoable");
}

#[test]
fn a_batch_undoes_as_one_action() {
    let mut s = store();
    let changes = s
        .execute_all(vec![
            Command::CreateTask {
                task: new_task("One"),
            },
            Command::CreateTask {
                task: new_task("Two"),
            },
        ])
        .unwrap();
    assert_eq!(changes.tasks.len(), 2);
    s.undo().unwrap();
    assert!(s.snapshot().unwrap().tasks.is_empty());
}

#[test]
fn history_stacks_behave() {
    let mut s = store();
    assert!(s.undo().unwrap().is_none());
    assert!(s.redo().unwrap().is_none());

    let a = add_task(&mut s, new_task("A"));
    add_task(&mut s, new_task("B"));
    s.undo().unwrap();
    s.undo().unwrap();
    assert!(!s.can_undo());
    s.redo().unwrap();
    assert_eq!(s.snapshot().unwrap().tasks.len(), 1);

    // A new action clears the redo stack.
    s.execute(Command::UpdateTask {
        id: a.id.clone(),
        changes: vec![TaskChange::Title("A2".into())],
    })
    .unwrap();
    assert!(!s.can_redo());
    assert_eq!(task(&s, &a.id).title, "A2");
}

#[test]
fn events_are_broadcast_after_commit() {
    let mut s = store();
    let rx = s.subscribe();
    let t = add_task(&mut s, new_task("Watched"));
    let event = rx.try_recv().unwrap();
    assert_eq!(
        event.entities,
        vec![EntityRef {
            kind: EntityKind::Task,
            id: t.id.clone()
        }]
    );
    assert!(event.op_seq > 0);

    let _ = s.execute(Command::CreateTask { task: new_task("") });
    assert!(rx.try_recv().is_err(), "failed batches publish nothing");

    drop(rx);
    add_task(&mut s, new_task("Nobody listens")); // dropped receivers are pruned
}

#[test]
fn search_matches_prefixes_and_skips_deleted() {
    let mut s = store();
    let dns = add_task(
        &mut s,
        NewTask {
            description: "check the watchtower container".into(),
            ..new_task("Fix DNS resolver")
        },
    );
    let other = add_task(&mut s, new_task("Write \"quoted\" notes"));
    assert_eq!(s.search("resol", 10).unwrap(), vec![dns.id.clone()]);
    assert_eq!(s.search("dns watch", 10).unwrap(), vec![dns.id.clone()]);
    assert_eq!(s.search("\"quoted", 10).unwrap(), vec![other.id.clone()]);
    assert!(s.search("   ", 10).unwrap().is_empty());

    s.execute(Command::UpdateTask {
        id: dns.id.clone(),
        changes: vec![TaskChange::Title("Renew certificates".into())],
    })
    .unwrap();
    assert!(s.search("resolver", 10).unwrap().is_empty());
    assert_eq!(s.search("certif", 10).unwrap(), vec![dns.id.clone()]);

    s.execute(Command::DeleteTask { id: dns.id }).unwrap();
    assert!(s.search("certif", 10).unwrap().is_empty());
}

// ---------------------------------------------------------------------------------------
// Files, migrations and the ops log

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("taskmaster-test-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn fresh_file_db_persists_across_reopen_without_backup() {
    let dir = TempDir::new();
    let path = dir.0.join("data/task-master.sqlite");
    let (device, id) = {
        let mut s = Store::open(&path).unwrap();
        let t = add_task(&mut s, new_task("Persist me"));
        (s.device_id().to_owned(), t.id)
    };
    let s = Store::open(&path).unwrap();
    assert_eq!(s.device_id(), device);
    assert_eq!(task(&s, &id).title, "Persist me");
    assert!(
        !path.parent().unwrap().join("backups").exists(),
        "no migration ran on reopen, so no backup"
    );
}

#[test]
fn existing_db_is_backed_up_then_migrated() {
    let dir = TempDir::new();
    let path = dir.0.join("old.sqlite");
    {
        // A database from before migrations existed (schema version 0).
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE legacy (x INTEGER); INSERT INTO legacy VALUES (1);")
            .unwrap();
    }
    let mut s = Store::open(&path).unwrap();
    add_task(&mut s, new_task("Works after migration"));

    let backups: Vec<_> = std::fs::read_dir(dir.0.join("backups"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(backups.len(), 1, "{backups:?}");
    let backup = rusqlite::Connection::open(&backups[0]).unwrap();
    let legacy: i64 = backup
        .query_row("SELECT x FROM legacy", [], |r| r.get(0))
        .unwrap();
    assert_eq!(legacy, 1);
    let has_tasks: i64 = backup
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'tasks'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(has_tasks, 0, "backup was taken before migrating");
}

#[test]
fn every_write_lands_in_the_ops_log_with_increasing_hlc() {
    let dir = TempDir::new();
    let path = dir.0.join("ops.sqlite");
    let mut s = Store::open(&path).unwrap();
    let tag = add_tag(&mut s, "x");
    let t = add_task(
        &mut s,
        NewTask {
            tag_ids: vec![tag.id.clone()],
            ..new_task("Logged")
        },
    );
    s.undo().unwrap();
    let device = s.device_id().to_owned();
    drop(s);

    let conn = rusqlite::Connection::open(&path).unwrap();
    let ops: Vec<(String, String, String, String, String, String)> = conn
        .prepare("SELECT entity, entity_id, kind, hlc, batch_id, device_id FROM ops ORDER BY seq")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let kinds: Vec<(&str, &str)> = ops.iter().map(|o| (o.0.as_str(), o.2.as_str())).collect();
    assert_eq!(
        kinds,
        [
            ("tag", "create"),
            ("task", "create"),
            ("task_tag", "link"),
            ("task_tag", "unlink"), // undo, newest op first
            ("task", "delete"),
        ]
    );
    assert!(ops.iter().all(|o| o.5 == device));
    assert!(ops.windows(2).all(|w| w[0].3 < w[1].3), "HLC increases");
    assert_eq!(ops[1].1, t.id);
    assert_eq!(ops[1].4, ops[2].4, "create + link share a batch");
    assert_eq!(ops[3].4, ops[4].4, "the undo is one batch");
    assert_ne!(ops[2].4, ops[3].4);
}

// ---------------------------------------------------------------------------------------
// Wire format (what the UI sends through the generated bindings)

#[test]
fn commands_parse_from_the_ui_json_shape() {
    let mut s = store();
    let tag = add_tag(&mut s, "ui");
    let id = new_id();
    let json = serde_json::json!([
        { "type": "create_task", "task": { "id": id, "title": "From UI", "tag_ids": [tag.id] } },
        { "type": "update_task", "id": id, "changes": [
            { "priority": "urgent" },
            { "due_date": "2026-11-30" },
            { "estimate_min": null },
            { "status_id": IN_PROGRESS }
        ] },
        { "type": "update_task", "id": id, "changes": [{ "due_date": null }] },
        { "type": "set_parent", "id": id, "parent_id": null }
    ]);
    let commands: Vec<Command> = serde_json::from_value(json).unwrap();
    s.execute_all(commands).unwrap();
    let t = task(&s, &id);
    assert_eq!(t.priority, Priority::Urgent);
    assert_eq!(t.status_id, IN_PROGRESS);
    assert_eq!(t.due_date, None);
    assert_eq!(t.tag_ids, vec![tag.id]);

    let snapshot = serde_json::to_value(s.snapshot().unwrap()).unwrap();
    assert_eq!(snapshot["tasks"][0]["priority"], "urgent");
    assert_eq!(snapshot["statuses"][2]["category"], "in_progress");
}

#[test]
fn task_activity_lists_meaningful_changes_newest_first() {
    let mut s = store();
    let tag = add_tag(&mut s, "history");
    let t = add_task(&mut s, new_task("Track me"));
    s.execute(Command::UpdateTask {
        id: t.id.clone(),
        changes: vec![TaskChange::Title("Tracked".into())],
    })
    .unwrap();
    s.execute(Command::TagTask {
        task_id: t.id.clone(),
        tag_id: tag.id.clone(),
    })
    .unwrap();

    let activity = s.task_activity(&t.id, 50).unwrap();
    let kinds: Vec<&str> = activity.iter().map(|a| a.kind.as_str()).collect();
    assert_eq!(
        kinds,
        ["link", "update", "create"],
        "updated_at-only ops are skipped"
    );
    let title = &activity[1].fields;
    assert_eq!(title.len(), 1);
    assert_eq!(
        (
            title[0].field.as_str(),
            title[0].before.as_str(),
            title[0].after.as_str()
        ),
        ("title", "\"Track me\"", "\"Tracked\"")
    );
    assert_eq!(activity[0].fields[0].after, format!("\"{}\"", tag.id));
    assert!(activity[2].fields.is_empty(), "create lists no field diffs");
    assert!(activity[0].at > 0);
    assert_eq!(s.task_activity(&t.id, 1).unwrap().len(), 1);
}

// ---------------------------------------------------------------------------------------
// Board moves and rank rebalancing (M3)

/// The live task ids of a column, in board order.
fn column(s: &Store, status_id: &str) -> Vec<Id> {
    let mut tasks: Vec<Task> = s
        .snapshot()
        .unwrap()
        .tasks
        .into_iter()
        .filter(|t| t.status_id == status_id)
        .collect();
    tasks.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.id.cmp(&b.id)));
    tasks.into_iter().map(|t| t.id).collect()
}

/// The rank a UI computes for dropping `id` at `at` in `status_id` (neighbours exclude it).
fn drop_rank(s: &Store, id: &str, status_id: &str, at: usize) -> String {
    let snapshot = s.snapshot().unwrap();
    let rank_of = |tid: &str| {
        snapshot
            .tasks
            .iter()
            .find(|t| t.id == tid)
            .unwrap()
            .rank
            .clone()
    };
    let others: Vec<Id> = column(s, status_id)
        .into_iter()
        .filter(|t| t != id)
        .collect();
    let before = at.checked_sub(1).map(|i| rank_of(&others[i]));
    let after = others.get(at).map(|t| rank_of(t));
    rank::key_between(before.as_deref(), after.as_deref()).unwrap()
}

#[test]
fn long_rank_rebalances_the_column_in_the_same_undoable_batch() {
    let mut s = store();
    let first = add_task(&mut s, new_task("First"));
    let last = add_task(&mut s, new_task("Last"));
    let mut expected = vec![first.id.clone(), last.id.clone()];
    let mut rebalanced = false;
    // Keep dropping new cards right after `first`: the gap halves each time and keys grow.
    for i in 0..400 {
        let t = add_task(&mut s, new_task(&format!("Card {i}")));
        let rank = drop_rank(&s, &t.id, TODO, 1);
        let command = Command::MoveTask {
            id: t.id.clone(),
            status_id: TODO.into(),
            rank: rank.clone(),
        };
        expected.retain(|id| id != &t.id);
        expected.insert(1, t.id.clone());
        if rank.len() > MAX_RANK_LEN {
            let changes = roundtrip(&mut s, command);
            assert!(
                changes.tasks.len() > 2,
                "rebalance returns the whole column"
            );
            rebalanced = true;
        } else {
            s.execute(command).unwrap();
        }
        assert_eq!(column(&s, TODO), expected, "order after drop {i}");
        let snapshot = s.snapshot().unwrap();
        assert!(snapshot.tasks.iter().all(|t| t.rank.len() <= MAX_RANK_LEN));
        if rebalanced {
            break;
        }
    }
    assert!(rebalanced, "keys never grew past {MAX_RANK_LEN} chars");

    // The rebalance does not show up in other cards' activity.
    let activity = s.task_activity(&last.id, 50).unwrap();
    assert!(activity.iter().all(|a| a.kind == "create"), "{activity:?}");
}

/// Plan M3 "done when": 50 drags in a row never reorder wrongly, and undo reverts a drag.
#[test]
fn fifty_random_drags_match_a_reference_model() {
    let mut s = store();
    let statuses = [BACKLOG, TODO, IN_PROGRESS, DONE];
    for i in 0..12 {
        add_task(&mut s, new_task(&format!("Task {i}")));
    }
    let ids = column(&s, TODO);
    let mut model: Vec<Vec<Id>> = statuses.iter().map(|st| column(&s, st)).collect();
    let initial = s.snapshot().unwrap();

    let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = move |n: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        usize::try_from(seed % n as u64).unwrap()
    };
    let mut snapshots = vec![initial.clone()];
    for drag in 0..50 {
        let id = ids[next(ids.len())].clone();
        let to = next(statuses.len());
        for col in &mut model {
            col.retain(|t| t != &id);
        }
        let at = next(model[to].len() + 1);
        model[to].insert(at, id.clone());

        let rank = drop_rank(&s, &id, statuses[to], at);
        s.execute(Command::MoveTask {
            id,
            status_id: statuses[to].into(),
            rank,
        })
        .unwrap();
        for (st, col) in statuses.iter().zip(&model) {
            assert_eq!(&column(&s, st), col, "column {st} after drag {drag}");
        }
        snapshots.push(s.snapshot().unwrap());
    }

    // Each undo steps back exactly one drag.
    for expected in snapshots.iter().rev().skip(1) {
        s.undo().unwrap().expect("a drag to undo");
        assert_eq!(&s.snapshot().unwrap(), expected);
    }
    assert_eq!(s.snapshot().unwrap(), initial);
}

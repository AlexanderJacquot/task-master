//! Spaces (ADR 033, T1): routing commands between the personal and the team database,
//! Today picks on team tasks as personal marks, personal rows pointing at team rows,
//! undo across both, and sharing a project to the team.

use taskmaster_core::*;

fn spaces() -> Spaces {
    let mut spaces = Spaces::new(Store::open_in_memory().unwrap());
    spaces.attach_team(Store::open_in_memory().unwrap());
    spaces
}

fn add_project(s: &mut Spaces, name: &str, space: Space) -> Project {
    let project = NewProject {
        name: name.into(),
        ..NewProject::default()
    };
    s.execute(vec![Command::CreateProject { project }], Some(space))
        .unwrap()
        .projects
        .remove(0)
}

fn add_task(s: &mut Spaces, title: &str, project_id: Option<&str>) -> Task {
    let task = NewTask {
        title: title.into(),
        project_id: project_id.map(Into::into),
        ..NewTask::default()
    };
    s.execute(vec![Command::CreateTask { task }], None)
        .unwrap()
        .tasks
        .remove(0)
}

fn titles(snapshot: &Snapshot) -> Vec<String> {
    let mut out: Vec<String> = snapshot.tasks.iter().map(|t| t.title.clone()).collect();
    out.sort();
    out
}

#[test]
fn without_a_team_it_is_the_personal_store() {
    let mut s = Spaces::new(Store::open_in_memory().unwrap());
    let task = add_task(&mut s, "Mine", None);
    assert_eq!(titles(&s.snapshot().unwrap()), ["Mine"]);
    assert_eq!(s.team_snapshot().unwrap(), None);
    let err = s.execute(
        vec![Command::CreateTag {
            tag: NewTag {
                name: "x".into(),
                ..NewTag::default()
            },
        }],
        Some(Space::Team),
    );
    assert!(err.is_err(), "no team to write to");
    s.undo().unwrap().expect("undo");
    assert!(s.snapshot().unwrap().tasks.is_empty());
    s.redo().unwrap().expect("redo");
    assert_eq!(s.snapshot().unwrap().tasks[0].id, task.id);
}

#[test]
fn rows_follow_their_container() {
    let mut s = spaces();
    let team_project = add_project(&mut s, "Platform", Space::Team);
    let mine = add_project(&mut s, "Garden", Space::Personal);
    add_task(&mut s, "Ship the API", Some(&team_project.id));
    add_task(&mut s, "Plant tomatoes", Some(&mine.id));
    add_task(&mut s, "Inbox thing", None);

    assert_eq!(
        titles(&s.snapshot().unwrap()),
        ["Inbox thing", "Plant tomatoes"]
    );
    let team = s.team_snapshot().unwrap().unwrap();
    assert_eq!(titles(&team), ["Ship the API"]);
    assert_eq!(team.projects.len(), 1);

    // An edit goes where the row is.
    let api = team.tasks[0].clone();
    s.execute(
        vec![Command::UpdateTask {
            id: api.id.clone(),
            changes: vec![TaskChange::Title("Ship the v2 API".into())],
        }],
        None,
    )
    .unwrap();
    assert_eq!(
        s.team().unwrap().task(&api.id).unwrap().title,
        "Ship the v2 API"
    );
    assert_eq!(s.space_of(&api.id).unwrap(), Some(Space::Team));
    assert_eq!(s.space_of(&mine.id).unwrap(), Some(Space::Personal));
}

#[test]
fn a_team_row_cannot_point_at_a_personal_one() {
    let mut s = spaces();
    let mine = add_project(&mut s, "Garden", Space::Personal);
    let tag = s
        .execute(
            vec![Command::CreateTag {
                tag: NewTag {
                    name: "home".into(),
                    ..NewTag::default()
                },
            }],
            None,
        )
        .unwrap()
        .tags
        .remove(0);
    let team_project = add_project(&mut s, "Platform", Space::Team);
    let task = add_task(&mut s, "Ship", Some(&team_project.id));
    // A personal tag on a team task: the team database has no such tag.
    let err = s.execute(
        vec![Command::TagTask {
            task_id: task.id.clone(),
            tag_id: tag.id,
        }],
        None,
    );
    assert!(err.is_err());
    // Moving a team task into a personal project fails the same way.
    let err = s.execute(
        vec![Command::UpdateTask {
            id: task.id,
            changes: vec![TaskChange::ProjectId(Some(mine.id))],
        }],
        None,
    );
    assert!(err.is_err());
}

#[test]
fn today_on_a_team_task_is_a_personal_mark() {
    let mut s = spaces();
    let p = add_project(&mut s, "Platform", Space::Team);
    let task = add_task(&mut s, "Ship", Some(&p.id));
    let changes = s
        .execute(
            vec![Command::UpdateTask {
                id: task.id.clone(),
                changes: vec![
                    TaskChange::TodayOn(Some("2026-11-21".into())),
                    TaskChange::Priority(Priority::High),
                ],
            }],
            None,
        )
        .unwrap();
    // The front end gets the task back with its pick.
    let shown = changes.tasks.iter().find(|t| t.id == task.id).unwrap();
    assert_eq!(shown.today_on.as_deref(), Some("2026-11-21"));
    assert_eq!(shown.priority, Priority::High);
    // The team's row never carries it; the personal space holds the mark.
    assert_eq!(s.team().unwrap().task(&task.id).unwrap().today_on, None);
    assert_eq!(s.personal().task_marks().unwrap().len(), 1);
    let team = s.team_snapshot().unwrap().unwrap();
    assert_eq!(team.tasks[0].today_on.as_deref(), Some("2026-11-21"));

    // One undo takes back both parts.
    s.undo().unwrap().expect("undo");
    let team = s.team_snapshot().unwrap().unwrap();
    assert_eq!(team.tasks[0].today_on, None);
    assert_eq!(team.tasks[0].priority, task.priority);
    s.redo().unwrap().expect("redo");
    let team = s.team_snapshot().unwrap().unwrap();
    assert_eq!(team.tasks[0].today_on.as_deref(), Some("2026-11-21"));

    // Clearing it, then picking it again, reuses the mark.
    for today in [None, Some("2026-11-22".to_owned())] {
        s.execute(
            vec![Command::UpdateTask {
                id: task.id.clone(),
                changes: vec![TaskChange::TodayOn(today.clone())],
            }],
            None,
        )
        .unwrap();
        let team = s.team_snapshot().unwrap().unwrap();
        assert_eq!(team.tasks[0].today_on, today);
    }
}

#[test]
fn a_new_team_task_picked_for_today() {
    let mut s = spaces();
    let p = add_project(&mut s, "Platform", Space::Team);
    let task = NewTask {
        title: "Ship".into(),
        project_id: Some(p.id),
        today_on: Some("2026-11-21".into()),
        ..NewTask::default()
    };
    let changes = s.execute(vec![Command::CreateTask { task }], None).unwrap();
    assert_eq!(changes.tasks[0].today_on.as_deref(), Some("2026-11-21"));
    assert_eq!(
        s.team_snapshot().unwrap().unwrap().tasks[0]
            .today_on
            .as_deref(),
        Some("2026-11-21")
    );
}

#[test]
fn personal_rows_point_at_team_tasks() {
    let mut s = spaces();
    let p = add_project(&mut s, "Platform", Space::Team);
    let task = add_task(&mut s, "Ship", Some(&p.id));
    let start = 1_800_000_000_000;
    s.execute(
        vec![Command::CreateTimeBlock {
            block: NewTimeBlock {
                id: None,
                task_id: task.id.clone(),
                start_at: start,
                end_at: start + 3_600_000,
                outcome: None,
            },
        }],
        Some(Space::Team), // personal-only rows stay personal whatever the context
    )
    .unwrap();
    let note = NewNote {
        title: "Design".into(),
        task_id: Some(task.id.clone()),
        ..NewNote::default()
    };
    s.execute(vec![Command::CreateNote { note }], None).unwrap();

    let mine = s.snapshot().unwrap();
    assert_eq!(mine.time_blocks.len(), 1);
    assert_eq!(mine.notes.len(), 1);
    assert!(s.team_snapshot().unwrap().unwrap().time_blocks.is_empty());

    // A block on a task the team deleted is hidden, not deleted.
    s.execute(
        vec![Command::DeleteTask {
            id: task.id.clone(),
        }],
        None,
    )
    .unwrap();
    assert!(s.snapshot().unwrap().time_blocks.is_empty());
    s.undo().unwrap().expect("undo");
    assert_eq!(s.snapshot().unwrap().time_blocks.len(), 1);

    // A missing task is refused.
    let err = s.execute(
        vec![Command::CreateTimeBlock {
            block: NewTimeBlock {
                id: None,
                task_id: new_id(),
                start_at: start,
                end_at: start + 60_000,
                outcome: None,
            },
        }],
        None,
    );
    assert!(err.is_err());
}

#[test]
fn search_covers_both_spaces() {
    let mut s = spaces();
    let p = add_project(&mut s, "Platform", Space::Team);
    let team_task = add_task(&mut s, "Invoice export", Some(&p.id));
    let mine = add_task(&mut s, "Invoice the client", None);
    let ids = s.search("invoice", 10).unwrap();
    assert!(ids.contains(&team_task.id) && ids.contains(&mine.id));
    assert!(!s.task_activity(&team_task.id, 10).unwrap().is_empty());
}

#[test]
fn statuses_follow_the_named_space() {
    let mut s = spaces();
    let todo = s.snapshot().unwrap().statuses[1].clone();
    s.execute(
        vec![Command::UpdateStatus {
            id: todo.id.clone(),
            changes: vec![StatusChange::Name("Ready".into())],
        }],
        Some(Space::Team),
    )
    .unwrap();
    let team = s.team_snapshot().unwrap().unwrap();
    assert!(team.statuses.iter().any(|st| st.name == "Ready"));
    assert!(
        s.snapshot()
            .unwrap()
            .statuses
            .iter()
            .all(|st| st.name != "Ready")
    );
}

#[test]
fn sharing_a_project_moves_it_to_the_team() {
    let mut s = spaces();
    let p = add_project(&mut s, "Website", Space::Personal);
    let epic = s
        .execute(
            vec![Command::CreateEpic {
                epic: NewEpic {
                    name: "Launch".into(),
                    project_id: Some(p.id.clone()),
                    ..NewEpic::default()
                },
            }],
            None,
        )
        .unwrap()
        .epics
        .remove(0);
    let tag = s
        .execute(
            vec![Command::CreateTag {
                tag: NewTag {
                    name: "web".into(),
                    ..NewTag::default()
                },
            }],
            None,
        )
        .unwrap()
        .tags
        .remove(0);
    let parent = s
        .execute(
            vec![Command::CreateTask {
                task: NewTask {
                    title: "Landing page".into(),
                    project_id: Some(p.id.clone()),
                    epic_id: Some(epic.id.clone()),
                    today_on: Some("2026-11-21".into()),
                    tag_ids: vec![tag.id.clone()],
                    ..NewTask::default()
                },
            }],
            None,
        )
        .unwrap()
        .tasks
        .remove(0);
    let child = s
        .execute(
            vec![Command::CreateTask {
                task: NewTask {
                    title: "Hero copy".into(),
                    parent_id: Some(parent.id.clone()),
                    ..NewTask::default()
                },
            }],
            None,
        )
        .unwrap()
        .tasks
        .remove(0);
    let start = 1_800_000_000_000;
    s.execute(
        vec![Command::CreateTimeBlock {
            block: NewTimeBlock {
                id: None,
                task_id: parent.id.clone(),
                start_at: start,
                end_at: start + 3_600_000,
                outcome: None,
            },
        }],
        None,
    )
    .unwrap();
    s.execute(
        vec![Command::CreateNote {
            note: NewNote {
                title: "Brief".into(),
                task_id: Some(parent.id.clone()),
                ..NewNote::default()
            },
        }],
        None,
    )
    .unwrap();
    let other = add_task(&mut s, "Groceries", None);

    s.share_project(&p.id).unwrap();

    let mine = s.snapshot().unwrap();
    assert_eq!(titles(&mine), ["Groceries"]);
    assert!(mine.projects.is_empty() && mine.epics.is_empty() && mine.notes.is_empty());
    // The block stays personal and still shows: its task lives on in the team.
    assert_eq!(mine.time_blocks.len(), 1);

    let team = s.team_snapshot().unwrap().unwrap();
    assert_eq!(titles(&team), ["Hero copy", "Landing page"]);
    let moved = team.tasks.iter().find(|t| t.id == parent.id).unwrap();
    assert_eq!(moved.epic_id.as_deref(), Some(epic.id.as_str()));
    assert_eq!(moved.today_on.as_deref(), Some("2026-11-21"));
    assert_eq!(moved.tag_ids.len(), 1);
    assert_eq!(team.tags[0].name, "web");
    let moved_child = team.tasks.iter().find(|t| t.id == child.id).unwrap();
    assert_eq!(moved_child.parent_id.as_deref(), Some(parent.id.as_str()));
    assert_eq!(team.notes.len(), 1);
    assert_eq!(s.space_of(&parent.id).unwrap(), Some(Space::Team));
    assert_eq!(s.space_of(&other.id).unwrap(), Some(Space::Personal));

    // One undo brings it all back to the personal space.
    s.undo().unwrap().expect("undo");
    let mine = s.snapshot().unwrap();
    assert_eq!(titles(&mine), ["Groceries", "Hero copy", "Landing page"]);
    assert!(s.team_snapshot().unwrap().unwrap().tasks.is_empty());
    assert_eq!(s.space_of(&parent.id).unwrap(), Some(Space::Personal));
}

#[test]
fn leaving_the_team_keeps_personal_undo() {
    let mut s = spaces();
    let p = add_project(&mut s, "Platform", Space::Team);
    add_task(&mut s, "Ship", Some(&p.id));
    add_task(&mut s, "Mine", None);
    s.detach_team().expect("a team to leave");
    s.undo().unwrap().expect("the personal task");
    assert!(s.snapshot().unwrap().tasks.is_empty());
    assert_eq!(s.undo().unwrap(), None, "the team's part is forgotten");
}

#[test]
fn migration_keeps_rows_and_drops_task_keys() {
    // A personal row naming a task that is not in this database is accepted now.
    let mut store = Store::open_in_memory().unwrap();
    let mut linked = std::collections::HashSet::new();
    let foreign = new_id();
    linked.insert(foreign.clone());
    let start = 1_800_000_000_000;
    store
        .execute_linked(
            vec![Command::CreateTimeBlock {
                block: NewTimeBlock {
                    id: None,
                    task_id: foreign.clone(),
                    start_at: start,
                    end_at: start + 60_000,
                    outcome: None,
                },
            }],
            linked,
        )
        .unwrap();
    // Without the team listing it, the same block is refused.
    let err = store.execute(Command::CreateTimeBlock {
        block: NewTimeBlock {
            id: None,
            task_id: foreign,
            start_at: start,
            end_at: start + 60_000,
            outcome: None,
        },
    });
    assert!(err.is_err());
    // Notes still search after their table was rebuilt.
    store
        .execute(Command::CreateNote {
            note: NewNote {
                title: "Quarterly plan".into(),
                ..NewNote::default()
            },
        })
        .unwrap();
    assert_eq!(store.search_notes("quarterly", 5).unwrap().len(), 1);
}

#[test]
fn a_team_attachment_takes_its_file_along() {
    let dir = std::env::temp_dir().join(format!("tm-spaces-{}", new_id()));
    let mut s = Spaces::new(
        Store::open_in_memory()
            .unwrap()
            .with_files(dir.join("personal")),
    );
    s.attach_team(
        Store::open_in_memory()
            .unwrap()
            .with_files(dir.join("team")),
    );
    let p = add_project(&mut s, "Platform", Space::Team);
    let task = add_task(&mut s, "Spec", Some(&p.id));
    // The desktop stores a picked file in the personal folder, then attaches it.
    let stored = s.personal().files().unwrap().put_bytes(b"spec").unwrap();
    s.execute(
        vec![Command::CreateAttachment {
            attachment: NewAttachment {
                id: None,
                task_id: Some(task.id),
                meeting_id: None,
                note_id: None,
                hash: stored.hash.clone(),
                name: "spec.txt".into(),
                mime: None,
                size: 4,
            },
        }],
        None,
    )
    .unwrap();
    assert!(s.team().unwrap().files().unwrap().contains(&stored.hash));
    assert_eq!(s.team_snapshot().unwrap().unwrap().attachments.len(), 1);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn changes_say_which_rows_are_the_teams() {
    let mut s = spaces();
    let p = add_project(&mut s, "Platform", Space::Team);
    let changes = s
        .execute(
            vec![
                Command::CreateTask {
                    task: NewTask {
                        title: "Team".into(),
                        project_id: Some(p.id.clone()),
                        ..NewTask::default()
                    },
                },
                Command::CreateTask {
                    task: NewTask {
                        title: "Mine".into(),
                        ..NewTask::default()
                    },
                },
            ],
            None,
        )
        .unwrap();
    let team = changes.tasks.iter().find(|t| t.title == "Team").unwrap();
    let mine = changes.tasks.iter().find(|t| t.title == "Mine").unwrap();
    assert!(changes.team_ids.contains(&team.id));
    assert!(!changes.team_ids.contains(&mine.id));
    // Undoing it reports the same.
    let undone = s.undo().unwrap().unwrap();
    assert!(undone.team_ids.contains(&team.id));
    assert!(!undone.team_ids.contains(&mine.id));
}

#[test]
fn a_tag_made_for_a_team_task_is_the_teams() {
    let mut s = spaces();
    let p = add_project(&mut s, "Platform", Space::Team);
    let task = add_task(&mut s, "Ship", Some(&p.id));
    let tag_id = new_id();
    s.execute(
        vec![
            Command::CreateTag {
                tag: NewTag {
                    id: Some(tag_id.clone()),
                    name: "backend".into(),
                    color: None,
                },
            },
            Command::TagTask {
                task_id: task.id.clone(),
                tag_id: tag_id.clone(),
            },
        ],
        None,
    )
    .unwrap();
    assert_eq!(s.space_of(&tag_id).unwrap(), Some(Space::Team));
    assert_eq!(s.team().unwrap().task(&task.id).unwrap().tag_ids, [tag_id]);
}

//! Comments and notices (ADR 033, T5): comments on tasks with their authors, editing only
//! one's own in a team space, and mentions and assignments by teammates as notices.

use taskmaster_core::*;

const ADA: &str = "01a1fe00-0000-7000-8000-00000000ada0";
const BOB: &str = "01a1fe00-0000-7000-8000-00000000b0b0";

fn team_store(author: &str) -> Store {
    let mut store = Store::open_in_memory().unwrap();
    store.set_author(Some(author.into()));
    for (id, name) in [(ADA, "Ada"), (BOB, "Bob")] {
        store
            .execute_without_undo(vec![Command::CreateMember {
                member: NewMember {
                    id: id.into(),
                    name: name.into(),
                    color: None,
                },
            }])
            .unwrap();
    }
    store
}

fn add_task(s: &mut Store, title: &str) -> Task {
    s.execute(Command::CreateTask {
        task: NewTask {
            title: title.into(),
            ..NewTask::default()
        },
    })
    .unwrap()
    .tasks
    .remove(0)
}

fn comment(s: &mut Store, task_id: &str, body: &str) -> Comment {
    s.execute(Command::CreateComment {
        comment: NewComment {
            id: None,
            task_id: task_id.into(),
            body: body.into(),
        },
    })
    .unwrap()
    .comments
    .remove(0)
}

/// Bob's store with everything Ada's has.
fn bob_from(ada: &Store) -> Store {
    let mut bob = Store::open_in_memory().unwrap();
    bob.set_author(Some(BOB.into()));
    let page = ada.ops_after(0, 1000).unwrap();
    bob.apply_remote(page.ops, None).unwrap();
    bob
}

#[test]
fn comments_carry_their_author_and_undo() {
    let mut ada = team_store(ADA);
    let task = add_task(&mut ada, "Ship");
    let c = comment(&mut ada, &task.id, "  Looks good  ");
    assert_eq!(c.body, "Looks good");
    assert_eq!(c.author_id.as_deref(), Some(ADA));
    assert_eq!(ada.snapshot().unwrap().comments.len(), 1);
    ada.undo().unwrap().expect("undo");
    assert!(ada.snapshot().unwrap().comments.is_empty());
    assert!(
        ada.execute(Command::CreateComment {
            comment: NewComment {
                id: None,
                task_id: task.id,
                body: "   ".into(),
            },
        })
        .is_err()
    );
}

#[test]
fn only_the_author_changes_a_team_comment() {
    let mut ada = team_store(ADA);
    let task = add_task(&mut ada, "Ship");
    let c = comment(&mut ada, &task.id, "First draft");
    let mut bob = bob_from(&ada);
    assert!(
        bob.execute(Command::UpdateComment {
            id: c.id.clone(),
            body: "Edited by Bob".into(),
        })
        .is_err()
    );
    assert!(
        bob.execute(Command::DeleteComment { id: c.id.clone() })
            .is_err()
    );
    ada.execute(Command::UpdateComment {
        id: c.id.clone(),
        body: "Second draft".into(),
    })
    .unwrap();
    ada.execute(Command::DeleteComment { id: c.id }).unwrap();
    assert!(ada.snapshot().unwrap().comments.is_empty());
}

#[test]
fn a_deleted_task_hides_its_comments() {
    let mut s = Store::open_in_memory().unwrap();
    let task = add_task(&mut s, "Mine");
    let c = comment(&mut s, &task.id, "Note to self");
    assert_eq!(c.author_id, None);
    s.execute(Command::DeleteTask { id: task.id }).unwrap();
    assert!(s.snapshot().unwrap().comments.is_empty());
}

#[test]
fn notices_list_what_teammates_did_for_me() {
    let mut ada = team_store(ADA);
    let task = add_task(&mut ada, "Ship");
    let other = add_task(&mut ada, "Other");
    comment(&mut ada, &task.id, "@bob can you review?");
    comment(&mut ada, &other.id, "No mention here");
    ada.execute(Command::UpdateTask {
        id: other.id.clone(),
        changes: vec![TaskChange::AssigneeId(Some(BOB.into()))],
    })
    .unwrap();

    let mut bob = bob_from(&ada);
    // Bob's own mention of himself is no news.
    comment(&mut bob, &task.id, "@Bob reminder");
    let notices = bob.notices(0, 10).unwrap();
    let kinds: Vec<(&str, &str)> = notices
        .iter()
        .map(|n| (n.kind.as_str(), n.task_id.as_deref().unwrap_or_default()))
        .collect();
    assert_eq!(
        kinds,
        [
            ("assigned", other.id.as_str()),
            ("mention", task.id.as_str())
        ]
    );
    assert!(notices.iter().all(|n| n.author_id == ADA));
    // Only what came after the last one seen.
    let newest = notices[0].seq;
    assert!(bob.notices(newest, 10).unwrap().is_empty());
    // Ada gets none: nobody else did anything.
    assert!(ada.notices(0, 10).unwrap().is_empty());
    // Without an author (a personal space) there are none.
    assert!(
        Store::open_in_memory()
            .unwrap()
            .notices(0, 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn mentions_in_descriptions_notes_and_edited_comments_are_notices() {
    let mut ada = team_store(ADA);
    let task = add_task(&mut ada, "Ship");
    let describe = |s: &mut Store, text: &str| {
        s.execute(Command::UpdateTask {
            id: task.id.clone(),
            changes: vec![TaskChange::Description(text.into())],
        })
        .unwrap();
    };
    describe(&mut ada, "Needs @Bob for the review");
    // Editing elsewhere in a text that already mentions Bob is no news.
    describe(&mut ada, "Needs @Bob for the review, by Friday");
    let note = ada
        .execute(Command::CreateNote {
            note: NewNote {
                title: "Plan".into(),
                body: "Ask @bob about it".into(),
                ..NewNote::default()
            },
        })
        .unwrap()
        .notes
        .remove(0);
    let c = comment(&mut ada, &task.id, "Looks fine");
    ada.execute(Command::UpdateComment {
        id: c.id.clone(),
        body: "Looks fine, @Bob?".into(),
    })
    .unwrap();

    let bob = bob_from(&ada);
    let notices = bob.notices(0, 10).unwrap();
    let got: Vec<_> = notices
        .iter()
        .map(|n| {
            (
                n.kind.as_str(),
                n.task_id.as_deref(),
                n.comment_id.as_deref(),
                n.note_id.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            ("mention", Some(task.id.as_str()), Some(c.id.as_str()), None),
            ("mention", None, None, Some(note.id.as_str())),
            ("mention", Some(task.id.as_str()), None, None),
        ]
    );

    // A deleted note drops out.
    ada.execute(Command::DeleteNote { id: note.id }).unwrap();
    let bob = bob_from(&ada);
    assert_eq!(bob.notices(0, 10).unwrap().len(), 2);
}

#[test]
fn comments_follow_their_task_into_the_team_space() {
    let mut s = Spaces::new(Store::open_in_memory().unwrap());
    s.attach_team(team_store(ADA));
    let project = s
        .execute(
            vec![Command::CreateProject {
                project: NewProject {
                    name: "Platform".into(),
                    ..NewProject::default()
                },
            }],
            Some(Space::Team),
        )
        .unwrap()
        .projects
        .remove(0);
    let task = s
        .execute(
            vec![Command::CreateTask {
                task: NewTask {
                    title: "Ship".into(),
                    project_id: Some(project.id),
                    ..NewTask::default()
                },
            }],
            None,
        )
        .unwrap()
        .tasks
        .remove(0);
    let changes = s
        .execute(
            vec![Command::CreateComment {
                comment: NewComment {
                    id: None,
                    task_id: task.id,
                    body: "Hi".into(),
                },
            }],
            None,
        )
        .unwrap();
    assert!(changes.team_ids.contains(&changes.comments[0].id));
    assert_eq!(s.team_snapshot().unwrap().unwrap().comments.len(), 1);
    assert!(s.snapshot().unwrap().comments.is_empty());
}

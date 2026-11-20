//! Notes (ADR 032): notes and folders with undo, validation, moves between folders, the
//! task a note is attached to, sync between replicas and export/import.

use taskmaster_core::*;

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

fn add_note(s: &mut Store, note: NewNote) -> Note {
    s.execute(Command::CreateNote { note })
        .unwrap()
        .notes
        .remove(0)
}

fn note(title: &str) -> NewNote {
    NewNote {
        title: title.into(),
        ..NewNote::default()
    }
}

fn add_folder(s: &mut Store, name: &str) -> NoteFolder {
    let folder = NewNoteFolder {
        name: name.into(),
        ..NewNoteFolder::default()
    };
    s.execute(Command::CreateNoteFolder { folder })
        .unwrap()
        .note_folders
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
    let task = add_task(&mut s, "Write the spec");
    let changes = roundtrip(
        &mut s,
        Command::CreateNote {
            note: NewNote {
                title: "  Meeting\n notes ".into(),
                body: "See [the spec](task:x)".into(),
                task_id: Some(task.id.clone()),
                ..NewNote::default()
            },
        },
    );
    let n = &changes.notes[0];
    assert_eq!(n.title, "Meeting notes", "whitespace is tidied");
    assert_eq!(n.task_id.as_deref(), Some(task.id.as_str()));
    assert_eq!(n.folder_id, None);
    assert_eq!(s.snapshot().unwrap().notes, vec![n.clone()]);

    let updated = roundtrip(
        &mut s,
        Command::UpdateNote {
            id: n.id.clone(),
            changes: vec![
                NoteChange::Title(String::new()),
                NoteChange::Body("# Hello".into()),
                NoteChange::TaskId(None),
            ],
        },
    );
    let u = &updated.notes[0];
    assert_eq!((u.title.as_str(), u.body.as_str()), ("", "# Hello"));
    assert_eq!(u.task_id, None);

    roundtrip(&mut s, Command::DeleteNote { id: n.id.clone() });
    assert!(s.snapshot().unwrap().notes.is_empty());
}

#[test]
fn new_notes_go_to_the_end_of_their_folder() {
    let mut s = store();
    let folder = add_folder(&mut s, "Ideas");
    let a = add_note(&mut s, note("a"));
    let b = add_note(&mut s, note("b"));
    let c = add_note(
        &mut s,
        NewNote {
            folder_id: Some(folder.id.clone()),
            ..note("c")
        },
    );
    assert!(a.rank < b.rank);
    assert_eq!(c.folder_id.as_deref(), Some(folder.id.as_str()));

    // Moving without a rank appends to the new folder.
    let moved = s
        .execute(Command::UpdateNote {
            id: a.id.clone(),
            changes: vec![NoteChange::FolderId(Some(folder.id.clone()))],
        })
        .unwrap()
        .notes
        .remove(0);
    assert_eq!(moved.folder_id.as_deref(), Some(folder.id.as_str()));
    assert!(moved.rank > c.rank);

    // A rank given with the move is kept.
    let first = rank::key_between(None, Some(&c.rank)).unwrap();
    let placed = s
        .execute(Command::UpdateNote {
            id: b.id.clone(),
            changes: vec![
                NoteChange::FolderId(Some(folder.id.clone())),
                NoteChange::Rank(first.clone()),
            ],
        })
        .unwrap()
        .notes
        .remove(0);
    assert_eq!(placed.rank, first);
}

#[test]
fn deleting_a_folder_moves_its_notes_to_the_top_level() {
    let mut s = store();
    let top = add_note(&mut s, note("top"));
    let folder = add_folder(&mut s, "Work");
    let inside: Vec<Note> = ["one", "two"]
        .iter()
        .map(|t| {
            add_note(
                &mut s,
                NewNote {
                    folder_id: Some(folder.id.clone()),
                    ..note(t)
                },
            )
        })
        .collect();
    let changes = roundtrip(
        &mut s,
        Command::DeleteNoteFolder {
            id: folder.id.clone(),
        },
    );
    assert!(changes.note_folders[0].deleted_at.is_some());
    let snap = s.snapshot().unwrap();
    assert!(snap.note_folders.is_empty());
    let order: Vec<&str> = snap.notes.iter().map(|n| n.title.as_str()).collect();
    assert_eq!(
        order,
        ["top", "one", "two"],
        "kept in order, after the top level"
    );
    assert!(snap.notes.iter().all(|n| n.folder_id.is_none()));
    assert_eq!(snap.notes[0].id, top.id);
    assert_eq!(snap.notes[1].id, inside[0].id);
}

#[test]
fn folders_rename_and_reorder() {
    let mut s = store();
    let a = add_folder(&mut s, "A");
    let b = add_folder(&mut s, "B");
    assert!(a.rank < b.rank);
    let first = rank::key_between(None, Some(&a.rank)).unwrap();
    roundtrip(
        &mut s,
        Command::UpdateNoteFolder {
            id: b.id.clone(),
            changes: vec![
                NoteFolderChange::Name("  Before  A ".into()),
                NoteFolderChange::Rank(first),
            ],
        },
    );
    let names: Vec<String> = s
        .snapshot()
        .unwrap()
        .note_folders
        .into_iter()
        .map(|f| f.name)
        .collect();
    assert_eq!(names, ["Before A", "A"]);
}

#[test]
fn rejects_bad_notes_and_folders() {
    let mut s = store();
    let folder = add_folder(&mut s, "F");
    let gone = add_task(&mut s, "Gone");
    s.execute(Command::DeleteTask {
        id: gone.id.clone(),
    })
    .unwrap();

    assert!(matches!(
        s.execute(Command::CreateNote {
            note: NewNote {
                task_id: Some(gone.id.clone()),
                ..note("x")
            }
        }),
        Err(Error::NotFound { .. })
    ));
    assert!(matches!(
        s.execute(Command::CreateNote {
            note: NewNote {
                folder_id: Some(new_id()),
                ..note("x")
            }
        }),
        Err(Error::NotFound { .. })
    ));
    let long = "x".repeat(MAX_NOTE_TITLE_CHARS + 1);
    assert!(invalid(s.execute(Command::CreateNote { note: note(&long) })).contains("title"));
    let huge = NewNote {
        body: "é".repeat(MAX_NOTE_BODY_CHARS + 1),
        ..note("big")
    };
    assert!(invalid(s.execute(Command::CreateNote { note: huge })).contains("at most"));
    // Within the limit in characters though longer in bytes.
    let multibyte = NewNote {
        body: "é".repeat(MAX_NOTE_BODY_CHARS / 2 + 1),
        ..note("ok")
    };
    s.execute(Command::CreateNote { note: multibyte }).unwrap();

    assert!(
        invalid(s.execute(Command::CreateNoteFolder {
            folder: NewNoteFolder {
                name: "   ".into(),
                ..NewNoteFolder::default()
            }
        }))
        .contains("empty")
    );
    assert!(
        invalid(s.execute(Command::UpdateNoteFolder {
            id: folder.id.clone(),
            changes: vec![],
        }))
        .contains("at least one")
    );
    s.execute(Command::DeleteNoteFolder {
        id: folder.id.clone(),
    })
    .unwrap();
    assert!(matches!(
        s.execute(Command::DeleteNoteFolder { id: folder.id }),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn notes_outlive_their_task() {
    let mut s = store();
    let task = add_task(&mut s, "T");
    let n = add_note(
        &mut s,
        NewNote {
            task_id: Some(task.id.clone()),
            ..note("About T")
        },
    );
    s.execute(Command::DeleteTask { id: task.id }).unwrap();
    assert_eq!(s.snapshot().unwrap().notes, vec![n]);
}

#[test]
fn notes_sync_between_replicas() {
    let mut server = store();
    let mut a = store();
    let mut b = store();
    let folder = add_folder(&mut a, "Shared");
    let n = add_note(
        &mut a,
        NewNote {
            folder_id: Some(folder.id.clone()),
            ..note("Sync me")
        },
    );
    for device in [&mut a, &mut b] {
        sync(device, &mut server);
    }
    let snap = b.snapshot().unwrap();
    assert_eq!(snap.note_folders, vec![folder]);
    assert_eq!(snap.notes, vec![n.clone()]);

    // Concurrent edits of different fields both land.
    a.execute(Command::UpdateNote {
        id: n.id.clone(),
        changes: vec![NoteChange::Body("from a".into())],
    })
    .unwrap();
    b.execute(Command::UpdateNote {
        id: n.id.clone(),
        changes: vec![NoteChange::Title("Renamed on b".into())],
    })
    .unwrap();
    sync(&mut a, &mut server);
    sync(&mut b, &mut server);
    sync(&mut a, &mut server);
    for replica in [&a, &b] {
        let got = replica.snapshot().unwrap().notes.remove(0);
        assert_eq!(
            (got.title.as_str(), got.body.as_str()),
            ("Renamed on b", "from a")
        );
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
fn export_and_import_carry_notes() {
    let mut source = store();
    let folder = add_folder(&mut source, "F");
    let n = add_note(
        &mut source,
        NewNote {
            folder_id: Some(folder.id.clone()),
            body: "body".into(),
            ..note("Export me")
        },
    );
    let file = source.export().unwrap();

    let mut target = store();
    let summary = target.import(&file).unwrap();
    assert_eq!(summary.notes, 1);
    let snap = target.snapshot().unwrap();
    assert_eq!(snap.notes, vec![n]);
    assert_eq!(snap.note_folders, vec![folder]);
}

struct TempDir(std::path::PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("taskmaster-notes-{}", new_id()));
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
fn search_finds_notes_by_title_and_body() {
    let mut s = store();
    let plan = add_note(
        &mut s,
        NewNote {
            title: "Launch plan".into(),
            body: "Budget approved by finance.\n\nNext: the press kit.".into(),
            ..NewNote::default()
        },
    );
    let other = add_note(
        &mut s,
        NewNote {
            title: "Groceries".into(),
            body: "Bread, launch snacks".into(),
            ..NewNote::default()
        },
    );

    let hits = s.search_notes("budg", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].note_id, plan.id);
    assert!(hits[0].snippet.contains("[Budget]"), "{}", hits[0].snippet);

    // Every word must match; a title match ranks first.
    let both = s.search_notes("launch", 10).unwrap();
    assert_eq!(
        both.iter().map(|h| h.note_id.as_str()).collect::<Vec<_>>(),
        [plan.id.as_str(), other.id.as_str()]
    );
    assert_eq!(s.search_notes("launch bread", 10).unwrap().len(), 1);
    assert!(s.search_notes("  ", 10).unwrap().is_empty());
    assert!(s.search_notes("\"quoted", 10).unwrap().is_empty());

    // Edits are indexed; deleted notes are not found, and come back with undo.
    s.execute(Command::UpdateNote {
        id: other.id.clone(),
        changes: vec![NoteChange::Body("Milk".into())],
    })
    .unwrap();
    assert_eq!(s.search_notes("launch", 10).unwrap().len(), 1);
    assert_eq!(s.search_notes("milk", 10).unwrap().len(), 1);
    s.execute(Command::DeleteNote {
        id: plan.id.clone(),
    })
    .unwrap();
    assert!(s.search_notes("budget", 10).unwrap().is_empty());
    s.undo().unwrap();
    assert_eq!(s.search_notes("budget", 10).unwrap().len(), 1);
}

#[test]
fn notes_take_attachments_hidden_with_them() {
    let dir = TempDir::new();
    let mut s = Store::open_in_memory()
        .unwrap()
        .with_files(dir.0.join("attachments"));
    let page = add_note(&mut s, note("Diagram"));
    let stored = s.files().unwrap().put_bytes(b"png bytes").unwrap();
    let attach = |note_id: Option<String>, task_id: Option<String>| Command::CreateAttachment {
        attachment: NewAttachment {
            id: None,
            task_id,
            meeting_id: None,
            note_id,
            hash: stored.hash.clone(),
            name: "sketch.png".into(),
            mime: None,
            size: stored.size,
        },
    };
    let created = roundtrip(&mut s, attach(Some(page.id.clone()), None));
    let attachment = created.attachments[0].clone();
    assert_eq!(attachment.note_id.as_deref(), Some(page.id.as_str()));
    assert_eq!(attachment.task_id, None);
    assert_eq!(attachment.mime, "image/png");
    assert!(
        created.notes[0].updated_at >= page.updated_at,
        "the note is touched"
    );
    assert!(s.file_in_use(&stored.hash).unwrap());

    let task = add_task(&mut s, "T");
    assert!(
        invalid(s.execute(attach(Some(page.id.clone()), Some(task.id)))).contains("exactly one")
    );

    // Renaming and removing work as for a task's files.
    s.execute(Command::UpdateAttachment {
        id: attachment.id.clone(),
        changes: vec![AttachmentChange::Name("plan.png".into())],
    })
    .unwrap();
    s.undo().unwrap();

    s.execute(Command::DeleteNote {
        id: page.id.clone(),
    })
    .unwrap();
    assert!(s.snapshot().unwrap().attachments.is_empty());
    assert!(
        !s.file_in_use(&stored.hash).unwrap(),
        "purgeable once hidden"
    );
    s.undo().unwrap();
    assert_eq!(s.snapshot().unwrap().attachments, vec![attachment.clone()]);

    // A deleted note takes no new files.
    s.execute(Command::DeleteNote {
        id: page.id.clone(),
    })
    .unwrap();
    assert!(matches!(
        s.execute(attach(Some(page.id), None)),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn note_attachments_sync_and_export() {
    let dir = TempDir::new();
    let mut a = Store::open_in_memory()
        .unwrap()
        .with_files(dir.0.join("attachments"));
    let mut server = store();
    let page = add_note(&mut a, note("Shared"));
    let stored = a.files().unwrap().put_bytes(b"abc").unwrap();
    a.execute(Command::CreateAttachment {
        attachment: NewAttachment {
            id: None,
            task_id: None,
            meeting_id: None,
            note_id: Some(page.id.clone()),
            hash: stored.hash.clone(),
            name: "notes.txt".into(),
            mime: None,
            size: stored.size,
        },
    })
    .unwrap();
    sync(&mut a, &mut server);
    let there = server.snapshot().unwrap();
    assert_eq!(there.attachments.len(), 1);
    assert_eq!(
        there.attachments[0].note_id.as_deref(),
        Some(page.id.as_str())
    );
    assert_eq!(
        server.search_notes("shared", 5).unwrap().len(),
        1,
        "indexed on arrival"
    );

    let file = a.export().unwrap();
    let mut b = store();
    b.import(&file).unwrap();
    assert_eq!(
        b.snapshot().unwrap().attachments,
        a.snapshot().unwrap().attachments
    );
    assert_eq!(
        b.search_notes("shared", 5).unwrap().len(),
        1,
        "indexed on import"
    );
}

//! Attachments (ADR 011): rows through commands with undo, content in a FileStore,
//! backups, export/import of the files, and the activity feed.

use std::path::PathBuf;

use taskmaster_core::*;

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("taskmaster-attach-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn store(dir: &TempDir) -> Store {
    Store::open_in_memory()
        .unwrap()
        .with_files(dir.0.join("attachments"))
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

fn attach(s: &mut Store, task_id: &str, name: &str, bytes: &[u8]) -> Attachment {
    let stored = s.files().unwrap().put_bytes(bytes).unwrap();
    let attachment = NewAttachment {
        id: None,
        task_id: task_id.into(),
        hash: stored.hash,
        name: name.into(),
        mime: None,
        size: stored.size,
    };
    s.execute(Command::CreateAttachment { attachment })
        .unwrap()
        .attachments
        .remove(0)
}

fn invalid<T: std::fmt::Debug>(result: Result<T>) -> String {
    match result {
        Err(Error::Invalid(message)) => message,
        other => panic!("expected an invalid error, got {other:?}"),
    }
}

#[test]
fn attaching_renaming_and_detaching_roundtrip_through_undo() {
    let dir = TempDir::new();
    let mut s = store(&dir);
    let task = add_task(&mut s, "Bug report");
    let before = s.snapshot().unwrap();

    let shot = attach(&mut s, &task.id, "C:\\shots\\Screen.PNG", b"png bytes");
    assert_eq!(shot.name, "Screen.PNG", "folders are stripped");
    assert_eq!(shot.mime, "image/png", "guessed from the name");
    assert_eq!(shot.size, 9);
    assert_eq!(
        s.snapshot().unwrap().attachments,
        std::slice::from_ref(&shot)
    );
    assert!(
        s.snapshot().unwrap().tasks[0].updated_at >= task.updated_at,
        "the task is touched"
    );
    assert!(s.attachment_path(&shot.id).unwrap().is_file());

    s.undo().unwrap();
    assert_eq!(s.snapshot().unwrap(), before);
    s.redo().unwrap();
    assert_eq!(
        s.snapshot().unwrap().attachments,
        std::slice::from_ref(&shot)
    );

    let renamed = s
        .execute(Command::UpdateAttachment {
            id: shot.id.clone(),
            changes: vec![AttachmentChange::Name("login-bug.png".into())],
        })
        .unwrap();
    assert_eq!(renamed.attachments[0].name, "login-bug.png");
    assert_eq!(renamed.tasks.len(), 1, "the task comes back touched");

    s.execute(Command::DeleteAttachment {
        id: shot.id.clone(),
    })
    .unwrap();
    assert!(s.snapshot().unwrap().attachments.is_empty());
    assert!(
        s.attachment_path(&shot.id).is_ok(),
        "the content stays for undo"
    );
    s.undo().unwrap();
    assert_eq!(s.snapshot().unwrap().attachments[0].name, "login-bug.png");
}

#[test]
fn the_same_content_is_stored_once() {
    let dir = TempDir::new();
    let mut s = store(&dir);
    let a = add_task(&mut s, "A");
    let b = add_task(&mut s, "B");
    let one = attach(&mut s, &a.id, "logo.png", b"same");
    let two = attach(&mut s, &b.id, "copy.png", b"same");
    assert_eq!(one.hash, two.hash);
    assert_ne!(one.id, two.id);
    assert_eq!(s.files().unwrap().hashes().unwrap().len(), 1);
}

#[test]
fn attachments_follow_their_task_through_delete_and_undo() {
    let dir = TempDir::new();
    let mut s = store(&dir);
    let task = add_task(&mut s, "Has a file");
    attach(&mut s, &task.id, "notes.txt", b"hi");
    s.execute(Command::DeleteTask {
        id: task.id.clone(),
    })
    .unwrap();
    assert!(
        s.snapshot().unwrap().attachments.is_empty(),
        "hidden with the task"
    );
    s.undo().unwrap();
    assert_eq!(s.snapshot().unwrap().attachments.len(), 1);
}

#[test]
fn bad_attachments_are_refused() {
    let dir = TempDir::new();
    let mut s = store(&dir);
    let task = add_task(&mut s, "T");
    let stored = s.files().unwrap().put_bytes(b"x").unwrap();
    let good = NewAttachment {
        id: None,
        task_id: task.id.clone(),
        hash: stored.hash.clone(),
        name: "x.bin".into(),
        mime: Some("application/x-custom".into()),
        size: 1,
    };

    let unstored = NewAttachment {
        hash: "a".repeat(64),
        ..good.clone()
    };
    assert!(
        invalid(s.execute(Command::CreateAttachment {
            attachment: unstored
        }))
        .contains("no stored file")
    );

    let not_a_hash = NewAttachment {
        hash: "../../etc/passwd".into(),
        ..good.clone()
    };
    assert!(
        s.execute(Command::CreateAttachment {
            attachment: not_a_hash
        })
        .is_err()
    );

    let too_big = NewAttachment {
        size: MAX_ATTACHMENT_BYTES + 1,
        ..good.clone()
    };
    assert!(
        invalid(s.execute(Command::CreateAttachment {
            attachment: too_big
        }))
        .contains("50 MB")
    );

    let missing_task = NewAttachment {
        task_id: new_id(),
        ..good.clone()
    };
    assert!(matches!(
        s.execute(Command::CreateAttachment {
            attachment: missing_task
        }),
        Err(Error::NotFound { .. })
    ));

    let bad_mime = NewAttachment {
        mime: Some("text/html; evil".into()),
        ..good.clone()
    };
    let created = s
        .execute(Command::CreateAttachment {
            attachment: bad_mime,
        })
        .unwrap();
    assert_eq!(
        created.attachments[0].mime, "application/octet-stream",
        "an odd type falls back to the name's"
    );

    let kept = s
        .execute(Command::CreateAttachment { attachment: good })
        .unwrap();
    assert_eq!(kept.attachments[0].mime, "application/x-custom");

    let rename_empty = Command::UpdateAttachment {
        id: kept.attachments[0].id.clone(),
        changes: vec![AttachmentChange::Name("  ".into())],
    };
    assert!(s.execute(rename_empty).is_err());

    // A store without a file folder cannot attach anything.
    let mut bare = Store::open_in_memory().unwrap();
    let t = add_task(&mut bare, "T");
    let attachment = NewAttachment {
        id: None,
        task_id: t.id,
        hash: stored.hash,
        name: "x".into(),
        mime: None,
        size: 1,
    };
    assert!(
        bare.execute(Command::CreateAttachment { attachment })
            .is_err()
    );
}

#[test]
fn activity_lists_attach_rename_and_detach() {
    let dir = TempDir::new();
    let mut s = store(&dir);
    let task = add_task(&mut s, "T");
    let a = attach(&mut s, &task.id, "plan.pdf", b"%PDF");
    s.execute(Command::UpdateAttachment {
        id: a.id.clone(),
        changes: vec![AttachmentChange::Name("plan-v2.pdf".into())],
    })
    .unwrap();
    s.execute(Command::DeleteAttachment { id: a.id }).unwrap();

    let feed = s.task_activity(&task.id, 10).unwrap();
    let kinds: Vec<(&str, &str, &str)> = feed
        .iter()
        .map(|e| {
            (
                e.kind.as_str(),
                e.fields[0].before.as_str(),
                e.fields[0].after.as_str(),
            )
        })
        .take(3)
        .collect();
    assert_eq!(
        kinds,
        [
            ("detach", "null", "\"plan-v2.pdf\""),
            ("rename_attachment", "\"plan.pdf\"", "\"plan-v2.pdf\""),
            ("attach", "null", "\"plan.pdf\""),
        ]
    );
    assert_eq!(feed.last().unwrap().kind, "create");
}

#[test]
fn files_live_next_to_the_database_and_are_mirrored_into_backups() {
    let dir = TempDir::new();
    let db = dir.0.join("data/task-master.sqlite");
    let mut s = Store::open(&db).unwrap();
    let task = add_task(&mut s, "T");
    let a = attach(&mut s, &task.id, "a.txt", b"a");
    assert!(dir.0.join("data/attachments").join(&a.hash).is_file());

    let backups = dir.0.join("data/backups");
    s.daily_backup(&backups, "2026-11-05", 14).unwrap();
    assert!(backups.join("attachments").join(&a.hash).is_file());
    // Later files are mirrored even when today's database backup already exists.
    let b = attach(&mut s, &task.id, "b.txt", b"b");
    assert!(
        s.daily_backup(&backups, "2026-11-05", 14)
            .unwrap()
            .is_none()
    );
    assert!(backups.join("attachments").join(&b.hash).is_file());
}

#[test]
fn export_and_import_carry_rows_and_files() {
    let dir = TempDir::new();
    let mut source = store(&dir);
    let task = add_task(&mut source, "With files");
    let a = attach(&mut source, &task.id, "a.png", b"image");
    let file = source.export().unwrap();
    let exported = dir.0.join("export-attachments");
    assert_eq!(source.export_files_to(&exported).unwrap(), 1);

    let other = TempDir::new();
    let mut target = store(&other);
    target.import(&file).unwrap();
    assert_eq!(
        target.missing_files().unwrap(),
        std::slice::from_ref(&a.hash)
    );
    assert_eq!(target.import_files_from(&exported).unwrap(), 1);
    assert!(target.missing_files().unwrap().is_empty());
    assert_eq!(target.snapshot().unwrap(), source.snapshot().unwrap());
    assert!(target.attachment_path(&a.id).unwrap().is_file());
}

#[test]
fn attachment_commands_parse_from_the_ui_json_shape() {
    let json = r#"[
        {"type": "create_attachment", "attachment": {"id": null, "task_id": "t", "hash": "h",
          "name": "a.png", "mime": "image/png", "size": 3}},
        {"type": "update_attachment", "id": "a", "changes": [{"name": "b.png"}]},
        {"type": "delete_attachment", "id": "a"}
    ]"#;
    let commands: Vec<Command> = serde_json::from_str(json).unwrap();
    assert_eq!(commands.len(), 3);
}

// Settings → Files (ADR 023): listing, purging and dropping content purged elsewhere.

#[test]
fn stored_files_list_size_and_use() {
    let dir = TempDir::new();
    let mut s = store(&dir);
    let task = add_task(&mut s, "Report");
    let used = attach(&mut s, &task.id, "used.txt", b"used content");
    let gone = attach(&mut s, &task.id, "gone.txt", b"gone");
    s.execute(Command::DeleteAttachment {
        id: gone.id.clone(),
    })
    .unwrap();

    let mut files = s.stored_files().unwrap();
    files.sort_by_key(|f| f.size);
    assert_eq!(files.len(), 2);
    assert_eq!(
        (files[0].hash.as_str(), files[0].size),
        (gone.hash.as_str(), 4)
    );
    assert!(!files[0].in_use, "only a deleted attachment uses it");
    assert_eq!(
        (files[1].hash.as_str(), files[1].size),
        (used.hash.as_str(), 12)
    );
    assert!(files[1].in_use);
    assert!(files[1].stored_at > 0);
}

#[test]
fn purging_removes_unused_content_and_marks_it() {
    let dir = TempDir::new();
    let mut s = store(&dir);
    let task = add_task(&mut s, "Report");
    let used = attach(&mut s, &task.id, "used.txt", b"used content");
    let gone = attach(&mut s, &task.id, "gone.txt", b"gone");
    s.execute(Command::DeleteAttachment {
        id: gone.id.clone(),
    })
    .unwrap();

    let report = s
        .purge_files(&[gone.hash.clone(), used.hash.clone()])
        .unwrap();
    assert_eq!(
        report,
        PurgeReport {
            removed: 1,
            freed_bytes: 4,
            in_use: 1
        }
    );
    let files = s.files().unwrap();
    assert!(!files.contains(&gone.hash));
    assert!(
        files.contains(&used.hash),
        "a live attachment keeps its file"
    );
    assert_eq!(files.purged().unwrap(), vec![gone.hash.clone()]);
    assert_eq!(
        files.hashes().unwrap(),
        vec![used.hash.clone()],
        "markers are not files"
    );

    // Undo brings the attachment back without its content.
    s.undo().unwrap();
    assert_eq!(s.snapshot().unwrap().attachments.len(), 2);
    assert_eq!(s.missing_files().unwrap(), vec![gone.hash.clone()]);

    // Storing the same content again clears the purge.
    s.files().unwrap().put_bytes(b"gone").unwrap();
    assert!(s.files().unwrap().purged().unwrap().is_empty());
    assert!(invalid(s.purge_files(&["nope".into()])).contains("not a file hash"));
}

#[test]
fn files_of_deleted_tasks_can_be_purged() {
    let dir = TempDir::new();
    let mut s = store(&dir);
    let task = add_task(&mut s, "Old");
    let file = attach(&mut s, &task.id, "big.bin", b"big");
    assert!(s.file_in_use(&file.hash).unwrap());
    s.execute(Command::DeleteTask {
        id: task.id.clone(),
    })
    .unwrap();
    assert!(!s.file_in_use(&file.hash).unwrap());
    assert_eq!(
        s.purge_files(std::slice::from_ref(&file.hash))
            .unwrap()
            .removed,
        1
    );
}

#[test]
fn content_purged_elsewhere_is_dropped_unless_used_here() {
    let dir = TempDir::new();
    let mut s = store(&dir);
    let task = add_task(&mut s, "Report");
    let used = attach(&mut s, &task.id, "used.txt", b"used content");
    let gone = attach(&mut s, &task.id, "gone.txt", b"gone");
    s.execute(Command::DeleteAttachment {
        id: gone.id.clone(),
    })
    .unwrap();

    let removed = s
        .drop_purged(&[gone.hash.clone(), used.hash.clone(), "x".into()])
        .unwrap();
    assert_eq!(removed, 1);
    assert!(!s.files().unwrap().contains(&gone.hash));
    assert!(s.files().unwrap().contains(&used.hash));
    assert!(
        s.files().unwrap().purged().unwrap().is_empty(),
        "dropping a copy is not a new purge to send"
    );
}

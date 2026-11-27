//! The phone's reads and edits beyond the walking skeleton (docs/ios-plan.md P2–P6):
//! navigation, saved views, boards, task detail, search, field edits, ordering, subtasks,
//! undo and redo, time blocks, reminders, attachments, the app's life cycle, notes and new
//! projects.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use taskmaster_core::{
    Command, Layout, NewEpic, NewProject, NewView, Store, VIEW_SPEC_VERSION, ViewScope, ViewSpec,
};
use taskmaster_mobile::{
    AppError, Core, Day, EpicStage, ListRow, NewNoteInput, NewProjectInput, NewTaskInput, NoteEdit,
    NoteLinkKind, Outcome, Placement, Priority, ReminderKind, Scope, Stage, TaskEdit, TaskRow,
    ViewLayout,
};

fn temp_dir(label: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("tm-plumbing-{label}-{}", taskmaster_core::new_id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn day() -> Day {
    Day {
        today: "2026-11-20".into(),
        utc_offset_min: 60,
    }
}

fn open(dir: &Path) -> Arc<Core> {
    Core::open(dir.to_string_lossy().into_owned(), "Phone".into()).unwrap()
}

fn tasks(rows: &[ListRow]) -> Vec<&TaskRow> {
    rows.iter()
        .filter_map(|r| match r {
            ListRow::Task { task } => Some(task),
            ListRow::Group { .. } => None,
        })
        .collect()
}

fn titles(app: &Core, scope: Scope) -> Vec<String> {
    tasks(&app.list(scope, day()).unwrap())
        .into_iter()
        .map(|t| t.title.clone())
        .collect()
}

fn add(app: &Core, title: &str) -> String {
    app.add_task(
        NewTaskInput {
            title: title.into(),
            ..NewTaskInput::default()
        },
        day(),
    )
    .unwrap()
}

/// What the desktop made before the phone joined: an area with a child project, epics,
/// and a saved board. Written by a second connection, as a desktop's sync would.
struct Seeded {
    home: String,
    garden: String,
    spring: String,
    loose: String,
    view: String,
}

fn seed(dir: &Path) -> Seeded {
    let mut store = Store::open(dir.join("tasks.sqlite")).unwrap();
    let mut make = |command: Command| store.execute(command).unwrap();
    let home = make(Command::CreateProject {
        project: NewProject {
            name: "Home".into(),
            color: Some("#aa0000".into()),
            ..NewProject::default()
        },
    })
    .projects[0]
        .id
        .clone();
    let garden = make(Command::CreateProject {
        project: NewProject {
            name: "Garden".into(),
            parent_id: Some(home.clone()),
            ..NewProject::default()
        },
    })
    .projects[0]
        .id
        .clone();
    let spring = make(Command::CreateEpic {
        epic: NewEpic {
            name: "Spring planting".into(),
            project_id: Some(garden.clone()),
            target_date: Some("2027-03-01".into()),
            ..NewEpic::default()
        },
    })
    .epics[0]
        .id
        .clone();
    let loose = make(Command::CreateEpic {
        epic: NewEpic {
            name: "Someday".into(),
            ..NewEpic::default()
        },
    })
    .epics[0]
        .id
        .clone();
    let view = make(Command::CreateView {
        view: NewView {
            id: None,
            name: "Garden board".into(),
            spec: ViewSpec {
                version: VIEW_SPEC_VERSION,
                scope: ViewScope::Project { id: garden.clone() },
                filter: Default::default(),
                group_by: Default::default(),
                sort: Default::default(),
                layout: Layout::Board,
                swimlane: Default::default(),
                show_subtasks: false,
                show_cancelled: false,
                show_agent_tasks: false,
                lineage: None,
                show_closed_lanes: false,
                roadmap: None,
            },
            rank: None,
        },
    })
    .views[0]
        .id
        .clone();
    Seeded {
        home,
        garden,
        spring,
        loose,
        view,
    }
}

#[test]
fn navigation_lists_projects_epics_tags_views_and_counts() {
    let dir = temp_dir("nav");
    let seeded = seed(&dir);
    let app = open(&dir);
    let weed = add(&app, "Weed the beds");
    let seeds = add(&app, "Order seeds");
    app.add_task(
        NewTaskInput {
            title: "Buy bulbs".into(),
            due_date: Some("2026-11-18".into()),
            ..NewTaskInput::default()
        },
        day(),
    )
    .unwrap();
    app.edit_task(
        weed.clone(),
        vec![TaskEdit::Project {
            id: Some(seeded.garden.clone()),
        }],
        day(),
    )
    .unwrap();
    app.edit_task(
        seeds.clone(),
        vec![
            TaskEdit::Project {
                id: Some(seeded.garden.clone()),
            },
            TaskEdit::Epic {
                id: Some(seeded.spring.clone()),
            },
            TaskEdit::Today { on: true },
        ],
        day(),
    )
    .unwrap();
    let tag = app.create_tag("#outside".into(), None).unwrap();
    assert_eq!(
        app.create_tag("Outside".into(), None).unwrap(),
        tag,
        "no duplicate"
    );
    app.set_tags(weed.clone(), vec![tag.clone()]).unwrap();

    let nav = app.navigation(day()).unwrap();
    // Inbox: the one without a project; Today: picked plus overdue.
    assert_eq!(
        (nav.counts.inbox, nav.counts.today, nav.counts.overdue),
        (1, 2, 1)
    );
    let projects: Vec<_> = nav
        .projects
        .iter()
        .map(|p| (p.name.as_str(), p.depth, p.open))
        .collect();
    assert_eq!(projects, [("Home", 0, 0), ("Garden", 1, 2)]);
    assert_eq!(nav.projects[0].id, seeded.home);
    assert_eq!(nav.projects[0].color.as_deref(), Some("#aa0000"));
    assert_eq!(nav.projects[1].parent_id.as_deref(), Some(&*seeded.home));
    let spring = &nav.projects[1].epics[0];
    assert_eq!(
        (spring.name.as_str(), spring.state, spring.open, spring.done),
        ("Spring planting", EpicStage::Active, 1, 0)
    );
    assert_eq!(spring.target_date.as_deref(), Some("2027-03-01"));
    assert_eq!(nav.loose_epics[0].id, seeded.loose);
    assert_eq!(
        nav.tags
            .iter()
            .map(|t| (t.name.as_str(), t.open))
            .collect::<Vec<_>>(),
        [("outside", 1)]
    );
    assert_eq!(nav.views[0].name, "Garden board");
    assert_eq!(nav.views[0].layout, ViewLayout::Board);
    let stages: Vec<_> = nav.statuses.iter().map(|s| s.stage).collect();
    assert!(stages.contains(&Stage::Backlog) && stages.contains(&Stage::Done));

    // Lists by project, epic, tag and saved view.
    assert_eq!(
        titles(
            &app,
            Scope::Project {
                id: seeded.garden.clone()
            }
        )
        .len(),
        2
    );
    assert_eq!(
        titles(
            &app,
            Scope::Epic {
                id: seeded.spring.clone()
            }
        ),
        ["Order seeds"]
    );
    assert_eq!(titles(&app, Scope::Tag { id: tag }), ["Weed the beds"]);
    assert_eq!(
        titles(
            &app,
            Scope::View {
                id: seeded.view.clone()
            }
        )
        .len(),
        2
    );
    let gone = app
        .list(
            Scope::View {
                id: taskmaster_core::new_id(),
            },
            day(),
        )
        .unwrap_err();
    assert!(matches!(gone, AppError::NotFound { .. }), "{gone:?}");

    // The saved board: a column per status, cancelled left out as on the desktop.
    let board = app.board(Scope::View { id: seeded.view }, day()).unwrap();
    let shown: Vec<_> = nav
        .statuses
        .iter()
        .filter(|s| s.stage != Stage::Cancelled)
        .map(|s| s.id.clone())
        .collect();
    assert_eq!(
        board
            .iter()
            .map(|c| c.status.id.clone())
            .collect::<Vec<_>>(),
        shown
    );
    let todo = board
        .iter()
        .find(|c| c.status.stage == Stage::Todo)
        .unwrap();
    assert_eq!(todo.count, 2);
    assert_eq!(todo.cards.len(), 2);
}

#[test]
fn detail_edits_subtasks_and_activity() {
    let dir = temp_dir("detail");
    let seeded = seed(&dir);
    let app = open(&dir);
    let nav = app.navigation(day()).unwrap();
    let in_progress = nav
        .statuses
        .iter()
        .find(|s| s.stage == Stage::InProgress)
        .unwrap()
        .id
        .clone();
    let task = add(&app, "Plan the garden");
    let blocker = add(&app, "Measure the beds");
    app.edit_task(
        task.clone(),
        vec![
            TaskEdit::Title {
                value: "  Plan the vegetable garden ".into(),
            },
            TaskEdit::Description {
                value: "Rows **north** to south".into(),
            },
            TaskEdit::Priority {
                value: Priority::Urgent,
            },
            TaskEdit::DueDate {
                value: Some("2026-12-01".into()),
            },
            TaskEdit::Today { on: true },
            TaskEdit::Estimate { minutes: Some(45) },
            TaskEdit::Project {
                id: Some(seeded.garden.clone()),
            },
            TaskEdit::Epic {
                id: Some(seeded.spring.clone()),
            },
            TaskEdit::Status {
                id: in_progress.clone(),
            },
        ],
        day(),
    )
    .unwrap();
    let blank = app
        .edit_task(
            task.clone(),
            vec![TaskEdit::Title { value: " ".into() }],
            day(),
        )
        .unwrap_err();
    assert!(matches!(blank, AppError::Invalid { .. }));

    // A subtask takes its parent's project and epic.
    let sub = app
        .add_task(
            NewTaskInput {
                title: "Buy stakes".into(),
                parent_id: Some(task.clone()),
                ..NewTaskInput::default()
            },
            day(),
        )
        .unwrap();
    add(&app, "Draw a map");
    let map = app.search("map".into(), day()).unwrap()[0].id.clone();
    app.set_parent(map.clone(), Some(task.clone())).unwrap();
    app.set_done(sub.clone(), true).unwrap();

    let d = app.task(task.clone(), day()).unwrap();
    assert_eq!(d.row.title, "Plan the vegetable garden");
    assert_eq!(d.description, "Rows **north** to south");
    assert_eq!(d.row.priority, Priority::Urgent);
    assert_eq!(d.row.due_date.as_deref(), Some("2026-12-01"));
    assert!(d.row.today);
    assert_eq!(d.today_on.as_deref(), Some("2026-11-20"));
    assert_eq!(d.estimate_min, Some(45));
    assert_eq!(d.row.project_name.as_deref(), Some("Garden"));
    assert_eq!(d.epic_name.as_deref(), Some("Spring planting"));
    assert_eq!(d.row.stage, Stage::InProgress);
    assert_eq!(d.status_id, in_progress);
    assert_eq!((d.row.child_count, d.row.child_done), (2, 1));
    let subs: Vec<_> = d.subtasks.iter().map(|s| s.title.as_str()).collect();
    assert_eq!(subs, ["Buy stakes", "Draw a map"]);
    assert!(!d.by_agent);
    let s = app.task(sub.clone(), day()).unwrap();
    assert_eq!(s.parent.as_ref().map(|p| p.id.as_str()), Some(&*task));
    assert_eq!(s.row.project_name.as_deref(), Some("Garden"));
    assert_eq!(s.epic_id.as_deref(), Some(&*seeded.spring));
    assert_eq!(s.row.stage, Stage::Done);
    assert!(s.completed_at.is_some());

    // Taking a subtask out again; the blocker shows on the detail.
    app.set_parent(map, None).unwrap();
    assert_eq!(app.task(task.clone(), day()).unwrap().subtasks.len(), 1);
    assert!(app.task(blocker, day()).unwrap().blocked_by.is_empty());

    // Activity, newest first.
    let feed = app.activity(task.clone(), 50).unwrap();
    assert_eq!(feed.last().unwrap().kind, "create");
    assert!(
        feed.iter()
            .any(|a| a.fields.iter().any(|f| f.field == "title")),
        "{feed:?}"
    );

    // Search matches words by prefix, in title and description.
    let hits: Vec<_> = app
        .search("north".into(), day())
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(hits, std::slice::from_ref(&task));
    assert!(app.search("  ".into(), day()).unwrap().is_empty());

    let missing = app.task(taskmaster_core::new_id(), day()).unwrap_err();
    assert!(matches!(missing, AppError::NotFound { .. }));
}

#[test]
fn reorder_move_between_statuses_delete_undo_and_redo() {
    let dir = temp_dir("order");
    let app = open(&dir);
    assert!(!app.undo_state().can_undo);
    let a = add(&app, "A");
    let b = add(&app, "B");
    let c = add(&app, "C");
    let order = |app: &Core| titles(app, Scope::Inbox);
    assert_eq!(order(&app), ["A", "B", "C"]);

    // C between A and B; then A after C (neighbours given either way round).
    app.move_task(
        c.clone(),
        Placement {
            after_id: Some(a.clone()),
            before_id: Some(b.clone()),
            ..Placement::default()
        },
    )
    .unwrap();
    assert_eq!(order(&app), ["A", "C", "B"]);
    app.move_task(
        a.clone(),
        Placement {
            after_id: Some(b.clone()),
            before_id: Some(c.clone()),
            ..Placement::default()
        },
    )
    .unwrap();
    assert_eq!(order(&app), ["C", "A", "B"]);
    // To the top.
    app.move_task(
        b.clone(),
        Placement {
            before_id: Some(c.clone()),
            ..Placement::default()
        },
    )
    .unwrap();
    assert_eq!(order(&app), ["B", "C", "A"]);

    // Into another column of the board.
    let doing = app
        .navigation(day())
        .unwrap()
        .statuses
        .into_iter()
        .find(|s| s.stage == Stage::InProgress)
        .unwrap();
    app.move_task(
        a.clone(),
        Placement {
            status_id: Some(doing.id.clone()),
            ..Placement::default()
        },
    )
    .unwrap();
    let board = app.board(Scope::Inbox, day()).unwrap();
    let column = board.iter().find(|c| c.status.id == doing.id).unwrap();
    assert_eq!(column.cards[0].id, a);

    // Delete, undo, redo.
    app.delete_task(c.clone()).unwrap();
    assert!(!order(&app).contains(&"C".to_owned()));
    assert!(app.undo().unwrap());
    assert!(order(&app).contains(&"C".to_owned()));
    assert!(app.undo_state().can_redo);
    assert!(app.redo().unwrap());
    assert!(!order(&app).contains(&"C".to_owned()));
    assert!(!app.redo().unwrap());

    // Tags: exactly the set given, as one edit.
    let x = app.create_tag("x".into(), None).unwrap();
    let y = app.create_tag("y".into(), None).unwrap();
    app.set_tags(b.clone(), vec![x.clone(), y.clone()]).unwrap();
    app.set_tags(b.clone(), vec![y.clone()]).unwrap();
    let tags: Vec<_> = app
        .task(b.clone(), day())
        .unwrap()
        .tags
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(tags, [y]);
    assert!(app.undo().unwrap());
    assert_eq!(app.task(b, day()).unwrap().tags.len(), 2);
    assert!(matches!(
        app.create_tag(" # ".into(), None).unwrap_err(),
        AppError::Invalid { .. }
    ));
}

#[test]
fn time_blocks_and_reminders() {
    let dir = temp_dir("plan");
    let app = open(&dir);
    let task = app
        .add_task(
            NewTaskInput {
                title: "Prune the roses".into(),
                due_date: Some("2026-11-21".into()),
                ..NewTaskInput::default()
            },
            day(),
        )
        .unwrap();
    let done = app
        .add_task(
            NewTaskInput {
                title: "Already done".into(),
                due_date: Some("2026-11-21".into()),
                ..NewTaskInput::default()
            },
            day(),
        )
        .unwrap();
    app.set_done(done.clone(), true).unwrap();

    // 2026-11-20 at UTC+1: midnight is 2026-11-19 23:00 UTC.
    let midnight = 1_795_129_200_000_i64;
    let hour = 3_600_000_i64;
    let block = app
        .schedule(task.clone(), midnight + 10 * hour, midnight + 11 * hour)
        .unwrap();
    // One crossing midnight into the 21st, and one on a done task.
    app.schedule(task.clone(), midnight + 23 * hour, midnight + 25 * hour)
        .unwrap();
    app.schedule(done, midnight + 12 * hour, midnight + 13 * hour)
        .unwrap();
    let bad = app.schedule(task.clone(), midnight, midnight).unwrap_err();
    assert!(matches!(bad, AppError::Invalid { .. }));

    let today = app.day_blocks("2026-11-20".into(), day()).unwrap();
    assert_eq!(today.len(), 3);
    assert_eq!(today[0].id, block);
    assert_eq!(today[0].title, "Prune the roses");
    assert_eq!(today[0].outcome, Outcome::Planned);
    assert_eq!(app.day_blocks("2026-11-21".into(), day()).unwrap().len(), 1);
    assert!(matches!(
        app.day_blocks("tomorrow".into(), day()).unwrap_err(),
        AppError::Invalid { .. }
    ));

    app.move_block(block.clone(), midnight + 9 * hour, midnight + 10 * hour)
        .unwrap();
    app.set_block_outcome(block.clone(), Outcome::Worked)
        .unwrap();
    let moved = &app.day_blocks("2026-11-20".into(), day()).unwrap()[0];
    assert_eq!(
        (moved.start_at, moved.outcome),
        (midnight + 9 * hour, Outcome::Worked)
    );
    assert_eq!(app.task(task.clone(), day()).unwrap().blocks.len(), 2);

    // Reminders over two days: the due date at 9:00 and the planned block of the open
    // task; not the worked block, nor anything of the done task.
    let reminders = app
        .reminders(midnight, midnight + 48 * hour, 9 * 60, day())
        .unwrap();
    let got: Vec<_> = reminders
        .iter()
        .map(|r| (r.kind, (r.at - midnight) / hour))
        .collect();
    assert_eq!(got, [(ReminderKind::Block, 23), (ReminderKind::Due, 33)]);
    assert_eq!(reminders[1].key, format!("due:{task}:2026-11-21"));
    assert!(
        app.reminders(midnight, midnight + hour, 9 * 60, day())
            .unwrap()
            .is_empty()
    );

    app.unschedule(block).unwrap();
    assert_eq!(app.day_blocks("2026-11-20".into(), day()).unwrap().len(), 2);
}

#[test]
fn attachments_and_life_cycle() {
    let dir = temp_dir("files");
    let app = open(&dir);
    let task = add(&app, "Fix the fence");
    let photo = dir.join("IMG_0001.jpeg");
    std::fs::write(&photo, b"not really a jpeg").unwrap();

    let id = app
        .attach_file(
            task.clone(),
            photo.to_string_lossy().into_owned(),
            String::new(),
        )
        .unwrap();
    std::fs::remove_file(&photo).unwrap();
    let detail = app.task(task.clone(), day()).unwrap();
    assert_eq!(detail.attachments.len(), 1);
    let item = &detail.attachments[0];
    assert_eq!(
        (
            item.name.as_str(),
            item.mime.as_str(),
            item.size,
            item.on_device
        ),
        ("IMG_0001.jpeg", "image/jpeg", 17, true)
    );
    let file = app.attachment(id.clone()).unwrap();
    assert!(file.on_device);
    assert_eq!(std::fs::read(&file.path).unwrap(), b"not really a jpeg");
    assert!(
        matches!(
            app.fetch_attachment(id.clone()).unwrap_err(),
            AppError::Invalid { .. }
        ),
        "no server to fetch from"
    );
    app.remove_attachment(id.clone()).unwrap();
    assert!(app.task(task, day()).unwrap().attachments.is_empty());

    // Going to the background empties the write-ahead log; coming back picks up what
    // another process (a widget, the share extension) wrote.
    app.suspend().unwrap();
    assert_eq!(
        std::fs::metadata(dir.join("tasks.sqlite-wal"))
            .unwrap()
            .len(),
        0
    );
    {
        let mut other = Store::open(dir.join("tasks.sqlite")).unwrap();
        other
            .execute(Command::CreateTask {
                task: taskmaster_core::NewTask {
                    title: "From the share sheet".into(),
                    ..taskmaster_core::NewTask::default()
                },
            })
            .unwrap();
    }
    app.resume().unwrap();
    assert!(titles(&app, Scope::Inbox).contains(&"From the share sheet".to_owned()));
}

#[test]
fn sign_in_needs_a_connected_oidc_server() {
    let dir = temp_dir("signin");
    let app = open(&dir);
    let refused = app
        .sign_in("taskmaster://oidc/callback".into())
        .err()
        .unwrap();
    assert!(matches!(refused, AppError::Invalid { .. }), "{refused:?}");
}

#[test]
fn rows_carry_what_the_lists_draw() {
    let dir = temp_dir("rows");
    let seeded = seed(&dir);
    let app = open(&dir);
    app.resume().unwrap();
    let id = app
        .capture("Sow the beans #seeds #Garden @Garden".into(), day())
        .unwrap();
    app.edit_task(
        id.clone(),
        vec![
            TaskEdit::Epic {
                id: Some(seeded.spring.clone()),
            },
            TaskEdit::Estimate { minutes: Some(45) },
        ],
        day(),
    )
    .unwrap();
    let rows = app
        .list(
            Scope::Project {
                id: seeded.garden.clone(),
            },
            day(),
        )
        .unwrap();
    let row = tasks(&rows)
        .into_iter()
        .find(|t| t.id == id)
        .unwrap()
        .clone();
    assert_eq!(row.project_name.as_deref(), Some("Garden"));
    assert_eq!(row.epic_id.as_deref(), Some(seeded.spring.as_str()));
    assert_eq!(row.epic_name.as_deref(), Some("Spring planting"));
    assert_eq!(row.estimate_min, Some(45));
    // Alphabetical, whatever the case.
    assert_eq!(row.tags, vec!["Garden".to_string(), "seeds".to_string()]);
    assert!(row.created_at > 0);
}

#[test]
fn the_composer_previews_a_line_and_captures_for_today() {
    let dir = temp_dir("composer");
    seed(&dir);
    let app = open(&dir);
    app.resume().unwrap();

    let preview = app
        .preview_capture(
            "Call the plumber #home @Home @Nowhere !high ^tomorrow +epic:Someday".into(),
            day(),
        )
        .unwrap();
    assert_eq!(preview.title, "Call the plumber");
    assert_eq!(preview.tags.len(), 1);
    assert_eq!(preview.tags[0].name, "home");
    assert!(!preview.tags[0].known, "a new tag");
    // The last project marker wins, and nothing is called that.
    let project = preview.project.unwrap();
    assert_eq!(project.name, "Nowhere");
    assert!(!project.known);
    assert!(preview.epic.unwrap().known);
    assert_eq!(preview.priority, Some(Priority::High));
    assert_eq!(preview.due_date.as_deref(), Some("2026-11-21"));
    // Half typed: a bare marker is read as text, not an error.
    let half = app.preview_capture("Buy milk ^".into(), day()).unwrap();
    assert_eq!(half.title, "Buy milk ^");
    assert_eq!(half.due_date, None);

    let inbox = app
        .capture_to("For later".into(), day(), false, None)
        .unwrap();
    let today = app
        .capture_to("For now @Home".into(), day(), true, None)
        .unwrap();
    assert_eq!(titles(&app, Scope::Inbox), vec!["For later".to_string()]);
    let picked = app.list(Scope::Today, day()).unwrap();
    let picked = tasks(&picked);
    assert_eq!(picked.len(), 1);
    assert_eq!(picked[0].id, today);
    assert!(picked[0].today);
    assert_ne!(inbox, today);
    // One undo takes the whole capture back.
    app.undo().unwrap();
    assert!(titles(&app, Scope::Today).is_empty());

    // The composer's project picker files a line that names no project of its own; a
    // marker in the line wins over it.
    let nav = app.navigation(day()).unwrap();
    let id_of = |name: &str| {
        nav.projects
            .iter()
            .find(|p| p.name == name)
            .unwrap()
            .id
            .clone()
    };
    let (home, garden) = (id_of("Home"), id_of("Garden"));
    let picked = app
        .capture_to("Prune the roses".into(), day(), false, Some(garden.clone()))
        .unwrap();
    let typed = app
        .capture_to(
            "Fix the gate @Home".into(),
            day(),
            false,
            Some(garden.clone()),
        )
        .unwrap();
    let in_garden = app
        .list(Scope::Project { id: garden.clone() }, day())
        .unwrap();
    assert!(tasks(&in_garden).iter().any(|t| t.id == picked));
    let in_home = app.list(Scope::Project { id: home }, day()).unwrap();
    assert!(tasks(&in_home).iter().any(|t| t.id == typed));
    assert!(!titles(&app, Scope::Inbox).contains(&"Prune the roses".to_string()));
}

#[test]
fn notes_in_folders_with_links_files_and_search() {
    let dir = temp_dir("notes");
    let seeded = seed(&dir);
    let app = open(&dir);
    app.resume().unwrap();
    let boiler = add(&app, "Call the plumber");
    let radiators = add(&app, "Bleed the radiators");

    let home = app.create_note_folder("  Home ".into()).unwrap();
    let ideas = app.create_note_folder("Ideas".into()).unwrap();
    assert!(matches!(
        app.create_note_folder(" ".into()).unwrap_err(),
        AppError::Invalid { .. }
    ));
    let first = app
        .create_note(NewNoteInput {
            title: "Boiler and heating".into(),
            body: format!(
                "# Model\nVaillant ecoTEC 832.\n- [ ] Clear the cupboard\n\
                 See [Bleed the radiators](task:{radiators}) for [Home](project:{}).",
                seeded.home
            ),
            folder_id: Some(home.clone()),
            task_id: Some(boiler.clone()),
        })
        .unwrap();
    let second = app
        .create_note(NewNoteInput {
            folder_id: Some(home.clone()),
            ..NewNoteInput::default()
        })
        .unwrap();
    let loose = app
        .create_note(NewNoteInput {
            title: "Books to read".into(),
            body: "*Piranesi*, then the rest".into(),
            ..NewNoteInput::default()
        })
        .unwrap();

    // Folder by folder in their order, then the notes outside any; each in its order.
    let all = app.notes().unwrap();
    let folders: Vec<_> = all
        .folders
        .iter()
        .map(|f| (f.name.as_str(), f.count))
        .collect();
    assert_eq!(folders, vec![("Home", 2), ("Ideas", 0)]);
    let ids: Vec<_> = all.notes.iter().map(|n| n.id.clone()).collect();
    assert_eq!(ids, vec![first.clone(), second.clone(), loose.clone()]);
    assert_eq!(all.notes[0].snippet, "Model");
    assert_eq!(all.notes[0].task.as_ref().unwrap().id, boiler);
    assert_eq!(all.notes[1].title, "", "a blank title stays blank");
    assert_eq!(all.notes[2].snippet, "Piranesi, then the rest");

    // In full: the folder, the attached task, and what its links point at now.
    app.edit_task(
        radiators.clone(),
        vec![TaskEdit::Title {
            value: "Bleed every radiator".into(),
        }],
        day(),
    )
    .unwrap();
    let note = app.note(first.clone()).unwrap();
    assert_eq!(note.folder_name.as_deref(), Some("Home"));
    assert_eq!(note.task.unwrap().title, "Call the plumber");
    let links: Vec<_> = note
        .links
        .iter()
        .map(|l| (l.kind, l.title.as_str(), l.url.clone()))
        .collect();
    assert_eq!(
        links,
        vec![
            (
                NoteLinkKind::Task,
                "Bleed every radiator",
                format!("task:{radiators}")
            ),
            (
                NoteLinkKind::Project,
                "Home",
                format!("project:{}", seeded.home)
            ),
        ]
    );
    assert_eq!(note.links[1].color.as_deref(), Some("#aa0000"));

    // A task lists the notes attached to it, then those linking to it.
    let of = |task: &str| -> Vec<String> {
        app.task_notes(task.to_owned())
            .unwrap()
            .into_iter()
            .map(|n| n.id)
            .collect()
    };
    assert_eq!(of(&boiler), vec![first.clone()]);
    assert_eq!(of(&radiators), vec![first.clone()]);
    app.edit_note(
        loose.clone(),
        vec![NoteEdit::Task {
            id: Some(radiators.clone()),
        }],
    )
    .unwrap();
    assert_eq!(of(&radiators), vec![loose.clone(), first.clone()]);

    // Edits: title and text in one step; moving to a folder puts it at the end.
    app.edit_note(
        second.clone(),
        vec![
            NoteEdit::Title {
                value: "Garden plan".into(),
            },
            NoteEdit::Body {
                value: "Roses along the fence".into(),
            },
        ],
    )
    .unwrap();
    app.edit_note(
        loose.clone(),
        vec![NoteEdit::Folder {
            id: Some(ideas.clone()),
        }],
    )
    .unwrap();
    let moved = app.note(loose.clone()).unwrap();
    assert_eq!(moved.folder_name.as_deref(), Some("Ideas"));
    assert!(app.undo().unwrap());
    assert_eq!(app.note(loose.clone()).unwrap().folder_id, None);

    // Search reads titles and text.
    let found: Vec<_> = app
        .search_notes("roses".into())
        .unwrap()
        .into_iter()
        .map(|n| (n.id, n.snippet))
        .collect();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].0, second);
    assert!(found[0].1.contains("Roses"), "{}", found[0].1);
    assert!(app.search_notes("  ".into()).unwrap().is_empty());

    // A photo in a note.
    let photo = dir.join("plate.jpeg");
    std::fs::write(&photo, b"jpeg").unwrap();
    let file = app
        .attach_note_file(
            first.clone(),
            photo.to_string_lossy().into_owned(),
            String::new(),
        )
        .unwrap();
    let note = app.note(first.clone()).unwrap();
    assert_eq!(note.attachments.len(), 1);
    assert_eq!(note.attachments[0].id, file);
    assert_eq!(note.attachments[0].name, "plate.jpeg");

    // Folders: rename; deleting one moves its notes out, undo puts them back.
    app.rename_note_folder(home.clone(), "House".into())
        .unwrap();
    app.delete_note_folder(home.clone()).unwrap();
    assert_eq!(app.note(first.clone()).unwrap().folder_id, None);
    assert!(app.undo().unwrap());
    assert_eq!(
        app.note(first.clone()).unwrap().folder_name.as_deref(),
        Some("House")
    );

    app.delete_note(first.clone()).unwrap();
    assert!(matches!(
        app.note(first.clone()).unwrap_err(),
        AppError::NotFound { .. }
    ));
    assert_eq!(of(&boiler), Vec::<String>::new());
    assert!(app.undo().unwrap());
    assert_eq!(app.note(first).unwrap().title, "Boiler and heating");
}

#[test]
fn new_projects_go_at_the_end_one_level_deep() {
    let dir = temp_dir("new-projects");
    let seeded = seed(&dir);
    let app = open(&dir);
    app.resume().unwrap();

    let work = app
        .create_project(NewProjectInput {
            name: "  Work ".into(),
            color: Some("#3b82f6".into()),
            parent_id: None,
        })
        .unwrap();
    let shed = app
        .create_project(NewProjectInput {
            name: "Shed".into(),
            color: None,
            parent_id: Some(seeded.home.clone()),
        })
        .unwrap();
    let nav = app.navigation(day()).unwrap();
    let projects: Vec<_> = nav
        .projects
        .iter()
        .map(|p| (p.name.as_str(), p.depth, p.color.as_deref()))
        .collect();
    assert_eq!(
        projects,
        vec![
            ("Home", 0, Some("#aa0000")),
            ("Garden", 1, None),
            ("Shed", 1, None),
            ("Work", 0, Some("#3b82f6")),
        ]
    );
    assert!(nav.projects.iter().any(|p| p.id == work && !p.team));
    assert!(
        nav.projects
            .iter()
            .any(|p| p.id == shed && p.parent_id.as_deref() == Some(&*seeded.home))
    );

    // Blank names and a second level are refused; a new project takes tasks at once.
    assert!(matches!(
        app.create_project(NewProjectInput {
            name: " ".into(),
            ..NewProjectInput::default()
        })
        .unwrap_err(),
        AppError::Invalid { .. }
    ));
    assert!(matches!(
        app.create_project(NewProjectInput {
            name: "Beds".into(),
            parent_id: Some(seeded.garden.clone()),
            ..NewProjectInput::default()
        })
        .unwrap_err(),
        AppError::Invalid { .. }
    ));
    app.capture_to("Paint the shed".into(), day(), false, Some(shed.clone()))
        .unwrap();
    assert_eq!(
        titles(&app, Scope::Project { id: shed }),
        vec!["Paint the shed".to_string()]
    );
    assert!(app.undo().unwrap());
    assert!(app.undo().unwrap());
    assert!(
        !app.navigation(day())
            .unwrap()
            .projects
            .iter()
            .any(|p| p.name == "Shed")
    );
}

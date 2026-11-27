//! Performance budget (plan section 5): 10,000 tasks hydrate in under 300 ms.
//! Ignored by default; run in release mode:
//!
//! ```sh
//! cargo test --release -p taskmaster-core --test perf -- --ignored --nocapture
//! ```

use std::time::{Duration, Instant};

use taskmaster_core::*;

const TASKS: usize = 10_000;
const HYDRATE_BUDGET: Duration = Duration::from_millis(300);

fn seeded() -> Store {
    let mut s = Store::open_in_memory().unwrap();
    let projects: Vec<Id> = (0..20)
        .map(|i| {
            s.execute(Command::CreateProject {
                project: NewProject {
                    id: None,
                    name: format!("Project {i}"),
                    parent_id: None,
                    color: None,
                    icon: None,
                    rank: None,
                },
            })
            .unwrap()
            .projects[0]
                .id
                .clone()
        })
        .collect();
    let tags: Vec<Id> = (0..10)
        .map(|i| {
            s.execute(Command::CreateTag {
                tag: NewTag {
                    id: None,
                    name: format!("tag{i}"),
                    color: None,
                },
            })
            .unwrap()
            .tags[0]
                .id
                .clone()
        })
        .collect();
    for chunk in (0..TASKS).collect::<Vec<_>>().chunks(1000) {
        let batch = chunk
            .iter()
            .map(|&i| Command::CreateTask {
                task: NewTask {
                    title: format!("Task number {i} with a realistic title"),
                    description: "Some notes in **markdown**, a few lines long.\n- one\n- two"
                        .into(),
                    project_id: (i % 5 != 0).then(|| projects[i % projects.len()].clone()),
                    tag_ids: vec![tags[i % tags.len()].clone()],
                    due_date: (i % 4 == 0).then(|| "2026-12-01".into()),
                    ..NewTask::default()
                },
            })
            .collect();
        s.execute_all(batch).unwrap();
    }
    s
}

#[test]
#[ignore = "performance budget; run in release with --ignored"]
fn hydrating_10k_tasks_stays_within_budget() {
    let s = seeded();
    let mut best = Duration::MAX;
    for _ in 0..5 {
        let start = Instant::now();
        let snapshot = s.snapshot().unwrap();
        // What the IPC layer does before the UI parses it.
        let json = serde_json::to_string(&snapshot).unwrap();
        let elapsed = start.elapsed();
        assert_eq!(snapshot.tasks.len(), TASKS);
        assert!(json.len() > 1_000_000);
        best = best.min(elapsed);
    }
    println!("hydrate 10k tasks (snapshot + JSON): best of 5 = {best:?}");
    assert!(
        best < HYDRATE_BUDGET,
        "{best:?} is over the {HYDRATE_BUDGET:?} budget"
    );
}

#[test]
#[ignore = "performance budget; run in release with --ignored"]
fn a_write_on_a_10k_database_is_fast() {
    let mut s = seeded();
    let id = s.snapshot().unwrap().tasks[TASKS / 2].id.clone();
    let start = Instant::now();
    for i in 0..100 {
        s.execute(Command::UpdateTask {
            id: id.clone(),
            changes: vec![TaskChange::Title(format!("Renamed {i}"))],
        })
        .unwrap();
    }
    let each = start.elapsed() / 100;
    println!("update on a 10k database: {each:?} per write");
    assert!(each < Duration::from_millis(20));
}

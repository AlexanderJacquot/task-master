//! Fills a database with realistic-looking data for performance checks (plan section 5,
//! M3 board scrolling, M6 perf test). Writes through `Store::execute_all`, like the app.
//!
//! ```sh
//! cargo run --release -p taskmaster-core --example seed -- /tmp/seed.sqlite 10000
//! TASK_MASTER_DB=/tmp/seed.sqlite pnpm dev   # debug builds only
//! ```

use taskmaster_core::{Command, NewEpic, NewProject, NewTag, NewTask, Priority, Store, new_id};

const STATUSES: [&str; 5] = [
    "00000000-0000-7000-8000-000000000001",
    "00000000-0000-7000-8000-000000000002",
    "00000000-0000-7000-8000-000000000003",
    "00000000-0000-7000-8000-000000000004",
    "00000000-0000-7000-8000-000000000005",
];
const COLORS: [&str; 6] = [
    "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899",
];
const WORDS: [&str; 16] = [
    "Review", "Draft", "Fix", "Plan", "Call", "Ship", "Refactor", "Write", "Book", "Order",
    "Update", "Test", "Clean", "Prepare", "Email", "Sort",
];
const THINGS: [&str; 16] = [
    "invoice",
    "roadmap",
    "login bug",
    "slides",
    "dentist",
    "release notes",
    "backup job",
    "budget",
    "flights",
    "groceries",
    "API docs",
    "garden",
    "taxes",
    "onboarding",
    "router",
    "photos",
];

fn main() -> taskmaster_core::Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args.next().unwrap_or_else(|| "seed.sqlite".into());
    let count: usize = args.next().and_then(|n| n.parse().ok()).unwrap_or(2_000);
    let mut store = Store::open(&path)?;

    let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
    let mut next = move |n: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        usize::try_from(seed % n as u64).unwrap_or(0)
    };

    let projects: Vec<String> = (0..12).map(|_| new_id()).collect();
    let epics: Vec<String> = (0..8).map(|_| new_id()).collect();
    let tags: Vec<String> = (0..10).map(|_| new_id()).collect();
    let mut setup = Vec::new();
    for (i, id) in projects.iter().enumerate() {
        setup.push(Command::CreateProject {
            project: NewProject {
                id: Some(id.clone()),
                name: format!("Project {}", i + 1),
                parent_id: None,
                color: Some(COLORS[i % COLORS.len()].into()),
                icon: None,
                rank: None,
            },
        });
    }
    for (i, id) in epics.iter().enumerate() {
        setup.push(Command::CreateEpic {
            epic: NewEpic {
                id: Some(id.clone()),
                name: format!("Epic {}", i + 1),
                color: None,
                icon: None,
                project_id: None,
                description: None,
                target_date: None,
                rank: None,
            },
        });
    }
    for (i, id) in tags.iter().enumerate() {
        setup.push(Command::CreateTag {
            tag: NewTag {
                id: Some(id.clone()),
                name: format!("tag{}", i + 1),
                color: None,
            },
        });
    }
    store.execute_all(setup)?;

    let priorities = [
        Priority::Low,
        Priority::Normal,
        Priority::Normal,
        Priority::High,
        Priority::Urgent,
    ];
    for chunk in (0..count).collect::<Vec<_>>().chunks(500) {
        let batch = chunk
            .iter()
            .map(|_| {
                let tag_ids = (0..next(3))
                    .map(|_| tags[next(tags.len())].clone())
                    .collect();
                Command::CreateTask {
                    task: NewTask {
                        title: format!(
                            "{} {}",
                            WORDS[next(WORDS.len())],
                            THINGS[next(THINGS.len())]
                        ),
                        project_id: (next(5) > 0).then(|| projects[next(projects.len())].clone()),
                        epic_id: (next(3) == 0).then(|| epics[next(epics.len())].clone()),
                        status_id: Some(STATUSES[next(STATUSES.len())].into()),
                        priority: priorities[next(priorities.len())],
                        due_date: (next(4) == 0)
                            .then(|| format!("2026-{:02}-{:02}", 1 + next(12), 1 + next(28))),
                        tag_ids,
                        ..NewTask::default()
                    },
                }
            })
            .collect();
        store.execute_all(batch)?;
    }
    println!("Seeded {count} tasks into {path}");
    Ok(())
}

//! Fills a phone data folder with the tasks the iPhone mockups show (projects with
//! epics, a Today list, an Inbox, time blocks), to look at the app in the simulator and
//! for screenshots. Run with the app stopped, on a folder that has no tasks yet:
//!
//!   demo <data-dir> <today YYYY-MM-DD> <minutes east of UTC>
//!
//! The simulator's folder: `$(xcrun simctl get_app_container booted
//! space.solarnexus.taskmaster group.space.solarnexus.taskmaster)/TaskMaster`.

use std::process::ExitCode;

use taskmaster_core::{Command, NewEpic, NewProject, Store};
use taskmaster_mobile::{Core, Day, NewTaskInput, Priority, Stage, TaskEdit};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("demo: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let [dir, today, offset] = args else {
        return Err("usage: demo <data-dir> <today YYYY-MM-DD> <minutes east of UTC>".into());
    };
    let offset: i32 = offset
        .parse()
        .map_err(|_| "the offset is a number of minutes")?;
    let day = Day {
        today: today.clone(),
        utc_offset_min: offset,
    };
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let e = |e: taskmaster_mobile::AppError| e.to_string();

    // Projects and epics come from the desktop; write them as a desktop's sync would.
    let (code, home, health, phone, release) = {
        let mut store = Store::open(format!("{dir}/tasks.sqlite")).map_err(|e| e.to_string())?;
        let mut project = |name: &str, color: &str| -> Result<String, String> {
            Ok(store
                .execute(Command::CreateProject {
                    project: NewProject {
                        name: name.into(),
                        color: Some(color.into()),
                        ..NewProject::default()
                    },
                })
                .map_err(|e| e.to_string())?
                .projects[0]
                .id
                .clone())
        };
        let code = project("task-master", "#2383e2")?;
        let home = project("Home", "#448361")?;
        let health = project("Health", "#9065b0")?;
        let mut epic = |name: &str| -> Result<String, String> {
            Ok(store
                .execute(Command::CreateEpic {
                    epic: NewEpic {
                        name: name.into(),
                        project_id: Some(code.clone()),
                        ..NewEpic::default()
                    },
                })
                .map_err(|e| e.to_string())?
                .epics[0]
                .id
                .clone())
        };
        let phone = epic("iPhone app")?;
        let release = epic("Release 0.31")?;
        (code, home, health, phone, release)
    };

    let core = Core::open(dir.clone(), "Demo".into()).map_err(e)?;
    core.resume().map_err(e)?;
    let start = day_ms(today)?;
    let date = |days: i64| taskmaster_core::utc_date(start + days * 86_400_000);
    let add = |title: &str, project: Option<&str>, epic: Option<&str>| -> Result<String, String> {
        core.add_task(
            NewTaskInput {
                title: title.into(),
                project_id: project.map(Into::into),
                epic_id: epic.map(Into::into),
                ..NewTaskInput::default()
            },
            day.clone(),
        )
        .map_err(e)
    };
    let edit =
        |id: &str, edits: Vec<TaskEdit>| core.edit_task(id.into(), edits, day.clone()).map_err(e);
    let tag = |name: &str| core.create_tag(name.into(), None).map_err(e);
    // Local hours of today, as Unix ms.
    let midnight = start - i64::from(offset) * 60_000;
    let at = |hours: f64| midnight + (hours * 3_600_000.0) as i64;

    let in_progress = core
        .navigation(day.clone())
        .map_err(e)?
        .statuses
        .into_iter()
        .find(|s| s.stage == Stage::InProgress)
        .map(|s| s.id);
    let design = tag("design")?;
    let errand = tag("errand")?;

    let insurance = add("Renew the car insurance", Some(&home), None)?;
    edit(
        &insurance,
        vec![TaskEdit::DueDate {
            value: Some(date(-1)),
        }],
    )?;

    let mockups = add("Draw the phone mockups", Some(&code), Some(&phone))?;
    let mut edits = vec![
        TaskEdit::Today { on: true },
        TaskEdit::Priority { value: Priority::High },
        TaskEdit::Estimate { minutes: Some(90) },
        TaskEdit::DueDate { value: Some(date(2)) },
        TaskEdit::Description {
            value: "Six screens in the clean look, light and dark. Settle the **navigation** before any SwiftUI:\n- Tab bar or one stack\n- Where capture lives".into(),
        },
    ];
    if let Some(status) = in_progress {
        edits.push(TaskEdit::Status { id: status });
    }
    edit(&mockups, edits)?;
    core.set_tags(mockups.clone(), vec![design.clone()])
        .map_err(e)?;
    for (title, done) in [
        ("Today and Inbox", true),
        ("Project from Browse", true),
        ("Task detail", false),
        ("Capture and the day plan", false),
    ] {
        let sub = core
            .add_task(
                NewTaskInput {
                    title: title.into(),
                    parent_id: Some(mockups.clone()),
                    ..NewTaskInput::default()
                },
                day.clone(),
            )
            .map_err(e)?;
        if done {
            core.set_done(sub, true).map_err(e)?;
        }
    }
    core.schedule(mockups.clone(), at(10.0), at(11.5))
        .map_err(e)?;

    let review = add(
        "Review the CalDAV pull request",
        Some(&code),
        Some(&release),
    )?;
    edit(
        &review,
        vec![
            TaskEdit::Today { on: true },
            TaskEdit::Estimate { minutes: Some(30) },
        ],
    )?;
    core.schedule(review, at(14.5), at(15.0)).map_err(e)?;

    let dentist = add("Book the dentist", Some(&health), None)?;
    edit(&dentist, vec![TaskEdit::Today { on: true }])?;
    core.set_tags(dentist, vec![errand.clone()]).map_err(e)?;
    let cleaning = add("Pick up the dry cleaning", Some(&home), None)?;
    edit(
        &cleaning,
        vec![TaskEdit::DueDate {
            value: Some(today.clone()),
        }],
    )?;
    core.set_tags(cleaning, vec![errand]).map_err(e)?;
    let budget = add("Reply to Marie about the budget", Some(&home), None)?;
    edit(&budget, vec![TaskEdit::Today { on: true }])?;
    core.set_done(budget, true).map_err(e)?;

    let tab_bar = add("Tab bar and capture accessory", Some(&code), Some(&phone))?;
    edit(
        &tab_bar,
        vec![TaskEdit::DueDate {
            value: Some(date(3)),
        }],
    )?;
    let chips = add("Task detail with field chips", Some(&code), Some(&phone))?;
    core.set_tags(chips, vec![design]).map_err(e)?;
    let notes = add("Release notes", Some(&code), Some(&release))?;
    edit(
        &notes,
        vec![TaskEdit::DueDate {
            value: Some(date(6)),
        }],
    )?;
    add("Retire the old capture window", Some(&code), None)?;

    for line in [
        "Liquid Glass tab bar examples",
        "Boiler model number",
        "Ask Sam about the team server",
        "Buy AA batteries",
        "Widget for the next time block",
    ] {
        core.capture(line.into(), day.clone()).map_err(e)?;
    }
    core.suspend().map_err(e)?;
    println!("seeded {dir}");
    Ok(())
}

/// Midnight UTC of a `YYYY-MM-DD` day, as Unix ms (days from the civil date).
fn day_ms(iso: &str) -> Result<i64, String> {
    let parts: Vec<i64> = iso.split('-').filter_map(|p| p.parse().ok()).collect();
    let [y, m, d] = parts[..] else {
        return Err(format!("'{iso}' is not YYYY-MM-DD"));
    };
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Ok((era * 146_097 + doe - 719_468) * 86_400_000)
}

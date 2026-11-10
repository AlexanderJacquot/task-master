//! A second replica for the iOS UI tests in CI (`.github/workflows/ios.yml`): it puts
//! tasks on a test server before the phone app starts, and afterwards checks that what
//! was typed on the phone arrived.
//!
//!   replica <server-url> seed
//!   replica <server-url> expect "<task title>"

use std::process::ExitCode;

use taskmaster_mobile::{Core, Day, JoinMode, ListRow, Scope};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("replica: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[&str]) -> Result<(), String> {
    let (url, action) = match args {
        [url, action @ ..] => (*url, action),
        [] => return Err("usage: replica <server-url> seed | expect <title>".into()),
    };
    let dir = std::env::temp_dir().join(format!("tm-replica-{}", std::process::id()));
    let core = Core::open(dir.to_string_lossy().into_owned(), "CI replica".into())
        .map_err(|e| e.to_string())?;
    core.sync_connect(url.into()).map_err(|e| e.to_string())?;
    core.sync_join(JoinMode::Merge).map_err(|e| e.to_string())?;
    // The server's UTC day is close enough for seeded due dates.
    let day = Day {
        today: taskmaster_core::utc_date(taskmaster_core::now_ms()),
        utc_offset_min: 0,
    };
    match action {
        ["seed"] => {
            for line in [
                "Seeded on the server",
                "Water the plants ^today !high",
                "Renew the passport ^+2w #paperwork",
                "Read the sync ADR !low",
            ] {
                core.capture(line.into(), day.clone())
                    .map_err(|e| e.to_string())?;
            }
        }
        ["expect", _] => {}
        _ => return Err("usage: replica <server-url> seed | expect <title>".into()),
    }
    let status = core.sync_now();
    if let Some(error) = status.last_error {
        return Err(format!("sync failed: {error}"));
    }
    if let ["expect", title] = action {
        let rows = core.list(Scope::All, day).map_err(|e| e.to_string())?;
        let found = rows
            .iter()
            .any(|row| matches!(row, ListRow::Task { task } if task.title == *title));
        if !found {
            return Err(format!("no task titled '{title}' reached the server"));
        }
        println!("found '{title}'");
    }
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

//! Restarting the app (after an update, or when the data moves) without a second Dock icon
//! on macOS.
//!
//! Tauri restarts a macOS app with `open -n` while the old instance is still running. The
//! Dock gives that second instance a tile of its own, next to the pinned one, and keeps it
//! after the old instance quits: the app then shows twice in the Dock until it is quit. So
//! on macOS the restart is ours: a detached `sh` waits for this process to exit, then opens
//! the bundle with a plain `open`, which LaunchServices matches to the pinned tile. Tauri's
//! own `open -n` never runs, because the process exits first (see [`on_run_event`]).

use tauri::{AppHandle, RunEvent};

/// Restarts the app through the normal exit (`RunEvent::ExitRequested`, then
/// `RunEvent::Exit`), so the shutdown in the run loop still happens.
pub fn restart(app: &AppHandle) {
    app.request_restart();
}

/// Called from the run loop after its own handling. On macOS, at the exit of a restart,
/// starts the new instance once this one is gone and exits before Tauri relaunches it.
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    #[cfg(target_os = "macos")]
    macos::on_run_event(app, event);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

#[cfg(target_os = "macos")]
mod macos {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::{AppHandle, RunEvent};

    static RESTARTING: AtomicBool = AtomicBool::new(false);

    pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
        match event {
            RunEvent::ExitRequested { code, .. } => {
                RESTARTING.store(*code == Some(tauri::RESTART_EXIT_CODE), Ordering::SeqCst);
            }
            RunEvent::Exit if RESTARTING.load(Ordering::SeqCst) => {
                let Ok(exe) = std::env::current_exe() else {
                    return;
                };
                let args: Vec<_> = std::env::args_os().skip(1).collect();
                let Some(argv) = super::open_after_exit(std::process::id(), &exe, &args) else {
                    return; // not inside an app bundle (`tauri dev`): Tauri restarts it
                };
                let spawned = Command::new("/bin/sh")
                    .args(argv)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .process_group(0)
                    .spawn();
                match spawned {
                    Ok(_) => {
                        app.cleanup_before_exit();
                        std::process::exit(0);
                    }
                    Err(e) => eprintln!("cannot schedule the relaunch, Tauri restarts: {e}"),
                }
            }
            _ => {}
        }
    }
}

/// The `/bin/sh` arguments that wait (up to 30 s) for `pid` to exit, then open the app
/// bundle holding `exe` with `args`. `None` when `exe` is not in `X.app/Contents/MacOS/`.
#[cfg(any(target_os = "macos", test))]
fn open_after_exit(
    pid: u32,
    exe: &std::path::Path,
    args: &[std::ffi::OsString],
) -> Option<Vec<std::ffi::OsString>> {
    let macos_dir = exe.parent()?;
    let contents = macos_dir.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos_dir.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    if !is_bundle {
        return None;
    }
    const SCRIPT: &str = r#"pid=$1; shift
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i+1)); done
exec /usr/bin/open "$@""#;
    let mut argv: Vec<std::ffi::OsString> = vec![
        "-c".into(),
        SCRIPT.into(),
        "sh".into(),
        pid.to_string().into(),
        bundle.into(),
    ];
    if !args.is_empty() {
        argv.push("--args".into());
        argv.extend(args.iter().cloned());
    }
    Some(argv)
}

#[cfg(test)]
mod tests {
    use super::open_after_exit;
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn opens_the_bundle_without_a_new_instance_once_the_process_is_gone() {
        let exe = Path::new("/Applications/task-master.app/Contents/MacOS/taskmaster-desktop");
        let argv = open_after_exit(42, exe, &[]).unwrap();
        assert_eq!(argv[0], "-c");
        let script = argv[1].to_str().unwrap();
        assert!(script.contains("kill -0 \"$pid\""));
        assert!(script.contains("exec /usr/bin/open \"$@\""));
        assert!(
            !script.contains("-n"),
            "a second instance gets its own Dock tile"
        );
        assert_eq!(
            argv[2..],
            ["sh", "42", "/Applications/task-master.app"].map(OsString::from)
        );
    }

    #[test]
    fn passes_the_arguments_on() {
        let exe = Path::new("/Applications/task-master.app/Contents/MacOS/taskmaster-desktop");
        let args = [OsString::from("--hidden"), OsString::from("a b")];
        let argv = open_after_exit(7, exe, &args).unwrap();
        assert_eq!(argv[5..], ["--args", "--hidden", "a b"].map(OsString::from));
    }

    #[test]
    fn needs_an_app_bundle() {
        assert!(
            open_after_exit(1, Path::new("/repo/target/debug/taskmaster-desktop"), &[]).is_none()
        );
        assert!(open_after_exit(1, Path::new("/x/Contents/MacOS/bin"), &[]).is_none());
    }

    /// The script really waits for the process and hands its arguments to `open`.
    #[cfg(unix)]
    #[test]
    fn the_script_waits_for_the_process() {
        use std::process::Command;
        let mut sleeper = Command::new("sleep").arg("0.5").spawn().unwrap();
        let exe = Path::new("/A.app/Contents/MacOS/a");
        let argv = open_after_exit(sleeper.id(), exe, &[OsString::from("x")]).unwrap();
        // Swap `open` for `echo` to see what it would run.
        let script = argv[1].to_str().unwrap().replace("/usr/bin/open", "echo");
        let reaper = std::thread::spawn(move || sleeper.wait());
        let started = std::time::Instant::now();
        let out = Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .args(&argv[2..])
            .output()
            .unwrap();
        reaper.join().unwrap().unwrap();
        assert!(started.elapsed() >= std::time::Duration::from_millis(400));
        assert_eq!(String::from_utf8_lossy(&out.stdout), "/A.app --args x\n");
    }
}

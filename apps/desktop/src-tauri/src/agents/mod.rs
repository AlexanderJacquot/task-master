//! Agent sessions (docs/adr/017-agent-sessions.md): Claude Code runs started from a task,
//! headless, with a live status in the window and the result recorded on the task.
//!
//! A run is `claude -p --output-format stream-json` with the task's brief on stdin and our
//! MCP server (`task-master-mcp`, next to the app's executable) in its config. One thread
//! reads the stream (activity → `AgentActivity` events), one keeps the end of stderr, and
//! the end of the run is written with `execute_without_undo`. Runs are children of the
//! app: quitting stops them and marks them interrupted.

pub mod launch;
pub mod stream;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as Process, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use taskmaster_core::{
    AgentNote, AgentRuntime, AgentSession, AgentSessionChange, Command, Id, NewAgentSession,
    ProjectFolder, SessionState,
};
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event as _;

use crate::config::AgentSettings;
use crate::{AppState, CommandResult, internal, invalid, with_store};
use launch::{Launch, Os, Run};
use stream::{Event, RunResult};

/// What a running session is doing now; `activity: None` when it stopped.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct AgentActivity {
    pub session_id: Id,
    pub activity: Option<String>,
}

/// Runs this app started and that are still going.
#[derive(Default)]
pub struct AgentRunner {
    live: Mutex<HashMap<Id, Live>>,
}

struct Live {
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
    activity: Arc<Mutex<Option<String>>>,
}

/// Kept of a run's stderr, for the error message when it fails.
const STDERR_TAIL: usize = 4000;

/// Name of the MCP server binary, next to the app's executable (a Tauri sidecar in
/// installers; `cargo build -p taskmaster-mcp` in development).
fn mcp_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot find the app: {e}"))?;
    let path = exe
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("task-master-mcp{}", std::env::consts::EXE_SUFFIX));
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "the task-master MCP server is missing ({}); reinstall the app, or in \
             development run `cargo build -p taskmaster-mcp`",
            path.display()
        ))
    }
}

// ---------------------------------------------------------------------------------------
// Pure parts

/// The first message of a session: the brief, then what the user asked.
pub fn opening_prompt(brief: &str, instructions: &str) -> String {
    let instructions = instructions.trim();
    let ask = if instructions.is_empty() {
        "Work on this task in the current folder."
    } else {
        instructions
    };
    format!("{}\n\n## What to do\n\n{ask}\n", brief.trim_end())
}

/// Appended to Claude Code's system prompt for the whole session.
pub fn session_rules(task_title: &str, task_id: &str) -> String {
    format!(
        "You were started from task-master, the user's task manager, to work on the task \
         \"{task_title}\" (id `{task_id}`). Its context is in the first message; the \
         task-master MCP tools give you more.\n\n\
         Track your work with those tools as you go: create agent tasks for the steps you \
         plan (they become subtasks of this task), move them to in_progress and done, add \
         short notes for findings and decisions, and call complete_session with a summary \
         (done, left, to check) before you finish.\n\n\
         You run in the background: nobody can answer a question or approve a tool while \
         you work. If you need a decision, stop, say what you need in your final message and \
         in complete_session; the user will reply with a follow-up message.\n"
    )
}

/// `--mcp-config` content: our server for this session.
pub fn mcp_config(server: &str, db: &str, session_id: &str) -> String {
    let config = serde_json::json!({
        "mcpServers": {
            launch::MCP_SERVER: {
                "command": server,
                "args": ["--db", db, "--session", session_id],
            }
        }
    });
    serde_json::to_string_pretty(&config).unwrap_or_default()
}

/// How a run ended, as changes to its session. `session` is as it was when it ended.
pub fn outcome(
    session: &AgentSession,
    cancelled: bool,
    result: Option<&RunResult>,
    denied: &[String],
    failure: Option<String>,
) -> Vec<AgentSessionChange> {
    let state = match (cancelled, result) {
        (true, _) => SessionState::Cancelled,
        (false, Some(r)) if !r.is_error => SessionState::Done,
        (false, _) => SessionState::Failed,
    };
    let mut changes = vec![AgentSessionChange::State(state)];
    if let Some(r) = result {
        // The agent's own summary (complete_session) wins over its last message.
        if session.summary.is_none() && r.text.is_some() {
            changes.push(AgentSessionChange::Summary(r.text.clone()));
        }
        if let Some(cost) = r.cost_usd_micros {
            let total = session.cost_usd_micros.unwrap_or(0) + cost;
            changes.push(AgentSessionChange::CostUsdMicros(Some(total)));
        }
        if let Some(turns) = r.turns {
            let total = session.turns.unwrap_or(0) + turns;
            changes.push(AgentSessionChange::Turns(Some(total)));
        }
    }
    // Tools refused for want of an approval: from the result and from the stream.
    let mut tools: Vec<&str> = result
        .map(|r| r.denials.iter().map(String::as_str).collect())
        .unwrap_or_default();
    tools.extend(denied.iter().map(String::as_str));
    tools.sort_unstable();
    tools.dedup();
    let error = match state {
        SessionState::Cancelled => None,
        SessionState::Done if tools.is_empty() => None,
        SessionState::Done => Some(format!(
            "Needed approval, so not used: {}. Allow them with another permission mode, or \
             continue in the terminal.",
            tools.join(", ")
        )),
        _ => Some(
            result
                .and_then(|r| r.text.clone())
                .or(failure)
                .unwrap_or_else(|| "Claude Code stopped without a result".into()),
        ),
    };
    changes.push(AgentSessionChange::Error(error));
    changes
}

// ---------------------------------------------------------------------------------------
// Running

fn settings(state: &AppState) -> CommandResult<AgentSettings> {
    Ok(state
        .config
        .lock()
        .map_err(|_| internal("config lock poisoned"))?
        .agents
        .clone())
}

/// A file of the app's as the runtime sees it.
fn runtime_path(path: &Path, runtime: AgentRuntime) -> Result<String, String> {
    let text = path.display().to_string();
    match runtime {
        AgentRuntime::Native => Ok(text),
        AgentRuntime::Wsl => launch::windows_to_wsl(&text)
            .ok_or_else(|| format!("{text} cannot be reached from WSL")),
    }
}

/// Hides the console window a child would open on Windows.
fn hidden(process: &mut Process) -> &mut Process {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        process.creation_flags(CREATE_NO_WINDOW);
    }
    process
}

fn process(launch: &Launch) -> Process {
    let mut p = Process::new(&launch.program);
    p.args(&launch.args);
    if let Some(cwd) = &launch.cwd {
        p.current_dir(cwd);
    }
    p
}

/// Starts one run of `session` (new, or a follow-up with `resume`) with `prompt` on stdin.
fn spawn_run(
    app: &AppHandle,
    state: &AppState,
    session: &AgentSession,
    resume: bool,
    prompt: String,
    rules: Option<String>,
) -> Result<(), String> {
    let settings = settings(state).map_err(|e| e.message)?;
    let runtime = session.runtime;
    if runtime == AgentRuntime::Wsl && !cfg!(windows) {
        return Err("the WSL runtime only works in the Windows app; choose Native".into());
    }
    if runtime == AgentRuntime::Native && !Path::new(&session.folder).is_dir() {
        return Err(format!("the folder {} does not exist", session.folder));
    }
    let dir = state.data_dir.join("agents").join(&session.id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot write {}: {e}", dir.display()))?;
    let server = runtime_path(&mcp_binary()?, runtime)?;
    let config_file = dir.join("mcp.json");
    let db = state.db_path.display().to_string();
    std::fs::write(&config_file, mcp_config(&server, &db, &session.id))
        .map_err(|e| format!("cannot write the MCP config: {e}"))?;
    let rules_file = dir.join("rules.md");
    if let Some(rules) = rules {
        std::fs::write(&rules_file, rules).map_err(|e| format!("cannot write the rules: {e}"))?;
    }
    let launch = launch::claude_command(
        &settings,
        &Run {
            folder: &session.folder,
            claude_session_id: &session.claude_session_id,
            resume,
            permission_mode: &session.permission_mode,
            mcp_config: &runtime_path(&config_file, runtime)?,
            rules: &runtime_path(&rules_file, runtime)?,
        },
    );
    let mut child = hidden(&mut process(&launch))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", launch.program))?;
    let (Some(mut stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill();
        return Err("cannot talk to Claude Code".into());
    };
    let live = Live {
        child: Arc::new(Mutex::new(child)),
        cancelled: Arc::new(AtomicBool::new(false)),
        activity: Arc::new(Mutex::new(Some("Starting".into()))),
    };
    let (child, cancelled, activity) = (
        live.child.clone(),
        live.cancelled.clone(),
        live.activity.clone(),
    );
    state
        .agents
        .live
        .lock()
        .map_err(|_| "agent lock poisoned")?
        .insert(session.id.clone(), live);
    emit(app, &session.id, Some("Starting".into()));

    std::thread::spawn(move || {
        // Closing stdin ends the prompt.
        let _ = stdin.write_all(prompt.as_bytes());
    });
    let tail = Arc::new(Mutex::new(String::new()));
    let tail_writer = tail.clone();
    std::thread::spawn(move || keep_tail(stderr, &tail_writer));

    let (app, id) = (app.clone(), session.id.clone());
    std::thread::Builder::new()
        .name(format!("agent-{id}"))
        .spawn(move || {
            let mut result = None;
            let mut denied = Vec::new();
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                match stream::parse_line(&line) {
                    Event::Activity(text) => {
                        if let Ok(mut a) = activity.lock() {
                            *a = Some(text.clone());
                        }
                        emit(&app, &id, Some(text));
                    }
                    Event::Denied { tool } => denied.push(tool),
                    Event::Finished(r) => result = Some(r),
                    Event::Started { .. } | Event::Other => {}
                }
            }
            let status = wait(&child);
            let failure = tail
                .lock()
                .ok()
                .map(|t| t.trim().to_owned())
                .filter(|t| !t.is_empty())
                .or_else(|| status.map(|s| format!("Claude Code exited ({s})")));
            finish(
                &app,
                &id,
                cancelled.load(Ordering::SeqCst),
                result.as_ref(),
                &denied,
                failure,
            );
        })
        .map_err(|e| format!("cannot watch the run: {e}"))?;
    Ok(())
}

/// Waits for the process to exit without holding its lock for long, so a cancel can
/// still kill it.
fn wait(child: &Mutex<Child>) -> Option<std::process::ExitStatus> {
    loop {
        match child.lock().ok()?.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {}
            Err(_) => return None,
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn keep_tail(mut stderr: impl Read, tail: &Mutex<String>) {
    let mut buf = [0u8; 4096];
    while let Ok(n) = stderr.read(&mut buf) {
        if n == 0 {
            break;
        }
        if let Ok(mut t) = tail.lock() {
            t.push_str(&String::from_utf8_lossy(&buf[..n]));
            if t.len() > STDERR_TAIL {
                let cut = t.len() - STDERR_TAIL;
                let cut = (cut..t.len()).find(|&i| t.is_char_boundary(i)).unwrap_or(0);
                t.drain(..cut);
            }
        }
    }
}

/// Records the end of a run, unless the session already left `running` (quit).
fn finish(
    app: &AppHandle,
    id: &str,
    cancelled: bool,
    result: Option<&RunResult>,
    denied: &[String],
    failure: Option<String>,
) {
    let state = app.state::<AppState>();
    if let Ok(mut live) = state.agents.live.lock() {
        live.remove(id);
    }
    let written = with_store(&state, |s| {
        let session = s.agent_session(id)?;
        if session.state != SessionState::Running {
            return Ok(());
        }
        let changes = outcome(&session, cancelled, result, denied, failure);
        s.execute_without_undo(vec![Command::UpdateAgentSession {
            id: id.to_owned(),
            changes,
        }])
        .map(|_| ())
    });
    if let Err(e) = written {
        eprintln!("cannot record the end of agent session {id}: {}", e.message);
    }
    emit(app, id, None);
}

fn emit(app: &AppHandle, session_id: &str, activity: Option<String>) {
    let _ = AgentActivity {
        session_id: session_id.to_owned(),
        activity,
    }
    .emit(app);
}

/// Stops every run (the app is quitting) and marks them interrupted.
pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let live: Vec<(Id, Live)> = match state.agents.live.lock() {
        Ok(mut live) => live.drain().collect(),
        Err(_) => return,
    };
    if live.is_empty() {
        return;
    }
    let commands = live
        .iter()
        .map(|(id, _)| Command::UpdateAgentSession {
            id: id.clone(),
            changes: vec![AgentSessionChange::State(SessionState::Interrupted)],
        })
        .collect();
    if let Err(e) = with_store(&state, |s| s.execute_without_undo(commands)) {
        eprintln!("cannot mark agent sessions interrupted: {}", e.message);
    }
    for (_, run) in live {
        run.cancelled.store(true, Ordering::SeqCst);
        if let Ok(mut child) = run.child.lock() {
            let _ = child.kill();
        }
    }
}

// ---------------------------------------------------------------------------------------
// IPC (ADR 017)

/// What "Send to Claude" sends.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AgentStart {
    pub task_id: Id,
    /// As typed or picked (a Windows path is converted for WSL).
    pub folder: String,
    /// The settings' default when `None`.
    pub permission_mode: Option<String>,
    /// Extra instructions; may be empty.
    pub prompt: String,
}

/// Starts a session on a task. The session is recorded even when Claude Code cannot be
/// started (as failed, with the reason), so the attempt shows on the task.
#[tauri::command]
#[specta::specta]
pub fn agent_start(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AgentStart,
) -> CommandResult<AgentSession> {
    let settings = settings(&state)?;
    let folder = launch::to_runtime_path(&input.folder, settings.runtime);
    let permission_mode = input.permission_mode.unwrap_or(settings.permission_mode);
    let (brief, title) = with_store(&state, |s| {
        let title = s
            .snapshot()?
            .tasks
            .into_iter()
            .find(|t| t.id == input.task_id)
            .map(|t| t.title)
            .unwrap_or_default();
        Ok((s.agent_brief(&input.task_id)?, title))
    })?;
    let session = with_store(&state, |s| {
        s.execute_without_undo(vec![Command::CreateAgentSession {
            session: NewAgentSession {
                id: None,
                task_id: input.task_id.clone(),
                claude_session_id: taskmaster_core::new_id(),
                folder,
                runtime: settings.runtime,
                permission_mode,
                prompt: input.prompt.clone(),
            },
        }])
    })?
    .agent_sessions
    .remove(0);
    let prompt = opening_prompt(&brief, &input.prompt);
    let rules = session_rules(&title, &input.task_id);
    if let Err(message) = spawn_run(&app, &state, &session, false, prompt, Some(rules)) {
        fail(&state, &session.id, &message);
        return Err(invalid(message));
    }
    Ok(session)
}

fn fail(state: &AppState, id: &str, message: &str) {
    let _ = with_store(state, |s| {
        s.execute_without_undo(vec![Command::UpdateAgentSession {
            id: id.to_owned(),
            changes: vec![
                AgentSessionChange::State(SessionState::Failed),
                AgentSessionChange::Error(Some(message.to_owned())),
            ],
        }])
    });
}

/// A follow-up turn of an ended session, run in the background like the first.
#[tauri::command]
#[specta::specta]
pub fn agent_send(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: Id,
    message: String,
) -> CommandResult<()> {
    if message.trim().is_empty() {
        return Err(invalid("write a message first"));
    }
    if is_live(&state, &session_id)? {
        return Err(invalid("the session is still running"));
    }
    let session = with_store(&state, |s| {
        s.execute_without_undo(vec![Command::UpdateAgentSession {
            id: session_id.clone(),
            changes: vec![
                AgentSessionChange::State(SessionState::Running),
                AgentSessionChange::Summary(None),
                AgentSessionChange::Error(None),
            ],
        }])
    })?
    .agent_sessions
    .remove(0);
    if let Err(message) = spawn_run(&app, &state, &session, true, message, None) {
        fail(&state, &session.id, &message);
        return Err(invalid(message));
    }
    Ok(())
}

fn is_live(state: &AppState, id: &str) -> CommandResult<bool> {
    Ok(state
        .agents
        .live
        .lock()
        .map_err(|_| internal("agent lock poisoned"))?
        .contains_key(id))
}

/// Stops a running session. One left `running` by a crash is marked cancelled.
#[tauri::command]
#[specta::specta]
pub fn agent_cancel(state: State<'_, AppState>, session_id: Id) -> CommandResult<()> {
    let run = state
        .agents
        .live
        .lock()
        .map_err(|_| internal("agent lock poisoned"))?
        .get(&session_id)
        .map(|l| (l.child.clone(), l.cancelled.clone()));
    match run {
        Some((child, cancelled)) => {
            cancelled.store(true, Ordering::SeqCst);
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        }
        None => {
            with_store(&state, |s| {
                s.execute_without_undo(vec![Command::UpdateAgentSession {
                    id: session_id.clone(),
                    changes: vec![AgentSessionChange::State(SessionState::Cancelled)],
                }])
            })?;
        }
    }
    Ok(())
}

/// Opens a terminal running `claude --resume` in the session's folder.
#[tauri::command]
#[specta::specta]
pub fn agent_open_terminal(state: State<'_, AppState>, session_id: Id) -> CommandResult<()> {
    let settings = settings(&state)?;
    let (session, device) = with_store(&state, |s| {
        Ok((s.agent_session(&session_id)?, s.device_id().to_owned()))
    })?;
    if session.device_id != device {
        return Err(invalid("this session ran on another device; open it there"));
    }
    let os = Os::current();
    let env_terminal = std::env::var("TERMINAL").ok();
    let launch = launch::terminal_command(
        &settings,
        session.runtime,
        &session.folder,
        &session.claude_session_id,
        os,
        env_terminal.as_deref(),
    );
    let started = process(&launch)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match started {
        Ok(_) => Ok(()),
        Err(_) if os == Os::Windows => {
            let fallback = launch::windows_console_fallback(
                &settings,
                session.runtime,
                &session.folder,
                &session.claude_session_id,
            );
            hidden(&mut process(&fallback))
                .spawn()
                .map(|_| ())
                .map_err(|e| internal(format!("cannot open a terminal: {e}")))
        }
        Err(e) => Err(internal(format!(
            "cannot open a terminal ({}): {e}; set one in Settings → Agents",
            launch.program
        ))),
    }
}

/// What each running session is doing, for a window that just opened.
#[tauri::command]
#[specta::specta]
pub fn agent_live(state: State<'_, AppState>) -> CommandResult<Vec<AgentActivity>> {
    let live = state
        .agents
        .live
        .lock()
        .map_err(|_| internal("agent lock poisoned"))?;
    Ok(live
        .iter()
        .map(|(id, run)| AgentActivity {
            session_id: id.clone(),
            activity: run.activity.lock().ok().and_then(|a| a.clone()),
        })
        .collect())
}

/// The brief a session on this task would start with (for the dialog's preview).
#[tauri::command]
#[specta::specta]
pub fn agent_brief(state: State<'_, AppState>, task_id: Id) -> CommandResult<String> {
    with_store(&state, |s| s.agent_brief(&task_id))
}

/// A task's agent notes (or one session's), the newest `limit`, oldest first.
#[tauri::command]
#[specta::specta]
pub fn agent_notes(
    state: State<'_, AppState>,
    task_id: Id,
    session_id: Option<Id>,
    limit: u32,
) -> CommandResult<Vec<AgentNote>> {
    with_store(&state, |s| {
        s.agent_notes(&task_id, session_id.as_deref(), limit)
    })
}

#[tauri::command]
#[specta::specta]
pub fn agent_settings(state: State<'_, AppState>) -> CommandResult<AgentSettings> {
    settings(&state)
}

#[tauri::command]
#[specta::specta]
pub fn set_agent_settings(
    state: State<'_, AppState>,
    settings: AgentSettings,
) -> CommandResult<AgentSettings> {
    let settings = settings.normalized().map_err(invalid)?;
    let mut config = state
        .config
        .lock()
        .map_err(|_| internal("config lock poisoned"))?;
    config.agents = settings.clone();
    config
        .save(&state.config_path)
        .map_err(|e| internal(format!("cannot save settings: {e}")))?;
    Ok(settings)
}

/// Claude Code as found with these settings (not saved).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ClaudeCheck {
    /// The path that works; save it as `claude_path` when it differs.
    pub path: String,
    pub version: String,
}

/// Checks Claude Code runs with these settings; when `claude` is not on the PATH the app
/// gets, looks it up through the user's login shell.
#[tauri::command]
#[specta::specta]
pub fn detect_claude(settings: AgentSettings) -> CommandResult<ClaudeCheck> {
    let settings = settings.normalized().map_err(invalid)?;
    let version = |path: &str| -> Result<String, String> {
        let out = hidden(&mut process(&launch::version_command(&settings, path)))
            .stdin(Stdio::null())
            .output()
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if out.status.success() && !text.is_empty() {
            Ok(text)
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
        }
    };
    if let Ok(v) = version(&settings.claude_path) {
        return Ok(ClaudeCheck {
            path: settings.claude_path.clone(),
            version: v,
        });
    }
    let lookup = hidden(&mut process(&launch::lookup_command(
        &settings,
        Os::current(),
    )))
    .stdin(Stdio::null())
    .output()
    .map_err(|e| invalid(format!("cannot look for Claude Code: {e}")))?;
    let found = launch::found_path(&String::from_utf8_lossy(&lookup.stdout))
        .ok_or_else(|| invalid("Claude Code was not found; install it, or give its full path"))?;
    let v = version(&found).map_err(|e| invalid(format!("{found} does not run: {e}")))?;
    Ok(ClaudeCheck {
        path: found,
        version: v,
    })
}

/// Installed WSL distributions (Windows only; empty elsewhere or without WSL).
#[tauri::command]
#[specta::specta]
pub fn list_wsl_distros() -> Vec<String> {
    if !cfg!(windows) {
        return Vec::new();
    }
    hidden(&mut Process::new("wsl.exe"))
        .args(["-l", "-q"])
        .stdin(Stdio::null())
        .output()
        .map(|out| launch::parse_distros(&out.stdout))
        .unwrap_or_default()
}

#[tauri::command]
#[specta::specta]
pub fn project_folders(state: State<'_, AppState>) -> CommandResult<Vec<ProjectFolder>> {
    with_store(&state, |s| s.project_folders())
}

/// Sets (or clears, with `None`) this device's folder for a project, as the current
/// runtime sees it.
#[tauri::command]
#[specta::specta]
pub fn set_project_folder(
    state: State<'_, AppState>,
    project_id: Id,
    path: Option<String>,
) -> CommandResult<Vec<ProjectFolder>> {
    let runtime = settings(&state)?.runtime;
    let folder = path
        .map(|p| launch::to_runtime_path(&p, runtime))
        .filter(|p| !p.is_empty())
        .map(|p| (p, runtime));
    with_store(&state, |s| {
        s.set_project_folder(&project_id, folder)?;
        s.project_folders()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> AgentSession {
        AgentSession {
            id: "s".into(),
            task_id: "t".into(),
            device_id: "d".into(),
            claude_session_id: "c".into(),
            folder: "/f".into(),
            runtime: AgentRuntime::Native,
            permission_mode: "acceptEdits".into(),
            prompt: String::new(),
            state: SessionState::Running,
            started_at: 1,
            ended_at: None,
            summary: None,
            cost_usd_micros: Some(1_000),
            turns: Some(2),
            error: None,
            created_at: 1,
            updated_at: 1,
            deleted_at: None,
        }
    }

    fn result(is_error: bool) -> RunResult {
        RunResult {
            is_error,
            subtype: "success".into(),
            text: Some("All done.".into()),
            cost_usd_micros: Some(500),
            turns: Some(3),
            denials: vec!["Write".into()],
        }
    }

    #[test]
    fn a_finished_run_records_its_result_and_adds_up_cost() {
        let changes = outcome(
            &session(),
            false,
            Some(&result(false)),
            &["Bash".into(), "Write".into()],
            None,
        );
        assert_eq!(
            changes,
            [
                AgentSessionChange::State(SessionState::Done),
                AgentSessionChange::Summary(Some("All done.".into())),
                AgentSessionChange::CostUsdMicros(Some(1_500)),
                AgentSessionChange::Turns(Some(5)),
                AgentSessionChange::Error(Some(
                    "Needed approval, so not used: Bash, Write. Allow them with another \
                     permission mode, or continue in the terminal."
                        .into()
                )),
            ]
        );
    }

    #[test]
    fn the_agents_own_summary_is_kept() {
        let mut s = session();
        s.summary = Some("From complete_session".into());
        let mut r = result(false);
        r.denials.clear();
        let changes = outcome(&s, false, Some(&r), &[], None);
        assert!(
            !changes
                .iter()
                .any(|c| matches!(c, AgentSessionChange::Summary(_)))
        );
        assert!(changes.contains(&AgentSessionChange::Error(None)));
    }

    #[test]
    fn failures_and_cancels_say_why() {
        let failed = outcome(&session(), false, Some(&result(true)), &[], None);
        assert_eq!(failed[0], AgentSessionChange::State(SessionState::Failed));
        assert_eq!(
            failed.last(),
            Some(&AgentSessionChange::Error(Some("All done.".into())))
        );

        let crashed = outcome(
            &session(),
            false,
            None,
            &[],
            Some("claude: not found".into()),
        );
        assert_eq!(
            crashed,
            [
                AgentSessionChange::State(SessionState::Failed),
                AgentSessionChange::Error(Some("claude: not found".into())),
            ]
        );
        let silent = outcome(&session(), false, None, &[], None);
        assert!(
            matches!(silent.last(), Some(AgentSessionChange::Error(Some(m))) if m.contains("without a result"))
        );

        let cancelled = outcome(&session(), true, Some(&result(false)), &[], None);
        assert_eq!(
            cancelled[0],
            AgentSessionChange::State(SessionState::Cancelled)
        );
        assert_eq!(cancelled.last(), Some(&AgentSessionChange::Error(None)));
    }

    /// The whole chain without the window: command line, real Claude Code, our MCP server
    /// writing to the database, stream parsing and the recorded outcome. Opt-in, as it
    /// costs tokens: `cargo build -p taskmaster-mcp && cargo test -p taskmaster-desktop
    /// real_claude -- --ignored`.
    #[test]
    #[ignore = "runs the real Claude Code"]
    fn real_claude_run_tracks_its_work_through_the_mcp() {
        use taskmaster_core::{NewTask, Store, TaskOwner};

        let dir =
            std::env::temp_dir().join(format!("tm-real-claude-{}", taskmaster_core::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("tasks.sqlite");
        let mut store = Store::open(&db).unwrap();
        let task = store
            .execute(Command::CreateTask {
                task: NewTask {
                    title: "Say hello".into(),
                    ..NewTask::default()
                },
            })
            .unwrap()
            .tasks
            .remove(0);
        let session = store
            .execute_without_undo(vec![Command::CreateAgentSession {
                session: NewAgentSession {
                    id: None,
                    task_id: task.id.clone(),
                    claude_session_id: taskmaster_core::new_id(),
                    folder: dir.display().to_string(),
                    runtime: AgentRuntime::Native,
                    permission_mode: "default".into(),
                    prompt: String::new(),
                },
            }])
            .unwrap()
            .agent_sessions
            .remove(0);

        let server = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../target/debug/task-master-mcp")
            .canonicalize()
            .expect("build the MCP server first: cargo build -p taskmaster-mcp");
        let config = dir.join("mcp.json");
        std::fs::write(
            &config,
            mcp_config(
                &server.display().to_string(),
                &db.display().to_string(),
                &session.id,
            ),
        )
        .unwrap();
        let rules = dir.join("rules.md");
        std::fs::write(&rules, session_rules(&task.title, &task.id)).unwrap();
        let settings = AgentSettings {
            model: Some("haiku".into()),
            ..AgentSettings::default()
        };
        let launch = launch::claude_command(
            &settings,
            &Run {
                folder: &session.folder,
                claude_session_id: &session.claude_session_id,
                resume: false,
                permission_mode: &session.permission_mode,
                mcp_config: &config.display().to_string(),
                rules: &rules.display().to_string(),
            },
        );
        let brief = store.agent_brief(&task.id).unwrap();
        let prompt = opening_prompt(
            &brief,
            "This is a test of the tools. Use only the task-master tools: add the note \
             'hello from the test', create one agent task titled 'Step one' and set it to \
             done, call complete_session with the summary 'Test passed', then reply DONE.",
        );
        let mut child = process(&launch)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(prompt.as_bytes())
            .unwrap();
        let mut result = None;
        let mut activity = Vec::new();
        for line in BufReader::new(child.stdout.take().unwrap()).lines() {
            match stream::parse_line(&line.unwrap()) {
                Event::Activity(a) => activity.push(a),
                Event::Finished(r) => result = Some(r),
                _ => {}
            }
        }
        child.wait().unwrap();
        let result = result.expect("no result");
        println!("activity: {activity:#?}\nresult: {result:?}");

        let session = store.agent_session(&session.id).unwrap();
        assert_eq!(
            session.summary.as_deref(),
            Some("Test passed"),
            "complete_session"
        );
        let changes = outcome(&session, false, Some(&result), &[], None);
        store
            .execute_without_undo(vec![Command::UpdateAgentSession {
                id: session.id.clone(),
                changes,
            }])
            .unwrap();
        let session = store.agent_session(&session.id).unwrap();
        assert_eq!(session.state, SessionState::Done);
        assert_eq!(
            session.summary.as_deref(),
            Some("Test passed"),
            "kept over the reply"
        );
        assert!(session.cost_usd_micros.is_some_and(|c| c > 0));
        let notes = store.agent_notes(&task.id, None, 10).unwrap();
        assert!(
            notes.iter().any(|n| n.body.contains("hello from the test")),
            "{notes:?}"
        );
        let snapshot = store.snapshot().unwrap();
        let step = snapshot
            .tasks
            .iter()
            .find(|t| t.title == "Step one")
            .expect("the agent task");
        assert_eq!(step.owner, TaskOwner::Agent);
        assert_eq!(step.parent_id.as_deref(), Some(task.id.as_str()));
        assert_eq!(step.status_id, "00000000-0000-7000-8000-000000000005");
        assert!(
            activity.iter().any(|a| a.starts_with("Noting: ")),
            "{activity:?}"
        );
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_prompt_and_files_carry_the_task() {
        assert_eq!(
            opening_prompt("# Task: X\n\n- Id: `t`\n", "  "),
            "# Task: X\n\n- Id: `t`\n\n## What to do\n\nWork on this task in the current folder.\n"
        );
        assert!(
            opening_prompt("# Task: X", "Only fix the tests").ends_with("Only fix the tests\n")
        );
        let rules = session_rules("Fix sync", "0190-id");
        assert!(rules.contains("\"Fix sync\" (id `0190-id`)"));
        assert!(rules.contains("complete_session"));
        let config: serde_json::Value = serde_json::from_str(&mcp_config(
            "/mnt/c/tm/task-master-mcp.exe",
            r"C:\data\tm.sqlite",
            "s1",
        ))
        .unwrap();
        assert_eq!(
            config,
            serde_json::json!({ "mcpServers": { "task-master": {
                "command": "/mnt/c/tm/task-master-mcp.exe",
                "args": ["--db", r"C:\data\tm.sqlite", "--session", "s1"],
            }}})
        );
    }
}

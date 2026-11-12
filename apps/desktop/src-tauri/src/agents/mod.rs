//! Agent sessions (docs/adr/017-agent-sessions.md): Claude Code runs started from a task,
//! headless, with a live status in the window and the result recorded on the task.
//!
//! A run is `claude -p --output-format stream-json` with the task's brief on stdin and our
//! MCP server (`task-master-mcp`, next to the app's executable) in its config. One thread
//! reads the stream (activity → `AgentActivity` events), one keeps the end of stderr, and
//! the end of the run is written with `execute_without_undo`. Runs are children of the
//! app: quitting stops them and marks them interrupted.

pub mod launch;
pub mod plan;
pub mod stream;

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as Process, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use taskmaster_core::{
    AgentNote, AgentRuntime, AgentSession, AgentSessionChange, AgentWorkflow, Command, Id,
    NewAgentSession, ProjectFolder, SessionState, Status, Store, Task,
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
    /// Sessions whose terminal is being watched (`watch_terminal`), one watcher each.
    watched: Mutex<HashSet<Id>>,
}

struct Live {
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
    activity: Arc<Mutex<Option<String>>>,
}

/// In the session's folder: a readable log of the last run (its messages and tools).
const RUN_LOG_FILE: &str = "run.log";

fn state_label(state: SessionState) -> &'static str {
    match state {
        SessionState::Running => "Running",
        SessionState::Done => "Done",
        SessionState::Failed => "Failed",
        SessionState::Cancelled => "Stopped",
        SessionState::Interrupted => "Interrupted",
        SessionState::Terminal => "In terminal",
    }
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

/// Appended to Claude Code's system prompt for the whole session: the app's rules, then
/// the user's standing directive for every agent (Settings → Agents), when any.
pub fn session_rules(
    task_title: &str,
    task_id: &str,
    done_status: &str,
    directive: Option<&str>,
) -> String {
    let rules = app_rules(task_title, task_id, done_status);
    match directive.map(str::trim).filter(|d| !d.is_empty()) {
        Some(directive) => format!(
            "{rules}\n# The user's standing instructions\n\n\
             The user set these for every agent session they start; follow them unless the \
             task says otherwise.\n\n{directive}\n"
        ),
        None => rules,
    }
}

fn app_rules(task_title: &str, task_id: &str, done_status: &str) -> String {
    format!(
        "You were started from task-master, the user's task manager, to work on the task \
         \"{task_title}\" (id `{task_id}`). Its context is in the first message; the \
         task-master MCP tools give you more.\n\n\
         Track your work with those tools as you go: create agent tasks for the steps you \
         plan (they become subtasks of this task), move them to in_progress and done, add \
         short notes for findings and decisions, and call complete_session with a summary \
         (done, left, to check) before you finish. If this task has subtasks of its own \
         (the user's), mark each one done with update_task as soon as you finish it; \
         complete_session refuses while a subtask is open unless you list it in \
         left_open. The app then moves this task to \
         {done_status} for the user to check: do not mark it done yourself.\n\n\
         You run in the background: nobody can answer a question or approve a tool while \
         you work. If you need a decision, stop, say what you need in your final message and \
         in complete_session; the user will reply with a follow-up message.\n"
    )
}

/// `--mcp-config` content: our server for this session, and the status picked for agent
/// work done (the server's default, Review, when `None`).
pub fn mcp_config(server: &str, db: &str, session_id: &str, done_status: Option<&str>) -> String {
    let mut args = vec!["--db", db, "--session", session_id];
    if let Some(id) = done_status {
        args.extend(["--done-status", id]);
    }
    let config = serde_json::json!({
        "mcpServers": {
            launch::MCP_SERVER: {
                "command": server,
                "args": args,
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
        if let Some(ms) = r.duration_ms {
            let total = session.duration_ms.unwrap_or(0) + ms;
            changes.push(AgentSessionChange::DurationMs(Some(total)));
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
                .unwrap_or_else(|| "The agent stopped without a result".into()),
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

/// The status move of a user's task the workflow makes for an agent event, if any.
fn task_move(
    s: &Store,
    task_id: &str,
    workflow: &AgentWorkflow,
    rule: fn(&AgentWorkflow, &[Status], &Task) -> Option<Command>,
) -> taskmaster_core::Result<Option<Command>> {
    let snapshot = s.snapshot()?;
    Ok(snapshot
        .tasks
        .iter()
        .find(|t| t.id == task_id)
        .and_then(|task| rule(workflow, &snapshot.statuses, task)))
}

/// Moves the session's task to the "sent to an agent" status (ADR 017); a failure is
/// only logged, the run goes on.
fn mark_started(state: &AppState, settings: &AgentSettings, task_id: &str) {
    let workflow = settings.workflow();
    let moved = with_store(state, |s| {
        if let Some(command) = task_move(s, task_id, &workflow, AgentWorkflow::on_start)? {
            s.execute_without_undo(vec![command])?;
        }
        Ok(())
    });
    if let Err(e) = moved {
        eprintln!("cannot move task {task_id} to in progress: {}", e.message);
    }
}

/// Writes the session's `mcp.json` (in its folder, which must exist) for this app's MCP
/// server, and returns its path. Rewritten for each run and terminal: the server's path
/// changes when the app does (an AppImage is mounted at a new place on each start).
fn write_mcp_config(
    state: &AppState,
    settings: &AgentSettings,
    session_id: &str,
    runtime: AgentRuntime,
) -> Result<PathBuf, String> {
    let server = runtime_path(&mcp_binary()?, runtime)?;
    let config_file = state
        .data_dir
        .join("agents")
        .join(session_id)
        .join("mcp.json");
    let db = state.db_path.display().to_string();
    let done_status = settings.done_status_id.as_deref();
    std::fs::write(
        &config_file,
        mcp_config(&server, &db, session_id, done_status),
    )
    .map_err(|e| format!("cannot write the MCP config: {e}"))?;
    Ok(config_file)
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

/// What a running Claude Code session sets for its own child processes. The app inherits
/// them when it is started from inside one (a dev build run by an agent, or a terminal
/// where Claude Code runs); passed on, they make every spawned `claude` a sub-session of
/// that one: transcripts off (so `--resume`, follow-ups and Resume find nothing), and
/// that session's id and messaging socket handed to our agents. Only these markers go;
/// the user's own configuration (API keys, `CLAUDE_CONFIG_DIR`, provider and model
/// settings) is passed on as is.
const INHERITED_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
];

fn process(launch: &Launch) -> Process {
    let mut p = Process::new(&launch.program);
    p.args(&launch.args);
    if let Some(cwd) = &launch.cwd {
        p.current_dir(cwd);
    }
    for var in INHERITED_SESSION_VARS {
        p.env_remove(var);
    }
    for (name, value) in host_env() {
        match value {
            Some(value) => p.env(name, value),
            None => p.env_remove(name),
        };
    }
    p
}

/// `settings` with `claude_path` usable by a `runtime` launch: in WSL, a bare name is
/// looked up once per distribution through the login shell (see
/// [`launch::wsl_needs_lookup`]) and remembered until the app restarts.
fn resolve_claude(
    settings: &AgentSettings,
    runtime: AgentRuntime,
) -> Result<AgentSettings, String> {
    if !launch::wsl_needs_lookup(settings, runtime) {
        return Ok(settings.clone());
    }
    static FOUND: Mutex<Vec<(Option<String>, String, String)>> = Mutex::new(Vec::new());
    let key = (settings.wsl_distro.clone(), settings.claude_path.clone());
    let cached = FOUND.lock().ok().and_then(|f| {
        f.iter()
            .find(|(d, n, _)| (d, n) == (&key.0, &key.1))
            .map(|(.., p)| p.clone())
    });
    let path = match cached {
        Some(path) => path,
        None => {
            let lookup_settings = AgentSettings {
                runtime: AgentRuntime::Wsl,
                ..settings.clone()
            };
            let out = hidden(&mut process(&launch::lookup_command(
                &lookup_settings,
                Os::current(),
            )))
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("cannot look for claude in WSL: {e}"))?;
            let path = launch::found_path(&String::from_utf8_lossy(&out.stdout)).ok_or_else(|| {
                format!(
                    "cannot start claude: not found in WSL{} (not even through your login shell); \
                     set its full path in the agent settings",
                    settings.wsl_distro.as_deref().map(|d| format!(" ({d})")).unwrap_or_default()
                )
            })?;
            if let Ok(mut f) = FOUND.lock() {
                f.push((key.0, key.1, path.clone()));
            }
            path
        }
    };
    Ok(AgentSettings {
        claude_path: path,
        ..settings.clone()
    })
}

/// [`launch::host_env`] for this process, read once (the AppImage sets it before start).
fn host_env() -> &'static [(String, Option<String>)] {
    static CHANGES: std::sync::OnceLock<Vec<(String, Option<String>)>> = std::sync::OnceLock::new();
    CHANGES.get_or_init(|| {
        let env: Vec<(String, String)> = std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
            .collect();
        launch::host_env(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
    })
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
    let settings = resolve_claude(&settings, runtime)?;
    if runtime == AgentRuntime::Native && !Path::new(&session.folder).is_dir() {
        return Err(format!("the folder {} does not exist", session.folder));
    }
    let dir = state.data_dir.join("agents").join(&session.id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot write {}: {e}", dir.display()))?;
    let config_file = write_mcp_config(state, &settings, &session.id, runtime)?;
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
            model: session.model.as_deref(),
            mcp_config: &runtime_path(&config_file, runtime)?,
            rules: &runtime_path(&rules_file, runtime)?,
        },
    );
    // A readable log of this run, for "Watch in terminal" (one run at a time).
    let mut run_log = std::fs::File::create(dir.join(RUN_LOG_FILE)).ok();
    if let Some(log) = run_log.as_mut() {
        let header = if resume {
            format!("● Your message:\n{}\n\n", prompt.trim())
        } else if session.prompt.trim().is_empty() {
            "● Sent from the task\n\n".to_owned()
        } else {
            format!("● Sent from the task:\n{}\n\n", session.prompt.trim())
        };
        let _ = log.write_all(header.as_bytes());
    }
    if let Some(cwd) = &launch.cwd
        && !cwd.is_dir()
    {
        return Err(format!(
            "the project folder {} does not exist; set it again in the project's settings",
            cwd.display()
        ));
    }
    let start = |launch: &Launch| {
        hidden(&mut process(launch))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    };
    let mut child = match start(&launch) {
        Ok(child) => child,
        // A GUI app often lacks the shell's PATH: find `claude` the way settings do.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && launch.program == "claude" => {
            let found = hidden(&mut process(&launch::lookup_command(&settings, Os::current())))
                .stdin(Stdio::null())
                .output()
                .ok()
                .and_then(|out| launch::found_path(&String::from_utf8_lossy(&out.stdout)))
                .ok_or_else(|| {
                    "cannot start claude: not found on the app's PATH; set its full path in the agent settings".to_owned()
                })?;
            let retry = Launch {
                program: found.clone(),
                ..launch
            };
            start(&retry).map_err(|e| format!("cannot start {found}: {e}"))?
        }
        Err(e) => return Err(format!("cannot start {}: {e}", launch.program)),
    };
    let (Some(mut stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill();
        return Err("cannot talk to the agent".into());
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
                if let Some(log) = run_log.as_mut() {
                    for text in stream::readable(&line) {
                        let _ = writeln!(log, "{text}");
                    }
                }
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
                .or_else(|| status.map(|s| format!("The agent exited ({s})")));
            finish(
                &app,
                &id,
                cancelled.load(Ordering::SeqCst),
                result.as_ref(),
                &denied,
                failure,
            );
            if let Some(log) = run_log.as_mut() {
                let state = app.state::<AppState>();
                let ended = with_store(&state, |s| s.agent_session(&id))
                    .map(|s| state_label(s.state))
                    .unwrap_or("ended");
                let _ = writeln!(log, "\n{}: {ended} ===", launch::RUN_END_PREFIX);
            }
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
    let workflow = settings(&state).map(|s| s.workflow()).unwrap_or_default();
    let written = with_store(&state, |s| {
        let session = s.agent_session(id)?;
        if session.state != SessionState::Running {
            return Ok(());
        }
        let changes = outcome(&session, cancelled, result, denied, failure);
        let done = changes.contains(&AgentSessionChange::State(SessionState::Done));
        let mut commands = vec![Command::UpdateAgentSession {
            id: id.to_owned(),
            changes,
        }];
        // The software rule (ADR 017): a run that ended well reports the task done, whether
        // or not the agent called complete_session.
        if done {
            commands.extend(task_move(
                s,
                &session.task_id,
                &workflow,
                AgentWorkflow::on_done,
            )?);
        }
        s.execute_without_undo(commands).map(|_| ())
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

/// What "Send to agent" sends.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AgentStart {
    pub task_id: Id,
    /// As typed or picked (a Windows path is converted for WSL).
    pub folder: String,
    /// The settings' default when `None`.
    pub permission_mode: Option<String>,
    /// Claude Code `--model` (alias or full name); the settings' model when `None`.
    #[serde(default)]
    pub model: Option<String>,
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
    let permission_mode = input
        .permission_mode
        .unwrap_or_else(|| settings.permission_mode.clone());
    let (brief, title, done_status) = with_store(&state, |s| {
        let snapshot = s.snapshot()?;
        let title = snapshot
            .tasks
            .iter()
            .find(|t| t.id == input.task_id)
            .map(|t| t.title.clone())
            .unwrap_or_default();
        let done_status = settings
            .workflow()
            .done_status(&snapshot.statuses)
            .map_or_else(|| "Review".to_owned(), |s| s.name.clone());
        Ok((s.agent_brief(&input.task_id)?, title, done_status))
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
                model: input.model.clone(),
                prompt: input.prompt.clone(),
            },
        }])
    })?
    .agent_sessions
    .remove(0);
    let prompt = opening_prompt(&brief, &input.prompt);
    let rules = session_rules(
        &title,
        &input.task_id,
        &done_status,
        settings.directive.as_deref(),
    );
    if let Err(message) = spawn_run(&app, &state, &session, false, prompt, Some(rules)) {
        fail(&state, &session.id, &message);
        return Err(invalid(message));
    }
    mark_started(&state, &settings, &input.task_id);
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
    mark_started(&state, &settings(&state)?, &session.task_id);
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

/// A terminal that closes sooner than this after opening was a launcher handing the window
/// to a terminal server (gnome-terminal, `wt.exe`, `osascript`), not the conversation ending.
const TERMINAL_LAUNCHER: Duration = Duration::from_secs(3);

/// Opens a terminal running `claude --resume` in the session's folder, with the session's
/// MCP config. A running session's headless run is stopped first. The session becomes
/// `terminal` until the agent records its summary, the user marks it done, or the terminal
/// closes (when it can be followed). Async: stopping a run waits for it, off the UI thread.
#[tauri::command(async)]
#[specta::specta]
pub fn agent_open_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: Id,
) -> CommandResult<()> {
    let settings = settings(&state)?;
    let (session, device) = with_store(&state, |s| {
        Ok((s.agent_session(&session_id)?, s.device_id().to_owned()))
    })?;
    if session.device_id != device {
        return Err(invalid("this session ran on another device; open it there"));
    }
    let os = Os::current();
    let default_terminal = match os {
        Os::Linux => std::env::var("TERMINAL")
            .ok()
            .filter(|t| !t.trim().is_empty())
            .map(|t| launch::linux_terminal_prefix(&t))
            .or_else(|| launch::detect_linux_terminal(on_path)),
        _ => None,
    };
    // A run in progress cannot be joined (`claude --resume` would fork it and load none of
    // its current turn), so the terminal takes it over: the headless run stops (its turn so
    // far is kept in the conversation) and the terminal continues the session.
    let was_live = is_live(&state, &session.id)?;
    if was_live {
        stop_for_terminal(&state, &session.id)?;
    }
    // The session's MCP config, up to date when it can be (the agent keeps its tools).
    let config = state
        .data_dir
        .join("agents")
        .join(&session.id)
        .join("mcp.json");
    if config.is_file()
        && let Err(e) = write_mcp_config(&state, &settings, &session.id, session.runtime)
    {
        eprintln!(
            "cannot update the MCP config of agent session {}: {e}",
            session.id
        );
    }
    let config = config
        .is_file()
        .then(|| runtime_path(&config, session.runtime).ok())
        .flatten();
    // A run still going (it did not stop in time) stays the app's: the terminal forks its
    // conversation and is the user's to close. Any other session is continued here, and
    // watched.
    let takes_over = !is_live(&state, &session.id)?;
    let session_dir = state.data_dir.join("agents").join(&session.id);
    let pid_file = session_dir.join(TERMINAL_PID_FILE);
    if takes_over && session.state == SessionState::Terminal {
        let open = read_pid(&pid_file).is_some_and(|pid| {
            claude_alive(
                &settings,
                session.runtime,
                os,
                pid,
                &session.claude_session_id,
            ) == Some(true)
        });
        if open {
            return Err(invalid(
                "this session is already open in a terminal; finish it there or mark it done",
            ));
        }
    }
    let _ = std::fs::remove_file(&pid_file);
    // Native Windows runs claude without a shell, so nothing can record its pid.
    let record_pid = takes_over
        && !(os == Os::Windows && session.runtime == AgentRuntime::Native)
        && pid_file.parent().is_some_and(Path::is_dir);
    let pid_path = if record_pid {
        Some(runtime_path(&pid_file, session.runtime).map_err(invalid)?)
    } else {
        None
    };
    let settings = resolve_claude(&settings, session.runtime).map_err(invalid)?;
    let resume = launch::resume_args(
        &settings,
        &launch::Resume {
            claude_session_id: &session.claude_session_id,
            mcp_config: config.as_deref(),
            permission_mode: &session.permission_mode,
            model: session.model.as_deref(),
            // Stopped mid-turn: the terminal picks the turn up rather than waiting.
            interrupted: was_live && takes_over,
        },
    );
    let launch = launch::terminal_command(
        &settings,
        session.runtime,
        &session.folder,
        &resume,
        pid_path.as_deref(),
        os,
        default_terminal.as_deref(),
    );
    // What the terminal prints when it cannot start, for the error (see `run_watch`).
    let errors = || {
        std::fs::File::create(session_dir.join(TERMINAL_LOG_FILE))
            .map_or_else(|_| Stdio::null(), Stdio::from)
    };
    // `NO_COLOR` comes from agent shells (a build started by Codex or Claude Code), not
    // from the user: the terminal is the user's, in color.
    let started = process(&launch)
        .env_remove("NO_COLOR")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(errors())
        .spawn();
    let child = match started {
        Ok(child) => child,
        Err(_) if os == Os::Windows => {
            let fallback = launch::windows_console_fallback(
                &settings,
                session.runtime,
                &session.folder,
                &resume,
                pid_path.as_deref(),
            );
            hidden(&mut process(&fallback))
                .spawn()
                .map_err(|e| internal(format!("cannot open a terminal: {e}")))?
        }
        Err(e) => {
            return Err(internal(format!(
                "cannot open a terminal ({}): {e}; set one in Settings → Agents (e.g. `kitty` \
                 or `gnome-terminal --`)",
                launch.program
            )));
        }
    };
    if !takes_over {
        return Ok(());
    }
    if session.state != SessionState::Terminal {
        with_store(&state, |s| {
            s.execute_without_undo(vec![Command::UpdateAgentSession {
                id: session.id.clone(),
                changes: vec![AgentSessionChange::State(SessionState::Terminal)],
            }])
        })?;
    }
    watch_terminal(
        &app,
        &session,
        Some(TerminalProcess {
            child,
            program: launch.program,
        }),
    );
    Ok(())
}

/// How long opening a terminal waits for the headless run it takes over to end.
const TAKE_OVER_WAIT: Duration = Duration::from_secs(5);

/// Stops the session's headless run and waits until its end is recorded (`finish`), so
/// that record cannot land after the session became `terminal`.
fn stop_for_terminal(state: &AppState, id: &str) -> CommandResult<()> {
    let run = state
        .agents
        .live
        .lock()
        .map_err(|_| internal("agent lock poisoned"))?
        .get(id)
        .map(|l| (l.child.clone(), l.cancelled.clone()));
    let Some((child, cancelled)) = run else {
        return Ok(());
    };
    cancelled.store(true, Ordering::SeqCst);
    if let Ok(mut child) = child.lock() {
        let _ = child.kill();
    }
    let deadline = std::time::Instant::now() + TAKE_OVER_WAIT;
    while std::time::Instant::now() < deadline {
        let ended = !is_live(state, id)?
            && with_store(state, |s| s.agent_session(id))?.state != SessionState::Running;
        if ended {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    eprintln!("agent session {id}: the run did not stop in time for its terminal");
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Terminal sessions: no loose terminals once the work is done

/// In the session's folder: claude's pid, written by the terminal's shell before `exec`.
const TERMINAL_PID_FILE: &str = "terminal.pid";
/// In the session's folder: what the last terminal opened for it printed on stderr.
const TERMINAL_LOG_FILE: &str = "terminal.log";
/// How often a watcher reads the session's state.
const TERMINAL_POLL: Duration = Duration::from_secs(1);
/// Every this many polls, a watcher also checks claude is still running.
const TERMINAL_PROBE_EVERY: u32 = 5;
/// After the session is done, time for Claude's last message before its terminal closes.
const TERMINAL_CLOSE_GRACE: Duration = Duration::from_secs(8);
/// Between SIGTERM and SIGKILL.
const TERMINAL_KILL_WAIT: Duration = Duration::from_secs(3);

/// What a terminal watcher does next.
#[derive(Debug, PartialEq, Eq)]
enum Watch {
    Keep,
    /// Claude or its window is gone while the session is in the terminal: mark it done.
    Done,
    /// The session ended (agent summary, Mark done, removed): stop claude.
    Close,
    /// Nothing left to do.
    Stop,
}

/// `state`: the session's (`None` once removed). `window_closed`: the terminal process the
/// app started exited after [`TERMINAL_LAUNCHER`] (launchers exit at once and say nothing).
/// `claude`: whether the recorded pid still runs this session's claude, when known.
fn watch_step(state: Option<SessionState>, window_closed: bool, claude: Option<bool>) -> Watch {
    let gone = claude == Some(false) || (claude.is_none() && window_closed);
    match state {
        Some(SessionState::Terminal) if gone => Watch::Done,
        Some(SessionState::Terminal) => Watch::Keep,
        _ if gone => Watch::Stop,
        _ => Watch::Close,
    }
}

/// A terminal this app started for a session.
struct TerminalProcess {
    child: Child,
    /// The terminal program, for messages.
    program: String,
}

/// A terminal that exits with an error before [`TERMINAL_LAUNCHER`] and before its shell
/// recorded claude's pid never showed the conversation (a missing library, a bad option):
/// left as is, the session would stay "In terminal" with nothing open.
fn terminal_failed(quick: bool, success: bool, pid_recorded: bool) -> bool {
    quick && !success && !pid_recorded
}

/// The session's error when its terminal could not start: the status, and the lines of
/// what it printed that name an error (else its last line).
fn terminal_failure(program: &str, status: &str, stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let mut said: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|l| l.to_lowercase().contains("error"))
        .take(2)
        .collect();
    if said.is_empty() {
        said.extend(lines.last());
    }
    let mut message = format!("The terminal ({program}) closed at once ({status})");
    if !said.is_empty() {
        let said: String = said.join(" ").chars().take(400).collect();
        message.push_str(&format!(": {said}"));
    }
    message.push_str(". Pick another terminal in Settings → Agents, or open it again.");
    message
}

fn read_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// Whether `pid` runs claude for this session (its command line names the Claude session
/// id, so a reused pid is never mistaken for it); `None` when it cannot be checked.
fn claude_alive(
    settings: &AgentSettings,
    runtime: AgentRuntime,
    os: Os,
    pid: u32,
    claude_session_id: &str,
) -> Option<bool> {
    let probe = launch::probe_command(settings, runtime, os, pid)?;
    let output = hidden(&mut process(&probe))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&output.stdout).contains(claude_session_id))
}

/// Stops this session's claude (SIGTERM, then SIGKILL), which closes most terminals, and
/// the terminal process the app started if it is still there.
fn close_terminal(
    settings: &AgentSettings,
    session: &AgentSession,
    os: Os,
    pid: Option<u32>,
    child: Option<&mut Child>,
) {
    let alive = |pid| {
        claude_alive(
            settings,
            session.runtime,
            os,
            pid,
            &session.claude_session_id,
        ) == Some(true)
    };
    if let Some(pid) = pid.filter(|pid| alive(*pid)) {
        for signal in ["TERM", "KILL"] {
            if let Some(kill) = launch::signal_command(settings, session.runtime, os, pid, signal) {
                let _ = hidden(&mut process(&kill))
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            let sent = Instant::now();
            while alive(pid) && sent.elapsed() < TERMINAL_KILL_WAIT {
                std::thread::sleep(Duration::from_millis(200));
            }
            if !alive(pid) {
                break;
            }
        }
    }
    if let Some(child) = child
        && matches!(child.try_wait(), Ok(None))
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Watches a session continued in a terminal: marks it done when claude or its window goes
/// away, and once it is done (the agent's summary, Mark done) or removed, stops claude so
/// no terminal is left behind. `child` is the terminal process when this app started it.
fn watch_terminal(app: &AppHandle, session: &AgentSession, child: Option<TerminalProcess>) {
    let state = app.state::<AppState>();
    let first = state
        .agents
        .watched
        .lock()
        .is_ok_and(|mut watched| watched.insert(session.id.clone()));
    if !first {
        return;
    }
    let app = app.clone();
    let id = session.id.clone();
    let session = session.clone();
    let spawned = std::thread::Builder::new()
        .name("agent-terminal".into())
        .spawn(move || {
            let state = app.state::<AppState>();
            run_watch(&state, &session, child);
            if let Ok(mut watched) = state.agents.watched.lock() {
                watched.remove(&session.id);
            }
        });
    if let Err(e) = spawned {
        eprintln!("cannot watch the terminal of agent session {id}: {e}");
        if let Ok(mut watched) = state.agents.watched.lock() {
            watched.remove(&id);
        }
    }
}

/// `session` is as it was before its terminal opened.
fn run_watch(state: &AppState, session: &AgentSession, mut child: Option<TerminalProcess>) {
    let os = Os::current();
    let opened = Instant::now();
    let session_dir = state.data_dir.join("agents").join(&session.id);
    let pid_file = session_dir.join(TERMINAL_PID_FILE);
    let mut window_closed = false;
    let mut claude = None;
    for tick in 1u32.. {
        std::thread::sleep(TERMINAL_POLL);
        if let Some(t) = child.as_mut()
            && let Ok(Some(status)) = t.child.try_wait()
        {
            let quick = opened.elapsed() < TERMINAL_LAUNCHER;
            if terminal_failed(quick, status.success(), read_pid(&pid_file).is_some()) {
                let stderr = std::fs::read_to_string(session_dir.join(TERMINAL_LOG_FILE))
                    .unwrap_or_default();
                let error = terminal_failure(&t.program, &status.to_string(), &stderr);
                // Back to where it was; a session already stuck in the terminal is done.
                let back = match session.state {
                    SessionState::Terminal | SessionState::Running => SessionState::Done,
                    other => other,
                };
                let reverted = with_store(state, |s| {
                    s.execute_without_undo(vec![Command::UpdateAgentSession {
                        id: session.id.clone(),
                        changes: vec![
                            AgentSessionChange::State(back),
                            AgentSessionChange::Error(Some(error.clone())),
                        ],
                    }])
                });
                if let Err(e) = reverted {
                    eprintln!(
                        "cannot record the failed terminal of {}: {}",
                        session.id, e.message
                    );
                }
                break;
            }
            window_closed = !quick;
            child = None;
        }
        let Ok(settings) = settings(state) else {
            return;
        };
        let current = with_store(state, |s| s.agent_session(&session.id))
            .ok()
            .filter(|s| s.deleted_at.is_none())
            .map(|s| s.state);
        let pid = read_pid(&pid_file);
        // Check the process when it matters: periodically, and before acting on an end.
        if current != Some(SessionState::Terminal) || tick % TERMINAL_PROBE_EVERY == 0 {
            claude = pid.and_then(|pid| {
                claude_alive(
                    &settings,
                    session.runtime,
                    os,
                    pid,
                    &session.claude_session_id,
                )
            });
        }
        match watch_step(current, window_closed, claude) {
            Watch::Keep => {}
            Watch::Done => {
                let ended = with_store(state, |s| {
                    s.execute_without_undo(vec![Command::UpdateAgentSession {
                        id: session.id.clone(),
                        changes: vec![AgentSessionChange::State(SessionState::Done)],
                    }])
                });
                if let Err(e) = ended {
                    eprintln!("cannot end agent session {}: {}", session.id, e.message);
                }
                break;
            }
            Watch::Close => {
                std::thread::sleep(TERMINAL_CLOSE_GRACE);
                close_terminal(
                    &settings,
                    session,
                    os,
                    pid,
                    child.as_mut().map(|t| &mut t.child),
                );
                break;
            }
            Watch::Stop => break,
        }
    }
    let _ = std::fs::remove_file(&pid_file);
}

/// At start-up: watch again the terminal sessions of this device that recorded claude's
/// pid, so an app restart never leaves a finished one open.
pub fn watch_terminals(app: &AppHandle) {
    let state = app.state::<AppState>();
    let sessions = with_store(&state, |s| {
        let device = s.device_id().to_owned();
        Ok(s.snapshot()?
            .agent_sessions
            .into_iter()
            .filter(|a| a.state == SessionState::Terminal && a.device_id == device)
            .collect::<Vec<_>>())
    });
    match sessions {
        Ok(sessions) => {
            for session in sessions {
                let pid_file = state
                    .data_dir
                    .join("agents")
                    .join(&session.id)
                    .join(TERMINAL_PID_FILE);
                if pid_file.is_file() {
                    watch_terminal(app, &session, None);
                }
            }
        }
        Err(e) => eprintln!("cannot list terminal sessions: {}", e.message),
    }
}

/// Whether an executable `name` is in a directory of this process's `PATH`.
fn on_path(name: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|dir| {
            std::fs::metadata(dir.join(name)).is_ok_and(|m| m.is_file() && is_executable(&m))
        })
    })
}

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_: &std::fs::Metadata) -> bool {
    true
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

/// The Claude plan's usage limits (5-hour and weekly windows), read with Claude Code's
/// sign-in where agents run; an `invalid` error carries a message to show as is.
#[tauri::command(async)]
#[specta::specta]
pub fn claude_plan_usage(state: State<'_, AppState>) -> CommandResult<plan::PlanUsage> {
    let settings = settings(&state)?;
    plan::fetch(&settings).map_err(invalid)
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
    .map_err(|e| invalid(format!("cannot look for the agent: {e}")))?;
    let found = launch::found_path(&String::from_utf8_lossy(&lookup.stdout))
        .ok_or_else(|| invalid("The agent was not found; install it, or give its full path"))?;
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
            model: None,
            prompt: String::new(),
            state: SessionState::Running,
            started_at: 1,
            ended_at: None,
            summary: None,
            cost_usd_micros: Some(1_000),
            turns: Some(2),
            duration_ms: Some(4_000),
            error: None,
            created_at: 1,
            updated_at: 1,
            deleted_at: None,
        }
    }

    #[test]
    fn spawned_claudes_are_not_sub_sessions_of_the_one_that_started_the_app() {
        let launch = Launch {
            program: "claude".into(),
            args: vec![],
            cwd: None,
        };
        let p = process(&launch);
        let removed: Vec<_> = p
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        for var in [
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDECODE",
        ] {
            assert!(removed.iter().any(|r| r == var), "{var} is removed");
        }
        // The user's own configuration passes through.
        for kept in [
            "ANTHROPIC_API_KEY",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_USE_BEDROCK",
        ] {
            assert!(!removed.iter().any(|r| r == kept), "{kept} is kept");
        }
    }

    #[test]
    fn a_terminal_that_cannot_start_is_reported() {
        // An error exit before the shell ran: failed. A launcher handing over (success), a
        // late exit (the window closed) or a recorded pid (claude ran) are not.
        assert!(terminal_failed(true, false, false));
        assert!(!terminal_failed(true, true, false));
        assert!(!terminal_failed(false, false, false));
        assert!(!terminal_failed(true, false, true));

        // kitty started with the AppImage's PYTHONHOME (the bug this guards against).
        let kitty = "Python path configuration:\n  PYTHONHOME = '/tmp/.mount_x/usr/'\n\
                     Fatal Python error: init_fs_encoding: failed to get the Python codec\n\
                     Python runtime state: core initialized\n\
                     ModuleNotFoundError: No module named 'encodings'\n\n\
                     Current thread 0x0001 (most recent call first):\n  <no Python frame>\n";
        let message = terminal_failure("kitty", "exit status: 1", kitty);
        assert_eq!(
            message,
            "The terminal (kitty) closed at once (exit status: 1): Fatal Python error: \
             init_fs_encoding: failed to get the Python codec ModuleNotFoundError: No module \
             named 'encodings'. Pick another terminal in Settings → Agents, or open it again."
        );
        assert!(
            terminal_failure("foot", "exit status: 2", "foot: unknown option -- x\n")
                .contains("(exit status: 2): foot: unknown option -- x.")
        );
        assert!(terminal_failure("st", "signal: 6", "").contains("(signal: 6). Pick"));
    }

    #[test]
    fn a_terminal_watcher_ends_and_closes_at_the_right_moments() {
        use SessionState::{Done, Terminal};
        // In the terminal: keep going while claude runs or cannot be checked.
        assert_eq!(watch_step(Some(Terminal), false, Some(true)), Watch::Keep);
        assert_eq!(watch_step(Some(Terminal), false, None), Watch::Keep);
        // Claude exited (/exit in a launcher terminal) or its window closed: done.
        assert_eq!(watch_step(Some(Terminal), false, Some(false)), Watch::Done);
        assert_eq!(watch_step(Some(Terminal), true, None), Watch::Done);
        // The agent recorded its summary, or the user marked it done or removed it: close
        // what is still open, also when only the window is known to be there.
        assert_eq!(watch_step(Some(Done), false, Some(true)), Watch::Close);
        assert_eq!(watch_step(Some(Done), false, None), Watch::Close);
        assert_eq!(watch_step(None, false, Some(true)), Watch::Close);
        // Nothing left running.
        assert_eq!(watch_step(Some(Done), false, Some(false)), Watch::Stop);
        assert_eq!(watch_step(Some(Done), true, None), Watch::Stop);
    }

    /// The real thing on this machine: the terminal script records the pid of what it
    /// `exec`s, the check recognises it by the Claude session id, and closing stops it.
    #[cfg(unix)]
    #[test]
    fn a_finished_terminal_session_is_stopped_by_its_recorded_pid() {
        let dir = std::env::temp_dir().join(format!("tm-terminal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join(TERMINAL_PID_FILE);
        let mut session = session();
        session.claude_session_id = format!("0199a000-test-{}", std::process::id());
        // `claude` stands in as `sh -c 'while :; do sleep 1; done' <session id>`, so its
        // command line carries the id like `claude --resume <id>` does (a lone `sleep`
        // would be exec'd and drop it), and no long sleep outlives the test.
        let settings = AgentSettings {
            claude_path: "sh".into(),
            ..AgentSettings::default()
        };
        let resume = vec![
            "-c".into(),
            "while :; do sleep 1; done".into(),
            session.claude_session_id.clone(),
        ];
        let launch = launch::terminal_command(
            &settings,
            AgentRuntime::Native,
            dir.to_str().unwrap(),
            &resume,
            pid_file.to_str(),
            Os::Linux,
            Some("env"),
        );
        let mut window = process(&launch).spawn().unwrap();
        let mut pid = None;
        for _ in 0..50 {
            pid = read_pid(&pid_file);
            if pid.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let pid = pid.expect("the script writes the pid");
        assert_eq!(pid, window.id(), "exec keeps the pid");
        let os = Os::current();
        let id = session.claude_session_id.clone();
        assert_eq!(
            claude_alive(&settings, AgentRuntime::Native, os, pid, &id),
            Some(true)
        );
        // Another session's id never matches, so a reused pid is left alone.
        assert_eq!(
            claude_alive(&settings, AgentRuntime::Native, os, pid, "other"),
            Some(false)
        );

        close_terminal(&settings, &session, os, Some(pid), None);
        let status = window.wait().unwrap();
        assert!(!status.success(), "stopped by a signal");
        assert_eq!(
            claude_alive(&settings, AgentRuntime::Native, os, pid, &id),
            Some(false)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn result(is_error: bool) -> RunResult {
        RunResult {
            is_error,
            subtype: "success".into(),
            text: Some("All done.".into()),
            cost_usd_micros: Some(500),
            turns: Some(3),
            duration_ms: Some(6_000),
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
                AgentSessionChange::DurationMs(Some(10_000)),
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
                    model: None,
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
                None,
            ),
        )
        .unwrap();
        let rules = dir.join("rules.md");
        std::fs::write(&rules, session_rules(&task.title, &task.id, "Review", None)).unwrap();
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
                model: session.model.as_deref(),
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
        let rules = session_rules("Fix sync", "0190-id", "To check", None);
        assert!(rules.contains("\"Fix sync\" (id `0190-id`)"));
        assert!(rules.contains("complete_session"));
        assert!(rules.contains("moves this task to To check"));
        assert!(rules.contains("mark each one done"), "{rules}");
        assert!(!rules.contains("standing instructions"));
        assert_eq!(
            session_rules("Fix sync", "0190-id", "To check", Some("  \n ")),
            rules
        );
        let directed = session_rules(
            "Fix sync",
            "0190-id",
            "To check",
            Some("\nAnswer in French.\nCommit on a branch.\n\n"),
        );
        let (head, tail) = directed
            .split_once("# The user's standing instructions")
            .unwrap();
        assert_eq!(head, format!("{rules}\n"));
        assert!(
            tail.ends_with("\n\nAnswer in French.\nCommit on a branch.\n"),
            "{tail}"
        );
        let picked: serde_json::Value =
            serde_json::from_str(&mcp_config("tm-mcp", "tm.sqlite", "s1", Some("st1"))).unwrap();
        assert_eq!(
            picked["mcpServers"]["task-master"]["args"],
            serde_json::json!([
                "--db",
                "tm.sqlite",
                "--session",
                "s1",
                "--done-status",
                "st1"
            ])
        );
        let config: serde_json::Value = serde_json::from_str(&mcp_config(
            "/mnt/c/tm/task-master-mcp.exe",
            r"C:\data\tm.sqlite",
            "s1",
            None,
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

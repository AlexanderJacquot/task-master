//! Terminal sessions (M21, ADR 028): the Claude Code sessions run outside the app, read
//! from the transcripts Claude Code keeps (`<config>/projects/<folder>/<session>.jsonl`,
//! where agents run: this device or WSL) and recorded with `RecordTerminalSessions`, so
//! their cost and time count with the app's own agent sessions.
//!
//! The transcript format is Claude Code's own, not a documented API: unknown lines are
//! ignored, and a session without a reply from the model is skipped. The cost is Claude
//! Code's own total (`cost-state`), not a price list of ours; a transcript without one
//! has no cost.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use taskmaster_core::{AgentRuntime, Command, TerminalSessionRecord};
use tauri::{AppHandle, Manager, State};

use super::launch::Launch;
use super::{hidden, process, settings};
use crate::config::AgentSettings;
use crate::{AppState, CommandResult, invalid, with_store};

/// A transcript's session, as far as the totals need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transcript {
    pub folder: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub started_at: i64,
    pub ended_at: i64,
    pub cost_usd_micros: Option<i64>,
    pub duration_ms: Option<i64>,
    pub turns: i64,
}

/// One process's running totals (`cost-state` lines repeat them; the last one counts).
#[derive(Default)]
struct CostState {
    cost_usd: f64,
    api_ms: i64,
    tool_ms: i64,
}

/// The lines read; the others (requests, file history) can be large and are skipped
/// without parsing. Claude Code writes compact JSON.
const WANTED: &[&str] = &[
    "\"type\":\"assistant\"",
    "\"type\":\"user\"",
    "\"type\":\"cost-state\"",
    "\"type\":\"ai-title\"",
    "\"type\":\"custom-title\"",
    "\"subtype\":\"turn_duration\"",
];

/// Reads a transcript; `None` when the model never answered in it.
pub fn read(reader: impl BufRead) -> Option<Transcript> {
    let mut folder = None;
    let mut started_at = None;
    let mut ended_at = None;
    let mut ai_title = None;
    let mut custom_title = None;
    let mut output_by_model: HashMap<String, i64> = HashMap::new();
    let mut requests: HashSet<String> = HashSet::new();
    let mut replies = 0_i64;
    let mut turn_ms = 0_i64;
    // By the process's start: a resumed session may start its totals again.
    let mut costs: Vec<(i64, CostState)> = Vec::new();

    for line in reader.lines() {
        let Ok(line) = line else { break };
        if !WANTED.iter().any(|w| line.contains(w)) {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let text = |key: &str| value.get(key).and_then(Value::as_str);
        match text("type") {
            Some(kind @ ("assistant" | "user")) => {
                if folder.is_none() {
                    folder = text("cwd").map(str::to_owned);
                }
                if let Some(at) = text("timestamp").and_then(parse_time) {
                    started_at = Some(started_at.map_or(at, |s: i64| s.min(at)));
                    ended_at = Some(ended_at.map_or(at, |e: i64| e.max(at)));
                }
                if kind == "assistant" {
                    let message = value.get("message");
                    let model = message
                        .and_then(|m| m.get("model"))
                        .and_then(Value::as_str)
                        .filter(|m| !m.starts_with('<'));
                    if let Some(model) = model {
                        replies += 1;
                        let output = message
                            .and_then(|m| m.pointer("/usage/output_tokens"))
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                        *output_by_model.entry(model.to_owned()).or_default() += output;
                        if value.get("isSidechain").and_then(Value::as_bool) != Some(true) {
                            match text("requestId") {
                                Some(id) => {
                                    requests.insert(id.to_owned());
                                }
                                None => {
                                    requests.insert(format!("line-{replies}"));
                                }
                            }
                        }
                    }
                }
            }
            Some("cost-state") => {
                let start = value.get("startTime").and_then(Value::as_i64).unwrap_or(0);
                let state = CostState {
                    cost_usd: value
                        .get("totalCostUSD")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0),
                    api_ms: value
                        .get("totalAPIDuration")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                    tool_ms: value
                        .get("totalToolDuration")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                };
                match costs.iter_mut().find(|(s, _)| *s == start) {
                    Some((_, last)) => *last = state,
                    None => costs.push((start, state)),
                }
            }
            Some("ai-title") => ai_title = text("aiTitle").map(str::to_owned),
            Some("custom-title") => custom_title = text("customTitle").map(str::to_owned),
            Some("system") if text("subtype") == Some("turn_duration") => {
                turn_ms += value
                    .get("durationMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(0);
            }
            _ => {}
        }
    }

    if replies == 0 {
        return None;
    }
    let cost_usd_micros = (!costs.is_empty()).then(|| {
        let usd: f64 = costs.iter().map(|(_, c)| c.cost_usd.max(0.0)).sum();
        (usd * 1_000_000.0).round() as i64
    });
    let duration_ms = if turn_ms > 0 {
        Some(turn_ms)
    } else {
        let worked: i64 = costs.iter().map(|(_, c)| c.api_ms + c.tool_ms).sum();
        (worked > 0).then_some(worked)
    };
    let model = output_by_model
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
        .map(|(m, _)| m);
    Some(Transcript {
        folder: folder?,
        title: custom_title.or(ai_title),
        model,
        started_at: started_at?,
        ended_at: ended_at?,
        cost_usd_micros,
        duration_ms,
        turns: requests.len() as i64,
    })
}

/// `2026-11-15T21:39:58.080Z` (UTC, as Claude Code writes it) as Unix ms.
fn parse_time(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 20 || !text.ends_with('Z') || b[4] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    let fraction = &text[19..text.len() - 1];
    let millis = match fraction.strip_prefix('.') {
        None if fraction.is_empty() => 0,
        Some(digits) if !digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit()) => {
            format!("{digits:0<3}")[..3].parse::<i64>().ok()?
        }
        _ => return None,
    };
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis)
}

// ---------------------------------------------------------------------------------------
// Scanning

/// Kept in the data folder: each transcript's size and change time when last read, so a
/// scan reads only what changed.
const CACHE_FILE: &str = "terminal-sessions.json";
/// Records per batch: one op batch should stay small.
const CHUNK: usize = 100;
/// How often the background scan runs.
const INTERVAL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Default, Serialize, Deserialize)]
struct Cache {
    /// Where the transcripts were read from: a new place starts again.
    root: String,
    files: HashMap<String, (u64, u64)>,
}

/// What one scan did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct TerminalScan {
    /// Transcripts read (new or changed since the last scan).
    pub read: u32,
    /// Sessions added or updated.
    pub recorded: u32,
}

/// One scan at a time: the background one and "Import now" share it.
static SCANNING: Mutex<()> = Mutex::new(());

/// Claude Code's `projects` folder where agents run, as this process can read it.
fn projects_dir(settings: &AgentSettings) -> Result<PathBuf, String> {
    if settings.runtime == AgentRuntime::Wsl {
        let mut args: Vec<String> = match &settings.wsl_distro {
            Some(distro) => vec!["-d".into(), distro.clone()],
            None => Vec::new(),
        };
        args.extend([
            "--exec".into(),
            "sh".into(),
            "-c".into(),
            r#"wslpath -w "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects""#.into(),
        ]);
        let launch = Launch {
            program: "wsl.exe".into(),
            args,
            cwd: None,
        };
        let out = hidden(&mut process(&launch))
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("cannot reach WSL: {e}"))?;
        let path = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if !out.status.success() || path.is_empty() {
            return Err("cannot find Claude Code's folder in WSL".into());
        }
        return Ok(PathBuf::from(path));
    }
    let config = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|home| PathBuf::from(home).join(".claude"))
        })
        .ok_or("cannot find the home folder")?;
    Ok(config.join("projects"))
}

/// Every `<folder>/<session>.jsonl` (not the sub-agents' transcripts in subfolders).
fn transcripts(root: &Path) -> Vec<(PathBuf, u64, u64)> {
    let Ok(folders) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for folder in folders.flatten() {
        let Ok(files) = std::fs::read_dir(folder.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let Ok(meta) = file.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            found.push((path, meta.len(), modified));
        }
    }
    found
}

/// The session id a transcript is named after, when it is one.
fn session_id(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let uuid = stem.len() == 36
        && stem.char_indices().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        });
    uuid.then(|| stem.to_owned())
}

fn load_cache(path: &Path) -> Cache {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Reads new and changed transcripts and records their sessions.
pub fn scan(state: &AppState) -> Result<TerminalScan, String> {
    let _one = SCANNING.lock().map_err(|_| "scan lock poisoned")?;
    let settings = settings(state).map_err(|e| e.message)?;
    let root = projects_dir(&settings)?;
    let cache_path = state.data_dir.join(CACHE_FILE);
    let mut cache = load_cache(&cache_path);
    let root_text = root.display().to_string();
    if cache.root != root_text {
        cache = Cache {
            root: root_text,
            files: HashMap::new(),
        };
    }

    let mut report = TerminalScan::default();
    let mut records = Vec::new();
    let mut read_files = Vec::new();
    let mut present = HashSet::new();
    for (path, size, modified) in transcripts(&root) {
        let key = path.display().to_string();
        present.insert(key.clone());
        if cache.files.get(&key) == Some(&(size, modified)) {
            continue;
        }
        let Some(claude_session_id) = session_id(&path) else {
            continue;
        };
        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        report.read += 1;
        if let Some(t) = read(BufReader::new(file)) {
            records.push(TerminalSessionRecord {
                id: None,
                claude_session_id,
                folder: t.folder,
                title: t.title,
                model: t.model,
                started_at: t.started_at,
                ended_at: t.ended_at,
                cost_usd_micros: t.cost_usd_micros,
                duration_ms: t.duration_ms,
                turns: Some(t.turns),
            });
        }
        read_files.push((key, (size, modified)));
    }

    for chunk in records.chunks(CHUNK) {
        let changes = with_store(state, |s| {
            s.execute_without_undo(vec![Command::RecordTerminalSessions {
                sessions: chunk.to_vec(),
            }])
        })
        .map_err(|e| e.message)?;
        report.recorded += changes.terminal_sessions.len() as u32;
    }
    // Remembered only once recorded, so a failed write is read again next time.
    cache.files.retain(|k, _| present.contains(k));
    cache.files.extend(read_files);
    if let Ok(bytes) = serde_json::to_vec(&cache) {
        let _ = std::fs::write(&cache_path, bytes);
    }
    Ok(report)
}

/// Scans shortly after start, then every few minutes, while the setting is on.
pub fn run(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("terminal-sessions".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_secs(15));
            loop {
                let state = app.state::<AppState>();
                let on = settings(&state).is_ok_and(|s| s.import_terminal_sessions);
                if on && let Err(e) = scan(&state) {
                    eprintln!("cannot read terminal sessions: {e}");
                }
                std::thread::sleep(INTERVAL);
            }
        });
}

/// Reads the terminal sessions now ("Import now" on the Agents page).
#[tauri::command(async)]
#[specta::specta]
pub fn scan_terminal_sessions(state: State<'_, AppState>) -> CommandResult<TerminalScan> {
    scan(&state).map_err(invalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(items: &[Value]) -> String {
        items
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn reply(at: &str, model: &str, request: &str, output: i64) -> Value {
        serde_json::json!({
            "type": "assistant", "timestamp": at, "cwd": "/home/alex/Code/task-master",
            "requestId": request, "isSidechain": false,
            "message": {"model": model, "usage": {"output_tokens": output}}
        })
    }

    #[test]
    fn a_transcript_gives_its_folder_times_cost_and_work() {
        let text = lines(&[
            serde_json::json!({"type": "mode", "mode": "normal"}),
            serde_json::json!({"type": "user", "timestamp": "2026-11-15T21:39:53.000Z",
                "cwd": "/home/alex/Code/task-master", "message": {"role": "user", "content": "hi"}}),
            reply("2026-11-15T21:39:58.000Z", "claude-opus-5-5", "req_1", 500),
            reply("2026-11-15T21:40:02.000Z", "claude-opus-5-5", "req_1", 20),
            reply("2026-11-15T21:40:05.000Z", "claude-haiku-5-5", "req_2", 10),
            reply("2026-11-15T21:41:00.000Z", "<synthetic>", "req_3", 0),
            serde_json::json!({"type": "system", "subtype": "turn_duration", "durationMs": 28_667}),
            serde_json::json!({"type": "system", "subtype": "turn_duration", "durationMs": 1_333}),
            serde_json::json!({"type": "ai-title", "aiTitle": "Model downloads"}),
            // Repeated totals of one process: the last counts; a second process adds up.
            serde_json::json!({"type": "cost-state", "startTime": 1, "totalCostUSD": 1.0}),
            serde_json::json!({"type": "cost-state", "startTime": 1, "totalCostUSD": 18.5304889}),
            serde_json::json!({"type": "cost-state", "startTime": 2, "totalCostUSD": 0.25}),
            serde_json::json!({"type": "user", "timestamp": "2026-11-15T22:00:00.000Z"}),
        ]);
        let t = read(text.as_bytes()).unwrap();
        assert_eq!(t.folder, "/home/alex/Code/task-master");
        assert_eq!(t.title.as_deref(), Some("Model downloads"));
        assert_eq!(t.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(t.started_at, 1_794_778_793_000);
        assert_eq!(t.ended_at, 1_794_780_000_000);
        assert_eq!(t.cost_usd_micros, Some(18_780_489));
        assert_eq!(t.duration_ms, Some(30_000));
        assert_eq!(t.turns, 2);
    }

    #[test]
    fn a_renamed_session_keeps_its_name_and_missing_totals_stay_unknown() {
        let text = lines(&[
            reply("2026-11-15T10:00:00.000Z", "claude-sonnet-5-5", "r", 5),
            serde_json::json!({"type": "ai-title", "aiTitle": "Guessed"}),
            serde_json::json!({"type": "custom-title", "customTitle": "Mine"}),
            "not json".into(),
        ]);
        let t = read(text.as_bytes()).unwrap();
        assert_eq!(t.title.as_deref(), Some("Mine"));
        assert_eq!(t.cost_usd_micros, None);
        assert_eq!(t.duration_ms, None);
    }

    #[test]
    fn a_session_the_model_never_answered_is_skipped() {
        let text = lines(&[
            serde_json::json!({"type": "user", "timestamp": "2026-11-15T10:00:00.000Z", "cwd": "/x"}),
            serde_json::json!({"type": "cost-state", "startTime": 1, "totalCostUSD": 0.0}),
        ]);
        assert_eq!(read(text.as_bytes()), None);
    }

    #[test]
    fn timestamps_are_read_as_utc() {
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_time("2026-11-15T21:39:58.080Z"),
            Some(1_794_778_798_080)
        );
        assert_eq!(
            parse_time("2024-02-29T12:00:00.5Z"),
            Some(1_709_208_000_500)
        );
        assert_eq!(parse_time("2026-11-15 21:39:58Z"), None);
        assert_eq!(parse_time("2026-13-15T21:39:58Z"), None);
    }

    #[test]
    fn transcripts_are_named_after_their_session() {
        let dir = std::env::temp_dir().join(format!("tm-terminal-{}", taskmaster_core::new_id()));
        let folder = dir.join("-home-alex-Code-x");
        std::fs::create_dir_all(folder.join("abc/subagents")).unwrap();
        let id = "570eb077-f629-4e89-8f67-955cd640f8fd";
        std::fs::write(folder.join(format!("{id}.jsonl")), "{}").unwrap();
        std::fs::write(folder.join("notes.txt"), "").unwrap();
        std::fs::write(folder.join("abc/subagents/agent-1.jsonl"), "{}").unwrap();
        let found = transcripts(&dir);
        assert_eq!(found.len(), 1);
        assert_eq!(session_id(&found[0].0).as_deref(), Some(id));
        assert_eq!(session_id(Path::new("/x/agent-1.jsonl")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod real {
    /// Reads this machine's own transcripts: `cargo test -p taskmaster-desktop --lib
    /// real_transcripts -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads ~/.claude/projects"]
    fn real_transcripts() {
        let root = super::projects_dir(&crate::config::AgentSettings::default()).unwrap();
        let started = std::time::Instant::now();
        let (mut n, mut cost, mut ms) = (0, 0_i64, 0_i64);
        for (path, ..) in super::transcripts(&root) {
            let file = std::fs::File::open(&path).unwrap();
            if let Some(t) = super::read(std::io::BufReader::new(file)) {
                n += 1;
                cost += t.cost_usd_micros.unwrap_or(0);
                ms += t.duration_ms.unwrap_or(0);
            }
        }
        println!(
            "{n} sessions, ${:.2}, {:.1} h worked, read in {:?}",
            cost as f64 / 1e6,
            ms as f64 / 3.6e6,
            started.elapsed()
        );
    }
}

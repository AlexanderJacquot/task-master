//! Claude Code's `--output-format stream-json` output, one JSON object per line, read into
//! what the app shows: a live activity line, permission denials, and the final result.
//! Unknown lines and fields are ignored, so newer Claude Code versions keep working.

use serde_json::Value;

/// The end of a run (`"type": "result"`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResult {
    pub is_error: bool,
    /// `success`, `error_max_turns`, `error_during_execution`, …
    pub subtype: String,
    /// Claude's final message.
    pub text: Option<String>,
    pub cost_usd_micros: Option<i64>,
    pub turns: Option<i64>,
    /// How long the run took, in ms.
    pub duration_ms: Option<i64>,
    /// Tools refused because the permission mode needed an approval nobody could give.
    pub denials: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The session started (`system/init`), with Claude Code's session id.
    Started {
        session_id: String,
    },
    /// What the agent is doing now, for the status line.
    Activity(String),
    /// A tool was refused.
    Denied {
        tool: String,
    },
    Finished(RunResult),
    /// Anything else.
    Other,
}

/// Longest activity line, in characters.
const ACTIVITY_CHARS: usize = 90;

pub fn parse_line(line: &str) -> Event {
    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
        return Event::Other;
    };
    let text = |key: &str| value.get(key).and_then(Value::as_str);
    match (text("type"), text("subtype")) {
        (Some("system"), Some("init")) => match text("session_id") {
            Some(id) => Event::Started {
                session_id: id.to_owned(),
            },
            None => Event::Other,
        },
        (Some("system"), Some("permission_denied")) => Event::Denied {
            tool: text("tool_name").unwrap_or("a tool").to_owned(),
        },
        (Some("assistant"), _) => assistant(&value),
        (Some("result"), _) => Event::Finished(result(&value)),
        _ => Event::Other,
    }
}

/// One stream line as readable text for the run log a "Watch in terminal" window follows:
/// Claude's words, each tool it uses, refusals, and the end. Empty for anything else.
pub fn readable(line: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
        return Vec::new();
    };
    let text = |key: &str| value.get(key).and_then(Value::as_str);
    match (text("type"), text("subtype")) {
        (Some("system"), Some("init")) => {
            let mut started = String::from("● Agent started");
            if let Some(model) = text("model") {
                started.push_str(&format!(" ({model})"));
            }
            vec![started]
        }
        (Some("system"), Some("permission_denied")) => {
            vec![format!(
                "  ✗ Not allowed: {}",
                text("tool_name").unwrap_or("a tool")
            )]
        }
        (Some("assistant"), _) => {
            let content = value
                .pointer("/message/content")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let mut out = Vec::new();
            for item in content {
                match item["type"].as_str() {
                    Some("text") => {
                        let said = item["text"].as_str().unwrap_or_default().trim();
                        if !said.is_empty() {
                            out.push(String::new());
                            out.extend(said.lines().map(str::to_owned));
                        }
                    }
                    Some("tool_use") => {
                        let name = item["name"].as_str().unwrap_or("a tool");
                        out.push(format!("  → {}", describe_tool(name, &item["input"])));
                    }
                    _ => {}
                }
            }
            out
        }
        (Some("result"), _) => {
            let r = result(&value);
            let mut end = format!("● Finished ({})", r.subtype.replace('_', " "));
            if let Some(turns) = r.turns {
                end.push_str(&format!(" · {turns} turns"));
            }
            if let Some(micros) = r.cost_usd_micros {
                end.push_str(&format!(" · ${:.4}", micros as f64 / 1_000_000.0));
            }
            vec![String::new(), end]
        }
        _ => Vec::new(),
    }
}

/// The last tool use of an assistant message, else the start of its text.
fn assistant(value: &Value) -> Event {
    let content = value
        .pointer("/message/content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let tool = content.iter().rev().find(|c| c["type"] == "tool_use");
    if let Some(tool) = tool {
        let name = tool["name"].as_str().unwrap_or("a tool");
        return Event::Activity(clip(&describe_tool(name, &tool["input"])));
    }
    let said = content
        .iter()
        .filter(|c| c["type"] == "text")
        .filter_map(|c| c["text"].as_str())
        .flat_map(str::lines)
        .map(str::trim)
        .find(|l| !l.is_empty());
    match said {
        Some(line) => Event::Activity(clip(line)),
        None => Event::Other,
    }
}

fn result(value: &Value) -> RunResult {
    let denials = value["permission_denials"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|d| d["tool_name"].as_str())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    RunResult {
        is_error: value["is_error"].as_bool().unwrap_or(false),
        subtype: value["subtype"].as_str().unwrap_or("unknown").to_owned(),
        text: value["result"]
            .as_str()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned),
        cost_usd_micros: value["total_cost_usd"]
            .as_f64()
            .filter(|c| c.is_finite() && *c >= 0.0)
            .map(|c| (c * 1_000_000.0).round() as i64),
        turns: value["num_turns"].as_i64(),
        duration_ms: value["duration_ms"].as_i64().filter(|ms| *ms >= 0),
        denials,
    }
}

/// "Editing store.rs", "Running `cargo test`", …
fn describe_tool(name: &str, input: &Value) -> String {
    let field = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or_default();
    let file = |key: &str| {
        let path = field(key);
        path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned()
    };
    if let Some(tool) = name.strip_prefix("mcp__task-master__") {
        return match tool {
            "add_note" => format!("Noting: {}", field("body")),
            "create_task" => format!("Planning: {}", field("title")),
            "update_task" => "Updating a task".into(),
            "complete_session" => "Writing the summary".into(),
            _ => "Reading tasks".into(),
        };
    }
    match name {
        "Bash" => {
            let command = field("command").lines().next().unwrap_or_default();
            format!("Running `{command}`")
        }
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => {
            let key = if name == "NotebookEdit" {
                "notebook_path"
            } else {
                "file_path"
            };
            format!("Editing {}", file(key))
        }
        "Read" => format!("Reading {}", file("file_path")),
        "Grep" | "Glob" => format!("Searching for {}", field("pattern")),
        "WebFetch" | "WebSearch" => "Browsing the web".into(),
        "Task" | "Agent" => format!("Delegating: {}", field("description")),
        "TodoWrite" => "Planning".into(),
        "ToolSearch" => "Loading tools".into(),
        other => match other.strip_prefix("mcp__") {
            Some(rest) => format!("Using {}", rest.replace("__", ": ")),
            None => format!("Using {other}"),
        },
    }
}

fn clip(text: &str) -> String {
    let text = text.trim();
    match text.char_indices().nth(ACTIVITY_CHARS) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real run (Claude Code 2.1.318), trimmed: Bash allowed, Write denied.
    const RUN: &str = include_str!("fixtures/run.jsonl");

    #[test]
    fn a_recorded_run_reads_as_a_log_to_watch() {
        let log: Vec<String> = RUN.lines().flat_map(readable).collect();
        assert_eq!(log[0], "● Agent started (claude-haiku-5-5)");
        assert!(
            log.contains(&"  → Running `echo hello`".to_owned()),
            "{log:#?}"
        );
        assert!(
            log.contains(&"  → Editing notes.txt".to_owned()),
            "{log:#?}"
        );
        assert!(
            log.contains(&"  ✗ Not allowed: Write".to_owned()),
            "{log:#?}"
        );
        assert!(
            log.last().unwrap().starts_with("● Finished (success)"),
            "{log:#?}"
        );
        // Tool results and other noise stay out.
        assert!(!log.iter().any(|l| l.contains("tool_result")), "{log:#?}");
        assert!(readable("not json").is_empty());
    }

    #[test]
    fn a_recorded_run_reads_as_status_updates_and_a_result() {
        let events: Vec<Event> = RUN
            .lines()
            .map(parse_line)
            .filter(|e| *e != Event::Other)
            .collect();
        assert_eq!(
            events[..4],
            [
                Event::Started {
                    session_id: "0199a000-0000-7000-8000-00000000abcd".into()
                },
                Event::Activity("Running `echo hello`".into()),
                Event::Activity("Editing notes.txt".into()),
                Event::Denied {
                    tool: "Write".into()
                },
            ]
        );
        let Some(Event::Finished(result)) = events.last() else {
            panic!("no result in {events:?}");
        };
        assert!(!result.is_error);
        assert_eq!(result.subtype, "success");
        assert_eq!(result.turns, Some(3));
        assert_eq!(result.cost_usd_micros, Some(3127));
        assert_eq!(result.duration_ms, Some(4414));
        assert_eq!(result.denials, ["Write"]);
        assert!(
            result
                .text
                .as_deref()
                .unwrap()
                .starts_with("The shell command printed")
        );
        assert!(
            matches!(&events[events.len() - 2], Event::Activity(t) if t.starts_with("The shell"))
        );
    }

    #[test]
    fn tools_are_described_briefly() {
        let describe = |name: &str, input: Value| describe_tool(name, &input);
        assert_eq!(
            describe(
                "Read",
                serde_json::json!({ "file_path": r"C:\dev\src\lib.rs" })
            ),
            "Reading lib.rs"
        );
        assert_eq!(
            describe(
                "Bash",
                serde_json::json!({ "command": "cargo test\n--quiet" })
            ),
            "Running `cargo test`"
        );
        assert_eq!(
            describe(
                "mcp__task-master__add_note",
                serde_json::json!({ "body": "Found it" })
            ),
            "Noting: Found it"
        );
        assert_eq!(
            describe("mcp__github__create_pr", serde_json::json!({})),
            "Using github: create_pr"
        );
        assert_eq!(describe("Frobnicate", Value::Null), "Using Frobnicate");
        let long = clip(&"x".repeat(200));
        assert_eq!(long.chars().count(), ACTIVITY_CHARS + 1);
    }

    #[test]
    fn errors_and_noise_are_handled() {
        let failed = parse_line(
            r#"{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":6,"total_cost_usd":0.5}"#,
        );
        assert_eq!(
            failed,
            Event::Finished(RunResult {
                is_error: true,
                subtype: "error_max_turns".into(),
                text: None,
                cost_usd_micros: Some(500_000),
                turns: Some(6),
                duration_ms: None,
                denials: Vec::new(),
            })
        );
        assert_eq!(parse_line("not json"), Event::Other);
        assert_eq!(parse_line(""), Event::Other);
        assert_eq!(parse_line(r#"{"type":"rate_limit_event"}"#), Event::Other);
        assert_eq!(
            parse_line(r#"{"type":"assistant","message":{"content":[{"type":"thinking"}]}}"#),
            Event::Other
        );
    }
}

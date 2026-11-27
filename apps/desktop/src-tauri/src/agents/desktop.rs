//! Opening a session's conversation in the Claude desktop app (ADR 029 amendment).
//!
//! The desktop app opens one of its Code sessions with
//! `claude://code/continue?session=local_<id>`, where the id is the app's own. It keeps
//! each session's record in `<app data>/claude-code-sessions/<account>/<org>/local_<id>.json`
//! with the Claude Code conversation it runs (`cliSessionId`), which is the id we record
//! (`claude_session_id`). Neither the link nor the files are a documented API: a record we
//! cannot read is skipped, and nothing found is an error the user sees.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

/// The desktop app's record of one of its Code sessions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopSession {
    /// `local_<uuid>`: the id its links take.
    pub id: String,
    /// Archived sessions do not open from a link.
    pub archived: bool,
    last_activity: i64,
}

/// The desktop app's session records on this computer, where it has them.
pub fn sessions_dir() -> Option<PathBuf> {
    let data = if cfg!(target_os = "macos") {
        PathBuf::from(std::env::var_os("HOME")?).join("Library/Application Support")
    } else if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA")?)
    } else {
        return None;
    };
    Some(data.join("Claude").join("claude-code-sessions"))
}

/// The desktop session running one of these conversations: not archived first, then the
/// latest active. `root` is [`sessions_dir`].
pub fn find(root: &Path, conversations: &[&str]) -> Option<DesktopSession> {
    let mut found: Vec<DesktopSession> = Vec::new();
    for account in dirs(root) {
        for org in dirs(&account) {
            let Ok(files) = std::fs::read_dir(&org) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                let named = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("local_") && n.ends_with(".json"));
                if named && let Some(session) = read(&path, conversations) {
                    found.push(session);
                }
            }
        }
    }
    found
        .into_iter()
        .max_by_key(|s| (!s.archived, s.last_activity))
}

fn dirs(path: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(path)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

/// One record, when it runs one of `conversations`.
fn read(path: &Path, conversations: &[&str]) -> Option<DesktopSession> {
    let record: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let runs = ["cliSessionId", "lastAssistantCliSessionId"]
        .iter()
        .filter_map(|k| record.get(*k)?.as_str())
        .any(|id| conversations.contains(&id));
    let id = record.get("sessionId")?.as_str()?;
    (runs && is_local_id(id)).then(|| DesktopSession {
        id: id.to_owned(),
        archived: record.get("isArchived").and_then(Value::as_bool) == Some(true),
        last_activity: record
            .get("lastActivityAt")
            .and_then(Value::as_i64)
            .unwrap_or(0),
    })
}

/// The ids the desktop app's links accept: `local_` and up to 64 letters, digits or `-`.
fn is_local_id(id: &str) -> bool {
    id.strip_prefix("local_").is_some_and(|rest| {
        (1..=64).contains(&rest.len())
            && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

/// The link that opens this desktop session.
pub fn continue_link(session: &DesktopSession) -> String {
    format!("claude://code/continue?session={}", session.id)
}

/// Lines read from the start of a transcript when looking for the first prompt.
const HEAD_LINES: usize = 40;

/// The conversation whose first prompt names `marker` (our agent session id, which the
/// first message of a desktop session carries), among the transcripts written since
/// `since` (Unix ms). For a session whose conversation id was never recorded: one whose
/// agent wrote through the claude.ai connector, which has no environment to read it from.
pub fn conversation_naming(
    transcripts: &[(PathBuf, u64, u64)],
    marker: &str,
    since: u64,
) -> Option<String> {
    let mut recent: Vec<_> = transcripts.iter().filter(|t| t.2 >= since).collect();
    // The oldest first: the conversation that the link opened, not one that quotes it.
    recent.sort_by_key(|t| t.2);
    recent.into_iter().find_map(|(path, _, _)| {
        let file = std::fs::File::open(path).ok()?;
        let named = BufReader::new(file)
            .lines()
            .take(HEAD_LINES)
            .map_while(Result::ok)
            .any(|line| line.contains(marker));
        if named {
            super::terminal::session_id(path)
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tm-desktop-{}", taskmaster_core::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record(root: &Path, id: &str, value: Value) {
        let org = root.join("account").join("org");
        std::fs::create_dir_all(&org).unwrap();
        std::fs::write(org.join(format!("{id}.json")), value.to_string()).unwrap();
    }

    #[test]
    fn finds_the_desktop_session_of_a_conversation() {
        let root = temp();
        let conversation = "d2a49ded-69bc-4a26-9605-be159b710702";
        record(
            &root,
            "local_aaa",
            json!({"sessionId": "local_aaa", "cliSessionId": "other", "lastActivityAt": 9}),
        );
        record(
            &root,
            "local_bbb",
            json!({"sessionId": "local_bbb", "cliSessionId": conversation, "isArchived": false,
                   "lastActivityAt": 5}),
        );
        std::fs::write(root.join("account").join("org").join("notes.txt"), "x").unwrap();
        record(&root, "local_bad", json!("not a record"));

        let found = find(&root, &[conversation]).unwrap();
        assert_eq!(found.id, "local_bbb");
        assert!(!found.archived);
        assert_eq!(
            continue_link(&found),
            "claude://code/continue?session=local_bbb"
        );
        assert_eq!(find(&root, &["missing"]), None);
        assert_eq!(find(&root.join("nowhere"), &[conversation]), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prefers_a_session_that_is_not_archived_and_takes_its_last_conversation() {
        let root = temp();
        record(
            &root,
            "local_old",
            json!({"sessionId": "local_old", "cliSessionId": "c1", "isArchived": true,
                   "lastActivityAt": 50}),
        );
        record(
            &root,
            "local_new",
            json!({"sessionId": "local_new", "cliSessionId": "c0",
                   "lastAssistantCliSessionId": "c1", "lastActivityAt": 10}),
        );
        assert_eq!(find(&root, &["c1"]).unwrap().id, "local_new");
        std::fs::remove_file(root.join("account/org/local_new.json")).unwrap();
        assert!(find(&root, &["c1"]).unwrap().archived);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn only_takes_ids_its_links_accept() {
        assert!(is_local_id("local_38b5e164-56c0-4a1d-bbcf-4b7e2b7a9396"));
        assert!(!is_local_id("local_"));
        assert!(!is_local_id("local_a&b"));
        assert!(!is_local_id("cse_abc"));
        assert!(!is_local_id(&format!("local_{}", "a".repeat(65))));
        let root = temp();
        record(
            &root,
            "local_x",
            json!({"sessionId": "local_x?y=1", "cliSessionId": "c"}),
        );
        assert_eq!(find(&root, &["c"]), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn finds_the_conversation_whose_first_prompt_names_the_session() {
        let root = temp();
        let write = |name: &str, lines: &[String]| {
            let path = root.join(format!("{name}.jsonl"));
            std::fs::write(&path, lines.join("\n")).unwrap();
            path
        };
        let marker = "01a1f384-cabc-7312-9536-0a31756b5ad0";
        let ours = "11111111-1111-4111-8111-111111111111";
        let quoting = "22222222-2222-4222-8222-222222222222";
        let old = "33333333-3333-4333-8333-333333333333";
        let prompt = format!(r#"{{"type":"user","message":"session `{marker}`"}}"#);
        let found = vec![
            (write(quoting, std::slice::from_ref(&prompt)), 1, 300),
            (write(ours, &["{}".into(), prompt.clone()]), 1, 200),
            (write(old, std::slice::from_ref(&prompt)), 1, 50),
            (write("not-a-uuid", &[prompt]), 1, 150),
            (
                write("44444444-4444-4444-8444-444444444444", &["{}".into()]),
                1,
                100,
            ),
        ];
        assert_eq!(
            conversation_naming(&found, marker, 100).as_deref(),
            Some(ours)
        );
        assert_eq!(conversation_naming(&found, marker, 400), None);
        assert_eq!(conversation_naming(&found, "nobody", 0), None);
        std::fs::remove_dir_all(&root).ok();
    }
}

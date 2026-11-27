//! The Claude plan's own usage limits (the 5-hour window and the weekly ones), as Claude
//! Code's `/usage` shows them: read with the OAuth sign-in Claude Code keeps on this device
//! (or in WSL), from Anthropic's usage endpoint. Read-only: the token is never refreshed or
//! written here, so Claude Code stays the only owner of its sign-in.
//!
//! The endpoint is not a documented API; unknown fields are ignored and a changed shape
//! reads as "no limits", not as an error.

use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use taskmaster_core::AgentRuntime;

use super::launch::Launch;
use super::{hidden, process};
use crate::config::AgentSettings;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";

/// One usage window of the plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct PlanWindow {
    /// The endpoint's key: `five_hour`, `seven_day`, `seven_day_opus`, …
    pub kind: String,
    pub label: String,
    /// Share used, 0–100 (may pass 100 when over).
    pub percent: f64,
    /// When the window resets (Unix ms); `None` when it has not started.
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct PlanUsage {
    /// `pro`, `max`, … as Claude Code recorded it at sign-in.
    pub plan: Option<String>,
    pub windows: Vec<PlanWindow>,
    pub fetched_at: i64,
}

/// Claude Code's sign-in, as far as this module needs it.
#[derive(Debug, PartialEq)]
pub struct Credentials {
    pub token: String,
    /// Unix ms; `None` when not recorded.
    pub expires_at: Option<i64>,
    pub plan: Option<String>,
}

const NOT_SIGNED_IN: &str = "Claude Code is not signed in with a Claude plan here. Plan \
                             limits apply to a Pro or Max sign-in (run `claude` and /login), \
                             not to API keys.";

/// Reads `.credentials.json` (or the macOS keychain item, which holds the same JSON).
pub fn parse_credentials(json: &str) -> Option<Credentials> {
    let value: Value = serde_json::from_str(json.trim()).ok()?;
    let oauth = value.get("claudeAiOauth")?;
    let token = oauth.get("accessToken")?.as_str()?.trim();
    if token.is_empty() {
        return None;
    }
    Some(Credentials {
        token: token.to_owned(),
        expires_at: oauth.get("expiresAt").and_then(Value::as_i64),
        plan: oauth
            .get("subscriptionType")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
            .map(str::to_owned),
    })
}

fn run_text(launch: &Launch) -> Option<String> {
    let out = hidden(&mut process(launch))
        .stdin(Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The credentials Claude Code uses where agents run (this device, or WSL).
fn credentials(settings: &AgentSettings) -> Result<Credentials, String> {
    if settings.runtime == AgentRuntime::Wsl {
        let mut args: Vec<String> = match &settings.wsl_distro {
            Some(distro) => vec!["-d".into(), distro.clone()],
            None => Vec::new(),
        };
        args.extend([
            "--exec".into(),
            "sh".into(),
            "-c".into(),
            r#"cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json""#.into(),
        ]);
        let json = run_text(&Launch {
            program: "wsl.exe".into(),
            args,
            cwd: None,
        });
        return json
            .as_deref()
            .and_then(parse_credentials)
            .ok_or_else(|| NOT_SIGNED_IN.to_owned());
    }
    if let Ok(token) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN")
        && !token.trim().is_empty()
    {
        return Ok(Credentials {
            token: token.trim().to_owned(),
            expires_at: None,
            plan: None,
        });
    }
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|home| std::path::PathBuf::from(home).join(".claude"))
        });
    if let Some(found) = dir
        .and_then(|d| std::fs::read_to_string(d.join(".credentials.json")).ok())
        .as_deref()
        .and_then(parse_credentials)
    {
        return Ok(found);
    }
    if cfg!(target_os = "macos") {
        let keychain = run_text(&Launch {
            program: "security".into(),
            args: vec![
                "find-generic-password".into(),
                "-s".into(),
                "Claude Code-credentials".into(),
                "-w".into(),
            ],
            cwd: None,
        });
        if let Some(found) = keychain.as_deref().and_then(parse_credentials) {
            return Ok(found);
        }
    }
    Err(NOT_SIGNED_IN.to_owned())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// The plan's usage now, read with Claude Code's sign-in.
pub fn fetch(settings: &AgentSettings) -> Result<PlanUsage, String> {
    let creds = credentials(settings)?;
    let now = now_ms();
    if creds.expires_at.is_some_and(|at| at <= now) {
        return Err(
            "Claude Code's sign-in has expired. It renews the next time an agent \
                    runs (or when you run `claude`); then refresh."
                .into(),
        );
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut resp = agent
        .get(USAGE_URL)
        .header("Authorization", &format!("Bearer {}", creds.token))
        .header("anthropic-beta", OAUTH_BETA)
        .header("Accept", "application/json")
        .header("User-Agent", "task-master")
        .call()
        .map_err(|e| format!("Cannot reach Anthropic: {e}"))?;
    let status = resp.status().as_u16();
    match status {
        200..=299 => {}
        401 | 403 => {
            return Err(
                "Anthropic refused Claude Code's sign-in. Run `claude` to sign in \
                        again (or let an agent run), then refresh."
                    .into(),
            );
        }
        429 => return Err("Anthropic asks to wait before reading usage again.".into()),
        code => return Err(format!("Anthropic answered HTTP {code}.")),
    }
    let text = resp
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let value: Value =
        serde_json::from_str(&text).map_err(|_| "Anthropic did not answer JSON.".to_owned())?;
    Ok(PlanUsage {
        plan: creds.plan,
        windows: parse_usage(&value),
        fetched_at: now,
    })
}

/// Known windows first, in this order; others follow with a label made from their key.
const KNOWN: [(&str, &str); 5] = [
    ("five_hour", "5-hour window"),
    ("seven_day", "Week, all models"),
    ("seven_day_opus", "Week, Opus"),
    ("seven_day_sonnet", "Week, Sonnet"),
    ("seven_day_oauth_apps", "Week, other apps"),
];

/// The windows of a usage answer. The 5-hour and all-models weekly windows always show;
/// model-specific ones only once something was used in them.
pub fn parse_usage(value: &Value) -> Vec<PlanWindow> {
    let Some(map) = value.as_object() else {
        return Vec::new();
    };
    let window = |kind: &str, label: String, v: &Value| -> Option<PlanWindow> {
        let percent = v.get("utilization")?.as_f64().filter(|p| p.is_finite())?;
        let percent = percent.max(0.0);
        let always = kind == "five_hour" || kind == "seven_day";
        if !always && percent <= 0.0 {
            return None;
        }
        Some(PlanWindow {
            kind: kind.to_owned(),
            label,
            percent,
            resets_at: v
                .get("resets_at")
                .and_then(Value::as_str)
                .and_then(parse_rfc3339),
        })
    };
    let mut out: Vec<PlanWindow> = KNOWN
        .iter()
        .filter_map(|(kind, label)| window(kind, (*label).to_owned(), map.get(*kind)?))
        .collect();
    let mut others: Vec<_> = map
        .iter()
        .filter(|(k, _)| !KNOWN.iter().any(|(known, _)| known == k) && k.as_str() != "extra_usage")
        .filter_map(|(k, v)| window(k, label_of(k), v))
        .collect();
    others.sort_by(|a, b| a.kind.cmp(&b.kind));
    out.extend(others);
    if let Some(extra) = map.get("extra_usage")
        && extra.get("is_enabled").and_then(Value::as_bool) == Some(true)
        && let Some(w) = window("extra_usage", "Extra usage, this month".into(), extra)
    {
        out.push(w);
    }
    out
}

/// `seven_day_haiku` → "Seven day haiku".
fn label_of(key: &str) -> String {
    let words = key.replace('_', " ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => words,
    }
}

/// `2026-11-12T18:59:59.943648+00:00` (or `…Z`) as Unix ms.
pub fn parse_rfc3339(text: &str) -> Option<i64> {
    let text = text.trim();
    let num = |s: &str| -> Option<i64> {
        s.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| s.parse().ok())
            .flatten()
    };
    let (date, rest) = text.split_once(['T', 't', ' '])?;
    let mut d = date.splitn(3, '-');
    let (y, m, day) = (num(d.next()?)?, num(d.next()?)?, num(d.next()?)?);
    // Split the offset off the time.
    let (time, offset_ms) = if let Some(t) = rest.strip_suffix(['Z', 'z']) {
        (t, 0)
    } else {
        let at = rest.rfind(['+', '-'])?;
        let (t, off) = rest.split_at(at);
        let sign = if off.starts_with('-') { -1 } else { 1 };
        let (oh, om) = off[1..].split_once(':')?;
        (t, sign * (num(oh)? * 60 + num(om)?) * 60_000)
    };
    let (hms, frac) = match time.split_once('.') {
        Some((hms, frac)) => (hms, frac),
        None => (time, ""),
    };
    let mut t = hms.splitn(3, ':');
    let (h, min, s) = (num(t.next()?)?, num(t.next()?)?, num(t.next()?)?);
    let ms = match frac.get(..frac.len().min(3)) {
        Some("") | None => 0,
        Some(digits) => num(digits)? * 10_i64.pow(3 - digits.len() as u32),
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) || h > 23 || min > 59 || s > 60 {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + min) * 60_000 + s * 1000 + ms - offset_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_are_read_from_claude_codes_file() {
        let json = r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x","refreshToken":"r",
            "expiresAt":1762000000000,"scopes":["user:inference"],"subscriptionType":"max"}}"#;
        assert_eq!(
            parse_credentials(json),
            Some(Credentials {
                token: "sk-ant-oat01-x".into(),
                expires_at: Some(1_762_000_000_000),
                plan: Some("max".into()),
            })
        );
        assert_eq!(parse_credentials(r#"{"claudeAiOauth":{}}"#), None);
        assert_eq!(parse_credentials("{}"), None);
        assert_eq!(parse_credentials("not json"), None);
    }

    #[test]
    fn usage_windows_are_read_in_order() {
        let answer = serde_json::json!({
            "five_hour": { "utilization": 37.0, "resets_at": "2026-11-12T18:59:59.943648+00:00" },
            "seven_day": { "utilization": 12.5, "resets_at": "2026-11-17T08:00:00Z" },
            "seven_day_oauth_apps": null,
            "seven_day_opus": { "utilization": 0.0, "resets_at": null },
            "seven_day_sonnet": { "utilization": 4.0, "resets_at": "2026-11-17T08:00:00+00:00" },
            "seven_day_haiku": { "utilization": 1.0, "resets_at": null },
            "extra_usage": { "is_enabled": false, "utilization": 3.0 },
            "something_else": "ignored"
        });
        let windows = parse_usage(&answer);
        let kinds: Vec<_> = windows.iter().map(|w| w.kind.as_str()).collect();
        assert_eq!(
            kinds,
            [
                "five_hour",
                "seven_day",
                "seven_day_sonnet",
                "seven_day_haiku"
            ]
        );
        assert_eq!(windows[0].label, "5-hour window");
        assert_eq!(windows[0].percent, 37.0);
        assert_eq!(windows[0].resets_at, Some(1_794_509_999_943));
        assert_eq!(windows[3].label, "Seven day haiku");
        assert_eq!(windows[3].resets_at, None);

        // A fresh window with nothing used yet still shows; enabled extra usage too.
        let fresh = serde_json::json!({
            "five_hour": { "utilization": 0, "resets_at": null },
            "extra_usage": { "is_enabled": true, "utilization": 20.0 }
        });
        let windows = parse_usage(&fresh);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].percent, 0.0);
        assert_eq!(windows[1].kind, "extra_usage");

        assert!(parse_usage(&serde_json::json!([])).is_empty());
    }

    /// Reads this machine's real plan usage: `cargo test -p taskmaster-desktop live_plan
    /// -- --ignored --nocapture`.
    #[test]
    #[ignore = "calls Anthropic with this machine's Claude Code sign-in"]
    fn live_plan_usage() {
        let settings: AgentSettings = serde_json::from_str("{}").unwrap();
        println!("{:#?}", fetch(&settings));
    }

    #[test]
    fn timestamps_parse_with_offsets_and_fractions() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2000-03-01T00:00:00Z"), Some(951_868_800_000));
        assert_eq!(
            parse_rfc3339("2026-11-12T19:59:59.9+01:00"),
            parse_rfc3339("2026-11-12T18:59:59.900Z")
        );
        assert_eq!(
            parse_rfc3339("2026-11-12T13:00:00-05:30"),
            parse_rfc3339("2026-11-12T18:30:00Z")
        );
        assert_eq!(parse_rfc3339("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_rfc3339("yesterday"), None);
        assert_eq!(parse_rfc3339("2026-11-12T18:00:00"), None);
    }
}

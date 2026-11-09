//! Pure command building for agent sessions (ADR 017): the `claude` invocation for each
//! runtime, the terminal that resumes a session, and path conversions for WSL. No
//! process is started here, so every case is unit-tested on any OS.

use std::path::PathBuf;

use taskmaster_core::AgentRuntime;

use crate::config::AgentSettings;

/// A program to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    /// Working directory of the started program (native runs; WSL uses `--cd`).
    pub cwd: Option<PathBuf>,
}

/// The operating system the app runs on (a parameter, so tests cover all three).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Mac,
    Linux,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Linux
        }
    }
}

/// One headless run of Claude Code.
#[derive(Debug, Clone)]
pub struct Run<'a> {
    /// The working directory, as the runtime sees it.
    pub folder: &'a str,
    pub claude_session_id: &'a str,
    /// A follow-up turn of an existing session (`--resume`) rather than a new one.
    pub resume: bool,
    pub permission_mode: &'a str,
    /// `--model` for this session; the settings' model when `None`.
    pub model: Option<&'a str>,
    /// MCP config and rules files, as the runtime sees them.
    pub mcp_config: &'a str,
    pub rules: &'a str,
}

/// Name of our MCP server in the config file; its tools are `mcp__task-master__*`.
pub const MCP_SERVER: &str = "task-master";

/// `claude -p` with streamed JSON output. The prompt goes on stdin, never on the command
/// line (no quoting through `wsl.exe`, no length limit).
pub fn claude_command(settings: &AgentSettings, run: &Run<'_>) -> Launch {
    let mut claude = vec![
        "-p".to_owned(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
    ];
    if run.resume {
        claude.extend(["--resume".into(), run.claude_session_id.to_owned()]);
    } else {
        claude.extend(["--session-id".into(), run.claude_session_id.to_owned()]);
        // Kept for the whole session: a resumed run reuses the original system prompt.
        claude.extend(["--append-system-prompt-file".into(), run.rules.to_owned()]);
    }
    claude.extend([
        "--permission-mode".into(),
        run.permission_mode.to_owned(),
        "--mcp-config".into(),
        run.mcp_config.to_owned(),
        // Headless runs cannot ask: our own tools never need a prompt.
        "--allowedTools".into(),
        format!("mcp__{MCP_SERVER}"),
    ]);
    if let Some(model) = run.model.or(settings.model.as_deref()) {
        claude.extend(["--model".into(), model.to_owned()]);
    }
    in_runtime(
        settings,
        settings.runtime,
        run.folder,
        &settings.claude_path,
        claude,
    )
}

/// `program args…` run in `folder` by the runtime: directly, or through `wsl.exe --exec`
/// (no Linux shell, so arguments arrive exactly as given).
fn in_runtime(
    settings: &AgentSettings,
    runtime: AgentRuntime,
    folder: &str,
    program: &str,
    args: Vec<String>,
) -> Launch {
    match runtime {
        AgentRuntime::Native => Launch {
            program: program.to_owned(),
            args,
            cwd: Some(PathBuf::from(folder)),
        },
        AgentRuntime::Wsl => {
            let mut wsl = wsl_prefix(settings);
            wsl.extend([
                "--cd".into(),
                folder.to_owned(),
                "--exec".into(),
                program.to_owned(),
            ]);
            wsl.extend(args);
            Launch {
                program: "wsl.exe".into(),
                args: wsl,
                cwd: None,
            }
        }
    }
}

fn wsl_prefix(settings: &AgentSettings) -> Vec<String> {
    match &settings.wsl_distro {
        Some(distro) => vec!["-d".into(), distro.clone()],
        None => Vec::new(),
    }
}

/// Linux terminals tried in order when neither the setting nor `$TERMINAL` names one, with
/// what each needs before the command it runs. Debian's chosen default first, then ones
/// people install on purpose, then desktop defaults, then xterm. (Arch, Fedora and others
/// have no `x-terminal-emulator`.)
pub const LINUX_TERMINALS: &[(&str, &str)] = &[
    ("x-terminal-emulator", "-e"),
    ("kitty", ""),
    ("alacritty", "-e"),
    ("wezterm", "start --"),
    ("ghostty", "-e"),
    ("foot", ""),
    ("konsole", "-e"),
    ("gnome-terminal", "--"),
    ("xfce4-terminal", "-x"),
    ("xterm", "-e"),
];

/// The command prefix that runs a program in `terminal`, a command such as `$TERMINAL`:
/// the known flag for a known terminal, else `-e`.
pub fn linux_terminal_prefix(terminal: &str) -> String {
    let terminal = terminal.trim();
    let name = terminal.rsplit('/').next().unwrap_or(terminal);
    match LINUX_TERMINALS.iter().find(|(known, _)| *known == name) {
        Some((_, "")) => terminal.to_owned(),
        Some((_, flag)) => format!("{terminal} {flag}"),
        None => format!("{terminal} -e"),
    }
}

/// The first of [`LINUX_TERMINALS`] that `installed` finds, as a command prefix.
pub fn detect_linux_terminal(installed: impl Fn(&str) -> bool) -> Option<String> {
    LINUX_TERMINALS
        .iter()
        .find(|(name, _)| installed(name))
        .map(|(name, _)| linux_terminal_prefix(name))
}

/// How a terminal continues a session by hand (see [`resume_args`]).
#[derive(Debug, Clone, Copy)]
pub struct Resume<'a> {
    pub claude_session_id: &'a str,
    /// The session's MCP config, as the runtime sees it.
    pub mcp_config: Option<&'a str>,
    /// The session's `--permission-mode`, so the terminal asks no more than the run did.
    pub permission_mode: &'a str,
    /// `--model` for this session; the settings' model when `None`.
    pub model: Option<&'a str>,
    /// The terminal stopped a turn in progress: a first message makes claude pick it up
    /// instead of waiting at an interrupted conversation.
    pub interrupted: bool,
}

/// First message of a terminal that took over a turn in progress.
pub const CONTINUE_PROMPT: &str =
    "The app stopped your turn to open this terminal. Continue where you left off.";

/// `claude` arguments that continue a session by hand: `--resume <id>`, plus the session's
/// MCP config (as the runtime sees it), so the agent keeps its task-master tools and can
/// add notes and record its summary from the terminal too, its permission mode and model.
/// The prompt, when any, comes last, after single-value options: `--mcp-config` and
/// `--allowedTools` take several values and would swallow it.
pub fn resume_args(settings: &AgentSettings, resume: &Resume<'_>) -> Vec<String> {
    let mut args = vec!["--resume".to_owned(), resume.claude_session_id.to_owned()];
    if let Some(config) = resume.mcp_config {
        args.extend([
            "--mcp-config".into(),
            config.to_owned(),
            "--allowedTools".into(),
            format!("mcp__{MCP_SERVER}"),
        ]);
    }
    if !resume.permission_mode.is_empty() {
        args.extend([
            "--permission-mode".into(),
            resume.permission_mode.to_owned(),
        ]);
    }
    let model = resume.model.or(settings.model.as_deref());
    if let Some(model) = model {
        args.extend(["--model".into(), model.to_owned()]);
    }
    if resume.interrupted {
        if resume.permission_mode.is_empty() && model.is_none() {
            // Nothing single-valued since `--allowedTools`: end the options.
            args.push("--".into());
        }
        args.push(CONTINUE_PROMPT.into());
    }
    args
}

/// `[cd <folder> && ][echo $$ > <pid file> && ]exec <claude> <args>` for a POSIX shell,
/// every word quoted. `exec` keeps the shell's pid, so the pid file names claude itself
/// (the app stops it once the session is done; see `agents::watch_terminal`).
fn resume_script(
    settings: &AgentSettings,
    folder: Option<&str>,
    resume: &[String],
    pid_file: Option<&str>,
) -> String {
    let mut script = String::new();
    if let Some(folder) = folder {
        script.push_str(&format!("cd {} && ", sh_quote(folder)));
    }
    if let Some(pid_file) = pid_file {
        script.push_str(&format!("echo $$ > {} && ", sh_quote(pid_file)));
    }
    script.push_str(&format!("exec {}", sh_quote(&settings.claude_path)));
    for arg in resume {
        script.push(' ');
        script.push_str(&sh_quote(arg));
    }
    script
}

/// `claude <resume>` inside WSL in `folder`: through `sh -c` when it records its pid,
/// directly (`--exec`, no shell) otherwise.
fn wsl_resume(
    settings: &AgentSettings,
    folder: &str,
    resume: &[String],
    pid_file: Option<&str>,
) -> Launch {
    let runtime = AgentRuntime::Wsl;
    match pid_file {
        Some(_) => {
            let script = resume_script(settings, None, resume, pid_file);
            in_runtime(settings, runtime, folder, "sh", vec!["-c".into(), script])
        }
        None => in_runtime(
            settings,
            runtime,
            folder,
            &settings.claude_path,
            resume.to_vec(),
        ),
    }
}

/// A visible terminal running `claude <resume>` (see [`resume_args`]) in the session's
/// folder, so the user can take over the conversation. On Linux, `default_terminal` is the
/// command prefix to use when the settings name none (`$TERMINAL`, else a detected one).
/// With `pid_file` (as the runtime sees it), claude's pid is written there first; native
/// Windows cannot (no shell runs claude), so callers pass `None` for it.
pub fn terminal_command(
    settings: &AgentSettings,
    runtime: AgentRuntime,
    folder: &str,
    resume: &[String],
    pid_file: Option<&str>,
    os: Os,
    default_terminal: Option<&str>,
) -> Launch {
    let resume = resume.to_vec();
    match os {
        Os::Windows => {
            // Windows Terminal: `wt -d <dir> <command…>`; WSL sets its folder with --cd.
            let mut args = Vec::new();
            match runtime {
                AgentRuntime::Wsl => {
                    let inner = wsl_resume(settings, folder, &resume, pid_file);
                    args.push(inner.program);
                    args.extend(inner.args);
                }
                AgentRuntime::Native => {
                    args.extend(["-d".into(), folder.to_owned(), settings.claude_path.clone()]);
                    args.extend(resume);
                }
            }
            Launch {
                program: "wt.exe".into(),
                args,
                cwd: None,
            }
        }
        Os::Mac => {
            let script = resume_script(settings, Some(folder), &resume, pid_file);
            Launch {
                program: "osascript".into(),
                args: vec![
                    "-e".into(),
                    format!(
                        "tell application \"Terminal\" to do script \"{}\"",
                        applescript_escape(&script)
                    ),
                    "-e".into(),
                    "tell application \"Terminal\" to activate".into(),
                ],
                cwd: None,
            }
        }
        Os::Linux => {
            let prefix = settings
                .terminal
                .clone()
                .or_else(|| default_terminal.map(str::to_owned))
                .unwrap_or_else(|| "x-terminal-emulator -e".into());
            let mut parts = prefix.split_whitespace().map(str::to_owned);
            let program = parts.next().unwrap_or_else(|| "x-terminal-emulator".into());
            let mut args: Vec<String> = parts.collect();
            let script = resume_script(settings, Some(folder), &resume, pid_file);
            args.extend(["sh".into(), "-c".into(), script]);
            Launch {
                program,
                args,
                cwd: None,
            }
        }
    }
}

/// Starts the line that ends a run log (`agents/<id>/run.log`).
pub const RUN_END_PREFIX: &str = "=== Run ended";

/// Windows without Windows Terminal: a console window through `cmd /c start`.
pub fn windows_console_fallback(
    settings: &AgentSettings,
    runtime: AgentRuntime,
    folder: &str,
    resume: &[String],
    pid_file: Option<&str>,
) -> Launch {
    let resume = resume.to_vec();
    let mut args = vec!["/c".to_owned(), "start".into(), String::new()];
    match runtime {
        AgentRuntime::Wsl => {
            let inner = wsl_resume(settings, folder, &resume, pid_file);
            args.push(inner.program);
            args.extend(inner.args);
        }
        AgentRuntime::Native => {
            args.extend(["/D".into(), folder.to_owned(), settings.claude_path.clone()]);
            args.extend(resume);
        }
    }
    Launch {
        program: "cmd.exe".into(),
        args,
        cwd: None,
    }
}

/// Prints the command line of process `pid` in the runtime (`ps -p <pid> -o args=`),
/// nothing when it is gone. Not available for native Windows (`None`).
pub fn probe_command(
    settings: &AgentSettings,
    runtime: AgentRuntime,
    os: Os,
    pid: u32,
) -> Option<Launch> {
    in_unix(
        settings,
        runtime,
        os,
        ["ps", "-p", &pid.to_string(), "-o", "args="],
    )
}

/// Sends `signal` (`TERM`, `KILL`) to process `pid` in the runtime. Not available for
/// native Windows (`None`).
pub fn signal_command(
    settings: &AgentSettings,
    runtime: AgentRuntime,
    os: Os,
    pid: u32,
    signal: &str,
) -> Option<Launch> {
    in_unix(
        settings,
        runtime,
        os,
        ["kill", &format!("-{signal}"), &pid.to_string()],
    )
}

/// A POSIX tool run where claude runs: directly on macOS/Linux, through `wsl.exe --exec`.
fn in_unix<const N: usize>(
    settings: &AgentSettings,
    runtime: AgentRuntime,
    os: Os,
    command: [&str; N],
) -> Option<Launch> {
    let [program, args @ ..] = command.as_slice() else {
        return None;
    };
    match (runtime, os) {
        (AgentRuntime::Wsl, _) => {
            let mut wsl = wsl_prefix(settings);
            wsl.push("--exec".into());
            wsl.extend(command.iter().map(|w| (*w).to_owned()));
            Some(Launch {
                program: "wsl.exe".into(),
                args: wsl,
                cwd: None,
            })
        }
        (AgentRuntime::Native, Os::Windows) => None,
        (AgentRuntime::Native, _) => Some(Launch {
            program: (*program).to_owned(),
            args: args.iter().map(|w| (*w).to_owned()).collect(),
            cwd: None,
        }),
    }
}

/// Finds `claude` through the user's login shell, which sets up the PATH a GUI app (or
/// `wsl.exe --exec`) does not get. Prints the path on its last line.
pub fn lookup_command(settings: &AgentSettings, os: Os) -> Launch {
    // `wsl.exe --exec` may not set $SHELL: fall back to the user's login shell from
    // passwd, so a PATH set only in ~/.zshrc (say) is still found.
    let lookup = r#"s=${SHELL:-$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)}; exec "${s:-/bin/sh}" -lic 'command -v claude'"#;
    match (settings.runtime, os) {
        (AgentRuntime::Wsl, _) => {
            let mut args = wsl_prefix(settings);
            args.extend(["--exec".into(), "sh".into(), "-c".into(), lookup.into()]);
            Launch {
                program: "wsl.exe".into(),
                args,
                cwd: None,
            }
        }
        (AgentRuntime::Native, Os::Windows) => Launch {
            program: "where.exe".into(),
            args: vec!["claude".into()],
            cwd: None,
        },
        (AgentRuntime::Native, _) => Launch {
            program: "sh".into(),
            args: vec!["-c".into(), lookup.into()],
            cwd: None,
        },
    }
}

/// Whether `claude_path` must be looked up before a WSL launch: `wsl.exe --exec` runs no
/// shell, so the PATH a profile sets up (`~/.local/bin`, nvm, …) is missing and a bare
/// `claude` fails inside the distribution (`execvpe(claude) failed`), where the app cannot
/// catch it. Native launches retry on `NotFound` instead.
pub fn wsl_needs_lookup(settings: &AgentSettings, runtime: AgentRuntime) -> bool {
    runtime == AgentRuntime::Wsl && !settings.claude_path.starts_with('/')
}

/// `claude --version` in the runtime.
pub fn version_command(settings: &AgentSettings, claude_path: &str) -> Launch {
    match settings.runtime {
        AgentRuntime::Native => Launch {
            program: claude_path.to_owned(),
            args: vec!["--version".into()],
            cwd: None,
        },
        AgentRuntime::Wsl => {
            let mut args = wsl_prefix(settings);
            args.extend(["--exec".into(), claude_path.to_owned(), "--version".into()]);
            Launch {
                program: "wsl.exe".into(),
                args,
                cwd: None,
            }
        }
    }
}

/// The path a lookup printed: the last line that is an absolute path (an interactive
/// login shell may print a banner first).
pub fn found_path(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .rev()
        .find(|l| l.starts_with('/') || is_windows_absolute(l))
        .map(str::to_owned)
}

/// Distribution names from `wsl.exe -l -q`, which prints UTF-16LE.
pub fn parse_distros(bytes: &[u8]) -> Vec<String> {
    let text = if bytes.len() >= 2 && bytes.iter().skip(1).step_by(2).all(|&b| b == 0) {
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

/// A folder as the runtime sees it. For WSL, a Windows path picked in a dialog becomes
/// a Linux one: `\\wsl.localhost\<distro>\home\x` → `/home/x`, `C:\dev` → `/mnt/c/dev`.
pub fn to_runtime_path(path: &str, runtime: AgentRuntime) -> String {
    let path = path.trim();
    match runtime {
        AgentRuntime::Native => path.to_owned(),
        AgentRuntime::Wsl => windows_to_wsl(path).unwrap_or_else(|| path.to_owned()),
    }
}

/// A Windows path as WSL sees it, or `None` when it is not a Windows path.
pub fn windows_to_wsl(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    for prefix in ["//wsl.localhost/", "//wsl$/"] {
        if normalized.len() > prefix.len()
            && normalized[..prefix.len()].eq_ignore_ascii_case(prefix)
        {
            // `<distro>/rest`: the distro name goes, the rest is the Linux path.
            let rest = &normalized[prefix.len()..];
            let linux = rest
                .find('/')
                .map_or("", |at| rest[at..].trim_end_matches('/'));
            return Some(if linux.is_empty() {
                "/".to_owned()
            } else {
                linux.to_owned()
            });
        }
    }
    let bytes = normalized.as_bytes();
    if is_windows_absolute(&normalized) {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = normalized[2..].trim_end_matches('/');
        return Some(format!("/mnt/{drive}{rest}"));
    }
    None
}

fn is_windows_absolute(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// Single-quotes a word for `sh`.
pub fn sh_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

fn applescript_escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Set only by the AppImage's runtime and launch hooks, meaningless outside it.
const APPIMAGE_ONLY_VARS: &[&str] = &[
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "GTK_THEME",
    "PYTHONDONTWRITEBYTECODE",
];

/// The environment changes (`None`: remove) that give a program the app starts the user's
/// environment back when the app runs as an AppImage (`APPDIR` set). Its runtime points
/// `LD_LIBRARY_PATH`, `PYTHONHOME`, `PYTHONPATH`, `PATH`, `QT_PLUGIN_PATH`, the GTK and
/// GStreamer variables and others into the image; inherited, they break other programs
/// (kitty, which embeds Python, dies at start-up). Entries inside the image are dropped
/// from path lists, and a variable left with none is removed. Empty outside an AppImage.
pub fn host_env<'a>(
    env: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Vec<(String, Option<String>)> {
    let env: Vec<_> = env.into_iter().collect();
    let Some(appdir) = env
        .iter()
        .find(|(name, _)| *name == "APPDIR")
        .map(|(_, value)| value.trim_end_matches('/'))
        .filter(|dir| !dir.is_empty())
    else {
        return Vec::new();
    };
    let inside = |entry: &str| entry == appdir || entry.starts_with(&format!("{appdir}/"));
    env.iter()
        .filter_map(|(name, value)| {
            if APPIMAGE_ONLY_VARS.contains(name) {
                return Some((name.to_string(), None));
            }
            if !value.split(':').any(inside) {
                return None;
            }
            let kept: Vec<&str> = value
                .split(':')
                .filter(|entry| !entry.is_empty() && !inside(entry))
                .collect();
            Some((name.to_string(), (!kept.is_empty()).then(|| kept.join(":"))))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(runtime: AgentRuntime) -> AgentSettings {
        AgentSettings {
            runtime,
            wsl_distro: Some("Ubuntu".into()),
            ..AgentSettings::default()
        }
    }

    fn run(resume: bool) -> Run<'static> {
        Run {
            folder: "/home/alex/Code/my project",
            claude_session_id: "0199a000-0000-7000-8000-00000000abcd",
            resume,
            permission_mode: "acceptEdits",
            model: None,
            mcp_config: "/mnt/c/Users/Alex J/AppData/agents/s1/mcp.json",
            rules: "/mnt/c/Users/Alex J/AppData/agents/s1/rules.md",
        }
    }

    #[test]
    fn a_native_run_starts_claude_in_the_folder() {
        let launch = claude_command(&settings(AgentRuntime::Native), &run(false));
        assert_eq!(launch.program, "claude");
        assert_eq!(
            launch.cwd,
            Some(PathBuf::from("/home/alex/Code/my project"))
        );
        assert_eq!(
            launch.args,
            [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--session-id",
                "0199a000-0000-7000-8000-00000000abcd",
                "--append-system-prompt-file",
                "/mnt/c/Users/Alex J/AppData/agents/s1/rules.md",
                "--permission-mode",
                "acceptEdits",
                "--mcp-config",
                "/mnt/c/Users/Alex J/AppData/agents/s1/mcp.json",
                "--allowedTools",
                "mcp__task-master",
            ]
        );
    }

    #[test]
    fn a_wsl_run_goes_through_wsl_exec_without_a_shell() {
        let mut s = settings(AgentRuntime::Wsl);
        s.claude_path = "/home/alex/.local/bin/claude".into();
        s.model = Some("sonnet".into());
        let launch = claude_command(&s, &run(true));
        assert_eq!(launch.program, "wsl.exe");
        assert_eq!(launch.cwd, None);
        assert_eq!(
            launch.args[..7],
            [
                "-d",
                "Ubuntu",
                "--cd",
                "/home/alex/Code/my project",
                "--exec",
                "/home/alex/.local/bin/claude",
                "-p"
            ]
        );
        let rest = &launch.args[7..];
        assert!(
            rest.windows(2)
                .any(|w| w == ["--resume", "0199a000-0000-7000-8000-00000000abcd"])
        );
        assert!(!rest.contains(&"--session-id".to_owned()));
        assert!(
            !rest.contains(&"--append-system-prompt-file".to_owned()),
            "kept from the first run"
        );
        assert!(rest.ends_with(&["--model".to_owned(), "sonnet".to_owned()]));
    }

    #[test]
    fn the_default_distro_needs_no_flag() {
        let mut s = settings(AgentRuntime::Wsl);
        s.wsl_distro = None;
        assert_eq!(claude_command(&s, &run(false)).args[0], "--cd");
    }

    /// `resume_args` with no permission mode, model or interrupted turn.
    fn plain_resume(id: &str, mcp_config: Option<&str>) -> Vec<String> {
        resume_args(
            &settings(AgentRuntime::Native),
            &Resume {
                claude_session_id: id,
                mcp_config,
                permission_mode: "",
                model: None,
                interrupted: false,
            },
        )
    }

    #[test]
    fn terminals_keep_the_sessions_mode_and_model_and_pick_up_a_stopped_turn() {
        let id = "0199a000-0000-7000-8000-00000000abcd";
        let mut s = settings(AgentRuntime::Native);
        s.model = Some("sonnet".into());
        let resume = Resume {
            claude_session_id: id,
            mcp_config: Some("/data/agents/s1/mcp.json"),
            permission_mode: "bypassPermissions",
            model: Some("opus"),
            interrupted: true,
        };
        assert_eq!(
            resume_args(&s, &resume),
            [
                "--resume",
                id,
                "--mcp-config",
                "/data/agents/s1/mcp.json",
                "--allowedTools",
                "mcp__task-master",
                "--permission-mode",
                "bypassPermissions",
                "--model",
                "opus",
                CONTINUE_PROMPT,
            ]
        );
        // The settings' model when the session has none; nothing sent when no turn stopped.
        let idle = Resume {
            model: None,
            interrupted: false,
            ..resume
        };
        assert_eq!(resume_args(&s, &idle)[8..], ["--model", "sonnet"]);
        // Without a single-valued option after `--allowedTools`, `--` ends the options.
        let bare = Resume {
            permission_mode: "",
            model: None,
            ..resume
        };
        let args = resume_args(&settings(AgentRuntime::Native), &bare);
        assert_eq!(args[6..], ["--", CONTINUE_PROMPT]);
    }

    #[test]
    fn terminals_resume_the_session_on_each_os() {
        let id = "0199a000-0000-7000-8000-00000000abcd";
        let folder = "/home/alex/it's here";
        let resume = plain_resume(id, None);
        let wt = terminal_command(
            &settings(AgentRuntime::Wsl),
            AgentRuntime::Wsl,
            folder,
            &resume,
            None,
            Os::Windows,
            None,
        );
        assert_eq!(wt.program, "wt.exe");
        assert_eq!(
            wt.args,
            [
                "wsl.exe", "-d", "Ubuntu", "--cd", folder, "--exec", "claude", "--resume", id
            ]
        );
        let native = terminal_command(
            &settings(AgentRuntime::Native),
            AgentRuntime::Native,
            r"C:\dev\app",
            &resume,
            None,
            Os::Windows,
            None,
        );
        assert_eq!(native.args, ["-d", r"C:\dev\app", "claude", "--resume", id]);

        let mac = terminal_command(
            &settings(AgentRuntime::Native),
            AgentRuntime::Native,
            folder,
            &resume,
            None,
            Os::Mac,
            None,
        );
        assert_eq!(mac.program, "osascript");
        assert_eq!(
            mac.args[1],
            format!(
                r#"tell application "Terminal" to do script "cd '/home/alex/it'\\''s here' && exec 'claude' '--resume' '{id}'""#
            )
        );

        let linux = terminal_command(
            &settings(AgentRuntime::Native),
            AgentRuntime::Native,
            folder,
            &resume,
            None,
            Os::Linux,
            Some("kitty"),
        );
        assert_eq!(linux.program, "kitty");
        assert_eq!(linux.args[..2], ["sh", "-c"]);
        assert_eq!(
            linux.args[2],
            format!("cd '/home/alex/it'\\''s here' && exec 'claude' '--resume' '{id}'")
        );
        let mut custom = settings(AgentRuntime::Native);
        custom.terminal = Some("gnome-terminal --".into());
        let gnome = terminal_command(
            &custom,
            AgentRuntime::Native,
            folder,
            &resume,
            None,
            Os::Linux,
            Some("kitty"),
        );
        assert_eq!(gnome.program, "gnome-terminal");
        assert_eq!(gnome.args[..2], ["--", "sh"]);
        let fallback = terminal_command(
            &settings(AgentRuntime::Native),
            AgentRuntime::Native,
            folder,
            &resume,
            None,
            Os::Linux,
            None,
        );
        assert_eq!(fallback.program, "x-terminal-emulator");

        // Without a setting or `$TERMINAL`, the first known terminal installed, with its flag.
        assert_eq!(linux_terminal_prefix("kitty"), "kitty");
        assert_eq!(
            linux_terminal_prefix("/usr/bin/konsole"),
            "/usr/bin/konsole -e"
        );
        assert_eq!(linux_terminal_prefix("wezterm"), "wezterm start --");
        assert_eq!(linux_terminal_prefix("st"), "st -e");
        let arch = |name: &str| ["xterm", "konsole", "kitty"].contains(&name);
        assert_eq!(detect_linux_terminal(arch).as_deref(), Some("kitty"));
        let plasma = |name: &str| ["xterm", "konsole"].contains(&name);
        assert_eq!(detect_linux_terminal(plasma).as_deref(), Some("konsole -e"));
        let debian = |name: &str| ["x-terminal-emulator", "kitty"].contains(&name);
        assert_eq!(
            detect_linux_terminal(debian).as_deref(),
            Some("x-terminal-emulator -e")
        );
        assert_eq!(detect_linux_terminal(|_| false), None);

        let console = windows_console_fallback(
            &settings(AgentRuntime::Wsl),
            AgentRuntime::Wsl,
            folder,
            &resume,
            None,
        );
        assert_eq!(console.program, "cmd.exe");
        assert_eq!(console.args[..4], ["/c", "start", "", "wsl.exe"]);
        let console = windows_console_fallback(
            &settings(AgentRuntime::Native),
            AgentRuntime::Native,
            r"C:\dev",
            &resume,
            None,
        );
        assert_eq!(
            console.args[3..],
            ["/D", r"C:\dev", "claude", "--resume", id]
        );

        // With the session's MCP config, the terminal keeps the task-master tools.
        let with_tools = plain_resume(id, Some("/data/agents/s1/mcp.json"));
        assert_eq!(
            with_tools,
            [
                "--resume",
                id,
                "--mcp-config",
                "/data/agents/s1/mcp.json",
                "--allowedTools",
                "mcp__task-master"
            ]
        );
        let kitty = terminal_command(
            &settings(AgentRuntime::Native),
            AgentRuntime::Native,
            "/srv/app",
            &with_tools,
            None,
            Os::Linux,
            Some("kitty"),
        );
        assert_eq!(
            kitty.args[2],
            format!(
                "cd '/srv/app' && exec 'claude' '--resume' '{id}' '--mcp-config' \
                 '/data/agents/s1/mcp.json' '--allowedTools' 'mcp__task-master'"
            )
        );
    }

    #[test]
    fn terminals_record_claudes_pid_so_the_app_can_stop_it() {
        let id = "0199a000-0000-7000-8000-00000000abcd";
        let resume = plain_resume(id, None);
        let linux = terminal_command(
            &settings(AgentRuntime::Native),
            AgentRuntime::Native,
            "/srv/app",
            &resume,
            Some("/data/agents/s1/terminal.pid"),
            Os::Linux,
            Some("kitty"),
        );
        assert_eq!(
            linux.args[2],
            format!(
                "cd '/srv/app' && echo $$ > '/data/agents/s1/terminal.pid' && exec 'claude' \
                 '--resume' '{id}'"
            )
        );
        // WSL goes through sh only to write the pid; --cd still sets the folder.
        let wt = terminal_command(
            &settings(AgentRuntime::Wsl),
            AgentRuntime::Wsl,
            "/home/alex/app",
            &resume,
            Some("/mnt/c/agents/s1/terminal.pid"),
            Os::Windows,
            None,
        );
        assert_eq!(
            wt.args,
            [
                "wsl.exe",
                "-d",
                "Ubuntu",
                "--cd",
                "/home/alex/app",
                "--exec",
                "sh",
                "-c",
                &format!(
                    "echo $$ > '/mnt/c/agents/s1/terminal.pid' && exec 'claude' '--resume' '{id}'"
                ),
            ]
        );
        let console = windows_console_fallback(
            &settings(AgentRuntime::Wsl),
            AgentRuntime::Wsl,
            "/home/alex/app",
            &resume,
            Some("/mnt/c/agents/s1/terminal.pid"),
        );
        assert_eq!(console.args[3..10], wt.args[..7]);

        let native = settings(AgentRuntime::Native);
        let probe = probe_command(&native, AgentRuntime::Native, Os::Linux, 4242).unwrap();
        assert_eq!(probe.program, "ps");
        assert_eq!(probe.args, ["-p", "4242", "-o", "args="]);
        let term = signal_command(&native, AgentRuntime::Native, Os::Mac, 4242, "TERM").unwrap();
        assert_eq!(
            (term.program.as_str(), &term.args[..]),
            ("kill", &["-TERM".to_owned(), "4242".to_owned()][..])
        );
        let wsl = signal_command(
            &settings(AgentRuntime::Wsl),
            AgentRuntime::Wsl,
            Os::Windows,
            7,
            "KILL",
        )
        .unwrap();
        assert_eq!(wsl.program, "wsl.exe");
        assert_eq!(wsl.args, ["-d", "Ubuntu", "--exec", "kill", "-KILL", "7"]);
        assert!(probe_command(&native, AgentRuntime::Native, Os::Windows, 1).is_none());
    }

    #[test]
    fn a_bare_claude_is_looked_up_only_for_wsl() {
        let mut s = settings(AgentRuntime::Wsl);
        s.claude_path = "claude".into();
        assert!(wsl_needs_lookup(&s, AgentRuntime::Wsl));
        assert!(!wsl_needs_lookup(&s, AgentRuntime::Native));
        s.claude_path = "/home/alex/.local/bin/claude".into();
        assert!(!wsl_needs_lookup(&s, AgentRuntime::Wsl));
    }

    #[test]
    fn windows_paths_become_wsl_paths() {
        assert_eq!(
            windows_to_wsl(r"\\wsl.localhost\Ubuntu\home\alex\Code"),
            Some("/home/alex/Code".into())
        );
        assert_eq!(
            windows_to_wsl(r"\\wsl$\Ubuntu-24.04\home\alex\"),
            Some("/home/alex".into())
        );
        assert_eq!(windows_to_wsl(r"\\WSL.LOCALHOST\Ubuntu"), Some("/".into()));
        assert_eq!(
            windows_to_wsl(r"C:\Users\Alex J\dev"),
            Some("/mnt/c/Users/Alex J/dev".into())
        );
        assert_eq!(windows_to_wsl("D:/data/"), Some("/mnt/d/data".into()));
        assert_eq!(windows_to_wsl("/home/alex"), None);
        assert_eq!(
            to_runtime_path(" /home/alex ", AgentRuntime::Wsl),
            "/home/alex"
        );
        assert_eq!(to_runtime_path(r"C:\dev", AgentRuntime::Native), r"C:\dev");
    }

    #[test]
    fn distros_are_read_from_utf16_output() {
        let utf16: Vec<u8> = "Ubuntu\r\nDebian\r\n\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(parse_distros(&utf16), ["Ubuntu", "Debian"]);
        assert_eq!(parse_distros(b"Ubuntu\nArch\n"), ["Ubuntu", "Arch"]);
        assert!(parse_distros(b"").is_empty());
    }

    #[test]
    fn the_lookup_takes_the_last_absolute_path() {
        assert_eq!(
            found_path("Welcome to zsh!\n/home/alex/.local/bin/claude\n"),
            Some("/home/alex/.local/bin/claude".into())
        );
        assert_eq!(
            found_path("C:\\Users\\a\\AppData\\claude.exe\r\n"),
            Some("C:\\Users\\a\\AppData\\claude.exe".into())
        );
        assert_eq!(found_path("claude not found"), None);
        let lookup = lookup_command(&settings(AgentRuntime::Wsl), Os::Windows);
        assert_eq!(lookup.args[..4], ["-d", "Ubuntu", "--exec", "sh"]);
    }

    #[test]
    fn programs_started_from_an_appimage_get_the_users_environment_back() {
        // What the AppImage runtime and its GTK hook set (seen in /proc/<pid>/environ).
        let m = "/tmp/.mount_task-mmpDlmm";
        let env = [
            ("APPDIR", m.to_owned()),
            (
                "APPIMAGE",
                "/home/alex/Downloads/task-master.AppImage".into(),
            ),
            ("ARGV0", "/home/alex/Downloads/task-master.AppImage".into()),
            ("OWD", "/home/alex".into()),
            ("GTK_THEME", "Adwaita:dark".into()),
            ("PYTHONDONTWRITEBYTECODE", "1".into()),
            ("PYTHONHOME", format!("{m}/usr/")),
            ("PYTHONPATH", format!("{m}/usr/share/pyshared/:")),
            (
                "LD_LIBRARY_PATH",
                format!("{m}/usr/lib/:{m}/usr/lib/x86_64-linux-gnu/:/opt/cuda/lib64"),
            ),
            (
                "PATH",
                format!("{m}/usr/bin/:{m}/bin/:/home/alex/.local/bin:/usr/bin"),
            ),
            ("GTK_PATH", format!("{m}//usr/lib/gtk-3.0")),
            (
                "XDG_DATA_DIRS",
                format!("{m}/usr/share:/usr/share:/usr/local/share"),
            ),
            ("HOME", "/home/alex".into()),
            // A neighbour whose name only starts like the mount stays.
            ("EDITOR", format!("{m}x/bin/vi")),
        ];
        let mut changes = host_env(env.iter().map(|(k, v)| (*k, v.as_str())));
        changes.sort();
        let removed = |name: &str| (name.to_owned(), None);
        let set = |name: &str, value: &str| (name.to_owned(), Some(value.to_owned()));
        assert_eq!(
            changes,
            vec![
                removed("APPDIR"),
                removed("APPIMAGE"),
                removed("ARGV0"),
                removed("GTK_PATH"),
                removed("GTK_THEME"),
                set("LD_LIBRARY_PATH", "/opt/cuda/lib64"),
                removed("OWD"),
                set("PATH", "/home/alex/.local/bin:/usr/bin"),
                removed("PYTHONDONTWRITEBYTECODE"),
                removed("PYTHONHOME"),
                removed("PYTHONPATH"),
                set("XDG_DATA_DIRS", "/usr/share:/usr/local/share"),
            ]
        );
        // Outside an AppImage, nothing changes.
        assert!(host_env([("PATH", "/usr/bin"), ("GTK_THEME", "Breeze")]).is_empty());
    }
}

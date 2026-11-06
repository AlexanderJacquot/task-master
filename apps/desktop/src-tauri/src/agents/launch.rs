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
    if let Some(model) = &settings.model {
        claude.extend(["--model".into(), model.clone()]);
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

/// `claude` arguments that continue a session by hand: `--resume <id>`, plus the session's
/// MCP config (as the runtime sees it), so the agent keeps its task-master tools and can
/// add notes and record its summary from the terminal too.
pub fn resume_args(claude_session_id: &str, mcp_config: Option<&str>) -> Vec<String> {
    let mut args = vec!["--resume".to_owned(), claude_session_id.to_owned()];
    if let Some(config) = mcp_config {
        args.extend([
            "--mcp-config".into(),
            config.to_owned(),
            "--allowedTools".into(),
            format!("mcp__{MCP_SERVER}"),
        ]);
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

/// Starts the line that ends a run log; the watch script stops at it.
pub const RUN_END_PREFIX: &str = "=== Run ended";

/// A POSIX script that shows a run log as it grows (read-only), stops at the line
/// starting with [`RUN_END_PREFIX`], then closes after `close_after` seconds.
pub fn watch_script(log: &str, close_after: u32) -> String {
    format!(
        "log={log}; n=0\n\
         echo 'Watching the background run of this session (read only).'\n\
         echo 'This window closes when it ends.'\n\
         echo\n\
         while :; do\n\
         \x20 if [ -f \"$log\" ]; then\n\
         \x20   ended=0; grep -q '^{end}' \"$log\" && ended=1\n\
         \x20   total=$(wc -l < \"$log\" | tr -d ' ')\n\
         \x20   if [ \"$total\" -gt \"$n\" ]; then sed -n \"$((n + 1)),${{total}}p\" \"$log\"; n=$total; fi\n\
         \x20   [ \"$ended\" = 1 ] && break\n\
         \x20 fi\n\
         \x20 sleep 1\n\
         done\n\
         echo\n\
         echo 'To continue this conversation: send a follow-up on the task, or Open in terminal.'\n\
         echo 'This window closes in {close_after} seconds.'\n\
         sleep {close_after}\n",
        log = sh_quote(log),
        end = RUN_END_PREFIX,
    )
}

/// A visible terminal running a POSIX `script` where claude runs (inside WSL for the WSL
/// runtime). `None` for native Windows, which has no POSIX shell.
pub fn shell_terminal(
    settings: &AgentSettings,
    runtime: AgentRuntime,
    script: &str,
    os: Os,
    default_terminal: Option<&str>,
) -> Option<Launch> {
    let sh = vec!["sh".to_owned(), "-c".into(), script.to_owned()];
    match (runtime, os) {
        (AgentRuntime::Wsl, _) => {
            let mut args = vec!["wsl.exe".to_owned()];
            args.extend(wsl_prefix(settings));
            args.push("--exec".into());
            args.extend(sh);
            Some(Launch {
                program: "wt.exe".into(),
                args,
                cwd: None,
            })
        }
        (AgentRuntime::Native, Os::Windows) => None,
        (AgentRuntime::Native, Os::Mac) => Some(Launch {
            program: "osascript".into(),
            args: vec![
                "-e".into(),
                format!(
                    "tell application \"Terminal\" to do script \"{}\"",
                    applescript_escape(&format!("sh -c {}", sh_quote(script)))
                ),
                "-e".into(),
                "tell application \"Terminal\" to activate".into(),
            ],
            cwd: None,
        }),
        (AgentRuntime::Native, Os::Linux) => {
            let prefix = settings
                .terminal
                .clone()
                .or_else(|| default_terminal.map(str::to_owned))
                .unwrap_or_else(|| "x-terminal-emulator -e".into());
            let mut parts = prefix.split_whitespace().map(str::to_owned);
            let program = parts.next().unwrap_or_else(|| "x-terminal-emulator".into());
            let mut args: Vec<String> = parts.collect();
            args.extend(sh);
            Some(Launch {
                program,
                args,
                cwd: None,
            })
        }
    }
}

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
    let lookup = r#"exec "${SHELL:-/bin/sh}" -lic 'command -v claude'"#;
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

    #[test]
    fn terminals_resume_the_session_on_each_os() {
        let id = "0199a000-0000-7000-8000-00000000abcd";
        let folder = "/home/alex/it's here";
        let resume = resume_args(id, None);
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
        let with_tools = resume_args(id, Some("/data/agents/s1/mcp.json"));
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
        let resume = resume_args(id, None);
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
    fn a_running_session_is_watched_read_only_in_a_terminal() {
        let script = watch_script("/data/agents/s1/run.log", 15);
        assert!(
            script.starts_with("log='/data/agents/s1/run.log'; n=0\n"),
            "{script}"
        );
        assert!(script.contains("grep -q '^=== Run ended'"), "{script}");
        assert!(script.ends_with("sleep 15\n"), "{script}");
        let linux = shell_terminal(
            &settings(AgentRuntime::Native),
            AgentRuntime::Native,
            &script,
            Os::Linux,
            Some("kitty"),
        )
        .unwrap();
        assert_eq!(linux.program, "kitty");
        assert_eq!(linux.args[..2], ["sh", "-c"]);
        let wsl = shell_terminal(
            &settings(AgentRuntime::Wsl),
            AgentRuntime::Wsl,
            &script,
            Os::Windows,
            None,
        )
        .unwrap();
        assert_eq!(wsl.program, "wt.exe");
        assert_eq!(
            wsl.args[..6],
            ["wsl.exe", "-d", "Ubuntu", "--exec", "sh", "-c"]
        );
        assert!(
            shell_terminal(
                &settings(AgentRuntime::Native),
                AgentRuntime::Native,
                &script,
                Os::Windows,
                None,
            )
            .is_none()
        );
    }

    /// The script itself, run by `sh` on a log that grows and then ends.
    #[cfg(unix)]
    #[test]
    fn the_watch_script_shows_the_log_and_stops_at_its_end() {
        let dir = std::env::temp_dir().join(format!("tm-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("run.log");
        std::fs::write(&log, "● Agent started\n  → Running `ls`\n").unwrap();
        let script = watch_script(log.to_str().unwrap(), 0);
        let child = std::process::Command::new("sh")
            .args(["-c", &script])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let mut more = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
        use std::io::Write as _;
        writeln!(more, "Done.\n{RUN_END_PREFIX}: Done ===").unwrap();
        let output = child.wait_with_output().unwrap();
        let shown = String::from_utf8_lossy(&output.stdout);
        let started = shown.find("● Agent started").unwrap();
        let done = shown.find("Done.").unwrap();
        assert!(started < done, "{shown}");
        assert!(shown.contains("=== Run ended: Done ==="), "{shown}");
        assert_eq!(
            shown.matches("Running `ls`").count(),
            1,
            "each line once: {shown}"
        );
        let _ = std::fs::remove_dir_all(&dir);
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
}

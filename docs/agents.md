# Claude sessions from a task

To use task-master's tools in your own Claude conversations instead, see docs/mcp.md.

**Send to Claude** starts Claude Code in the background on a task: in a folder you pick,
with the task's context, and with task-master's own tools so Claude can report what it is
doing. You follow it on the task, answer it with a follow-up, or open it in a terminal.
Design: `docs/adr/017-agent-sessions.md`.

## 1. Set up (once per device)

1. Install Claude Code and sign in to it once in a terminal (`claude`). On Windows, the
   usual setup is Claude Code inside WSL; a Windows install works too.
2. task-master → **Settings → Agents**:
   - **Runs**: *On this computer* (macOS, Linux, or a Windows install of Claude Code), or
     *In WSL* (Windows app, Claude Code in a WSL distribution). With WSL, pick the
     **Distribution**, or leave *Default*.
   - **Claude Code**: the command, `claude` by default. Click **Check**. Apps started from
     the desktop often do not get your shell's `PATH`; when `claude` is only found through
     your login shell, Check shows where and offers **Use this path**.
   - **Claude may**: the default permissions for new sessions (see below).
   - **Model**: optional, Claude Code's default otherwise.
   - **Terminal** (Linux only): the command that runs what follows it, e.g. `kitty` or
     `gnome-terminal --`. Empty means `$TERMINAL`, else the first installed of
     `x-terminal-emulator`, kitty, alacritty, wezterm, ghostty, foot, konsole,
     gnome-terminal, xfce4-terminal and xterm (each with the flag it needs).
   - **Save**.
3. Optionally give each project a folder: on the project page, the folder button →
   **Choose folder…**. This is device configuration: it is never synced, so each device
   keeps its own paths.

## 2. Send a task

On a task (side panel or page), the **Claude** section → **Send to Claude**:

- **Folder**: where Claude works. Prefilled with the task's last session folder, then the
  project's (or its area's) folder on this device, then the latest folder you used.
  **Browse…** picks one; recent folders are one click away. Under WSL, type a Linux path
  (`/home/you/project`) or pick a folder (`\\wsl.localhost\…` and `C:\…` are converted).
  The first folder used for a project without one becomes its folder.
- **Claude may**:
  - *Edit files* (default): reads and edits files in the folder. Other commands that need
    approval are skipped.
  - *Plan only*: explores and proposes a plan, changes nothing.
  - *Ask first*: anything that needs approval is skipped, since nobody can approve it in
    the background. The session lists what it was refused.
  - *Everything*: runs any command without asking. Asks you to confirm first; use it only
    in folders you can afford to lose.
- **Instructions**: optional. The task's context is always sent: title, description,
  subtasks, prerequisites and dependents, epic, project, tags, earlier sessions'
  summaries and notes. **What Claude gets** shows it.

**Start**. The task's card and row get a chip with what Claude is doing ("Editing
store.rs", "Running `cargo test`"), and the **Agents** page in the sidebar lists it.

## 3. Follow and continue

The task's **Claude** section has one card per session: state, folder, duration, cost and
turns, the summary Claude wrote, its notes, and errors or refused tools.

- **Stop** ends a running session.
- **Reply to continue this session…**: a follow-up turn in the same conversation, after a
  run ended. Headless runs cannot ask you questions mid-run; Claude ends its turn instead,
  and you answer here.
- **Open in terminal** runs `claude --resume <session>` in the folder, in a real terminal
  (Windows Terminal when installed, else a console; Terminal on macOS; the setting on
  Linux), with task-master's tools, so Claude can still add notes and record its summary.
  While a run is going, the button is **Continue in terminal**: Claude Code cannot join a
  run in progress, so the background run stops (what it did so far stays in the
  conversation, the turn it was in is cut short) and the terminal continues the session
  interactively. The session then shows **In terminal** until Claude records its summary, you click **Mark
  done**, or you quit Claude there (`/exit`, or closing the window). Once it is done, the
  app stops that Claude about 8 seconds later (time for its last message), which closes
  the terminal, so finished sessions never pile up. This also holds across an app
  restart. Not with a native Windows install of Claude Code, where the app cannot tell
  which process is Claude: close those yourself. A session already open in a terminal
  cannot be opened in a second one.
- The bin icon removes an ended session from the task's history (undoable).

Sessions run as children of the app. Quitting asks first when some are running, and stops
them; they show **Interrupted**. **Resume** continues one in the background (a follow-up
asking Claude to pick up where it left off). If Claude still finishes after the app quit,
its summary marks the session done.

## 4. Agent tasks

Claude may create tasks to plan and track its work: usually subtasks of the task you
sent. They belong to the agent and stay out of your views:

- They count under their parent and carry a bot mark in its subtask list.
- **Agents** lists them under the task they serve. **Make it mine** turns one into an
  ordinary task of yours.
- A view's options have **Show agent tasks** to see them in place.

Claude can edit its own tasks freely. Of your tasks, it can only change the status, and
only of the task you sent and its subtasks, and it never closes them (Done, Cancelled):
that is yours to decide.

## 5. Review

The app moves the task itself; Claude is not asked to. When you send a task (or a
follow-up), it moves to **In progress**. When Claude reports the work done (it records its
summary, or its run ends well), it moves to **Review**, a status of the default workflow
between Waiting and Done, so finished agent work waits for you on the board instead of
being marked done unseen. Read the summary on the task, then move it to Done, or send a
follow-up. A task you already closed stays closed when Claude finishes.

Pick other statuses in Settings → Agents, under *When sent* and *When done* (per device).
Review is an ordinary status: rename, recolor or reorder it in Settings. If you delete a
picked status, the default is used again; with no Review status, tasks stay where they
are when Claude finishes.

## How it works

- Each session runs `claude -p` with `--output-format stream-json` in the folder, with
  the brief and your instructions on stdin, and the task-master MCP server
  (`task-master-mcp`, installed next to the app) in its `--mcp-config`. Files per session
  are in the app's data folder, `agents/<session id>/` (`mcp.json`, `rules.md`).
- The MCP server opens this device's database directly, so what Claude writes appears at
  once, syncs, and is in the task's activity. Its tools: `get_task`, `list_tasks`,
  `list_projects`, `search`, `create_task`, `update_task`, `add_note`,
  `complete_session`.
- Under WSL, Claude Code runs the Windows `task-master-mcp.exe` through WSL interop, so
  the database stays on the Windows side.

## Troubleshooting

- **"claude: not found"** or the session fails at once: Settings → Agents → **Check**,
  then **Use this path**. Under WSL, check the distribution is the one where Claude Code
  is installed.
- **"the task-master MCP server is missing"**: reinstall the app. In development, run
  `cargo build -p taskmaster-mcp` (the dev app looks for it in `target/debug/`).
- **Done, but "Needed approval…"**: the permission mode skipped tools. **Open in terminal**
  continues the session interactively, where Claude Code can ask you; or start again
  with more permissions.
- **Nothing happens in WSL**: `wsl.exe -l -q` in PowerShell must list the distribution;
  `wsl.exe -d <name> --exec claude --version` must print a version.

## Development

- `cargo build -p taskmaster-mcp` before `pnpm tauri dev`, so the dev app finds the server
  next to its binary.
- Installers bundle it through `src-tauri/tauri.sidecar.conf.json`, which runs
  `scripts/sidecar.mjs` (builds `taskmaster-mcp` for the target and copies it to
  `src-tauri/binaries/task-master-mcp-<triple>`) and lists it as `externalBin`. CI and
  release.yml pass it with `--config`. It stays out of `tauri.conf.json` because Tauri's
  build script refuses to compile the desktop crate when an `externalBin` file is
  missing, which would break plain `cargo clippy` and `cargo test`.
- A real end-to-end run (costs tokens): `cargo build -p taskmaster-mcp && cargo test -p
  taskmaster-desktop real_claude -- --ignored`.

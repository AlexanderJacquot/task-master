# ADR 017: Agent sessions (Claude Code from a task)

Date: 2026-11-05 · Status: accepted (M16, branch `m16-agent-sessions`); steps 1 to 5 done (manual Windows + WSL check pending)

## Context

Plan Phase 3 ("Claude sessions from a task"), started before Phase 2 at the user's request.
The user wants to send a task to Claude Code, let it run in the background with a visible
status, open it in a terminal when needed, and let agents track their own progress as tasks
in the same space without cluttering the user's views. Decided with the user:

- **Runtime is a per-device setting**: `wsl` (Windows app, claude inside a WSL distro, the
  user's case today), `native` (macOS/Linux, or Windows with a Windows claude install).
- **Headless runs**, with "Open in terminal" doing `claude --resume <id>` in a real terminal.
  No embedded PTY or terminal emulator.
- **Working directory**: a per-device default folder on the project, and a picker on spawn
  prefilled with the task's last folder, then the project's, then recent ones.
- **Agent tasks** carry `owner = agent` and are hidden from the user's views by default;
  an Agents section in the sidebar shows them with the sessions.

## Decisions

### Data (core, migration 0010)

- `tasks.owner TEXT NOT NULL DEFAULT 'me' CHECK (owner IN ('me','agent'))`. Set by
  `CreateTask`; the MCP always creates `agent` tasks. `UpdateTask` can change it (adopt an
  agent task: agent → me). Synced, exported, in undo like any field.
- `project_folders(project_id, path, runtime, updated_at)`: plan Phase 2's folders, as
  **device configuration** like the calendar tables (ADR 014): written directly by
  `Store::set_project_folder`, outside `ops`, never synced, exported or undoable (a path
  means nothing on another device, and each device has its own database, so no
  `device_id` column). No foreign key, so an import or "replace with the server's data"
  stays valid; `Store::project_folders` skips folders of projects that are gone.
- `agent_sessions(id, task_id, device_id, claude_session_id, folder, runtime,
  permission_mode, prompt, state, started_at, ended_at, summary, cost_usd_micros, turns,
  error, timestamps, deleted_at)`. `state` is `running | done | failed | cancelled |
  interrupted | terminal`. `running` and `terminal` (continued by hand in a terminal) are
  *active*: becoming inactive sets `ended_at`, becoming active again clears it; active
  sessions cannot be removed and stay out of the brief's earlier sessions. Rows go through `CreateAgentSession` / `UpdateAgentSession` /
  `DeleteAgentSession` and sync, so other devices see the history, but the commands refuse
  a session whose `device_id` is not this device's. Cost is stored in millionths of a
  dollar (an integer, so entities stay `Eq` and exact).
- **Sessions stay out of the undo stack**: the shell writes start, progress and end with
  `Store::execute_without_undo`, so Ctrl+Z still reaches the user's last edit. Removing a
  finished session is the user's action and goes through `execute` (undoable).
  `Store::interrupt_running_sessions` marks this device's `running` rows `interrupted` at
  start-up. Each start, end and note bumps the task's `updated_at`, as attachments do.
- `agent_notes(id, session_id, task_id, body, timestamps, deleted_at)`: progress lines the
  agent writes through the MCP (`AddAgentNote`, at most 4000 characters). Not in the
  snapshot (they can be many): read with `Store::agent_notes(task, session?, limit)`.
  Sessions are in the snapshot (of live tasks, like time blocks).
- The activity feed shows `agent_start` (folder), `agent_end` (state, summary) and
  `agent_note` (body). Export and import carry sessions and notes.
- `core::brief(task_id) -> String`: the context brief (task, description, subtasks,
  prerequisites and dependents with their status, epic, project, tags, priority, due date,
  recent activity, previous sessions' summaries) as markdown. Snapshot-tested.

### Spawning (desktop shell, `src-tauri/src/agents/`)

- IPC commands, the minimum for a process the core cannot own: `agent_start({task_id,
  folder, permission_mode?, prompt})`, `agent_send(session_id, message)` (a follow-up turn
  after a run ended), `agent_cancel`, `agent_open_terminal`, `agent_live` (activity of
  running sessions, for a window that just opened), and reads/settings: `agent_brief`,
  `agent_notes`, `agent_settings`, `set_agent_settings`, `detect_claude`,
  `list_wsl_distros`, `project_folders`, `set_project_folder`. One event,
  `AgentActivity { session_id, activity }` (`None` when a run stopped). CLAUDE.md's IPC
  list names the group.
- Settings (`config.json`, `agents`): runtime, WSL distro (default one when unset),
  `claude_path`, Linux terminal command, default permission mode, optional model.
  `detect_claude` runs `claude --version`; when `claude` is not on the PATH a GUI app
  (or `wsl.exe --exec`) gets, it asks the user's login shell (`$SHELL -lic 'command -v
  claude'`) and offers that absolute path.
- Each session has `<data dir>/agents/<session id>/` with `mcp.json` (our server with
  `--db` and `--session`) and `rules.md`, passed by path (as the runtime sees it:
  `C:\…` becomes `/mnt/c/…` under WSL). The run is `claude -p --output-format stream-json
  --verbose --session-id <id> --append-system-prompt-file rules.md --permission-mode
  <mode> --mcp-config mcp.json --allowedTools mcp__task-master [--model m]`; a follow-up
  uses `--resume <id>` instead of the id and rules (a resumed session keeps its first
  system prompt). The brief plus the user's instructions go on **stdin**.
- WSL: `wsl.exe [-d <distro>] --cd <linux folder> --exec <claude> …`. `--exec` runs
  without a Linux shell, so arguments arrive as given (paths with spaces). A folder
  picked in the dialog (`\\wsl.localhost\<distro>\…` or `C:\…`) is converted to a Linux
  path. Children start without a console window (`CREATE_NO_WINDOW`).
- The stream is parsed line by line (`agents/stream.rs`, tested on a recorded run):
  tool uses become the activity line ("Editing store.rs", "Running `cargo test`",
  "Noting: …"), `system/permission_denied` and the result's `permission_denials` list
  refused tools, `result` gives the final message, cost and turns. Live status goes to
  the window as an event, never through `execute`; the start and the end are written as
  commands (`execute_without_undo`).
- The end: cancelled when the user stopped it, done for a successful result, else failed
  with the result text, the end of stderr, or the exit status. The agent's own summary
  (`complete_session`) is kept over Claude's last message. Cost and turns add up over
  follow-ups. Refused tools on a done run are reported in `error` ("Needed approval…").
  A start that cannot launch (missing folder, MCP binary or `claude`) still records the
  session, as failed with the reason.
- Permission mode is chosen at spawn: `acceptEdits` by default, `plan`, `default` (tools
  that need approval are denied and listed in the result), `bypassPermissions` behind a
  confirmation. Approving tools from the app (`--permission-prompt-tool` served by our
  MCP) is a follow-up, noted under Later.
- **Open in terminal** runs `claude --resume <id>` in the folder: `wt.exe wsl.exe -d … --cd
  … --exec claude --resume <id>` on Windows (a `cmd /c start` console without Windows
  Terminal), Terminal.app through `osascript` on macOS, the setting, `$TERMINAL`, else the
  first installed of a known list (`x-terminal-emulator`, kitty, alacritty, wezterm, ghostty,
  foot, konsole, gnome-terminal, xfce4-terminal, xterm; each with its own "run" flag) on
  Linux, since Arch and Fedora have no `x-terminal-emulator`. The terminal gets the
  session's `--mcp-config` and `--allowedTools mcp__task-master`, so notes and the
  summary still land. Allowed while running (it forks the conversation in Claude Code)
  but the UI suggests waiting or cancelling; a running session stays `running`. Any other
  becomes `terminal`, which ends (`done`) when the agent calls `complete_session`, when
  the terminal process exits at least 3 s after opening (launchers such as gnome-terminal,
  `wt.exe` and `osascript` return at once and cannot be followed), or with the card's
  **Mark done** (a user edit, undoable). An `interrupted` session has **Resume**: a
  follow-up asking the agent to pick up where it left off.
- Sessions are children of the app: on exit the shell marks running ones `interrupted`
  and kills them (the confirmation before quitting is the UI's, step 4).

### MCP server (`crates/mcp`, a Tauri sidecar)

- Stdio MCP server built on the core, opening the **same local database** (ADR 015's
  local mode). The desktop already reloads on outside writes (`PRAGMA data_version`), so
  agent edits appear live. It writes through `core::execute`, so undo, ops and sync apply.
- Bundled as a Tauri `externalBin` sidecar, declared in `src-tauri/tauri.sidecar.conf.json`
  (passed with `--config` by CI and release.yml), whose `beforeBuildCommand` runs
  `scripts/sidecar.mjs`: `cargo build -p taskmaster-mcp --target $TAURI_ENV_TARGET_TRIPLE`
  copied to `binaries/task-master-mcp-<triple>`. Not in `tauri.conf.json`: tauri-build
  fails any build of the desktop crate whose `externalBin` file is missing, which would
  break plain `cargo clippy`/`cargo test` and `tauri dev`. The installed app finds it
  next to its executable; the dev app in `target/debug/`. Under WSL, claude starts the
  Windows `.exe` through WSL interop (`/mnt/c/...`), so the database stays on the Windows
  side with one writer process model and no network.
- Binary `task-master-mcp --db <path> [--session <id>]`. The per-session `--mcp-config`
  file passes both as arguments (no environment variables, which `wsl.exe` interop does
  not forward by default); the task comes from the session row. A missing database file
  is an error, never a new empty database. Without `--session` it still reads, searches
  and creates agent tasks, but notes, summaries and edits of the user's tasks are refused.
- Tools (tool errors come back as `is_error` results the model can read, not protocol
  errors): `get_task` (the brief; defaults to the session's task), `list_tasks` (project /
  epic / parent / owner filters, open tasks unless `include_closed`, at most 200 rows),
  `list_projects` (projects with areas, epics), `search`, `create_task` (owner `agent`; in
  a session a subtask of the session's task unless `parent_id` or `top_level`; project
  from the parent, else the session task; status by name or category; `depends_on`),
  `update_task` (agent tasks: status, title, description or `append_description`,
  priority, prerequisites; the user's tasks: status only, and only the session's task and
  its subtasks at any depth), `add_note`, `complete_session` (stores the summary; for a
  `running` session the shell still sets the state when the run ends, which keeps the
  agent's summary over Claude's last message; any other session, in a terminal or
  outliving an app that quit and marked it `interrupted`, is marked `done` here, since
  nothing else would end it).
- Server instructions tell the agent how to track its work and which task it is on.
- **Dependency: `rmcp` 3.9** (official Rust MCP SDK; features `server`, `macros`,
  `transport-io`) rather than a hand-written JSON-RPC loop.

### Sharing the database with the desktop (core changes for M16)

- **Outside writes no longer always clear the undo history.** `refresh_external_changes`
  now compares the fields other processes wrote (local ops not from this store's own
  batches, `updated_at` aside) with the fields undo or redo would write back (the
  inverses of the history's batches). Only an overlap clears the history; an agent adding
  notes, its own tasks, or renaming a task whose creation is the user's last edit leaves
  Ctrl+Z working. The UI still gets its reload event.
- **Write transactions are `BEGIN IMMEDIATE`.** With two writer processes on one WAL
  database, a deferred transaction that read first fails at once with
  `SQLITE_BUSY_SNAPSHOT` when the other committed meanwhile; an immediate one waits on
  the 5 s busy timeout instead.

### UI

- Task page and sidebar: **Send to Claude** button → dialog (folder with picker and recents,
  permission mode, optional instructions, a collapsed preview of the brief).
- A session chip on task cards and rows: spinner + activity line while running, then
  done / failed / interrupted. Task page: a Sessions section (state, duration, cost,
  summary, notes, denials) with Open in terminal, Send follow-up, Cancel.
- Sidebar **Agents** section: running sessions first, then recent ones, and an "Agent
  tasks" list grouped by the user's task they serve. Capped instead of virtualized (the
  latest 50 ended sessions, the 100 most recently updated agent tasks, with a note when
  more exist); each task's page keeps its full session history.
- Views get `owner` in `ViewSpec` (default `me`); a toggle "Show agent tasks" in the view
  options. Agent subtasks of the user's tasks are counted but collapsed, with an agent mark.
- Settings → Agents: runtime (`wsl` + distro picked from `wsl.exe -l -q`, or `native`),
  claude path (default `claude`), terminal, default permission mode; project page gets
  "Folder on this device".

## Consequences

- One new crate, one new Rust dependency (`rmcp`), one sidecar binary in the installers
  (release.yml builds it per target). No new frontend dependency.
- Agent work is ordinary data: synced, exported, undoable, searchable.
- Headless runs cannot ask questions mid-run; the agent ends its turn, the session shows
  done, and the user answers with Send follow-up or Open in terminal.
- Not in M16: CLI (`tk`), remote MCP over `/api/v1`, `.tasks.toml` folder markers, in-app
  permission approvals, sessions that survive quitting the app.

## Steps

1. Core: migration 0010, `owner`, project folders, sessions, notes, commands, brief +
   snapshot tests, sync/export coverage.
2. `crates/mcp` with tests driving the tools over an in-memory store.
3. Shell: settings, spawn (native + WSL), stream parser (tested on recorded streams),
   cancel, follow-up, open in terminal, start-up recovery; bindings regenerated.
4. UI: Send to Claude dialog, session chips and panel, Agents section, owner filter,
   Settings → Agents, project folder.
5. Sidecar packaging in tauri.conf and release.yml; docs/agents.md; manual check on
   Windows + WSL.

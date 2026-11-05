# ADR 017: Agent sessions (Claude Code from a task)

Date: 2026-11-05 · Status: accepted (M16, branch `m16-agent-sessions`); step 1 done

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
  interrupted`; leaving `running` sets `ended_at`, a follow-up turn back to `running`
  clears it. Rows go through `CreateAgentSession` / `UpdateAgentSession` /
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

### Spawning (desktop shell, `src-tauri/src/agents.rs`)

- New IPC commands, the minimum for a process the core cannot own: `agent_start(task_id,
  folder, runtime, permission_mode, extra_prompt)`, `agent_cancel(session_id)`,
  `agent_send(session_id, message)` (follow-up turn after a run ended),
  `agent_open_terminal(session_id)`. CLAUDE.md's IPC list gains this group.
- The shell generates the Claude session id (UUIDv7 formatted as a UUID) and runs
  `claude -p --output-format stream-json --verbose --session-id <id>
  --permission-mode <mode> --mcp-config <file> --append-system-prompt <rules>`, the brief
  on **stdin** (no quoting through `wsl.exe`). WSL runtime prefixes
  `wsl.exe -d <distro> --cd <path> --`, with the path given as a WSL path.
- The stream is parsed line by line: `system/init` confirms the session, `assistant` tool
  uses become the live activity line ("Editing src/x.rs"), `result` ends the session with
  summary, cost, turns and permission denials. Live status goes to the window as an event,
  not through `execute`; only start and end are written as commands.
- Permission mode is chosen at spawn: `acceptEdits` by default, `plan`, `default` (tools
  that need approval are denied and listed in the result), `bypassPermissions` behind a
  confirmation. Approving tools from the app (`--permission-prompt-tool` served by our
  MCP) is a follow-up, noted under Later.
- **Open in terminal** runs `claude --resume <id>` in the folder: `wt.exe wsl.exe -d … --cd
  …` on Windows, Terminal.app on macOS, `$TERMINAL` or a setting on Linux. Allowed while
  running (it forks the conversation in Claude Code) but the UI suggests waiting or cancelling.
- Sessions are children of the app: quitting the app cancels them after a confirmation.

### MCP server (`crates/mcp`, a Tauri sidecar)

- Stdio MCP server built on the core, opening the **same local database** (ADR 015's
  local mode). The desktop already reloads on outside writes (`PRAGMA data_version`), so
  agent edits appear live. It writes through `core::execute`, so undo, ops and sync apply.
- Bundled as a Tauri `externalBin` sidecar. Under WSL, claude starts the Windows `.exe`
  through WSL interop (`/mnt/c/...`), so the database stays on the Windows side with one
  writer process model and no network.
- The per-session `--mcp-config` file passes `TM_SESSION_ID` and `TM_TASK_ID`, so tools
  know their session without the model having to pass ids around.
- Tools: `get_task` (the brief, or any task), `list_tasks` (project / epic / status / owner
  filters, compact), `search`, `create_task` (owner `agent`, defaults to the session task's
  project, optional parent and prerequisite links), `update_task` (status, title,
  description, priority; agent-owned tasks freely, the user's tasks only status of the
  session task and its subtasks), `add_note`, `complete_session` (final summary).
- **Dependency: `rmcp`** (official Rust MCP SDK) rather than a hand-written JSON-RPC loop.

### UI

- Task page and sidebar: **Send to Claude** button → dialog (folder with picker and recents,
  permission mode, optional instructions, a collapsed preview of the brief).
- A session chip on task cards and rows: spinner + activity line while running, then
  done / failed / interrupted. Task page: a Sessions section (state, duration, cost,
  summary, notes, denials) with Open in terminal, Send follow-up, Cancel.
- Sidebar **Agents** section: running sessions first, then recent ones, and an "Agent
  tasks" list grouped by session task. Virtualized.
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

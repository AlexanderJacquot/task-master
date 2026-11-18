# ADR 028: Terminal sessions count with agent sessions

Date: 2026-11-18 · Status: accepted (M21, branch `m21-terminal-usage`)

## Context

The Agents page (ADR 017) totals what agent sessions cost and how long they worked, by
project, period and against spend limits. It only knows the sessions started with "Send
to agent". Most Claude Code work happens in a terminal, outside the app, and that cost and
time were missing.

Claude Code keeps a transcript of every session in
`${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<folder>/<session id>.jsonl`. Each line is one
JSON event. The lines that matter:

- `user` and `assistant` messages carry `timestamp` and `cwd`; assistant messages carry
  `message.model`, `message.usage` and `requestId`.
- `system` / `turn_duration` gives `durationMs`, the time one turn took (Claude working,
  not the user typing).
- `cost-state` gives the process's running totals: `totalCostUSD` (every model, sub-agents
  included), `totalAPIDuration`, `totalToolDuration` and `startTime`. It repeats; the last
  one for a `startTime` holds that process's totals.
- `ai-title` (or `custom-title` after a rename) is the conversation's name.

On this machine, 201 of 224 transcripts had a `cost-state` line. Reading them gives the
same $513.53 as summing the last `cost-state` of each process directly.

The format is not a documented API.

## Decisions

**A synced table, written through `execute`.** Migration 17 adds `terminal_sessions`:
one row per Claude Code session, with the folder, an optional project and task, title,
main model, first and last message, cost, working time and requests. It is an op entity
like the rest, so it syncs (every device's totals agree) and exports. Three commands:

- `RecordTerminalSessions { sessions }`: adds or updates rows by `claude_session_id`.
  It skips the app's own runs (an `agent_sessions` row has that id) and rows the user
  deleted. Unchanged rows write no op. New rows get the project whose folder on this
  device (`project_folders`, the deepest match; Windows paths compared without case)
  holds the session's folder, worktrees included. A row without a project gets one when
  its folder gains a project later, unless its project was ever set by hand (an op
  wrote `project_id`). The shell sends it with `execute_without_undo`: bookkeeping, not
  an edit.
- `UpdateTerminalSession { id, changes: [ProjectId | TaskId] }`: filing by hand,
  undoable.
- `DeleteTerminalSession { id }`: leaves it out of the totals; reading the transcript
  again does not bring it back. Undoable.

**Read in the shell, where agents run.** `src-tauri/src/agents/terminal.rs` reads the
`projects` folder of the agent runtime: this device's, or WSL's through
`wsl.exe … wslpath -w` (read over `\\wsl.localhost`). It reads only top-level
`*.jsonl` files named after a session id, so sub-agent transcripts are skipped. A scan
reads only files whose size or modification time changed; `terminal-sessions.json` in the
data folder remembers them. It runs 15 s after start and every 5 minutes (setting
"Count sessions I run in a terminal", on by default), and on demand ("read them now",
IPC `scan_terminal_sessions`). Lines are filtered by substring before parsing, since
request and file-history lines can be large. A first scan of 324 MB took 3.7 s in a
debug build.

**Claude Code's own numbers, no price list.** Cost is the sum of each process's last
`totalCostUSD`, and is `None` without a `cost-state`. Working time is the sum of
`turn_duration`, else API plus tool time. Requests are distinct `requestId`s outside
sidechains. The model is the one with the most output tokens.

**One set of totals.** The Agents page counts both kinds of session through one shape
(`Counted` in `usage.ts`): by project, by period (a terminal session counts on its last
message), and against the spend limits, which now cover terminal spend too ("Send to
agent" asks before going over). A "Sessions" filter shows all, those sent from tasks, or
those run in a terminal. Recent sessions mixes both. A terminal row has a project picker
and a remove button.

## Consequences

- Schema 17: update the sync server with the app.
- A Claude Code change to the transcript format degrades quietly: missing lines mean no
  cost or no time, never a failed scan.
- A transcript deleted by Claude Code's cleanup (`cleanupPeriodDays`) keeps its row: the
  row is the record.
- Sessions started from tasks but continued in a terminal (`agent_open_terminal`) keep
  their agent session and are not counted twice.
- Not in the MCP yet: `list_agent_sessions` lists the app's own runs only.

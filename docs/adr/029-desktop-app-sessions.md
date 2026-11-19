# ADR 029: Agent sessions in the Claude desktop app

Date: 2026-11-19 · Status: accepted (M22, branch `m22-desktop-app`)

## Context

"Send to agent" (ADR 017) starts Claude Code headless, followed by the app, or continues a
session in a terminal. The user also works in the Claude desktop app and wants to send a
task there instead.

The desktop app has a documented link, `claude://code/new?q=<prompt>&folder=<path>`. It
opens a new Code session in that folder with the prompt typed in. The user sends it. It
cannot:

- pass a system prompt or an MCP config;
- open an existing session (`claude://code/<id>` is reported as present but switched
  off; but see the second amendment);
- send the prompt by itself.

The desktop app exists for macOS and Windows only.

## Decisions

**A third place to run, "In the Claude desktop app".** `AgentStart.surface`:
`background` (the default) or `desktop`. For `desktop`, `agent_start` records the session,
marks it with a new state `desktop` (active, like `terminal`), and opens the link with the
opener plugin. Refused before anything is recorded on Linux, and when agents run in WSL:
the desktop app runs sessions on the Windows side. A failed open marks the session failed.

**The rules go in the first message.** `desktop_prompt` puts the app's rules first,
with the session id and "pass session_id to add_note and complete_session". Then the
user's standing directive, the brief and the instructions follow. When the link would be
too long, a short form sends the agent to `get_task` instead of carrying the brief. The
limit is 2,000 characters on Windows, where protocol launches are cut near 2 KB, and
16,000 elsewhere.

**The MCP takes a session id when it has none.** `add_note` and `complete_session` take
an optional `session_id`. A server started without a session (the claude.ai connector, or
the local server added by hand) accepts it only for a session in state `desktop`. A server
started for a session refuses any other id.

**Any device may record a desktop session.** No process belongs to it, and the claude.ai
connector writes from the sync server, another device. So `own_session` lets any device
update a `desktop` session. Once it ends, only its device may again.

**Its conversation id, then its cost.** Claude Code gives the servers it starts
`CLAUDE_CODE_SESSION_ID`. When the local server records a note or summary for a desktop
session, it also records that id: `AgentSessionChange::ClaudeSessionId`. The transcript
importer (ADR 028) then knows the transcript is this session's. It fills the session's
cost, time and requests from the transcript while the session is in the desktop app, or
once it has ended with no cost reported. It never does so for a headless run in progress,
which adds its own cost when it ends. A follow-up or "Open in terminal" can then resume
the conversation, but both are refused while it is still open in the desktop app.

**No migration.** `state` is free text, and the new value ships in the same release as
schema 17 (ADR 028), so no older app syncs with it.

## Consequences

- Through the claude.ai connector, no conversation id is recorded (it has no
  environment). That session's transcript shows on the Agents page as a terminal session
  instead, and the agent session has no cost.
- The permission mode and model chosen in the dialog do not apply: the desktop app has
  its own. The dialog hides them.
- Checked on macOS (2026-11-19, desktop app 6.6395, Claude Code 2.1.326): it writes
  transcripts to `~/.claude/projects` like the CLI, and gives `CLAUDE_CODE_SESSION_ID`
  (with `CLAUDE_CODE_ENTRYPOINT=claude-desktop`) to the stdio MCP servers it starts. Not
  yet on Windows.

## Amendment (2026-11-19, after the macOS check)

- The desktop app writes no `turn_duration` and a `cost-state` only now and then (often
  none for a whole session). The importer therefore fills a session's turns and time
  even without a cost (the cost follows with a later scan, if it ever appears), and the
  transcript reader gives a third measure of time: each prompt to the last line before
  the next (ADR 028 amendment). The scan cache records its reader version, so finished
  transcripts are read once more after such a change.
- **Open in terminal** on a session that was in the desktop app makes its
  `agents/<id>/` folder (it has none): the terminal gets the session's MCP config and
  records claude's pid, so Mark done stops it like any other.
- The desktop app asks to trust a folder it has not opened before; the first Send can
  end at that question, and the prompt must be sent again.

## Amendment (2026-11-19): back to the conversation

The desktop app (checked in 6.6395 on macOS) does open an existing Code session:
`claude://code/continue?session=local_<id>`, the link behind its own "Continue Last
Claude Code Session" action. It takes the desktop app's id, not the conversation's, and
only works while deep links are on and the user is signed in; an archived session opens
the Code home instead. The app keeps one record per session in
`<app data>/claude-code-sessions/<account>/<org>/local_<id>.json` (`~/Library/Application
Support/Claude` on macOS, `%APPDATA%\Claude` on Windows), with `cliSessionId` and
`lastAssistantCliSessionId`: the conversation we record. (It also gives
`CLAUDE_CODE_HOST_SESSION_ID=local_<id>` to the processes it starts.)

- **Click "In desktop app"** (the session card and the Agents page) to bring the
  conversation up. A new shell command, `agent_open_desktop(session_id)`, reads the
  records for the session's conversation id. When none was recorded (the claude.ai
  connector), it takes the transcript written since the session started whose first
  lines carry the session id (the first message names it), and looks that conversation
  up. It refuses on Linux, for a session of another device, when nothing is found (the
  prompt not sent yet, or deleted there), and for an archived conversation, with a reason
  shown on the card or row.
- **Reading, not recording.** The local id is looked up each time, not stored: no schema
  change, and nothing to sync for a path that only exists on one device. The records and
  the link are the desktop app's own, not a documented API: a record that does not parse
  is skipped, and a change there shows as "cannot find this conversation".

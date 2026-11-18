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
  off);
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
- Not checked on a real macOS or Windows desktop app: that it writes transcripts to
  `~/.claude/projects` like the CLI, and that it gives `CLAUDE_CODE_SESSION_ID` to MCP
  servers.

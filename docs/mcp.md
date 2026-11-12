# task-master in your own Claude (MCP)

task-master ships an MCP server, `task-master-mcp`, the program that gives Claude tools
over your tasks. **Send to Claude** (docs/agents.md) already starts it for each session.
You can also add it to the Claude you use every day, so that in any conversation you can
ask "what's on my plate this week?", "find the task about the sync bug", or "plan two
hours for it on Thursday".

## 1. Add it

The server comes with the app: install task-master on the computer and open it once (it
creates the database). Then register the binary with Claude. With no arguments it opens
the same database as the app on that computer.

| Installed from | Binary |
| --- | --- |
| AUR, `.deb`, `.rpm` | `/usr/bin/task-master-mcp` (on `PATH`) |
| Windows installer | `%LOCALAPPDATA%\task-master\task-master-mcp.exe` |
| macOS | `/Applications/task-master.app/Contents/MacOS/task-master-mcp` |
| AppImage | inside the image; use a package above, or `cargo build --release -p taskmaster-mcp` |
| Windows app, Claude Code in WSL | `/mnt/c/Users/<you>/AppData/Local/task-master/task-master-mcp.exe` |

**Claude Code**, for every project (`--scope user`; without it, only the current folder):

```sh
claude mcp add --scope user task-master -- task-master-mcp
# Windows app, Claude Code in WSL:
claude mcp add --scope user task-master -- /mnt/c/Users/<you>/AppData/Local/task-master/task-master-mcp.exe
```

Check with `claude mcp list`, or `/mcp` inside Claude Code. To skip the approval prompt
for each tool call, allow them in `~/.claude/settings.json`:
`"permissions": { "allow": ["mcp__task-master"] }`.

**Claude Desktop** (Windows, macOS): Settings → Developer → Edit Config opens
`claude_desktop_config.json`; add the server and restart Claude Desktop:

```json
{
  "mcpServers": {
    "task-master": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\task-master\\task-master-mcp.exe"
    }
  }
}
```

**claude.ai** in the browser and the mobile apps cannot start a program on your computer.
They need a server reachable over HTTPS (see *Later* below).

`task-master-mcp --show-db` prints the database it opens: `$TASK_MASTER_DB` when set,
else the "Data folder" chosen in Settings, else the app's data folder. `--db <path>`
picks another one.

## 2. How Claude uses it

There are no keywords and nothing to invoke. When a Claude Code session starts, it starts
each configured server and asks it for its tools: a name, a description, and the shape of
the arguments for each (`list_tasks`, `search`, `get_calendar`, ...), plus a short
instruction text from the server. These go into the model's context like the rest of the
prompt. The model reads your message and decides on its own to call a tool when one fits,
as it decides to read a file. "What should I work on today?" will usually lead to
`list_tasks` and `get_calendar`; "refactor this function" will not touch task-master.

- Naming it helps when the request is ambiguous: "check task-master for…".
- Claude Code asks before each call unless allowed (above). The call and its result show
  in the conversation.
- With many servers, Claude Code may hold back the full tool descriptions and load them
  when a search finds them relevant. It is still the model choosing.
- The server runs as long as the session, as a child process talking over stdin/stdout.
  It is not a daemon and opens no port.
- Compare: a **slash command** is what you invoke directly. A **skill** is also chosen by
  the model from its description. An **MCP server** adds tools (and could add prompts,
  which show up as `/mcp__task-master__…` commands; this one has none).

What it may do, outside a Send to Claude session:

- Read everything: tasks, projects and epics, search, the calendar (time blocks and your
  shown Google calendars), the lineage, and agent sessions.
- Create **agent tasks**: they stay out of your views, on the **Agents** page, where
  **Make it mine** turns one into your task. It can plan time and add links only for
  those.
- Your own tasks are read-only. Notes and session summaries need a session.

Writes go through the same commands as the app: they appear in the open app at once,
are in the task's activity, and sync.

### Agent run history

`list_agent_sessions` lists runs newest first. Use `state: "failed"` to find failures.
Use `latest_only: true` with that filter to find tasks whose **most recent** run failed;
without it, the list also includes earlier failures on tasks that succeeded later.
The optional `task_id` and `project_id` filters narrow the list. Each row includes the
session and task ids, task title and current task status, run state, start/end times
(Unix milliseconds), and a short summary and error. The response is JSON.

`list_agent_sessions` and `list_tasks` return at most 200 rows per call (50 by default).
When `next_cursor` is present, pass it as `cursor` with the same filters to read the next
page. `list_tasks` has no `next_cursor` after its last page.

## 3. Versions and updates

The server is versioned with the app: one release builds both, the installers ship
both, and the server reports the app's version to Claude (`/mcp` shows it). Updating the
app (in-app updater, `pacman`, or a new installer) updates the server; the next Claude
session starts the new one. Nothing is published separately, and there is no package
to install from npm or elsewhere.

The registration in Claude is just a command line: user scope keeps it in
`~/.claude.json`, project scope (`--scope project`) in a `.mcp.json` you can commit to a
repository.

## 4. Other computers

Each computer runs its own server over its own database: install task-master there, set
up sync (docs/server.md), and run the `claude mcp add` line once. What Claude changes on
one computer syncs to the others like any edit. The command differs per OS (table
above), so the line is per computer. Put it in your dotfiles setup script to repeat it.

## Later

- Let Claude create tasks that are yours, not agent tasks (an opt-in flag), for "add a
  task for…" requests. A rule change to ADR 017, to decide first.
- A remote MCP endpoint on the sync server (Streamable HTTP, with sign-in) for claude.ai
  and the mobile apps, and for computers without the app.
- Settings → Agents: show this computer's `claude mcp add` line with its binary path, to
  copy.
- A Claude Code plugin (a marketplace in a git repository with `.mcp.json` and a skill) to
  install it with `/plugin install`. It needs the binary on `PATH`, so it only suits
  package installs.

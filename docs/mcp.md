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
They use the sync server's remote endpoint instead (section 5).

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
  **Make it mine** turns one into your task. It changes and deletes those freely.
- Everything else you can do in the app, when you ask: create tasks of your own
  (`create_task` with `owner: "me"`); edit your tasks (`update_task`: status, title,
  description, priority, prerequisites, project, epic, parent, due date, today, estimate,
  tags, order in the column, adopting an agent task); delete them (`delete_task`); edit,
  archive and delete projects, epics and tags (`update_project`, `delete_project`,
  `update_epic`, `delete_epic`, `list_tags`, `update_tag`, `delete_tag`); plan or log
  time on any task (`schedule_block`, `update_block`); link any tasks (`link_tasks`);
  attachments (`list_attachments`, `attach_file`, `read_attachment`,
  `rename_attachment`, `remove_attachment`); remove ended agent sessions
  (`remove_agent_session`). Settings → Agents → **Let agents edit my tasks** turns all
  of this off (deletes included); the remote MCP on the sync server always may. Notes and
  session summaries need a session: the server's own, or one opened in the Claude desktop
  app, named with `session_id` (its first message gives it; ADR 029).
- Every write reports a `change_id`; `undo` reverts that change (refused when the same
  things changed since). With editing off it still undoes the agent's own changes.
- Not available: board columns and saved views (Settings), and app preferences.
- Attaching by `path` works on this device's server only; the remote MCP takes `text`
  or `base64` content and never reads the server's files.

`task-master-mcp --version` prints its version: it should match the app's (Settings →
About). On Windows, an update stops a running `task-master-mcp.exe` before replacing it
(Claude Code reconnects to the new one); before 0.22.0 it could stay on an old version.

Writes go through the same commands as the app: they appear in the open app at once,
are in the task's activity, and sync.

### Agent run history

`list_agent_sessions` lists runs newest first. Use `state: "failed"` to find failures.
Use `latest_only: true` with that filter to find tasks whose **most recent** run failed;
without it, the list also includes earlier failures on tasks that succeeded later.
The optional `task_id` and `project_id` filters narrow the list. Each row includes the
session and task ids, task title and current task status, run state, start/end times
(Unix milliseconds), and a short summary and error. The response is JSON.

### Meetings

`list_meetings` lists the user's meetings (Scribe, ADR 025) newest first, filtered by
project, epic, task or participant name; `get_meeting` returns one in full (links,
participants, attachment names, notes, summary). Both are read-only. `get_calendar` shows
meetings among the day's items. Pass `utc_offset` to read times in local time.

`list_agent_sessions`, `list_tasks` and `list_meetings` return at most 200 rows per call
(50 by default). When `next_cursor` is present, pass it as `cursor` with the same filters
to read the next page. `list_tasks` has no `next_cursor` after its last page.

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

## 5. claude.ai and the mobile apps (remote MCP)

claude.ai, Claude Desktop's connectors and the Claude mobile apps call MCP servers from
Anthropic's cloud, over HTTPS. The sync server (docs/server.md) serves the same tools at
`/mcp` when `TM_MCP=on` (design: ADR 024). A connector added on claude.ai is also in the
mobile apps. The tools work as in section 2 without a session: Claude reads everything,
creates agent tasks and plans time. Its writes sync to your computers like any edit.

### How sign-in works

The sync server is an OAuth **resource server**; your identity provider (the one from
docs/server.md section 5) is the **authorization server**. You sign in to it once, on
the device where you add the connector; Claude then holds tokens issued for this one
purpose, never your password.

1. Claude calls `/mcp` without a token. The server answers 401 with
   `WWW-Authenticate: Bearer resource_metadata="https://tasks.example.com/.well-known/oauth-protected-resource/mcp"`.
2. That document names your identity provider as the authorization server. Claude reads
   its discovery document and sends you to its login page (authorization code + PKCE).
3. The provider sends Claude back a code at `https://claude.ai/api/mcp/auth_callback`;
   Claude trades it for an **access token** (a signed JWT, typically valid for an hour)
   and a refresh token.
4. Every call carries `Authorization: Bearer <access token>`. The server checks, offline,
   with the provider's public keys: the signature, `typ: at+jwt` (an ID token is
   refused), the issuer, the audience (this server's `/mcp` URL), the expiry, the client
   (`TM_MCP_OAUTH_CLIENTS`) and, when set, `TM_OIDC_ALLOWED_GROUPS`. Anything else gets
   401 again.

So the provider must issue access tokens as JWTs in the RFC 9068 form (`typ: at+jwt`),
with the `/mcp` URL as audience, to a client you register by hand (step 2 below).

A server token with `api:write` (`token add claude-code --scope api:write`) also opens
`/mcp`, for Claude Code on a computer without the app, and works with `TM_AUTH=token`:
`claude mcp add --transport http task-master https://tasks.example.com/mcp --header "Authorization: Bearer tm_…"`.

### Setup

The examples use `https://tasks.example.com` for the sync server and Authelia as the
identity provider; adapt them to yours.

1. **Server**: set `TM_MCP=on`, with `TM_AUTH=oidc` and
   `TM_PUBLIC_URL=https://tasks.example.com`. With `TM_OIDC_ALLOWED_GROUPS` set, the
   access token must carry `groups` too (step 2).
2. **OAuth client for Claude**: a public client (no secret, PKCE S256), redirect URI
   `https://claude.ai/api/mcp/auth_callback`, audience `https://tasks.example.com/mcp`,
   JWT access tokens. Its client ID must be listed in `TM_MCP_OAUTH_CLIENTS` (default
   `task-master-claude`). With Authelia, under `identity_providers.oidc`:

   ```yaml
   clients:
     # Claude connector (claude.ai, mobile): public client, PKCE. ADR 024.
     - client_id: task-master-claude
       client_name: Claude (task-master)
       public: true
       token_endpoint_auth_method: none
       authorization_policy: two_factor
       require_pkce: true
       pkce_challenge_method: S256
       redirect_uris: ["https://claude.ai/api/mcp/auth_callback"]
       scopes: [openid, profile, groups, offline_access]
       response_types: [code]
       grant_types: [authorization_code, refresh_token]
       audience: ["https://tasks.example.com/mcp"]
       requested_audience_mode: implicit
       access_token_signed_response_alg: RS256
       claims_policy: task-master-claude
   claims_policies:
     task-master-claude:
       access_token: [groups]   # only needed with TM_OIDC_ALLOWED_GROUPS
   ```

3. **Reachability**: Claude calls from Anthropic's cloud, so `/mcp` and your identity
   provider's discovery, authorization and token endpoints must be reachable from the
   internet over HTTPS. If you filter by IP address or country, allow Anthropic's ranges
   (<https://platform.claude.com/docs/en/api/ip-addresses>). Every data route of the
   server needs a token, so exposing it is fine as long as `TM_AUTH` is not `none`
   (ADR 024).
4. **Claude**: Settings → Connectors → Add custom connector. URL
   `https://tasks.example.com/mcp`; Advanced settings → OAuth: "Use your own OAuth
   client", client ID `task-master-claude`, no secret. Connect, and sign in to your
   identity provider.

Check from outside your network: `curl -i -X POST https://tasks.example.com/mcp` gives
401 with the `WWW-Authenticate` header, and
`curl https://tasks.example.com/.well-known/oauth-protected-resource/mcp` the JSON.
When Claude cannot connect, the server logs why it refused a token
(`docker logs task-master | grep mcp:`), e.g. a missing `groups` claim or another
audience.

To cut Claude off: remove the connector in Claude, or remove the client from your
identity provider (refreshes then fail); an access token already issued works until its
expiry.

## Later

- Settings → Agents: show this computer's `claude mcp add` line with its binary path, to
  copy.
- A Claude Code plugin (a marketplace in a git repository with `.mcp.json` and a skill) to
  install it with `/plugin install`. It needs the binary on `PATH`, so it only suits
  package installs.

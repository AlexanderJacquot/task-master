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
  **Make it mine** turns one into your task. It can plan time and add links only for
  those.
- Edit your own tasks (title, description, priority, prerequisites, status), unless
  Settings → Agents → **Let agents edit my tasks** is off; the remote MCP on the sync
  server always may. Notes and session summaries need a session.

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

## 5. claude.ai and the mobile apps (remote MCP)

claude.ai, Claude Desktop's connectors and the Claude mobile apps call MCP servers from
Anthropic's cloud, over HTTPS. The sync server (docs/server.md) serves the same tools at
`/mcp` when `TM_MCP=on` (design: ADR 024). A connector added on claude.ai is also in the
mobile apps. The tools work as in section 2 without a session: Claude reads everything,
creates agent tasks and plans time. Its writes sync to your computers like any edit.

### How sign-in works

The server is an OAuth **resource server**; Authelia is the **authorization server**.
You sign in to Authelia (with 2FA) once, on the device where you add the connector; Claude
then holds tokens issued for this one purpose, never your password.

1. Claude calls `/mcp` without a token. The server answers 401 with
   `WWW-Authenticate: Bearer resource_metadata="https://tasks…/.well-known/oauth-protected-resource/mcp"`.
2. That document names Authelia as the authorization server. Claude reads Authelia's
   discovery document and sends you to its login page (authorization code + PKCE).
3. Authelia sends Claude back a code at `https://claude.ai/api/mcp/auth_callback`; Claude
   trades it for an **access token** (a JWT signed by Authelia, about an hour) and a
   refresh token.
4. Every call carries `Authorization: Bearer <access token>`. The server checks, offline,
   with Authelia's public keys: the signature, `typ: at+jwt` (an ID token is refused),
   the issuer, the audience (this server's `/mcp` URL), the expiry, the client
   (`TM_MCP_OAUTH_CLIENTS`) and, when set, `TM_OIDC_ALLOWED_GROUPS`. Anything else gets
   401 again.

A server token with `api:write` (`token add claude-code --scope api:write`) also opens
`/mcp`, for Claude Code on a computer without the app:
`claude mcp add --transport http task-master https://tasks…/mcp --header "Authorization: Bearer tm_…"`.

### Setup (homelab)

1. **Server** (`services/task-master/.env.j2`): `TM_MCP=on`, with `TM_AUTH=oidc` and
   `TM_PUBLIC_URL=https://tasks.solarnexus.space` already there. With
   `TM_OIDC_ALLOWED_GROUPS` set, add `groups` to the access token (step 2).
2. **Authelia client** (`identity_providers.oidc.clients`):

   ```yaml
         # Claude connector (claude.ai, mobile): public client, PKCE. ADR 024.
         - client_id: task-master-claude
           client_name: Claude (task-master)
           public: true
           token_endpoint_auth_method: none
           authorization_policy: two_factor
           require_pkce: true
           pkce_challenge_method: S256
           consent_mode: pre-configured
           pre_configured_consent_duration: 1M
           redirect_uris: ["https://claude.ai/api/mcp/auth_callback"]
           scopes: [openid, profile, groups, offline_access]
           response_types: [code]
           grant_types: [authorization_code, refresh_token]
           audience: ["https://tasks.solarnexus.space/mcp"]
           requested_audience_mode: implicit
           access_token_signed_response_alg: RS256
           claims_policy: task-master-claude
   ```

   and under `claims_policies`: `task-master-claude: { access_token: [groups] }` (only
   needed with allowed groups).
3. **Route**: `exposure: public` for `task-master` (rate limit, security headers,
   `geoblock-fr`). Claude calls from Anthropic's US range `160.79.104.0/21` (check
   <https://platform.claude.com/docs/en/api/ip-addresses> for the current list), both
   `/mcp` and Authelia, so `geoblock-fr` lists it in `allowedIPAddresses`. The whole
   host is public: every data route needs a token (ADR 024).
4. **Claude**: Settings → Connectors → Add custom connector. URL
   `https://tasks.solarnexus.space/mcp`; Advanced settings → OAuth: "Use your own OAuth
   client", client ID `task-master-claude`, no secret. Connect, sign in to Authelia.

Check from outside the LAN: `curl -i -X POST https://tasks.solarnexus.space/mcp` gives
401 with the `WWW-Authenticate` header, and
`curl https://tasks.solarnexus.space/.well-known/oauth-protected-resource/mcp` the JSON.
When Claude cannot connect, the server logs why it refused a token
(`docker logs task-master | grep mcp:`), e.g. a missing `groups` claim or another
audience.

To cut Claude off: remove the connector in Claude, or remove the client from Authelia
(refreshes then fail); an access token already issued works until its expiry (about an
hour).

## Later

- Let Claude create tasks that are yours, not agent tasks (an opt-in flag), for "add a
  task for…" requests. A rule change to ADR 017, to decide first.
- Settings → Agents: show this computer's `claude mcp add` line with its binary path, to
  copy.
- A Claude Code plugin (a marketplace in a git repository with `.mcp.json` and a skill) to
  install it with `/plugin install`. It needs the binary on `PATH`, so it only suits
  package installs.

# ADR 033: Team spaces, behind a server switch

Date: 2026-11-21 · Status: proposed (T1–T5 implemented on stacked branches `t1-spaces-core` … `t5-comments`; not yet tried in the running app)

## Context

The user wants to replace Jira for their team with task-master. Collaboration is the only
missing piece: each member keeps their own work, and a shared Team section shows everyone's
progress and tasks. ADR 015 built sync for one person's devices and rejected "multiple
users, sharing". Three things are single-user today: nothing in the data names a person
(`ops` has `device_id`, `TaskOwner` is `me | agent`); the server applies every pushed op
and serves the whole log to any `sync` token; and some fields on a task are one person's
planning (`today_on`).

Agreed with the user (2026-11-21):
- **One team** per server. No space switcher.
- **No roles for now.** Every member can do everything.
- **Tokens, not OIDC**, for team sign-in for now.
- **Team notes**: the team shares notes as well as tasks.
- **The personal instance stays lean.** The user's own app (personal Mac, homelab server)
  must show nothing of this. Work and personal run on **separate machines**, so no
  profiles on one machine are needed.
- **One repo** for both uses. Speed stays the priority: no network on the edit path.

## Decisions

**A space is a replica.** A space is one SQLite database with its own `ops` log, field
clocks and `sync_state` cursors: exactly what a database is today. The current database
becomes the user's **personal space**, unchanged. The **team space** is a second database
of the same schema. Merge, field clocks, HLC and repairs (ADR 015) run inside one space and
never see another, so they stay as they are. `client::sync(client, store)` already runs one
round for one pair; the worker runs it once per space.

**One `Store` per space on the desktop, not `ATTACH`.** A `Spaces` layer in the core holds
the stores, routes each `Command` to the space that owns its entity, and merges reads: the
snapshot tags every entity with its `space` (`personal | team`), search queries each store
and merges, `task_activity` asks the owning store. Each command writes exactly one space,
so "rows and op in one transaction" holds. `ATTACH` was rejected: foreign keys cannot cross
attached databases, and in WAL mode a transaction across them is not atomic as a whole.
With one space, `Spaces` is a pass-through.

**What lives where.** Every row lives in exactly one space.

| Team space | Personal space |
| --- | --- |
| Projects, epics, tasks, subtasks, dependencies | Private projects, epics, tasks (as today) |
| Its own statuses (default set at creation), tags, tag links | Time blocks, calendar sync |
| Attachments on team tasks and team notes | `task_marks` (Today picks), saved views |
| Team note folders and notes | Personal notes, meetings, transcripts |
| `members` (new), comments (new, T5) | Agent sessions and notes, terminal sessions, agent tasks |

**References go from personal to team, never back.** A personal row may point at a team
row (a time block, a meeting, a personal note or an agent session on a team task; a
personal task depending on a team one). A team row never points at a personal one:
teammates would see a dangling id. The core refuses such writes: a team task's project,
epic, parent, dependencies and tags are team rows; a team note attaches to team tasks only.
Markdown links in team text cannot be refused; a link to a row the reader does not have
renders as "private link".

The personal tables that reference `tasks` (`time_blocks`, `agent_sessions`, `agent_notes`,
`meetings`, `notes`, `attachments`, `terminal_sessions`) lose that foreign key (a table
rebuild, like migration 19). A reference to a missing or deleted task hides the row, as a
deleted task already hides its blocks.

**Personal state leaves the task.** `today_on` moves to a personal `task_marks` entity
(`task_id`, `today_on`), an ordinary entity (ops, undo, sync). Otherwise one member's Today
pick would change everyone's. The migration copies the column. Old ops in the log that set
`tasks.today_on` are applied as `task_marks` writes, because a fresh device pulls from 0.

**Identity.**
- `ops.author_id`: the user who made the edit. Old ops have none (the space's owner).
- Tasks get `assignee_id` and `reporter_id` (team tasks; null on personal ones).
- A `members` entity in the team space (`id`, `name`, `color`), written by the server
  through `core::execute` when a user is added or renamed, so names show offline.
- `TaskOwner::Me` means "the current user".

**Server: the team switch.** `TM_TEAM=on|off`, **off by default**, like `TM_MCP` (ADR 024).

- **Off**: the server is today's server. No team space, no team routes, no users beyond
  today's tokens. `/info` has `team: null`.
- **On**: at first start the server creates `data/spaces/team.sqlite`. `server.sqlite`
  gains `users` (id, name) and binds each token to a user. Every user also gets a personal
  space on the server (`data/spaces/<user>.sqlite`), synced across their work devices.
- `/info` gains `team: { name, me: { id, name } }` (the caller's user, when the request
  carries a token).
- Routes: the existing `/sync/*` and `/blobs/*` serve the caller's **personal** space, so
  the protocol of a personal server is unchanged. `/team/sync/push|pull` and
  `/team/blobs/*` serve the team space. `/events` stays one stream; its `head` event names
  the space (`{space, head}`).
- CLI: `task-master-server user add <name>`, `user rename`, `user remove` and
  `token add <name> --user <user> --scope …`. Handing a token to a teammate is the invite
  for now.

**The desktop follows its server.** There is no team toggle in the app. The desktop reads
`/info`: with `team: null`, or with no server at all, it is today's app. It has one space,
one sync loop and one snapshot. There is no Team section, Team page, assignee picker or
comments. The team screens are lazy TanStack Router routes, so a personal instance never
loads their code. With `team` set, it creates the team database, syncs it and shows the
team UI. A desktop pointed at a personal server stays as today; one pointed at a team server
shows the team UI. Same installers, same updates, same schema.

**Checks on a team push.** The token's user must be a member (every user is). Every op's
`author_id` must equal that user, so nobody pushes edits in someone else's name. With no
roles, there are no other checks. A removed user's token is revoked. Their client gets 403
on the team routes and deletes its team database. A copy already on their machine cannot be
taken back: that comes with working offline.

**Repairs in the team space are the server's.** Clients apply incoming team ops but do not
push repairs for the team space; the server repairs after each push and the repair ops
reach everyone in the next pull. Otherwise every member's device would write the same
repair as separate ops. Personal spaces keep today's behaviour.

**Undo in the team space** reverts only fields whose field clock still holds the undone
op's HLC. It never overwrites a teammate's later edit; the rest of the batch still undoes.

**Share to team.** One command moves a personal project (its epics, tasks, subtasks, tag
links, attachments, and the notes attached to its tasks) to the team space under the
**same ids**, so `[[task:…]]` links keep working, and soft-deletes the personal rows. The
`Spaces` layer resolves an id to its live row. Tags are matched by name in the team space
(created when missing). Time blocks and Today picks stay personal and keep pointing at the
moved tasks. History stays in the personal log; the team task's activity starts at the move.

**UI with the team switch on.**
- Sidebar: Personal and Team sections; Team notes under the team section.
- My work: personal tasks plus team tasks assigned to me.
- Team page: per member, in progress, done this week, overdue; all local queries.
- Assignee picker and member avatars on cards and rows; Settings → Team (server, members).

**MCP.** The local MCP uses the `Spaces` layer; tools take an optional `space` (default
personal), agent tasks stay personal. The remote MCP on the server acts as the token's
user, in both spaces.

**Backups and export.** The server's nightly backup covers every space file. A desktop's
local backup and export cover its personal space. The team space is backed up on the server.

**Speed.** Every edit still writes local SQLite first. The Team page and My work are local
queries over the replicated team space. A team member loads two snapshots at start instead
of one; a personal instance loads one, as today. Teammates see a change within ~2–4 s
through the existing stream.

## Milestones

Each ships with core tests on in-memory stores; branch per milestone (`t1-spaces-core`, …).

- **T1 Spaces in the core**: `Spaces` layer over several stores, merged snapshot with
  `space`, `task_marks` (migration, legacy `today_on` ops), dropped foreign keys, the
  personal → team reference rule, Share to team. Done when one process can run two local
  spaces and the tests cover routing, merging, references and moving. No server change.
- **T2 Identity**: `ops.author_id`, `assignee_id`/`reporter_id`, `members`, users and
  tokens bound to users on the server, `/info.team`. Done when every op names a person.
- **T3 Server team space**: `TM_TEAM`, `data/spaces/`, `/team/*` routes, `{space, head}`
  events, push checks, server-only team repairs, the user CLI; the desktop syncs both
  spaces and handles 403. Done when two desktops share a team space and a removed user
  loses it.
- **T4 Team UI**: sidebar sections, Team notes, My work, Team page, assignee picker,
  avatars, Settings → Team, lazy routes. Done when a personal instance shows and loads
  nothing of it.
- **T5 Jira parity**: comments (team entity), @mentions, watchers, desktop notifications
  from pulled ops that mention the user, activity by author.

## Consequences

- One schema and one code path for both uses; the personal instance carries the
  pass-through `Spaces` layer, `task_marks` and `author_id`, and none of the team runtime.
- Desktop and server stay in lockstep on the schema (ADR 015). With a team, every member
  updates together; auto-update makes this workable, a compatibility window may follow.
- A new member pulls the whole team log; op compaction (deferred in ADR 015) matters sooner.
- Statuses become per space: the team has its own workflow.
- Teammates never see each other's time blocks, meetings or Today picks.

## Deferred

- Roles (viewer, admin), per-project permissions, several teams per server.
- OIDC sign-in for team users (ADR 015's OIDC flow can map `sub` to a user later).
- Invites by link instead of handing out tokens.

## Rejected

- One shared log with per-row permissions: every op and every pull filtered, partial
  replication inside one log, repairs across rows a device cannot see.
- `ATTACH` of the team database to the personal connection (see above).
- A compile-time feature or a separate build for team mode: two builds, two release
  pipelines and twice the CI, for code a runtime switch already keeps idle.
- A thin client for team data (read through the API): no offline use, every view waits on
  the network.
- A team dashboard only (read-only aggregation of personal spaces): no assigning or shared
  editing, so it cannot replace Jira.
- Postgres, live presence, CRDT text merge: unchanged from ADR 015.

## Implementation notes (T1, branch `t1-spaces-core`)

- `crates/core/src/spaces.rs`: `Spaces` over a personal `Store` and an optional team one.
  `execute(commands, space)` routes each command by the row it names (`space_of`: the
  space holding a live row with that id, else any row); creates follow their container
  (parent, epic, project, folder), and `space` (default personal) decides the rest. One
  undo history across both: an action that wrote both spaces undoes as one.
- **Marks only on team tasks.** Personal tasks keep `tasks.today_on`, so a personal
  instance has no data migration and old ops need no translation. `Spaces` turns
  `TodayOn` on a team task (and `today_on` on a new one) into `SetTaskMark`, and shows
  marks as the tasks' `today_on` in `team_snapshot` and in returned changes. `Changes`
  carries `task_marks` internally only (`serde(skip)`).
- **Statuses follow the named space.** The default statuses have the same fixed ids in
  every database (migration 1), so `space_of` cannot tell them apart; status commands go
  to the space the front end names.
- Migration 20: `task_marks`; `time_blocks`, `agent_sessions`, `agent_notes`, `meetings`,
  `notes` and `terminal_sessions` rebuilt without keys to tasks, projects and epics.
  `attachments` keeps its keys: an attachment lives with its task's space. db.rs now runs
  migrations with foreign keys off (SQLite's procedure for rebuilding a referenced table)
  and migration 20 checks them before committing.
- Personal writes name team rows through `Store::execute_linked`: the ids the spaces layer
  found live in the team database. `linked_task`/`linked_project`/`linked_epic` accept them
  for blocks, agent sessions and notes, meetings, notes and terminal sessions;
  `touch_task` skips them. Dependencies stay within one space.
- With a team, `Spaces::snapshot` keeps blocks and agent sessions whose task is live in
  either space (a shared task is deleted in the personal space under the same id).
- `share_project`: an area (a project with children) is shared whole; a project inside a
  personal area is refused. Statuses map by name and category, tags by name. Completion
  times and the tasks' history start over in the team space.

## Implementation notes (T2, branch `t2-identity`)

- Migration 21: `ops.author_id`, `tasks.assignee_id` and `reporter_id` (no foreign keys:
  a removed member keeps their tasks' history), `members`. `Store::set_author` makes every
  later op carry the user; sync carries `author_id` both ways; `task_activity` returns it.
- A new task gets `reporter_id` from the store's author; `assignee_id` (create, or
  `TaskChange::AssigneeId`) must name a live member. `CreateMember` restores a removed
  member; `DeleteMember` leaves assignees in place.
- Member commands only go to the team space (an error without one). The server's users
  and their tokens, which write the members, come with T3.
- The new fields are left out of the JSON when empty, so a personal instance's snapshot,
  tasks and ops read exactly as before.

## Implementation notes (T3, branch `t3-server-team`)

- **Server.** `TM_TEAM=on` (needs `TM_AUTH=token`) and `TM_TEAM_NAME`. `server.sqlite`
  gains `users`; tokens may belong to one (`token add … --user`), and a removed user's
  tokens are deleted and refused. `user add|list|rename|remove` in the CLI. Each space is a
  `Replica` (store and head channel): the server's own (`tasks.sqlite`, for tokens of no
  user, the calendar runner and the remote MCP), `spaces/team/` and `spaces/user-<id>/`.
  `/sync/*`, `/blobs/*` and `/events` serve the caller's personal space; `/team/sync/*`,
  `/team/blobs/*` and `/team/events` the team's, to members only.
- **One stream per space**, not one stream with `{space, head}`: older clients read any
  `data:` line as their head, so the team's head gets its own `/team/events`.
- **Members** come from the users: `reconcile_members` runs at start and before each team
  push and pull, so CLI changes reach the team without a restart.
- **Push checks.** A team push may not hold member ops, and every op must be authored by
  the token's user. An op of another author that the server already has is dropped as a
  duplicate (a device resending everything after a server reset); any other is refused.
- **Undo in a team space** (a store with an author) reverts a field only while the undone
  op is still its latest write (`history::invert_batch`, guarded).
- **Client.** `Client::team()` prefixes a space's routes with `/team`. `sync()` locks its
  store through the `Replica` trait (a `Mutex<Store>`, or the desktop's team slot, which
  may close during a round).
- **Desktop.** `AppState` keeps the personal `Mutex<Store>` as before and adds
  `team: Mutex<Option<Store>>` and `history: Mutex<SpacesHistory>` (locked history, then
  personal, then team); `Spaces::borrowed` lends them for one call. `snapshot`, `execute`
  (now with `space`), `undo`, `redo`, `search`, `search_notes` and `task_activity` go
  through it; new reads `team_snapshot` and `share_project`. After each personal round
  the worker reads `/info.team`: with a member it opens `<data>/team/task-master.sqlite`
  (author set, repairs off; `member.json` lets it open offline at the next start) and syncs
  it through `client.team()`; without one, or on a refused token, it closes and deletes
  that copy. Team writes emit `StoreChanged` like personal ones. `SyncStatus.team` tells
  the UI.
- A team attachment's content is copied from the personal folder (where the desktop
  stores picked files) into the team's when its attachment is created.
- Not covered: Google Calendar sync of blocks on team tasks (the calendar reads tasks of
  the personal space only); the remote MCP endpoint serves the server's own space.


## Implementation notes (T4, branch `t4-team-ui`)

- `Changes.team_ids` names the returned entities that live in the team space, so the UI
  knows where each row is after a write, an undo or a share.
- The UI store hydrates `snapshot` and `team_snapshot` into the same maps, with `teamIds`,
  `members` and `team` (`{ info, statuses }`, from `SyncStatus.team`). Without a team these
  stay empty and nothing team-related renders. `mutate` takes an optional `space`.
- `lib/team.ts`: `isTeamTask` (listed, or inside a team project or task), member names and
  initials, `teamWork` (the Team page's grouping). Inbox counts and lists leave team tasks
  out (`ViewContext.teamIds`).
- Sidebar: a Team section (named after the team) with Team overview, the team's projects,
  a new-team-project input and Team notes (`NotesTree space="team"`); the personal Projects
  and Notes show only personal rows. A personal project's ⋯ menu has Share to team.
- `/team` is a lazy route (`React.lazy`): one column per member (you first), then
  Unassigned, each with Overdue, In progress, To do and Done this week.
- Task properties: an Assignee pill on team tasks; project, epic and tag choices are
  limited to the task's own space. A tag created in the same batch as the team task it goes
  on is created in the team space (core).
- Not done: avatars on board cards and list rows (the Team page and the task show them).

## Implementation notes (T5, branch `t5-comments`)

- Migration 22: `comments` (task, body, author, soft delete), an ordinary entity in its
  task's space. `CreateComment` writes the store's author; in a team space only the author
  may `UpdateComment` or `DeleteComment`. A deleted task hides its comments.
- `Store::notices(after, limit)` (IPC read `team_notices`): comments by others that
  mention `@<my name>` and tasks others assigned to me, newest first, from the team's op
  log; deleted tasks and comments drop out.
- UI: a Comments section on team tasks only (mentions highlighted); the activity feed names
  each change's author; the Team page opens with "For you"; Team overview in the sidebar
  counts notices not seen yet (`localStorage`, per device).
- Not done: watchers, desktop (OS) notifications (would need the notification plugin: a new
  dependency to propose), avatars on cards and rows, MCP tools for the team space, Google
  Calendar sync of blocks on team tasks.
- Later (branch `team-page-new-task`): a mention picker while typing `@` in comments and in
  the markdown editor (descriptions, notes, meeting notes); notices also for mentions newly
  written in team task descriptions, team notes and edited comments (`Notice.note_id`).


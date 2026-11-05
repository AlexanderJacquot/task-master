# Task System — Architecture & MVP Handoff Plan

Nov 4, 2026 · @Alex

## 1. Vision and MVP scope

Build a local-first desktop task manager on a reusable Rust core, so the same engine later powers a CLI, a Claude-facing MCP server, calendar sync and a mobile client. The MVP is only the task manager: fast capture, a kanban board, a list view, tags, subtasks, projects and epics.

**Problems it must solve**

- Too many tasks: capture must be instant, and views must hide what is not relevant now.
- Prioritizing: every task has a priority and an optional due date, and a Today view shows only what was picked for today.
- Bloat and slowness (DotPM, Jira): every interaction under 16 ms, startup under 1 s, no duplicated tasks by design.
- One place for everything: personal and professional work in one store, viewable per project or all at once.

**In the MVP**

- Task create, edit, delete, with markdown description
- Subtasks (parent/child) and non-task containers: projects and epics
- Tags, priority, due date, status
- Kanban board with drag and drop, list view with subtask tree
- Inbox, Today, All tasks, per-project and per-epic views, saved filters
- Quick capture with inline syntax, command palette, keyboard shortcuts, full-text search
- Undo/redo, automatic local backups, JSON export
- Builds for Windows, Linux and macOS

**Not in the MVP (designed for, built later)**

- Linking projects to folders, a `tk` CLI
- Spawning Claude sessions from a task, MCP server
- Calendar view, time blocks, time logging, calendar sync
- Multi-device sync and a phone client
- Standalone notes

## 2. Architecture decision

**Decision: Tauri 2 desktop shell, a Rust core crate that owns all logic and data, SQLite as the store, React + TypeScript for the UI.**

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | Tauri 2 | Native window on Windows, macOS, Linux from one codebase; \~10 MB installers instead of \~100 MB; iOS/Android targets exist for later |
| Core | Rust library crate (`core`) | One engine reused by the desktop app, a CLI, an MCP server and a sync server; strong types for the domain |
| Storage | SQLite (WAL mode) via `rusqlite` | Single file, instant queries on 10k+ tasks, transactions, FTS5 search, trivial backups |
| UI | React 19 + TypeScript + Vite | Largest ecosystem for the hard parts: drag and drop (dnd-kit), virtualization (TanStack Virtual), calendar views later; best-known stack for Claude Code |
| UI state | Zustand store, normalized, hydrated from core | Whole dataset in memory, filtering and board rendering never wait on IPC |
| Type bridge | `tauri-specta` (fallback `ts-rs`) | Rust command signatures generate TS bindings; no drift between core and UI |

**Alternatives rejected**

- Obsidian plugin: markdown files as a database is the root cause of DotPM's slowness and duplicates, and mobile UX stays poor. Obsidian can stay the notes tool; export to it later.
- Electron: same web UI, but heavier memory and installers, and no natural place for a reusable native core.
- Web app + server: needs hosting before it is useful, and cannot open folders or spawn terminals without a local agent anyway.
- Svelte or Solid UI: lighter, but weaker library coverage for kanban and calendar. Open to revisit in section 10.

**Guiding principles**

- Local-first: the app works fully offline; sync is an add-on, never a dependency.
- Every mutation is a command that writes the row and an entry in an append-only change log in one transaction. This gives undo, history, auditing and future sync from day one.
- The core never knows about the UI. Tauri commands are thin wrappers.

## 3. Domain model

Tasks are the only things you work on. Projects and epics are containers that group tasks without being tasks themselves, which is the Jira idea without the Jira weight.

| Entity | What it is | Key fields | Relations |
| --- | --- | --- | --- |
| Project | Where work lives: a life area or a body of work ("Chaumet", "Homelab", "Perso / Admin") | name, color, icon, archived, rank | Optional parent project (one level: areas → projects); later, linked folders |
| Epic | An outcome or goal that groups tasks, possibly across projects ("Go freelance", "Migrate homelab to IaC") | name, description, target date, status (active, done, dropped) | Many tasks; optional home project; progress computed from its tasks |
| Task | A unit of work | title, description (markdown), status, priority, due date, scheduled-for-today flag, estimate, rank, created/updated/completed timestamps | One project (or Inbox when none), zero or one epic, optional parent task, many tags |
| Subtask | A task whose `parent_id` is set | same as task | Inherits project and epic from the parent by default; unlimited depth in data, two levels shown in the UI |
| Tag | Free label across everything (`#waiting`, `#quick`, `#deep-work`) | name, color | Many-to-many with tasks |
| Status | A column of the workflow | name, category, color, rank, WIP limit | Global set in the MVP |
| View | A saved board or list | name, filter, group-by, sort, layout (board or list), swimlanes | Read-only query over tasks |

**Status categories** drive behavior regardless of the names you pick: `backlog`, `todo`, `in_progress`, `done`, `cancelled`. Default columns: Backlog, To do, In progress, Waiting, Done (Cancelled hidden by default). Moving a task to a `done` category sets `completed_at`.

**Priority** is four levels: Urgent, High, Normal (default), Low. Combined with due date and the Today flag, this feeds the default sort: Today first, then overdue, then priority, then due date, then manual rank.

**Inbox** is not an entity: it is every task with no project. Triage means giving each one a project, a priority, or deleting it.

**Identity and ordering**

- IDs are UUIDv7: sortable by creation time and safe to merge across devices.
- Manual order within a column or list uses fractional ranks (string keys between neighbors), so a drag writes one row, never renumbers a list.
- Deletes are soft (`deleted_at`) and purged after 30 days; required for undo and sync.

## 4. Data layer

One SQLite file in the OS app-data folder holds everything; an append-only `ops` table records every change, which is the foundation for undo, activity history and later sync.

**Initial schema (migration 0001)**

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,           -- UUIDv7
  parent_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL, color TEXT, icon TEXT,
  rank TEXT NOT NULL, archived_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

CREATE TABLE epics (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL, description TEXT, target_date TEXT,
  state TEXT NOT NULL DEFAULT 'active',   -- active | done | dropped
  rank TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

CREATE TABLE statuses (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  category TEXT NOT NULL,        -- backlog | todo | in_progress | done | cancelled
  color TEXT, rank TEXT NOT NULL, wip_limit INTEGER
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),   -- NULL = Inbox
  epic_id TEXT REFERENCES epics(id),
  parent_id TEXT REFERENCES tasks(id),
  status_id TEXT NOT NULL REFERENCES statuses(id),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 2,       -- 0 urgent .. 3 low
  due_date TEXT, today_on TEXT,              -- ISO date; today_on = picked for that day
  estimate_min INTEGER,
  rank TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  completed_at INTEGER, deleted_at INTEGER
);

CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT);
CREATE TABLE task_tags (task_id TEXT REFERENCES tasks(id), tag_id TEXT REFERENCES tags(id),
  PRIMARY KEY (task_id, tag_id));

CREATE TABLE views (id TEXT PRIMARY KEY, name TEXT NOT NULL, spec TEXT NOT NULL, rank TEXT NOT NULL);

CREATE TABLE ops (                -- append-only change log
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL, hlc TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- create | update | delete | restore | link | unlink
  patch TEXT NOT NULL,           -- JSON: changed fields with new values
  inverse TEXT NOT NULL,         -- JSON: previous values, used by undo
  batch_id TEXT                  -- groups ops from one user action
);

CREATE VIRTUAL TABLE tasks_fts USING fts5(title, description, content='tasks', content_rowid='rowid');
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

**Rules**

- Indexes on `tasks(project_id)`, `tasks(epic_id)`, `tasks(parent_id)`, `tasks(status_id, rank)`, `tasks(today_on)`, `ops(entity, entity_id)`.
- Timestamps are Unix milliseconds in UTC; calendar dates are ISO `YYYY-MM-DD` strings.
- `hlc` is a hybrid logical clock (wall time + counter + device). It costs nothing now and makes field-level last-writer-wins sync possible later without a schema change.
- Migrations are embedded SQL files run at startup (`rusqlite_migration`); the DB is copied to `backups/` before any migration.
- Backups: a rotating daily copy (keep 14) using SQLite's online backup API.
- Export/import: full JSON dump of all tables, versioned with the schema number.

## 5. Application architecture

All reads and writes go through one Rust core; every front end (desktop now, CLI, MCP and sync later) is a thin adapter over the same commands and queries.

&#91;embedded content: system architecture · 4 adapters over one core\]

Only the desktop app is built in the MVP; the CLI, MCP and sync adapters reuse the same commands, so adding them never touches the data model.

**Core crate (`crates/core`)**

- `model`: domain structs and enums (Task, Project, Epic, Tag, Status, View, Priority, StatusCategory).
- `db`: connection setup (WAL, foreign keys on), migrations, repositories. One writer connection on a dedicated thread, a small pool of readers.
- `commands`: a `Command` enum (`CreateTask`, `UpdateTask { id, patch }`, `MoveTask { id, status_id, rank }`, `SetParent`, `TagTask`, `CreateProject`, …). `execute(cmd)` validates, writes rows, appends `ops` and returns the changed entities, all in one transaction.
- `history`: undo/redo by applying the `inverse` of the last batch as a new batch.
- `query`: `snapshot()` returns every non-deleted entity for hydration; `search(text)` uses FTS5; view specs compile to SQL for the CLI and MCP.
- `events`: after commit, a `Changed { entities, op_seq }` event is broadcast to subscribers.
- `parse`: quick-capture syntax parser, shared so the CLI and MCP parse text the same way.

**Desktop shell (`apps/desktop/src-tauri`)**

- Tauri commands: `snapshot`, `execute`, `undo`, `redo`, `search`, `export`, `import`. That is the whole IPC surface; new features add command variants, not new endpoints.
- Forwards core `Changed` events to the window, so edits from a CLI or an MCP server appear live.
- Owns OS integration: global quick-capture hotkey, tray, window state, later terminal spawning.

**Frontend (`apps/desktop/src`)**

- Store: normalized maps (`tasks`, `projects`, `epics`, `tags`, `statuses`, `views`) plus derived selectors (children by parent, tasks by status, epic progress).
- Writes are optimistic: apply the patch locally, call `execute`, reconcile with the returned entities, roll back on error.
- Views are pure functions of store + view spec, so board, list and later calendar share filter and sort code.
- Routing: `/inbox`, `/today`, `/all`, `/project/:id`, `/epic/:id`, `/view/:id`, with the task detail as a side panel driven by `?task=<id>`.

**Performance budget (tested in M6)**

- 10,000 tasks: hydrate under 300 ms, filter and re-render a board under 16 ms.
- Long lists and columns virtualized; cards memoized by id and `updated_at`.
- Descriptions loaded lazily if snapshot size becomes a problem; not needed at MVP scale.

## 6. MVP feature spec

The MVP is a three-pane app: sidebar for navigation, a main area showing a board or a list, and a task detail panel that slides in from the right.

**Sidebar**

- Inbox (count), Today (count), All tasks
- Projects tree (areas with projects underneath), drag to reorder, archive
- Epics with a progress bar (done / total tasks)
- Tags, saved views

**Board view**

- Columns = statuses; cards show title, project color, epic, tags, priority, due date, subtask progress (e.g. 2/5).
- Drag and drop between and within columns (dnd-kit); keyboard moves with `Alt+←/→`.
- Optional swimlanes by project, epic or priority.
- WIP limit warning on a column header when exceeded.
- Subtasks hidden as cards by default (shown via toggle), so the board stays readable.

**List view**

- Tree of tasks with collapsible subtasks; group by status, project, epic, priority or due date.
- Inline edit of title, status, priority, due date; multi-select with bulk actions (move, tag, set project, delete).

**Task detail panel**

- Title, markdown description (editor with preview, e.g. CodeMirror 6 or Milkdown), status, priority, due date, Today toggle, project, epic, parent, tags.
- Subtask checklist: add, reorder, check off, promote to full task.
- Activity: the task's history read from `ops`.

**Capture and navigation**

- Quick capture (global hotkey, e.g. `Ctrl+Shift+Space`) opens a small window; `n` inside the app does the same.
- Inline syntax: `Fix DNS on watch #homelab @Homelab !high ^fri +epic:IaC` → tag, project, priority, due date, epic. Unknown tags are created; unknown projects prompt.
- Command palette (`Ctrl+K`): jump to any task, project, epic or view; run any action.
- Full-text search across titles and descriptions.
- Undo/redo (`Ctrl+Z` / `Ctrl+Shift+Z`) for every action, including drag and drop.

**Prioritization helpers**

- Today view: tasks with `today_on` = today, plus overdue, ordered by the default sort.
- "Plan my day" picker: from Today view, a list of candidates (high priority, due soon, in progress) to add with one key.
- Stale indicator on cards untouched for 30+ days, to support pruning.

**Settings**

- Edit statuses (names, colors, order, WIP limits), theme (light/dark/system), data folder, backup and export.

## 7. Extension points (post-MVP)

Each later feature plugs into the core as new tables, new command variants and a new adapter; none requires reworking the MVP.

**Phase 2: Folder workspaces and CLI**

- `project_folders(project_id, device_id, path)`: paths are per device, since `C:\dev\x` on Windows becomes `~/dev/x` on Linux or Mac.
- An optional `.tasks.toml` marker in a folder holds the project id, so any machine resolves folder → project without manual mapping.
- `tk` CLI (`crates/cli`) on the same core: `tk` in a folder lists that project's open tasks; `tk add "…"` uses the quick-capture parser; `tk done <id>`.
- Desktop: "Open folder" on a project; "Open in app" from the CLI (`tk open`) focuses the project.

**Phase 3: Claude sessions from a task**

- "Start Claude session" on a task (only when its project has a folder on this device).
- The core builds a context brief: task title, description, subtasks, epic and project context, recent activity. It is written to a temp file and passed as the opening prompt.
- The shell opens the user's terminal in the folder and runs `claude` with that prompt: Windows Terminal (`wt`), macOS Terminal or iTerm, Linux `$TERMINAL` (configurable). Exact Claude Code flags to be checked against current docs at implementation time.
- An MCP server (`crates/mcp`, stdio) exposes `get_task`, `list_tasks`, `update_task`, `add_subtask`, `add_note`, so the session can tick subtasks and log progress back; the desktop app sees changes live through core events.
- `claude_sessions(task_id, started_at, folder, summary)` records sessions on the task's activity.

**Phase 4: Calendar and time logging**

- `time_blocks(id, task_id, start, end, outcome)` with outcome `planned | done | worked | cancelled`; `worked` logs time without completing the task. Logged time = sum of `done` + `worked` blocks.
- Week and day views: drag a task from a side list onto the calendar, resize to set duration, click to set the outcome.
- Sync: push blocks to one dedicated calendar the app owns, then pull changes back. Candidates: Google Calendar API, Microsoft Graph, or CalDAV (self-hostable). Calendar-side edits limited to moving/resizing a block and marking it for rescheduling; outcomes stay in the app.

**Phase 5: Sync and phone**

- A small sync service (`crates/sync-server`, axum) on the homelab: devices push and pull `ops` since their last seen `seq`; merge is field-level last-writer-wins by `hlc`.
- Access behind Tailscale or the existing reverse proxy and SSO.
- Phone: a responsive layout first (board collapses to one column with a status switcher), shipped either as a Tauri 2 mobile build or as a PWA served by the sync service.

**Later candidates**: standalone markdown notes linked to tasks, recurring tasks, Obsidian export, weekly review screen, priority scoring.

## 8. Repo layout and tooling

One monorepo: a Cargo workspace for Rust and a pnpm workspace for the UI.

```text
taskapp/
├── Cargo.toml                 # workspace: crates/*, apps/desktop/src-tauri
├── rust-toolchain.toml        # pinned stable Rust
├── package.json               # pnpm workspace root, packageManager pinned
├── CLAUDE.md                  # conventions for Claude Code sessions
├── progress.md                # running log: done, in progress, next
├── docs/
│   ├── plan.md                # this plan, exported
│   └── adr/                   # one file per architecture decision
├── crates/
│   ├── core/
│   │   ├── migrations/        # 0001_init.sql, ...
│   │   └── src/{model,db,commands,history,query,events,parse}/
│   ├── cli/                   # phase 2
│   ├── mcp/                   # phase 3
│   └── sync-server/           # phase 5
└── apps/
    └── desktop/
        ├── src-tauri/         # Tauri shell: commands.rs, events.rs, main.rs
        └── src/
            ├── bindings.ts    # generated by tauri-specta, never edited
            ├── store/         # normalized store, selectors, optimistic writes
            ├── features/      # board/, list/, task-detail/, sidebar/, capture/, palette/
            ├── components/    # shared UI primitives
            └── lib/           # filters, sorting, dates, ranks
```

| Concern | Tool |
| --- | --- |
| Rust lint and format | `clippy` (deny warnings in CI), `rustfmt` |
| Rust tests | `cargo test` with in-memory SQLite; snapshot tests for the parser (`insta`) |
| TS lint and format | Biome |
| TS tests | Vitest for store, filters, ranks; Playwright smoke tests against the Vite dev build |
| Styling | Tailwind CSS + Radix primitives (accessible menus, dialogs, popovers) |
| Ranks | `fractional-indexing` (TS) mirrored by a small Rust implementation, with shared test vectors |
| CI | GitHub Actions matrix (windows, ubuntu, macos) for builds and release installers; macOS runners are the reason not to use Forgejo Actions for releases |
| Releases | `tauri-action`, Tauri updater plugin later |

## 9. Implementation milestones

Seven milestones take the MVP from empty repo to daily driver; each ends with something usable and a green CI on all three OSes.

| # | Milestone | Delivers | Done when |
| --- | --- | --- | --- |
| M0 | Scaffold | Monorepo, Tauri 2 + React app, empty `core` crate, CI matrix, CLAUDE.md, progress.md, ADR 001 (stack) | App window opens on Windows; CI builds on windows, ubuntu, macos; `cargo test` and `pnpm test` pass |
| M1 | Data core | Schema 0001, migrations, repositories, `Command` + `execute` with `ops`, undo/redo, `snapshot`, seeded default statuses, specta bindings | Core tests cover every command, undo of each, and migration on a fresh and an existing DB |
| M2 | List and detail | Sidebar shell, store + hydration, list view with subtask tree, task detail panel, create/edit/delete, optimistic writes | You can manage real tasks end to end in list view; state survives restart |
| M3 | Kanban | Board view, drag and drop with fractional ranks, card design, swimlanes, WIP limits, subtask toggle | Dragging 50 cards in a row never reorders wrongly; undo reverts a drag |
| M4 | Organization | Projects tree with areas, epics view with progress, tags, saved views (filter, group, sort), Inbox and Today | Every view in section 6 exists; a saved view reopens identically |
| M5 | Speed | Quick capture window + global hotkey, inline syntax parser, command palette, shortcuts, FTS search, Plan my day | Capturing a fully tagged task takes under 3 s from any app |
| M6 | Hardening | Daily backups, JSON export/import, settings screen, 10k-task perf test, installers for 3 OSes | Perf budget from section 5 met on the seeded DB; fresh install on Linux and Windows works |

**Working rhythm**

- One milestone per branch; each milestone split into tasks of a few hours, tracked in `progress.md` (and in the app itself from M2 on).
- Every core feature lands with tests before the UI uses it.
- Each architecture choice that changes later work gets a short ADR.
- From M2, use the app for its own backlog: dogfooding is the real acceptance test.

## 10. Open decisions and risks

Three decisions taken:

**Decide before M0**

- [ ] App name : task-master
- [ ] UI framework: React
- [ ] Default statuses: keep Backlog / To do / In progress / Waiting / Done

**Decide later**

- [ ] Per-project status sets (Phase 2+), or keep one global workflow.
- [x] Calendar provider for Phase 4: Google first, CalDAV later (ADR 013).
- [ ] Phone client: Tauri mobile build or PWA (Phase 5).

**Risks**

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Linux webview (WebKitGTK) renders and scrolls slower than WebView2 or WKWebView | Board feels less fluid on Linux | Virtualize early, avoid heavy CSS effects, test on Linux from M3 |
| Fractional ranks drift into long strings after many moves | Slower sorting, larger rows | Rebalance a column's ranks in one transaction when a key exceeds 32 chars |
| `tauri-specta` still on a release candidate | Binding generation breaks on upgrade | Pin the version; fall back to `ts-rs` + a hand-written invoke wrapper |
| Scope creep toward calendar and Claude before the base is solid | MVP never becomes a daily driver | Phases gated: no Phase 2 work until M6 is done and the app is used daily for two weeks |
| Corporate machine (client laptop) blocks unsigned installers or global hotkeys | App unusable for professional tasks at work | Portable build option; check policy early; sync (Phase 5) as the bridge between machines |

## 11. Kickoff

Export this doc to `docs/plan.md` in a new empty repo, add the CLAUDE.md below, then start Claude Code there with the first-session prompt.

**First-session prompt**

```markdown
Read docs/plan.md and CLAUDE.md. We are implementing milestone M0 (Scaffold).

1. Create the monorepo layout from section 8: Cargo workspace, pnpm workspace,
   Tauri 2 app in apps/desktop with React + TypeScript + Vite, empty crates/core.
2. Pin toolchains (rust-toolchain.toml, packageManager) to current stable versions.
3. Add Biome, Vitest, clippy/rustfmt config, and a GitHub Actions matrix
   (windows-latest, ubuntu-latest, macos-latest) running lint, tests and a Tauri build.
4. Wire one Tauri command `ping` from core through the shell to the UI, with
   tauri-specta generating bindings.ts.
5. Write docs/adr/001-stack.md summarizing section 2.
6. Update progress.md with what is done and the task list for M1.

Stop after M0 and summarize. Ask before adding any dependency not named in the plan.
```

**CLAUDE.md seed**

```markdown
# Task app: conventions

## Architecture
- All logic and data live in crates/core. The Tauri shell and the UI are thin adapters.
- Every mutation is a `Command` executed by `core::execute`, which writes rows AND
  an `ops` entry (patch + inverse) in ONE transaction. Never write tables directly.
- IDs are UUIDv7. Ordering uses fractional rank strings. Deletes are soft.
- Timestamps: Unix ms UTC. Calendar dates: ISO YYYY-MM-DD strings.
- IPC surface stays small: snapshot, execute, undo, redo, search, export, import.
- apps/desktop/src/bindings.ts is generated. Never edit it by hand.

## Frontend
- Normalized store; views are pure functions of store + view spec.
- Writes are optimistic and reconciled with the entities returned by execute.
- Virtualize any list that can exceed 100 rows.

## Workflow
- Read progress.md at the start of every session; update it at the end.
- Core changes ship with tests (in-memory SQLite). Parser changes ship with snapshot tests.
- Run `cargo clippy -- -D warnings`, `cargo test`, `pnpm biome check`, `pnpm test`
  before declaring a task done.
- New dependency or architecture change: propose it first, then record an ADR.
- Stay inside the current milestone. Note ideas for later in progress.md under "Later".
```

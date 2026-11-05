# Progress

Running log for task-master. Read at the start of every session; update at the end.

## Current milestone

**M11 Sync core**, branch `m11-sync-core` (from `main`): done, pending review. First of
the sync milestones in ADR 015 (M12 server, M13 desktop sync, M14 API, M15 CLI and MCP).
Plan Phase 5 started early at the user's request. Nothing user-visible yet: the desktop
does not sync until M13.

**M10 Google Calendar sync**, branch `m10-google-calendar`: merged to `main` with M9 and
released as **v0.4.0** (2026-11-05). Next: the user creates their OAuth client
(`docs/google-calendar.md`) and tries it in the real app; see "Not yet verified".

**M9 Calendar**: merged to `main` (`c9dc9b6`, not pushed). Plan Phase 4 started early at
the user's request (it skips the plan's gate: two weeks of daily use, Phases 2 and 3).

**M8 Attachments**, branch `m8-attachments` (from `main`): markdown preview, pasted
images and file attachments, the Windows title bar and the parchment rubric colors.
Merged to `main` and released as **v0.3.0** (2026-11-05). Next: install the update on
Windows (Settings → About and updates) and run the hands-on checks below.

**Windows title bar** (same working tree, ADR 012): the main window is frameless on
Windows and the app draws its own title bar. Done, pending a check on Windows.

**M7 Redesign**: done, including in-app updates (version 0.2.0). Left: install 0.2.0 by
hand once on Windows, then check the redesign in both themes and that 0.2.1 arrives
through the update button.

### Previous

**M6 Hardening**, branch `m6-hardening` (stacked on `m5-speed`): done, pending review, the
GitHub mirror setup and hands-on checks. The MVP milestones are complete; next is using
the app daily for two weeks before Phase 2 (plan section 10).

## Done

### Quick capture grows into the editor (2026-11-05)

Branch `worktree-capture-expand` (from `main`). In the `Ctrl+Shift+Space` window,
Shift+Enter saves the task and grows the window (900x720, within 90% of the screen,
resizable) into the full task editor (`TaskEditor`, page layout): title, properties,
description, subtasks, files, activity. Opening a subtask switches the editor to it
(`OpenTaskContext` replaces navigation where there is no router). While editing, the
window stays open on blur (so file pickers work); Esc leaves the current field, then
closes; Done and X close. The shell resets the window to 660x230 on every hotkey
opening. Window permissions added: `set-size`, `set-resizable`, `center`. Tests:
`captureWindow.test.tsx` (+3, injected `CaptureControls` like the title bar's). No new
dependencies.
- A task just created with Shift+Enter opens with the cursor in its description, from
  the capture window, a view's capture row or the New task dialog (`?focus=description`
  on the task page; `DescriptionEditor` `autoFocus`). Opening an existing task does not.
  Starting an edit now puts the cursor at the end of the text (was the start). Tests:
  app.test +2, the capture window test checks it, and the row test checks it does not.
- A task added from a view's top row (plain Enter) opens in the side panel with the
  cursor in its description. Settings → Adding tasks turns it off (per machine,
  `lib/capturePrefs.ts`, on by default). `useOpenTask` drops `focus` so the next task
  opened does not take the cursor. Tests: app.test +2.

### M11 Sync core (2026-11-05)

ADR `docs/adr/015-sync-server.md`. Agreed first with the user: one server that is a core
replica and the API; the desktop stays local-first and syncs asynchronously; CLI on the
local DB; MCP local by default, remote API optional; calendar sync on the desktop by
default, movable to the server; auth optional (base URL only, tokens, or OIDC);
**latest edit wins, per field, never a conflict prompt; a delete wins over a later edit;
multi-field rules repaired automatically**.
- Migration `0007_sync.sql`: `field_clocks` (HLC of the last write per field, tag links
  per task-tag pair; backfilled from `ops`), `ops.received`, index `ops_hlc`,
  `sync_state` (pushed seq, pull cursor).
- Op engine records field clocks on every local write. HLC receive rule
  (`Hlc::observe`); every write transaction first observes `MAX(ops.hlc)` (the CLI and a
  local MCP will share the database and device id). `Store::set_clock_offset` for clock
  skew (fed from the server time in M13).
- `sync` module: `SyncOp`, `OpsPage`, `Merged`; `Store::outbox` / `mark_pushed`,
  `ops_after` (server side), `sync_cursor`, `apply_remote` (one transaction, deferred
  foreign keys, dedupe by `op_id`, only newer fields written, inverse computed locally,
  change event). Repairs as local ops, deterministic: subtree of a deleted task, parent
  cycles (latest move kept), projects nested two levels, things in deleted projects or
  epics moved out, tasks on deleted statuses, `completed_at` follows status, same-name
  tags merged into the first-created one with their links.
- Import rebuilds field clocks, marks every op for a new push and clears `sync_state`.
- Tests: Rust +19 (18 in `tests/sync.rs` incl. a seeded random test of 3 devices with
  skewed clocks converging over 25 seeds, and the rules checked afterwards; 1 HLC unit).
  Mutation checks: making incoming ops always win fails 8 sync tests, disabling repairs
  fails 6. Perf budgets (10k tasks) still pass. Vitest unchanged (190).
- No new dependencies.

### Create tasks on the calendar (2026-11-05)

Branch `calendar-create` (stacked on `task-history`). Day and week views: press on an
empty spot of the time grid and drag to draw the time (quarter-hour snap; a plain click
makes a one-hour block), then type the task in the box beside it (capture markers work:
#tag !high +Project, with the same confirm before creating a project or epic). Task and
block are one batch (`createTask`'s new `schedule`, passed through `captureTask`), so one
undo removes both. `features/calendar/NewBlock.tsx`. Tests: calendar.test "creating a task
on the grid". Drawing stays within one day.

### Task history: undo, diffs, restore (2026-11-05)

Branch `task-history` (stacked on `remappable-shortcuts`). In a task's Activity: a quiet
"Undo last change" link, "Restore" on hover for any entry (puts the task back as it was
right after it), and description edits expand into a line diff. UI only: `lib/history.ts`
works out the old values from the activity's before/after and `restoreTask` sends one
ordinary batch (update_task + tag_task/untag_task), so the restore shows in the activity
and Ctrl+Z undoes it. Not put back (and said so): files, calendar blocks, the parent,
values pointing at deleted statuses/projects/epics/tags. Only the last 50 changes are
listed. Tests: `lib/history.test.ts`, attachments.test "task history".

### Remappable keyboard shortcuts (2026-11-05)

Branch `remappable-shortcuts` (stacked on `delete-tags`). `lib/keymap.ts`: the
remappable actions, their defaults, chord names ("Ctrl+K", "G I"), sequence matching and
checks (keys kept for typing are refused; a key used elsewhere moves). Saved per machine
in localStorage like the theme (only what differs from the defaults). `useShortcuts`
resolves through it; Esc, Ctrl+1–9, board/plan keys and Quick capture stay fixed.
Settings → Keyboard shortcuts records, removes and resets keys; the `?` overlay shows the
current keys with a "Change shortcuts" link. The sidebar's "G S" hint became a `?` box
(also on the rail). New default: Ctrl+, opens Settings. Tests: `lib/keymap.test.ts`,
app.test "keyboard shortcuts".

### Delete tags (2026-11-05)

Branch `delete-tags` (stacked on `menus-ui`). `TagMenu` (features/organize) offers "Delete
tag" with the number of tasks using it: hover ⋯ or right-click on a sidebar tag, ⋯ in the
tag page header (leaves for the Inbox first). `deleteTag` action: optimistic removal and
untagging; the core's `delete_tag` already untags and is one undoable batch. UI only.
Tests: `features/organize/tagDelete.test.tsx`. Renaming tags is still open (see Later).

### Dropdowns and menus restyled (2026-11-05)

Branch `menus-ui` (stacked on `project-icons`). Native `<select>` popups (gray OS list on
Windows) are gone: `Select` in `components/ui.tsx` is now Radix Select with an `options`
list and `onValueChange`; property pills open the same list (`SelectRoot`). One look for
every floating list: `MENU`, `MENU_ITEM`, `MENU_DANGER`, `MENU_SEPARATOR`, `MENU_LABEL`
plus `.tm-menu` in index.css (paper texture, layered shadow, scale-in, accent-tinted
highlight, check on the chosen option). Used by the sidebar, project, attachment and
filter menus. Tests pick options with `test/select.ts` `pickOption`. Not yet checked in
the real app on Windows.

### Project icons (2026-11-05)

Branch `project-icons`. The project page's color popover (now "Color and icon") offers 15
emoji, a field for any other one (kept to its first grapheme) and "No icon". A project
with an icon shows it instead of its color dot (`ProjectMark`): sidebar row and rail,
project title, task page breadcrumb and project pill, Today. UI only; the core already
had `ProjectChange::Icon`. Tests: `features/organize/projectIcon.test.tsx`.

### Board: collapsible and resizable columns (2026-11-05)

Branch `worktree-board-columns` (from `main`). ADR 004 addendum.
- `features/board/useBoardColumns.ts`: collapsed flag and width per status in
  `localStorage`, shared by every board; `lanesFor` (2 lanes from 512 px, 3 from 768 px).
- `BoardView`: collapse button and resize handle (drag, keyboard, double-click reset) in
  each header; collapsed columns become strips that still take drops (card goes on top);
  cells place cards side by side in wide columns; the drag overlay keeps the card's width.
- Tests: Vitest 196 (+6: prefs helpers; collapse/expand, Alt+→ into a collapsed column,
  resize and lanes). Checked in a browser with a fake core: drag-resize to 536 px gives
  two lanes, a drag onto the Waiting strip lands on top.

### Drop caps under headings (2026-11-05)

Branch `worktree-dropcap-headings`. On the task page the first paragraph after each
heading now gets a drop cap too: full size at the start and under `h1`, smaller (2.4em)
under `h2`–`h6`; headings clear the previous cap. CSS only (`index.css`).

### M10 Google Calendar sync (2026-11-05)

ADR `docs/adr/014-google-calendar-sync.md`; setup guide `docs/google-calendar.md`. Agreed
first: token in `config.json`, day plans pushed as all-day events. Free (no billing).
- Core `calendar` module: `CalendarProvider` trait, `sync()` (calendars → pull edits from
  the target calendar → push → shown calendars), `StoreAccess`; migration
  `0006_calendar_sync.sql` (sources, links, cached events; outside `ops`, not exported;
  import forgets links); app wins on conflicts; relink by stored key; RFC 3339 helpers;
  `Error::Remote`.
- Shell: `google.rs` (loopback OAuth with PKCE, least-privilege scopes, token refresh,
  Calendar v3 calls, JSON mapping, revoke), `calendar_sync.rs` (sync thread: 10 s after
  start, every 5 min, 4 s after task/block changes, Sync now; status; commands
  `calendar_status`, `google_connect`, `google_disconnect`, `set_calendar_shown`,
  `calendar_sync_now`, `calendar_events`; event `CalendarSynced`). `config.json` gains
  `google`. Direct deps `sha2`, `getrandom` (already in the tree).
- UI: `Api.calendar` (optional); Settings → Calendar (setup steps, client ID/secret,
  connect, calendars with checkboxes, last sync and report, errors, Sync now,
  Disconnect); calendar view shows events read-only (timed ones beside blocks, all-day
  ones in the lane and month cells, details popover with "Open in Google Calendar") and
  the sync state in the header.
- Tests: Rust 90 (+13: 7 sync engine against a fake server, 1 RFC 3339, 6 Google client
  incl. a real loopback listener with a preconnect socket; one mutation check of the
  conflict rule); Vitest 187 (+4: events on the calendar, settings connect/toggle/
  disconnect). Browser preview (fake core) checked both themes.
- Found while testing: Chrome's idle preconnect sockets would have aborted the sign-in;
  now ignored.

### M9 Calendar views and time blocks (2026-11-05)

ADR `docs/adr/013-calendar.md`. Agreed first: Google first (CalDAV later, provider trait),
dedicated calendar for pushed blocks, custom grid on dnd-kit, local M9 then sync M10.
- Core: migration `0005_time_blocks.sql`; `TimeBlock` + `BlockOutcome` in the snapshot
  and `Changes`; `create_time_block` / `update_time_block` (start, end, outcome) /
  `delete_time_block` with ops, undo, task `updated_at`; 24 h limit; activity entries
  `schedule` / `unschedule` / `reschedule` / `block_outcome`; export/import
  (`ImportSummary.time_blocks`).
- UI: `lib/calendar.ts` (dates, month grid, overlap layout, `resolveDrop`, next slot);
  actions `scheduleTask`, `moveBlock`, `setBlockOutcome` (done completes the task, one
  batch), `deleteBlock`; `/calendar` page (sidebar, `g c`, palette) with a task tray
  (Today + searchable other tasks, Schedule button), day/week grid (all-day lane of
  planned/due tasks, blocks side by side, drag to move, resize from the bottom edge,
  block menu: outcome, open task, remove; Delete key; now line; drop preview), month
  grid (blocks, planned and due tasks, "+N more", day number opens the day). Range
  remembered in `localStorage`.
- Tests: Rust +6 (`tests/time_blocks.rs`); Vitest 183 (+30: calendar model, block
  actions, calendar page). Checked in a browser with a fake core (Playwright): drags from
  the tray and between days land on the pointer's quarter hour, both themes, month view.
  Fix found there: drop position now tracks the real pointer (dnd-kit's delta counts
  scrolling).
- No new dependencies.
### Task page matched to the mockup (2026-11-05)

User, with a screenshot of 0.3.0 next to the mockup: the full task page still did not
look like the design. Branch `worktree-mockup-parity` (from `main`), merged to `main` and
released as **v0.3.1** (2026-11-05).
- Canvas and sidebar texture: vertical fibre only. The crossing near-horizontal grain
  read as graph paper on Windows.
- `PropertyPills` (page only): set properties as tinted pills without icons, the status
  tinted by its color, due as "Due Fri, Nov 6" (red when overdue), tags inline as pills;
  unset ones (Priority, Due date, Add to Today, Epic, Estimate, + Tag) as quiet labels
  after them. Native select/date inputs lie invisibly over the pills (date opens the
  picker); the estimate edits in place.
- Description: drop cap in the rendered view (`.tm-dropcap`), "Keep writing… Markdown
  works." under the text, no tall empty block.
- Subtasks (page): "Subtasks · 2 of 4" with a green progress bar, square boxes filled
  with the new `--tm-done` green; they now come right after the description, attachments
  after them (one quiet "Attach file" line when there are none).
- Bigger title ring is 2 px.
- Tests: Vitest 156 (+3: due label, page pills, subtask progress). Checked visually in
  both themes with a throwaway Vite harness (fake API, mockup's task). Rust unchanged.

### Parchment rubric red restored (2026-11-05)

User: the red accents from the mockup were missing on tasks. The app used one neutral ink
for headings in both themes and Tailwind's stock red/orange for priorities.
- New theme variables `--tm-rubric` (headings: #8b2e1f on parchment, #d4d4da in the dark,
  as in the mockups), `--tm-urgent`, `--tm-high` (mockup tones per theme); Tailwind colors
  `rubric`, `urgent`, `high`.
- Rubric on list group headers, board column and lane headers, the sidebar's Projects
  label, the full page's Subtasks and Attachments labels, and description headings.
  Priority text and pills use the urgent/high tones.

### Windows title bar (2026-11-05)

ADR `docs/adr/012-windows-title-bar.md`. The user's choice over recoloring the system bar.
- `tauri.windows.conf.json`: main window `decorations: false`, `shadow: true` (a shell
  test keeps its window list equal to `tauri.conf.json` otherwise).
- `TitleBar` (32 px): sidebar-colored part as wide as the sidebar (open or rail), canvas
  elsewhere, deep drag region (Aero Snap, double-click maximizes), Windows-style
  minimize / maximize-restore / close (Segoe glyphs, red close, dims unfocused); also on
  the loading and error screens. `SIDEBAR_WIDTH` shared with the sidebar.
- Window permissions for dragging, minimize, maximize, close.
- Fix: closing the main window quits (the hidden capture window kept the process alive).
- Tests: Vitest 153 (+4 title bar), Rust +1 (config drift). Linux smoke run unchanged.

### M8 Markdown preview and attachments (2026-11-05)

ADR `docs/adr/011-attachments-and-markdown.md`. Agreed first: rendered by default, click
to edit; 50 MB per file.
- Core: migration `0004_attachments.sql`; `Attachment` in the snapshot and `Changes`;
  `create_attachment` / `update_attachment` (rename) / `delete_attachment` with ops, undo
  and task `updated_at`; activity entries `attach` / `detach` / `rename_attachment`.
  `FileStore` (`files.rs`): content by SHA-256 in `attachments/` beside the DB, streamed
  writes, size limit, mirror to backups, checked import; `clean_file_name`, `mime_for`.
  Daily backups mirror files; export/import carry them (`ImportSummary.missing_files`).
- Shell: `store_file`, `store_data` (base64), `open_attachment`, `save_attachment`,
  `open_url`; `tm:` protocol (async) serving files by attachment id; CSP `img-src`;
  remote backup uploads files once (`attachments-uploaded.txt`); export writes
  `<name>-attachments/`. `tauri-plugin-opener` (Rust only).
- UI: `MarkdownView` (GFM, attachment images and file links, external links via
  `open_url`, clickable checklists, no raw HTML, no remote images), `DescriptionEditor`
  rendered by default (click / pencil to edit, Esc or blur saves), paste and drop of files
  into the editor, `AttachmentList` (thumbnails, open, save a copy, insert in
  description, rename, remove, Attach file, drop target), `useFileDrop` (OS drops via
  Tauri, routed to `[data-file-drop]`), `.tm-prose` styles for both themes. `Api.files`
  is optional, so existing test fakes are unchanged.
- Tests: Rust +13 (8 attachment integration tests, 5 file store); Vitest 149 (+17:
  helpers, attachment actions, task page: rendering, checklist, click to edit, paste,
  OS drop on list and description, dialog pick, activity).
- Smoke run of the debug app on a fresh DB: starts, migrates to v4, no errors.
- New dependencies: `sha2` 0.11.1, `base64` 0.23.1, `tauri-plugin-opener` 2.7.2,
  `react-markdown` 10.1.0, `remark-gfm` 4.0.1.

### M0 Scaffold (2026-11-04)

- Cargo workspace (`crates/core`, `apps/desktop/src-tauri`) and pnpm workspace (`apps/*`).
- Toolchains pinned: Rust 1.99.1 (`rust-toolchain.toml`), pnpm 12.17.0 (`packageManager`), Node >= 24.
- Tauri 2.12 + React 19 + TypeScript 7 + Vite 8 app in `apps/desktop`.
- `taskmaster-core` crate with a `ping()` function and a test.
- `ping` wired core → Tauri command → UI through `tauri-specta`; `bindings.ts` is generated by
  the debug app and by the `export_bindings` test, and CI fails if it is stale.
- Biome (recommended rules), Vitest, clippy (`-D warnings`), rustfmt.
- Forgejo CI (`.forgejo/workflows/ci.yml`): fmt, clippy, cargo test, bindings check,
  Biome, typecheck, Vitest, Tauri `.deb` build. Linux only.
- `docs/plan.md`, `docs/adr/001-stack.md`, `CLAUDE.md`.
- Placeholder app icon (`apps/desktop/src-tauri/app-icon.png`, regenerate the set with
  `pnpm --filter desktop tauri icon src-tauri/app-icon.png`).

Verified locally on Linux: all checks pass; release build produces a 2.9 MiB `.deb`.

### M7 CI on GitHub (2026-11-05)

ADR `docs/adr/010-ci-on-github.md`. The Forgejo checks moved to `.github/workflows/ci.yml`
(every branch push and PR, tags left to release.yml); `.forgejo/workflows/ci.yml` is a
manual-only stub that must stay (otherwise Forgejo runs the GitHub workflows). GitHub repo
made public for updates; v0.2.0 tagged and released from `main`.

### M7 In-app updates and build info (2026-11-05)

ADR `docs/adr/009-in-app-updates.md`; release steps in `docs/release.md`.
- `tauri-plugin-updater` 2.14.0 + `tauri-plugin-process` 2.4.0 (Rust and JS), capabilities
  `updater:default`, `process:allow-restart`. Endpoint: GitHub `releases/latest/download/
  latest.json`; Windows passive install.
- Signing key in `~/.tauri/task-master.key*` (back it up); public key in `tauri.conf.json`;
  secrets `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` set on the GitHub repo.
- Update bundles only in releases (`tauri.updater.conf.json` via the release workflow),
  so Forgejo CI and local builds need no key. Releases now publish automatically.
- UI: `lib/updater.ts` (UpdateSource + zustand state machine), Settings → About and
  updates (version, build commit and date, check / download with progress / restart /
  retry), sidebar "Update to x.y.z" pill; quiet check 10 s after start and every 6 h.
- Version 0.2.0 (tauri.conf.json, Cargo workspace, package.json).
- Verified locally: signed release build (`.deb.sig`, `.AppImage.sig`) with the key, and
  the unsigned CI-style build without it. Tests: 132 Vitest (+8: update store, About UI).

### M7 Redesign (2026-11-05)

From user feedback after the first Windows build; mockup agreed first (claude.ai canvas
"task-master redesign"). Decisions: `docs/adr/008-redesign.md`.
- Themes: every color a `--tm-*` variable; semantic Tailwind colors (`canvas`, `ink`,
  `accent`...); `neutral-*` and `blue-*` remapped per theme. Dark (default, gold accent) and
  Parchment (light: vellum, brown ink, rubric red, CSS grain). Settings: Dark / Parchment /
  Follow the system.
- Type: MedievalSharp (display) + Source Serif 4 (body), bundled. Icons: lucide-react.
- Sidebar: New task + Jump to, smart lists with icons, projects with hover + and ⋯ menu
  (rename, color, archive, delete; right-click; double-click renames), foldable Epics /
  Saved views / Tags, collapsible to a rail. Ctrl+1–9 jump to projects.
- New task dialog (sidebar, Ctrl+N; takes the current project/epic/tag/Today);
  Shift+Enter adds and opens. CaptureBox variants: inline, dialog, window.
- Full task page `/task/$taskId` (panel's Open, Shift+Enter on a row; Esc goes back).
- View header: big title, List/Board switch, Display and Filter menus. Restyled rows (round
  status-colored checkbox, selects on hover), board, palette, settings, Plan my day.
- Capture window 660x230 for the new layout.
- Tests: 124 Vitest (+6: full page from panel and Shift+Enter, New task dialog with project
  default, Ctrl+N / Ctrl+2, sidebar rename, dialog defaults); tests updated for the
  Display/Filter menus and folded sidebar sections. Rust unchanged.
- New dependencies: `lucide-react` 1.61.0, `@fontsource/medievalsharp` 5.3.0,
  `@fontsource-variable/source-serif-4` 5.3.0.

### M6 feedback: discoverability (2026-11-05)

Branch `m6-ux-feedback`. From the first Windows test: "no task creation button", "can't
rename projects" (both existed, but could only be found through Enter or a double-click).
- `CaptureBox`: an "Add task" button (becomes "Create" when confirming a new project or
  epic); a failed parse or a markers-only line now shows an inline error instead of doing
  nothing.
- `EditableTitle` (project, epic and saved view pages): a single click or the ✎ Rename
  button edits the title; the input now gets focus with its text selected (`InlineInput`
  `autoFocus`).
- Tests: 118 Vitest (+3: Add task button, parse failure, rename from the project page).

### M6 Hardening (2026-11-04)

- Core: migration `0003_statuses.sql`; status commands (create, update incl. WIP limit,
  delete) with workflow guards; `daily_backup` (VACUUM INTO, keep 14), `backup_to`,
  `export` / `import` (versioned JSON of every user table; replace-all, FK-checked, clears
  history); `utc_date`.
- Shell: `config.json` (data folder, remote backup; 0600), backup thread (20 s after start,
  then every 15 min), remote upload to Garage S3 (presigned PUT, retry, status), commands
  `get_config`, `set_remote_backup`, `test_remote_backup`, `backup_status`, `backup_now`,
  `export_to`, `import_from` (backup first), `set_data_dir` (copy + restart);
  `tauri-plugin-dialog`.
- UI: Settings (`/settings`, sidebar, palette, `g s`): workflow editor (order, name,
  color, category, WIP limit, add, delete), theme (system/light/dark), data folder,
  backups, export/import with confirmation, remote backup form with test. Store handles
  statuses as an ordered kind (optimistic + rollback).
- Perf: `cargo test --release -p taskmaster-core --test perf -- --ignored` (10k hydrate
  ~23 ms vs 300 ms; write ~75 µs); `PERF=1 pnpm --filter desktop exec vitest run
  src/perf.test.ts` (board ~1 ms, list ~4 ms vs 16 ms).
- Release: `.github/workflows/release.yml` (tauri-action, Linux/Windows/macOS draft
  release on `v*` tags); `docs/release.md`, `docs/backups.md`.
- Tests: 57 Rust (+ status rules, export/import, backups rotation, config, upload errors;
  2 perf ignored) and 115 Vitest (+ status actions, theme, settings UI; 2 perf opt-in).
- Decisions: `docs/adr/007-hardening.md`. New dependencies: `tauri-plugin-dialog` 2.8.3
  (+ JS), `rusty-s3` 0.10.2, `ureq` 3.4.3, `url` 2.5, `serde_json` in the shell.

### M5 Speed (2026-11-04)

- Core `parse` module: capture syntax (`#tag @Project +epic:X !high ^fri`, quoting,
  relative dates) as a pure function with an `insta` snapshot; `resolve` matches names
  (tags exact; projects and epics exact, unique prefix, unique word). `Store::parse_capture`.
- Shell: read-only `parse_capture` IPC; `tauri-plugin-global-shortcut` with
  `Ctrl+Shift+Space` showing a hidden, undecorated, always-on-top `capture` window
  (`capture-opened` event); registration failure is logged, not fatal.
- UI: `CaptureBox` everywhere (live preview chips, warnings, confirm an unknown
  project/epic with a second Enter; markers beat view defaults); `CaptureWindow`;
  `captureTask` builds one batch (new tags/project/epic + task).
- Command palette (`Ctrl+K`): actions, views, projects, epics, tags, and tasks via FTS
  search over titles and descriptions; arrows/Enter/Esc.
- Shortcuts: `g i / g t / g a`, `?` overlay; Plan my day on Today (`?plan=1`, `1`–`9`).
- Tests: 48 Rust (+4: parser snapshot, matching rules, capture resolution against live
  entities; date math) and 109 Vitest (palette ranking, plan candidates, capture batches,
  UI: preview/confirm, palette search, g-navigation, help, plan my day).
- Decisions: `docs/adr/006-capture-and-palette.md`. New dependencies:
  `tauri-plugin-global-shortcut` 2.4.1, `insta` 1.49 (dev).

### M4 Organization (2026-11-04)

- Core: migration `0002_views.sql` (timestamps + soft delete on `views`); typed, versioned
  `ViewSpec` (scope, filter, group_by, sort, layout, swimlane, toggles) exported to TS;
  `create_view` / `update_view` / `delete_view` with ops and undo; views in `Changes`.
- `lib/views.ts`: one spec-driven path for every view: tag scope, filters (status,
  priority, project, epic, tags, due), list grouping (status, project, epic, priority, due
  buckets), sorts (smart, manual, due, priority, newest, recently updated). `buildBoard`
  takes the same spec; a status filter limits the columns.
- Saved views: `/view/:id`, sidebar section, "Save as view" from any page, filter bar,
  draft edits with Save/Revert, rename (double-click), delete. Built-in views keep their
  display choices per machine (`useViewPrefs`, reads M3 keys).
- Tag views: `/tag/:id` from the sidebar; capture in a project/epic/tag/Today view sets it.
- Projects: page header with rename, color, area move, archive/unarchive, delete; sidebar
  archived section and drag to reorder siblings (post-drop link navigation cancelled).
- Epics: page with state, target date, home project, description and progress; done and
  dropped epics collapsed in the sidebar.
- Tests: 44 Rust (+5: view roundtrips, ordering, validation, UI JSON with defaults,
  migrating a v1 DB) and 97 Vitest (filters, grouping, sorting, board filters, project and
  epic actions, saved view and tag view UI flows).
- Decisions: `docs/adr/005-saved-views.md`. No new dependencies.

### M3 Kanban (2026-11-04)

- Dev machine setup (desktop, WSL2 Debian 12): rustup with the pinned toolchain, Node 24 via
  nvm (default), pnpm 12.17.0 via `npm i -g` (corepack under nvm failed to resolve pnpm 12),
  Tauri apt packages (`libwebkit2gtk-4.1-dev`, `libxdo-dev`, `libssl-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`, `file`).
- Core: rank rebalancing. A task rank over `MAX_RANK_LEN` (32) rewrites its status column with
  short keys in the same batch (one undo); rebalance ops carry only `rank` and are left out
  of `task_activity`.
- Board (`lib/board.ts`, `features/board/`): columns per status with counts and WIP warning,
  cards (title, priority, project color, epic, tags, subtask progress, due), manual rank
  order, swimlanes by project/epic/priority (a drop into a lane sets that field), subtask
  and cancelled toggles, virtualized cells, dnd-kit drag within/between cells with overlay,
  `Alt+←/→` keyboard moves, Space for keyboard drag, Enter/click to open.
  Inbox and Today boards keep tasks closed today, so the Done column is not always empty.
- `ListView` became `features/shell/ViewPage.tsx`: list/board toggle and board options per
  view, remembered in `localStorage` (`useViewPrefs`).
- `moveCard` action: one `move_task` (or one `update_task` with the lane change); renumbers
  the cell when the drop neighbours share a rank.
- Perf tooling: `cargo run --release -p taskmaster-core --example seed -- <db> <n>`; debug
  builds open `TASK_MASTER_DB` when set. `buildBoard` on 10k tasks: ~2.3 ms (no lanes),
  ~3.5 ms (lanes), model only.
- Tests: 83 Vitest (board model, drop ranks, 50 random drags through the store, board UI:
  layout toggle, Alt+→, open, lanes) and 39 Rust (rebalance + undo, 50 random drags against
  a reference model with undo of each).
- Decisions: `docs/adr/004-board.md`. New dependencies: `@dnd-kit/core` 6.3.1,
  `@dnd-kit/sortable` 10.0.0, `@dnd-kit/utilities` 3.2.2.

### M2 List and detail (2026-11-04)

- Store (`src/store`): normalized Zustand store over an injected `Api`, hydrated from
  `snapshot`; serialized optimistic writes with per-entity rollback; own-vs-foreign change
  event matching; undo/redo.
- Actions: create (with client UUIDv7 + rank), update, toggle done, delete with subtasks,
  set parent/promote, reorder subtasks, tag/untag, create tag on a task, create project/epic.
- Views (`src/lib/views.ts`): Inbox, Today (picked today, or due today/overdue and open),
  All, project (areas include their projects), epic; default sort (today, overdue,
  priority, due, rank); status groups with a two-level subtask tree.
- UI: sidebar (counts, projects tree with inline add, epics with progress, tags), list view
  (virtualized, inline title/status/priority/due, collapsible groups and subtasks, capture
  input), detail panel (all fields, CodeMirror markdown description, tag picker,
  subtask checklist, activity feed from `ops`), error toast, shortcuts.
- Core: `task_activity` query + Tauri command.
- Tests: 66 Vitest (rank vectors shared with Rust, views, store, API wrapper, full-app UI
  in jsdom) and 37 Rust. Release `.deb` builds (4.7 MiB) and starts.
- Decisions: `docs/adr/003-frontend-state.md`.

### M1 Data core (2026-11-04)

- Schema `0001_init.sql` (plan section 4) with indexes, FTS5 triggers and the six default
  statuses (fixed ids). Migrations run at startup; an existing DB is copied to `backups/` first.
- `Store` API: `open`, `execute`/`execute_all` (atomic batch), `undo`, `redo`, `snapshot`,
  `search`, `subscribe`. Modules: `model`, `db`, `ops`, `commands`, `history`, `query`,
  `events`, `rank`, `clock`.
- 16 commands: create/update/move/set-parent/delete task, tag/untag, and create/update/delete
  for projects, epics and tags. Every write appends `ops` (patch + inverse, batch id, HLC).
- Fractional ranks ported from `fractional-indexing`; shared vectors in
  `crates/core/test-vectors/rank.json`.
- Tauri commands `snapshot`, `execute`, `undo`, `redo`, `search` (+ `ping`) and a
  `storeChanged` event; DB at `<app data>/task-master.sqlite`.
- 36 Rust tests: every command with undo and redo back to the exact snapshot, validation
  rules, atomic batches, events, search, the ops log, migration of a fresh and an existing
  file, and the UI's JSON wire format.
- Design choices and deviations: `docs/adr/002-data-core.md`.

Verified locally: all checks pass; the app creates and migrates its DB on first launch.

### M0 deviations from the plan

- CI is Forgejo, Linux only; the 3-OS matrix moves to M6 (ADR 001).
- Biome pinned to 2.6.4: pnpm 12's minimum release age rejected 2.6.5 (released the same day).
  Bump it in a later session rather than adding a release-age exclusion.
- `vite.config.ts` is not in the app's `tsc` project (it would need `@types/node`); Vite
  still type-strips it on load.
- Packages implied by the stack but not named in the plan: `tauri-build`, `@tauri-apps/api`,
  `@tauri-apps/cli`, `@vitejs/plugin-react`, `typescript`, `specta`, `specta-typescript`.

## Not yet verified

- M10 against the real Google API (needs the user's OAuth client): sign-in in the
  browser on Windows and in WSL (where it depends on xdg-open finding a browser), the
  task-master calendar created once, blocks and plans appearing, a move / resize /
  delete in Google coming back, 410 handling, shown calendars, Disconnect revoking.
- M9 in the real window (WebKitGTK / WebView2): drag feel, resize, `color-mix` block
  fills, scroll position on open, migration of an existing DB to v5.
- Windows title bar on Windows: drag, double-click, Aero Snap, resize from every edge,
  shadow, maximized size (taskbar not covered), buttons in both themes, unfocused dimming,
  the strip lining up with the sidebar (open and rail), close quits the process.
- M8 by hand in the real window: paste a screenshot (Windows Snipping Tool, Linux), drop
  a PDF from the file manager onto the description and onto Attachments (drop position
  on HiDPI screens), images through `tm:` on Windows (`http://tm.localhost`), open and
  save a copy, links open in the browser, prose styles in both themes, a backup folder
  with `attachments/`, the remote upload of files, export + import on another machine.
- M2 UI by hand in the real window (`pnpm dev`): layout, dark mode, CodeMirror, popover.
- M6 by hand: Settings in the real window; dialogs (export, import, data folder + restart);
  a remote upload to Garage after creating the bucket/key (docs/backups.md); dark/light
  toggle; board scrolling with the 10k seed; first GitHub release after the mirror is set
  up (docs/release.md); fresh install on Linux and Windows (M6 "done when").
- M5 by hand: `Ctrl+Shift+Space` in a native X11 session or on Windows (WSLg only sees it
  while a WSLg window has focus), the capture window (appears centered, focused, hides on
  blur/Esc/save), the 3 s capture goal, palette feel. Shift+Enter there: the window
  grows and re-centers (WebKitGTK and WebView2, HiDPI), stays put while a file picker is
  open, and opens small again next time.
- M4 by hand: saved view save/revert/reopen, filter bar popovers, project drag in the
  sidebar, archive/delete flows, epic fields, dark mode.
- M3 board by hand: pointer drag feel (jsdom cannot test it), shaking a card between columns
  (the update-depth loop fix, ADR 004), drag between lanes, dark mode,
  and scrolling on WebKitGTK with a seeded DB:
  `cargo run --release -p taskmaster-core --example seed -- /tmp/seed.sqlite 10000`, then
  `TASK_MASTER_DB=/tmp/seed.sqlite pnpm dev`.

- Window opens on **Windows** and **macOS** (M0 "done when" asks for Windows). No CI for them yet.

## Next

1. Done 2026-11-04: Garage bucket + key configured; GitHub push mirror (SSH); `main`
   fast-forwarded to M6; Forgejo CI green; `v0.1.0` tagged and its draft release built for
   Linux, Windows and macOS (9 assets). Left: install it fresh on Linux and Windows, then
   publish the draft.
2. Use the app daily for two weeks; collect issues in the app itself.
3. Then Phase 2 (folder workspaces and the `tk` CLI on the same core and parser).

## Later

- Sync (M12): build to `docs/server.md` (env vars, image
  `harbor.solarnexus.space/knowledgesystem/task-master-server`, `token add|list|revoke`,
  `health`, `/info`); update that page in the same change if anything differs.
- Sync (M13): order equal ranks by id in `src/lib/views.ts` (two devices can pick the
  same rank); desktop reload on `PRAGMA data_version` for outside writers; ops
  compaction with the 30-day purge; `apply_remote` skips (and counts) ops for rows it
  never saw, which a server relaying in order never sends; surface `skipped` if it ever
  shows up.

- Calendar sync: CalDAV provider (iCloud) behind the same trait; refresh token in the OS
  keychain; a push right after each change instead of the 4 s pause; show which blocks
  are synced (a small cloud mark); pick another calendar as the target.
- Quick capture editor: an "Open in Task Master" button (show the main window on the
  task page; needs an event to the main window); Ctrl+Z inside the capture window.
- Calendar: drag on empty grid to block out an _existing_ task (new tasks done); keyboard moves of blocks;
  week start and working hours in Settings; Today view counting tasks with a block today;
  block list and logged time on the task page; multi-day blocks shown across days in the
  month view.
- Rename epics and tags from the sidebar (projects done in M7).
- Drop cap on the full task page's description (needs care with CodeMirror measuring).
- Optional sans body font (one variable, `--font-sans`).
- Board: Shift+Enter on a card to open the full page.
- Board: column widths and collapsed columns per saved view (today: per machine, all boards).

- List view multi-select and bulk actions (plan section 6), via one `execute` batch.

- Core: writer thread + reader pool if the M6 perf test needs it (ADR 002).
- Core: status commands (M6), undo across restarts.
- Core: compile `ViewSpec` to SQL for the CLI and MCP adapters (plan section 5).
- Sidebar: drag a project into another area (today: the project page's Area menu); keyboard
  reordering of projects; reorder saved views.
- Bump `rusqlite` to 0.41 once `rusqlite_migration` supports it.
- Purge soft-deleted rows after 30 days (plan section 3), designed with sync (ops expiry);
  also delete attachment files no row uses any more (and their backup mirror copies).
- Windows title bar: snap layout flyout on the maximize button (WM_NCHITTEST); macOS
  overlay title bar.
- Attachments: preview a PDF or image in the app (lightbox) instead of the default app;
  attach from the capture window; resize pasted images.
- Secret key in the OS keychain instead of `config.json`; signed installers.
- Board: WIP limits are now editable (M6); quick in-board column add/rename could follow.
- CSP in `tauri.conf.json` is a strict baseline; revisit when adding the markdown editor.
- Replace the placeholder icon.
- Capture: a tray icon and a `--capture` flag (needs the single-instance plugin) for
  desktops that refuse global hotkeys; configurable hotkey in settings.
- Palette: run per-view actions (toggle board/list, group by) and task actions (done,
  move, tag) on the selected task.
- Board: `Alt+↑/↓` to reorder within a column;
  scroll a keyboard-moved card into view when it lands below the fold.

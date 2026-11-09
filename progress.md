# Progress

Running log for task-master. Read at the start of every session; update at the end.

## Current milestone

**WSL agent fix** (2026-11-09, on `main`, uncommitted): runs and "Open in terminal" with the
WSL runtime failed with `execvpe(claude) failed` because `wsl.exe --exec` runs no shell, so
the profile's PATH (`~/.local/bin`) is missing, and the native NotFound retry never fired
(wsl.exe itself started). A bare `claude_path` is now resolved once per distro through the
login shell (`$SHELL`, else the passwd shell) before a WSL launch. Not yet verified on Windows.

**M16 Agent sessions** (ADR 017) is merged into `main` (from `m16-agent-sessions`):
"Send to Claude" from a task, headless Claude Code runs with a live status, an MCP server
for agents to track their work, and agent-owned tasks hidden from the user's views. Steps
1 to 5 done and checked by hand on Linux. Not yet verified: the WSL runtime and Windows
Terminal on Windows (unit-tested command lines only), and the Windows/macOS installers
with the sidecar, which only release.yml builds. Migration 0010 bumps the schema, so the
sync server must be upgraded with the desktops (replicas sync only at one version).

**v0.7.0** is prepared on `main`: agent sessions and the bundled MCP server, Review
workflow (schema 11), freeform Lineage canvas, settings categories, medieval icons,
sidebar and board polish, calendar popup fixes and public OAuth project pages. The
client and sync server share the release tag and must be upgraded together. Google
Calendar setup and enabling GitHub Pages remain user configuration steps.

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

### README with branding, screenshots and a quickstart (2026-11-09)

- README rewritten: banner and wordmark header, badges, features with three screenshots
  (board dark, Lineage lanes dark, Today light), quickstart (install table, first steps,
  optional setup), build from source, license. Images in `docs/images/` (WebP, ~240 KB).
- Screenshots come from `apps/desktop/showcase.html` (`src/showcase/`): the real UI on
  sample data with Tauri calls stubbed, development only (the release build has only
  index.html). `pnpm -C apps/desktop dev`, then `/showcase.html#/<route>`, `?theme=light`.
- Fixed on the way: list rows without a due date showed a sliver of the hidden "Due…"
  button (zero width but padded); the padding now applies only when it shows.
- `.playwright-mcp/` is gitignored.

### License: AGPL-3.0-or-later (2026-11-09, ADR 020)

- `LICENSE` (unmodified text from gnu.org), SPDX `AGPL-3.0-or-later` in the Cargo
  workspace (all crates and the Tauri bundles), both `package.json`, and the AUR
  `PKGBUILD` / `.SRCINFO`. README "License" section; Settings → About states the license
  and links to the source (`useOptionalApi`, so About still renders without a store).
- Checked: every Rust and JS dependency has an AGPL-compatible license.
- Lineage arrows: hovering a card or arrow shows a × to remove the link; settings
  categories use the app's icons (lucide kept for Shortcuts, Data, About until glyphs
  exist); the site's app icon is the purple one.

### Lineage as the main working view: lanes, pins, epic on cards, browsing (2026-11-09)

- "Arrange" select: Freeform, Lanes by epic, Lanes by project (`lanes.ts`, saved with the
  filters). Lanes stack top to bottom in rank order, with "No epic" / "No project" last;
  active epics in view get an empty lane to drop into. New cards go in their dependency
  column, so links still read left to right across lanes. Inside a lane cards move
  freely (positions are relative to the lane, saved per arrangement); dropping a card in
  another lane sets its epic or project (`update_task`, undoable). Lane headers stay at
  the left edge of the view and collapse (hidden cards and their arrows).
- Pins: the grip on each card becomes a pin on hover. A pinned card doesn't drag or
  nudge, and "Auto arrange" (both modes) leaves it in place, moving other cards off it.
- Cards show their epic (EpicMark in the epic color, title on one line then); hidden in
  epic lanes, as the project is in project lanes.
- Browsing without typing: with a card selected, the side panel lists its epic's tasks
  then its project's, with the link chips; with none selected, the tasks the filters
  match but the canvas leaves out ("Connected tasks only", a task's lineage). The plus
  popover suggests open tasks of the same epic, then project, before you type.
- Removing a link: hovering a card (or an arrow, or selecting a card) shows a × in the
  middle of its arrows; clicking it removes the dependency.
- Layout (positions, pins, lanes, collapsed) stays in the webview's local storage, per
  machine, on purpose: links sync through the core, the arrangement does not.
- Tests: `lanes.test.ts`, and `LineagePage.test.tsx` (epic lanes and dropping into
  another, project lanes, collapse, pins, suggestions, the "not on the canvas" list).
  Biome, typecheck and 341 frontend tests pass. Not checked in the real app (no browser
  mode without Tauri): look at lanes, dragging between them and the pin button on Linux
  and Windows.

### Lineage: filter by several epics and tags, "No epic", "No tag" (2026-11-09)

- Bug: with a project picked, the Epic select listed only epics whose home project was that
  project, so epics without a project disappeared (often leaving just "All epics").
- The Epic and Tag selects are now the FilterBar chips (`MultiPick`, exported with an
  `ariaLabel`): several values, "any of", with "No epic" / "No tag" (`FILTER_NONE`). Under
  a project filter the Epic chip lists that project's epics plus epics without a project;
  changing project drops picked epics of another project. Saved filters with the old
  single `epic` / `tag` strings are read as one-item lists.
- A card created from a plus button keeps its source's epic and tags, moved inside the
  filters only when the source itself doesn't match (a focused card).
- Tests: `graph.test.ts` (none sentinels, any-of) and `LineagePage.test.tsx` (chip
  options under a project, filtering, old saved filter). Biome, typecheck and the 333
  frontend tests pass.

### Release 0.10.0 (2026-11-09)

- Integrated the uncommitted work since 0.9.0 (Lineage side panel and linking, subtask
  picker, "No epic"/"No tag" filters, Metrics burn-down and focus, sharp Lineage cards)
  with the asset pack already on `main`. Fixed on the way: strict-null type errors in
  `actions.ts`, `hierarchy.ts` and `TaskPicker.tsx`; test fixtures made invalid fractional
  ranks past 9 (`a10`), now `fixtureRank()`; the subtask picker test raced the panel's
  re-render after opening. All CI checks pass locally (fmt, clippy, cargo test, bindings,
  biome, typecheck, 331 frontend tests). Schema unchanged (12).
- Notes in `docs/releases/0.10.0.md`; tagged `v0.10.0`.

### Metrics: medieval figures, burn-down, project focus (2026-11-09)

- Each figure card has a medieval title with the plain measure under it ("Quests fulfilled"
  / Completed, "Still afield" / Open now, ...), a medieval icon, and display-font numbers.
  The header uses the title crest and flourish ornaments, and every section gets a themed
  title plus a plain caption. Table columns stay plain.
- Burn-down (`burnDown` in `metrics/metrics.ts`): open tasks at the end of each day of the
  period, rebuilt from `created_at` and `completed_at`. Cancelled tasks have no
  completion time, so they count as closed at their last update. The chart shows the open
  count at the start and now, the net burn rate (open tasks removed per day) and a
  projected clear date, with a hover crosshair. The daily values table has a new "Open at
  day end" column.
- Project focus: `/metrics?project=<id|inbox>` (route search). The Project picker, a
  click on a "By project" row and the sidebar project ⋯ → Metrics all set it. A focused
  banner offers "Show all projects". "By tag" rows focus a tag the same way.
- Tests: `metrics.test.ts` (burn-down) and `MetricsPage.test.tsx` (focus from the URL,
  the banner and a row). Not run in the session (no permission to run pnpm, vitest, tsc
  or biome): `pnpm biome check`, `pnpm test`, typecheck, and a look at the page.

### Filter by "No epic" and "No tag" (2026-11-09)

- The Epic and Tags chips of the filter bar list "No epic" / "No tag" first. They store the
  sentinel `"none"` (`FILTER_NONE` in core `model.rs` and `lib/views.ts`) in
  `epic_ids` / `tag_ids`, so it combines with real ids as "any of" and saved views keep it
  with no schema change. Core view validation skips the sentinel.
- Tests: `views.test.ts` (matching) and `view_specs_are_validated` (a saved view with the
  sentinel). Clippy, rustfmt, cargo test and the bindings export pass (bindings changed
  only in doc comments). Not run in the session (no permission for pnpm):
  `pnpm biome check`, `pnpm test`, typecheck.

### Lineage canvas: blurry cards on Linux (2026-11-09)

- The cards were zoomed with `transform: translate(x, y) scale(zoom)` at fractional
  offsets. WebKitGTK rasterizes such a layer once and stretches the bitmap, so the card
  text looked out of focus and changed sharpness with the zoom level.
- `LineageCanvas.tsx` now pans with a whole-pixel `translate` on a wrapper and zooms the
  cards with CSS `zoom` on an inner layer, which lays text out at its real size. The SVG
  arrows use the same rounded offset so they stay aligned with the cards.
- Not run in the session (no permission to run commands): `pnpm biome check`,
  `pnpm test`, and a look at the canvas in the AppImage at a few zoom levels.

### Make a task a subtask of another, or adopt one as a subtask (2026-11-09)

- The core already had `set_parent`; the UI could only detach ("Promote"). Now:
  task details have "Make it a subtask of…" (or "Move under another task…") and the
  subtask list has "Add an existing task…", both a searchable task picker
  (`task-detail/TaskPicker.tsx`). Candidates exclude cycles, the current parent or
  children, and agent tasks (`task-detail/hierarchy.ts`).
- Lineage side panel: search results get "+ Parent" and "+ Subtask" next to Prereq and
  Dependent; the selected task shows "Subtask of …" with a button to make it top-level.
- `setParent` now also moves the subtasks' project/epic optimistically, as the core does.
- Tests in `hierarchy.test.ts`, `app.test.tsx` and `LineagePage.test.tsx`; not run in
  the session (no permission to run commands): run `pnpm test` and `pnpm biome check`.

### Lineage: side panel, dependents follow their prerequisite, popover closing (2026-11-09)

- The side panel is always there (hide/show remembered in `task-master.lineage-panel`):
  "Search tasks" finds any task; a result selects it and centers its card, or opens its
  lineage when the filters hide it. With a task selected, each result has "+ Prereq" and
  "+ Dependent" (disabled when already linked or circular), and the query can be created as
  a new prerequisite or dependent, placed beside the card. Replaces the old "Connection
  type" select and "Include other projects" box: search covers every project.
- "Dependents follow this task": copies the selected task's project, epic and tags onto its
  dependents (or the whole chain downstream) in one undoable batch (`copyBelonging` in
  `store/actions.ts`). Tags are added, never removed. Tasks created from a card's plus
  buttons now also take the card's tags (they already took its project and epic).
- The plus button's popover closes on any pointer down elsewhere on the canvas, cards
  included, even with text typed.
- Tests in `LineagePage.test.tsx` and `graph.test.ts`; not run in the session (no
  permission to run commands): run `pnpm test` and `pnpm biome check`.

### Lineage: empty canvas when opening a task's lineage (2026-11-09)

- The canvas restored the camera saved by whatever view was open last, so a task's
  lineage could open on an empty area. It now frames the cards when opened on a task, and
  refits on open whenever the saved camera shows none of the cards.
- Saved filters (project, "Connected tasks only", ...) could hide the focused task itself
  (e.g. an Inbox task with no links); the focused task now always shows.
- Tests added in `graph.test.ts` and `LineagePage.test.tsx`; not run in the session (no
  permission to run commands), run `pnpm test` and `pnpm biome check`.

### Asset pack and development asset lab (2026-11-09, ADR 019)

- Painted PNG asset pack imported as WebP by `scripts/asset-pack/import.sh <zip>` into
  `apps/desktop/src/assets/pack` (~930 KB; the 1024 px icon sources are gitignored).
- Native app icon regenerated from `app-linux-purple`; in-app logo is `app-banner` (`scripts/asset-pack/set-app-icon.sh`;
  `generate-app-icons.mjs` now takes an optional source path).
- `src/lib/ornaments.ts` defines switchable slots (logo, wordmark, title flourish/crest,
  done stamp, priority ribbon, empty page, corners, background, gold sidebar icons, About
  banner); `features/ornaments/AssetLab.tsx` is the live picker (Ctrl+Alt+A or Settings →
  Appearance), development builds only. Shipped: purple native icon, banner logo, divider
  under page titles, full wax seal on empty pages. A release build bundles only those.

### Release 0.9.0 (2026-11-08)

- Integrated the uncommitted work since 0.8.0: backup and sync frequency, default project
  for new tasks, live view search, Lineage epic filter and same-project connections,
  sidebar project indent. Fixed on the way: the config round-trip test (missing
  `schedule`), the Lineage filter test (missing `epic`), two a11y labels in Settings,
  biome formatting. `bindings.ts` regenerated. All CI checks pass locally (fmt, clippy,
  cargo test, bindings, biome, typecheck, pnpm test). Schema unchanged (12).
- Notes in `docs/releases/0.9.0.md`; tagged `v0.9.0`.
- Throwaway Obsidian import (`crates/core/examples/obsidian_import.rs`) was used once and
  deleted; the real database was backed up first to
  `backups/before-obsidian-import.sqlite` in the data folder.

### Backup and sync frequency (2026-11-08)

- Settings → Data and backups → Frequency: backup check (5 min to 24 h) and sync round
  (1 min to 1 h, or only on changes), saved per device in `config.json` (`schedule`).
  `set_schedule` command; the sync loop re-reads it on a kick, the backup thread every 30 s.
- Built and checked in the 0.9.0 release. Frontend tests for the new selects are still to
  write.

### Release 0.8.0 integration (2026-11-08)

- Integrated the new Lineage planning tools, board column fitting and agent subtask
  completion rules with the work already on `main`. Prepared release notes and the
  desktop/server version bump to 0.8.0; migration 0012 makes the schema 12.
- Updated the board resize integration test for columns that fit the viewport.
- Before tagging: frozen pnpm install, Biome, TypeScript, 312 frontend tests, Rust fmt,
  clippy, the full Rust suite, generated bindings check and the Linux `.deb` build pass.

### Agents keep subtasks up to date (2026-11-08)

- Agents finished tasks but left their subtasks open (they could not close the user's
  subtasks at all). `update_task` now lets them mark the user's subtasks of the session's
  task done (not cancelled; the session's task itself still goes to Review).
- Software rule: `complete_session` refuses while any subtask (user's or agent's, any
  depth) is open, listing them, unless named in its new `left_open` parameter. Server
  instructions and session rules say so. ADR 017 amended.
- Tests: MCP `tools.rs` (subtask done/cancel rules, the completion check), session rules.
  Not run in that session: cargo needed approval in the background run; run
  `cargo test -p taskmaster-mcp`, clippy and fmt before committing.

### Lineage view improvements (2026-11-08)

- Filters: tag, and completion ("Open and done", "Open only", "Ready (not blocked)": open
  tasks with no open prerequisite), next to project and connected-only. Filters are kept on
  this machine (`task-master.lineage-filter`).
- Done and cancelled cards are faded, colorless and struck through; links from a done
  prerequisite are dashed and faded. Open cards waiting on open prerequisites show
  "Blocked · N"; the inspector says Blocked / Ready.
- Plus buttons on a card's top corners (left: prerequisite, right: dependent) open a small
  popover: type a title to create a linked task (one batch, one undo; it keeps the current
  project/tag filter), or pick a matching existing task to link. The new card is placed one
  column to the side in the first free row.
- `/lineage?around=<id>` shows only that task's ancestors and descendants ("Lineage of …"
  chip to go back to all). Reached from the inspector ("Show only its lineage") and from
  the new Lineage section of the task panel and page ("Plan in Lineage"), which lists what
  blocks the task and what waits on it.
- Tests: graph filters, free slot placement, page interactions, task page section, and a
  core test that a create + link batch works and undoes as one. 309 frontend tests, Rust
  suite, clippy, fmt, Biome and TypeScript pass. Not checked by hand in the running app.

### Main integration and relaunch (2026-11-08)

- Integrated the terminal takeover updates and sidebar resize hit area into `main`.
- Verified `pnpm lint`, `pnpm typecheck`, `pnpm test` (302 passed),
  `cargo test --workspace --locked`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  and `cargo fmt --all -- --check` before rebuilding the desktop app.

### Taken-over terminal: in color, and it keeps working (2026-11-08)

- Open in terminal on a running session stopped the run mid-turn and started a bare
  `claude --resume`, which then sat at the interrupted conversation (you had to type
  "continue"). It also asked for permissions the run never needed, and used the default
  model. Now the terminal gets the session's `--permission-mode` and `--model` (the
  settings' model when the session has none). When it stopped a turn in progress, it also
  gets a first message (`launch::CONTINUE_PROMPT`), so claude carries on by itself. The
  prompt goes after the single-value options, because `--mcp-config` and `--allowedTools`
  take several values and would eat it; when there is no such option it goes after `--`.
- No color: the app inherited `NO_COLOR=1` from the agent shell that started it (here, a
  release build started by Codex). The terminal's process now drops `NO_COLOR`. Headless
  runs keep it.
- Checks: clippy and `cargo test -p taskmaster-desktop` pass (new test in `launch.rs`).
  Not tested by hand in the running app.

### Main integration and local verification (2026-11-08)

- All branch tips are contained in `main`; committed the remaining desktop, agent workflow,
  project icon, title bar and task detail changes from the main worktree together.
- Fixed the sidebar resizer's semantic element and event types so lint and TypeScript pass.
  Made the Google Calendar event test check the next week when today is Sunday.
- Verified `pnpm lint`, `pnpm typecheck`, `pnpm test` (302 passed),
  `cargo test --workspace --locked`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  and `cargo fmt --all -- --check`.

### New task keeps the cursor when expanded to the full page (2026-11-07)

A task added from a view's top row opens in the side panel with the cursor in its
description; its **Open** button went to the full page without the focus flag, so the
page opened with no cursor. The button now forwards `focus: "description"` when the panel
has it (a task just created), and stays plain otherwise, matching Shift+Enter on a list
row. Tests in `app.test.tsx` cover both cases.

### Running sessions continue in a real terminal (2026-11-07)

The terminal button on a running session opened a read-only window tailing `run.log`
("Watch in terminal"), not an interactive Claude. Now it is **Continue in terminal**:
`agent_open_terminal` stops the headless run (`stop_for_terminal`: kill, then wait up to
5 s until `finish` recorded its end, so it cannot overwrite `terminal`), then resumes it
with `claude --resume` like any ended session. The command is `#[tauri::command(async)]`
so the wait is off the UI thread. `launch::watch_script` / `shell_terminal` and their
tests are removed; `run.log` is still written as a record. ADR 017 and docs/agents.md
amended. The turn in progress is cut short (its work so far stays in the conversation).
- Also fixed the agents page test's expectation for the new `model: null` start field.
- Not run by hand yet: start a session, click the terminal button while it runs, check
  kitty opens an interactive Claude on the conversation and the card shows "In terminal".

### Terminal button on a running session opens a real terminal (2026-11-07)

The terminal button on a running session opened "Watch in terminal", a read-only window
following `run.log`, not Claude. It is now **Continue in terminal (stops the background
run)**: `agent_open_terminal` stops the headless run (as Stop), waits up to 5 s for its
end to be recorded (`stop_for_terminal`, so the `cancelled` write cannot land after
`terminal`), then runs `claude --resume` interactively like any ended session. The command
is `#[tauri::command(async)]` so the wait is off the UI thread. `launch::watch_script`,
`shell_terminal` and their tests are removed; `run.log` is still written as a record.
ADR 017 and docs/agents.md amended. Not run by hand: click it on a running session in the
real app and check that the terminal is interactive and the session shows "In terminal".

### Engraved project icons (2026-11-07)

Projects can pick one of 36 engravings from the GPT sheets (`assets/project-icons/*.png`,
96px, cut by `scripts/slice-project-icons.py`) besides an emoji. Stored as
`icon = "img:<name>"` (no schema change); `ProjectMark` renders it, the picker on the
project page has a new grid. Vitest +1. Looks fine on parchment and dark in a montage;
judge it in the real app at sidebar size (~16px), where the stipple may turn to mush.
Not run: cargo / full pnpm test (only organize tests and tsc).

### Linux title bar, no more black Wayland strip (2026-11-07)

ADR 012 amended. GTK drew its own dark title bar on Wayland above the app.
- `tauri.linux.conf.json`: main window `decorations: false` (shell test against drift,
  like the Windows file). Resize edges come from Tauri's frameless handling on GTK.
- `TitleBar` gets a `linux` variant (round SVG-icon buttons, red close disc);
  `titleBarStyleFor(userAgent)` / `customTitleBarStyle()` pick windows / linux / none.
- Tests: Vitest +2 (style detection, Linux buttons), Rust +1 (Linux config drift).
- Not run by hand yet: check drag, snap, double-click maximize and edge resizing on KDE
  Wayland. No compositor shadow or rounded corners on a frameless window.

### Task view no longer doubles the weathering (2026-11-07)

The full-page task view wrapped its content in its own `tex-canvas`, which painted a second
copy of the weathering layers (burnt edges etc.) inside the window-wide ones from `Framed`.
Removed the class in `TaskDetail.tsx`. Not verified by hand or by tests in that session.

### Agent terminals open from the AppImage (2026-11-07)

"Open in terminal" did nothing in the release AppImage and left the session "In terminal"
for good. The AppImage runtime exports `PYTHONHOME`, `PYTHONPATH`, `LD_LIBRARY_PATH`, `PATH`,
`QT_PLUGIN_PATH`, GTK/GStreamer variables into its mount; the terminal inherited them and
kitty (embedded Python) died at start-up ("Fatal Python error"), before its shell recorded
claude's pid, so the watcher waited forever.

- `launch::host_env`: every program the agents code starts (`process()`) gets the user's
  environment back: the image's entries are removed from path lists, AppImage-only
  variables are dropped. No-op outside an AppImage.
- A terminal that exits with an error within 3 s and before recording a pid sets the
  session back (stuck "In terminal" sessions become done) with an error that quotes its
  stderr (`terminal.log` in the session folder).
- `mcp.json` is rewritten when a terminal opens: it named the MCP server inside the old
  AppImage mount, gone after a restart.
- Not yet verified in a built AppImage: unit tests, plus kitty reproduced by hand with the
  AppImage's environment.

### Parchment background as WebP, with optional weathering (2026-11-06)

Branch `worktree-parchment-background` (on top of `worktree-perf-texture-tiles`), merged to
`main` with the lag fix and released as **v0.7.1** (no schema change; notes in
`docs/releases/0.7.1.md`).

- Generated candidate textures with `scripts/parchment/generate.py` (numpy + Pillow, FFT
  noise, seamless tiles) and reviewed them on a mock of the app: vellum, laid paper,
  calfskin, aged folio; then weathering layers over calfskin. The user picked calfskin as
  the base, with weathering as settings.
- `.tex-canvas`, `.tex-sidebar`, `.tex-sheet` now use `assets/parchment/
  parchment-calfskin.webp` (282 KB) under the existing vignettes, in place of the SVG
  fibre tile. Each WebP is a translucent overlay, so the colour tokens are unchanged.
- Settings → Appearance → "Parchment weathering": burnt edges, coffee rings, water
  damage, folded in four, any combination, per machine (`lib/weathering.ts`, localStorage
  like the theme, `wx-*` classes on <html>). Off by default; a layer that is off is a
  `none` variable, so its image is never loaded.
- Paint bench, 0.7.0 AppImage: calfskin and all layers run at 17 ms on the normal path;
  with painting forced onto the CPU, calfskin costs +5.5 ms on the AppImage and nothing
  on system WebKit, all four layers +6 ms (AppImage) and +10 ms (system). Recorded in
  docs/rendering-performance.md.
- Biome, tsc, Vite build (bundles all five WebPs) and 292 Vitest tests pass.
- Not yet verified: the look in the real app (the review used a mock), and on Windows
  and macOS. Possible tweak: the window-sized layers stretch on unusual aspect ratios.

### Lag on Linux: parchment texture repaints (2026-11-06)

- Profiled the running 0.7.0 AppImage on the Arch laptop (Iris Xe, KWin Wayland, 15 GB
  RAM). Not the machine and not the data: 27 tasks, 6.6 GB free, 0% CPU at idle. Of the
  web process's CPU time, ~75% was `SkiaCPUWorker` threads (software rasterization) and
  ~11% the JS/layout thread. Typing saves on blur, so keystrokes never reach the core.
- A/B in a WebKitGTK window (same page, 6 s of dragging a card and typing): the
  light-theme `repeating-linear-gradient` fibre (1px stripes) costs 276 ms per frame on
  the AppImage's bundled WebKitGTK 2.50.4 (Ubuntu 22.04 runner) whenever the background
  under a moving element repaints; 17 ms on Arch's WebKitGTK 2.54.2. The common
  `WEBKIT_DISABLE_DMABUF_RENDERER` / `WEBKIT_DISABLE_COMPOSITING_MODE` workarounds make
  it ~4x worse (1.1 s per frame).
- Fix: the fibre in `.tex-canvas`, `.tex-sidebar` and `.tex-sheet` is now a tiny SVG
  tile (same periods and opacities; 35 px = lcm(5, 7)); dropped the no-op
  `background-attachment: fixed`. Bundled WebKit 2.50.4: 276 → 17 ms per frame, CPU
  raster 18.6 s → 0 per 6 s run. Biome, 290 frontend tests and the Vite build pass.
- Not yet verified: the look side by side in the real app, and the feel in a rebuilt
  AppImage. The CI-built AppImage stays slower than Arch's own WebKit in general (flat
  background: 39 ms vs 17 ms per frame); on Arch, a native build is the faster runtime.
- Guidelines for backgrounds and effects in `docs/rendering-performance.md` (pointer in
  CLAUDE.md), from a second round of measurements: PNG/WebP textures (full window,
  fixed or tiled), radial vignettes, blur and shadows on the CPU path. Benchmark tool in
  `scripts/paint-bench/run.sh` (system WebKit and an extracted AppImage).
- Packaging decided in ADR 018: AUR `task-master-bin` repackages the release .deb (its
  binary links only system libraries; checked against Arch with ldd). `packaging/aur/
  PKGBUILD` built locally with makepkg from the 0.7.0 .deb. The `aur` job in release.yml
  sets the version and checksum, builds, installs and ldd-checks the package in an Arch
  container, and pushes to the AUR when `AUR_SSH_PRIVATE_KEY` is set. The package installs
  `/usr/share/task-master/managed-by`; `ConfigView.managed_by` carries it and the update
  store then stays off ("managed" status in Settings → About). Rust test for the marker,
  two updater store tests.
- Not yet verified: the `aur` job on GitHub (no Docker daemon here to run its container).
- **Pending: AUR registration is closed** (2026-11-06). The job lives in `aur.yml`
  (called by release.yml, also `workflow_dispatch` with a tag) and fails on purpose at
  "Publish to the AUR" while `AUR_SSH_PRIVATE_KEY` is missing; release runs show red
  until then, with the release itself unaffected. When registration reopens: account, key,
  secret, then `gh workflow run aur.yml -f tag=v<latest>` and restore the AUR mention in
  the release body (docs/release.md, setup step 4). First AUR version: 0.7.1 or later
  (0.7.0 binaries do not read the marker).

### Agent status moves as a software rule (2026-11-07)

- Settings → Agents: "When sent" and "When done" status pickers (defaults In progress and
  Review), stored per device in the agent settings. `core::AgentWorkflow` holds the rule;
  ADR 017 amended.
- The app moves the task to the "sent" status when a session or follow-up starts, and to
  the "done" status when a headless run ends `done` (even without `complete_session`).
  `complete_session` in the MCP server uses the picked status (`--done-status`).
- Tests: `crates/core/tests/agent_workflow.rs`, an MCP test for a picked status, an
  `mcp_config` args check, a Settings test. Clippy, cargo test, Biome on the changed files
  pass. `pnpm test` has 1 failure from the parallel Model-selector work
  (`agents.test.tsx` expects no `model` field); Biome flags `Sidebar.tsx` (also not
  part of this change).
- Not yet verified in the real app. A terminal session keeps the `mcp.json` written when
  it started, so a status picked later applies from its next headless run.

### Full task title visible on Linux (2026-11-07)

- The task title textarea relied on `field-sizing: content`, which WebKitGTK ignores, so
  long titles were cut off at 1 row (page) or 2 rows (panel). `TitleField` now sets its
  height from `scrollHeight` on mount, input, width change and font load.
- Not run in this session (no approval for commands): Biome, TypeScript, `pnpm test`.

### Release 0.7.0 integration (2026-11-06)

- Kept the M16 merge already on `main` and integrated the subsequent agent/session,
  Review status, settings, board, sidebar and icon changes for the client and server.
- Updated the Settings integration tests to navigate to Shortcuts and Workflow after
  the categories redesign; fixed the outstanding frontend formatting issues.
- Bumped workspace crates, desktop metadata and lockfile to 0.7.0; added release notes
  and updated the release workflow body with the schema 11 coordinated-upgrade notice.
- Passed rustfmt, Clippy with warnings denied, all 196 Rust tests (3 opt-in tests
  ignored), Biome, TypeScript, and all 290 frontend tests (2 skipped). The Rust network
  tests run outside the sandbox because they bind loopback listeners.
- Built the Linux 0.7.0 DEB with the release MCP sidecar via the same Tauri configuration
  as CI. Cross-platform installers and signed updater metadata are built by the tag
  workflow; the same tag publishes the versioned server container and `latest`.

### Watch a running session in a terminal (2026-11-06)

- Open in terminal on a running follow-up showed only the user's message: `claude
  --resume` loads the saved conversation and cannot join a run in progress. Each run now
  writes `agents/<id>/run.log` (readable: Claude's text, tool uses, denials, the end), and
  the button reads **Watch in terminal** while running: a read-only window following the
  log, closing 15 s after `=== Run ended`. Native Windows: refused (no POSIX shell).
- Tests: the log rendering of the recorded run, the watch script run by `sh` on a growing
  log, the terminal commands (Linux, WSL, none on native Windows), the button label.
- Note: the agent sessions sent from the dev app edited this working tree (app icons,
  TaskRow, BoardView, CaptureBox, SettingsPage, …); two `app.test.tsx` tests fail on its
  SettingsPage changes and Biome flags its formatting. Not part of this change.

### Spawned sessions are not sub-sessions (2026-11-06)

- An app started from inside a Claude Code session (the dev build run by an agent, or a
  terminal running Claude Code) inherited its `CLAUDECODE`/`CLAUDE_CODE_*` markers, so
  spawned `claude` ran as that session's child: transcript saving off (breaking
  `--resume`) and its id and messaging socket passed to our agents. `agents::process`
  now removes those markers (`INHERITED_SESSION_VARS`) from every child; the user's own
  configuration passes through. Unit test on the spawned command's environment.

### Review status for finished agent work (2026-11-06)

- Migration 0011 seeds **Review** (fixed id `…0007`, `in_progress`, between Waiting and
  Done) unless a live status named Review exists; `core::review_status` finds it.
- `complete_session` moves the user's session task to Review (not when it is closed or
  already there). `update_task` refuses done/cancelled for the user's tasks. The agent's
  rules, server instructions and tool description say so.
- Tests: the seed and the skip next to a user's own Review (db), the move and the
  closed-task case, the refusal (MCP); store tests renamed their "Review" status to QA.
- Verified: Clippy, rustfmt, 192 Rust tests, bindings unchanged, TypeScript, Biome and
  287 frontend tests. Schema version 11: the sync server must be upgraded with desktops.

### No loose terminal sessions (2026-11-06)

- A terminal opened on a session writes claude's pid (`agents/<id>/terminal.pid`, by the
  shell before `exec`; WSL through `sh -c`). A watcher thread per session ends it when
  claude goes away, and once the session is done (agent summary, Mark done) or removed,
  stops claude after an 8 s grace (SIGTERM, then SIGKILL), which closes the terminal.
  The pid must still run a command line with the Claude session id. Start-up re-watches
  `terminal` sessions; a second terminal on a session still open is refused. Native
  Windows (no shell around claude) records no pid and is not closed.
- Tests: the watcher's decision table, the pid-recording scripts and probe/kill commands
  (native, WSL, Windows console), and a real process on Unix started through the
  terminal script, recognised by its id and stopped by `close_terminal`.
- Verified: Clippy, rustfmt, 189 Rust tests, Biome, the agent UI tests. Hand check in
  the app pending.

### Medieval icon set (2026-11-06)

- `assets/icons/paths.json` now holds 22 medieval icons in the style of the cross `add`:
  letter (inbox), castle (projects), hourglass (due), anvil (settings), lantern (search),
  brazier (delete), great helm (agents), almanac (calendar), scroll (all tasks),
  chest / open chest (archive / unarchive), pennant (priority), gonfalon (saved views),
  quill (edit), scales (metrics), oak (lineage), arrow (send), candle (estimate),
  wax seal (done), crown and shield (new epic marks). `components/TaskIcons.tsx` exports
  each; call sites import them under the lucide name they replaced. Labelled icons get
  a `<title>` and `role="img"`.
- `scripts/generate-ui-icons.mjs` lays out the proof sheet for any number of icons.
  Chevrons, close, check, grip and more stay lucide for legibility.

### Medieval icons, batch 1: shell and agents (2026-11-07)

- New in `paths.json`: `play` (bow), `terminal` (grimoire), `more` (rivets), `list` (ledger),
  `columns` (banners), `filter` (sieve), `options` (lever), `update` (raven), `folder-open` /
  `folder-clear` (chests); `Hash` now uses the `tag` icon. Call sites import them under the
  lucide name they replaced. Still lucide on purpose: sidebar panel toggle, chevrons, grip.
- Later batches: attachments and task detail (paperclip, download, file, external link,
  rename, expand, undo/refresh/spinner), calendar and board, lineage tools, arrows,
  epic marks, X and check.

### Medieval icons, batch 2: everything else (2026-11-07)

- 30 more glyphs in `paths.json` (see the README table): attach/download/file/file-text,
  external (cog), rename, expand, undo (used for reset and restart too), refresh (mill wheel)
  and spinner (six-spoke wheel, rotation-symmetric for `animate-spin`), calendar-plus,
  map-pin, list-checks, child, branch, grid, pointer, minus, fletched arrows, double
  spearheads, six heraldic epic marks, close (crossed swords) and check (a plain tick).
- The parent link in the task header used `ArrowUpRight` rotated -90deg; it now uses the
  right arrow rotated to point up.
- Still lucide on purpose: chevrons, sidebar panel toggle, drag grip, and `Square` (stop
  buttons) and `ImageOff` (broken image), which were not in the review.

### M16 fixes from the first hand check (2026-11-06)

- Open in terminal on Linux: detects an installed terminal (`x-terminal-emulator`, kitty,
  alacritty, wezterm, ghostty, foot, konsole, gnome-terminal, xfce4-terminal, xterm),
  each with its "run" flag; `$TERMINAL` uses the same table. Arch has no
  `x-terminal-emulator`.
- New session state `terminal` ("In terminal"): an ended session opened in a terminal.
  The terminal gets the session's MCP config. It ends when the agent calls
  `complete_session`, when a followable terminal (≥ 3 s) exits, or with **Mark done**.
  `running` and `terminal` are "active" (`SessionState::is_active`) for `ended_at`,
  removal, the brief and the activity feed. No migration (`state` has no CHECK).
- `complete_session` marks a non-running session done: a run that outlived the app (dev
  restart) had left "Interrupted" with a "Done" summary.
- **Resume** on interrupted sessions sends a pick-up-where-you-left-off follow-up.
- Tests: core (terminal lifecycle), MCP (ending non-running sessions), launch (resume
  args with MCP config, terminal detection), UI (Resume, In terminal, Mark done).

### M16 step 5: sidecar packaging and docs (2026-11-06)

- `src-tauri/tauri.sidecar.conf.json`: `externalBin: binaries/task-master-mcp`, and a
  `beforeBuildCommand` that also runs `scripts/sidecar.mjs` (builds `taskmaster-mcp` for
  `TAURI_ENV_TARGET_TRIPLE`, release unless `TAURI_ENV_DEBUG`, copies it to
  `binaries/task-master-mcp-<triple>`, gitignored). Kept out of `tauri.conf.json`:
  tauri-build fails any desktop build whose `externalBin` file is missing, which would
  break plain `cargo clippy`/`test` and `tauri dev`. CI's deb build and release.yml pass
  it with a second `--config`.
- `docs/agents.md`: setup, sending, permission modes, follow-ups, agent tasks, how it
  works, troubleshooting, development. ADR 017 records the packaging.
- Verified: a local `tauri build --bundles deb` with the config installs
  `/usr/bin/task-master-mcp` next to `/usr/bin/taskmaster-desktop` (where the app looks);
  the bundled binary runs. Clippy passes without the sidecar file present. Windows
  (`.exe` suffix, WSL interop path) and the macOS cross targets are only exercised by
  release.yml.

### M16 step 4: the UI (2026-11-06)

- `features/agents/`: Send to Claude dialog (folder prefilled from the task's last
  session, the project's or area's folder on this device, then the latest; picker and
  recents; permission mode with a confirmation for "Everything"; instructions; brief
  preview), session chip on board cards and list rows, Sessions panel on the task (state,
  duration, cost, turns, summary, notes, error; Open in terminal, Stop, follow-up, remove),
  `/agents` page (running, recent, agent tasks grouped under the user's task they serve,
  "Make it mine"), project folder button on the project page, Settings → Agents.
- Views: `show_agent_tasks` (default off) in the view options; agent subtasks count under
  their parent and carry a bot mark in the subtask list; sidebar counts skip agent tasks.
- Store: `agent_sessions` entities, `agentActivity` from the `AgentActivity` event and
  `agent_live` on connect, `record()` for sessions the shell wrote. Quitting with running
  sessions asks first.
- The Agents page caps its lists (50 ended sessions, 100 agent tasks) with a note when
  more exist, instead of virtualizing (ADR updated).
- Tests: `sessions.test.ts` (helpers), `store/agents.test.ts`, `agents.test.tsx` (start
  flow, bypass confirmation, follow-up and terminal, row chip, Agents page and adopt),
  `agentSettings.test.tsx`, a views test for the owner filter; `test/fakeAgents.ts` and an
  `agentSession` fixture. The BoardCard test now renders inside a `StoreProvider`.
- Verified: workspace Clippy (`-D warnings`), rustfmt, all Rust tests, TypeScript, Biome
  and 275 frontend tests. Not yet run by hand in the app.

### M16 step 3: spawning sessions from the desktop shell (2026-11-05)

- `src-tauri/src/agents/`: `launch.rs` (claude command for native and WSL through
  `wsl.exe --exec`, Windows → WSL paths, resume-in-terminal for Windows Terminal / cmd,
  macOS Terminal and Linux, `wsl -l -q` UTF-16 parsing, login-shell lookup of `claude`),
  `stream.rs` (stream-json → activity, denials, result; tested on a recorded 2.1.318
  run), `mod.rs` (runs, threads, outcome, IPC). Settings → `config.json` `agents`.
- IPC: `agent_start`, `agent_send`, `agent_cancel`, `agent_open_terminal`, `agent_live`,
  `agent_brief`, `agent_notes`, `agent_settings`, `set_agent_settings`, `detect_claude`,
  `list_wsl_distros`, `project_folders`, `set_project_folder`; event `AgentActivity`.
  Start-up marks old running sessions interrupted; exit marks live ones interrupted and
  kills them. CLAUDE.md's IPC list updated.
- Checked by hand with the installed Claude Code: `--append-system-prompt-file` works on a
  new session, `-p --resume <id>` continues it (and keeps its first system prompt).
- Tests: 14 unit tests, plus an opt-in real run (`cargo build -p taskmaster-mcp && cargo
  test -p taskmaster-desktop real_claude -- --ignored`): Claude Code (Haiku) added a note,
  created and finished an agent subtask and recorded its summary through our MCP, live
  activity read "Noting: …", "Planning: Step one", and the outcome was recorded as done.
- Verified: workspace Clippy, rustfmt, 184 Rust tests (3 opt-in ignored), TypeScript,
  Biome and 259 frontend tests. Bindings regenerated (new commands, event and types).

### M16 step 2: MCP server (2026-11-05)

- New crate `crates/mcp` (`task-master-mcp --db <path> [--session <id>]`, rmcp 3.9, stdio)
  with `get_task`, `list_tasks`, `list_projects`, `search`, `create_task`, `update_task`,
  `add_note`, `complete_session`. Agent tasks are editable; the user's tasks only change
  status, and only within the session's task and its subtasks.
- Core: outside writes keep the undo history unless they touch a field undo would write
  back; write transactions are `BEGIN IMMEDIATE` so the desktop and an agent writing at
  the same moment wait instead of failing.
- Tests: 7 end-to-end MCP tests (rmcp client over an in-memory pipe), one core test with
  two stores on one file. Smoke: the real binary over stdio on a seeded database, and the
  installed Claude Code (2.1.318, Haiku, `--mcp-config`) connected and called
  `list_projects` with the right count.
- Verified: workspace Clippy (`-D warnings`), rustfmt, 170 Rust tests. No frontend changes.

### M16 step 1: agent sessions in the core (2026-11-05)

- Migration 0010: `tasks.owner` (`me | agent`), `agent_sessions`, `agent_notes`, and the
  device-local `project_folders`. Commands `CreateAgentSession`, `UpdateAgentSession`,
  `DeleteAgentSession`, `AddAgentNote`, `TaskChange::Owner`, `NewTask.owner`; only the
  session's own device may change it. `Store::execute_without_undo` keeps session
  bookkeeping out of Ctrl+Z; `interrupt_running_sessions` for start-up.
- Sessions in the snapshot and `Changes`; notes read per task; activity entries
  `agent_start`, `agent_end`, `agent_note`; export/import carry both tables.
- `Store::agent_brief(task)`: markdown context (task facts, project/area, epic, subtasks,
  prerequisites, dependents, attachments, earlier sessions, notes), two insta snapshots.
- Tests: `crates/core/tests/agents.rs` (13). Bindings regenerated; TS fixtures and test
  `Changes` literals gained the new fields, optimistic tasks are `owner: "me"`. The UI does
  not use sessions yet (step 4).
- Verified: full Rust suite, workspace Clippy (all targets, `-D warnings`), rustfmt,
  TypeScript, Biome and all 259 frontend tests pass.

### Source handoff checkpoint (2026-11-06)

- Included all pending main-worktree changes and integrated the remote 0.6.0 release
  commit. Other registered worktrees are clean, and their commits are already on remotes.
- Validation: 269 frontend tests, frontend production build, Biome, full workspace Rust
  tests and all-target Clippy passed. Native desktop interaction checks remain manual.

### Public Google OAuth pages (2026-11-06)

- Added static `site/` homepage, privacy policy and terms, shared responsive light/dark
  styling and the existing 128px app icon. Privacy disclosures match the current
  Calendar scopes, local storage, optional server credentials/cache, backups, revocation
  and retained copies; contact uses the maintainer's GitHub profile and project issues.
- Added a GitHub Pages workflow that uploads only `site/` from the public mirror's
  main branch. Documented enabling Pages, exact Branding URLs/domain and formal
  domain-verification limitations in `docs/github-pages.md`; corrected Calendar setup.
- Verified 3 pages and 38 local links/assets/anchors, workflow YAML/permissions/artifact
  path, icon size, desktop/mobile Chrome rendering, Biome and diff checks. Publication
  uses the new Pages workflow after Pages is enabled in the GitHub repository.

### Freeform Lineage canvas (2026-11-05)

- Tasks now move freely on a dotted canvas, with background dragging/scrolling to pan,
  cursor-centered Ctrl/Command + scroll zoom, Fit view and Auto arrange. Local card
  positions and the view are remembered on this machine; links follow moved cards.
- Drag from either connector to another task to create a dependency. Live curves snap
  to targets with valid/invalid highlights. Circular/self/duplicate links are rejected;
  empty drops, pointer cancellation and Escape leave task data untouched. Connections
  use the existing optimistic command path and failed saves roll back.
- The dependency inspector opens on selection; click-to-connect and searchable lists
  remain available for keyboard users. Alt + arrow keys nudge cards. Filters clear
  hidden selections/connections and fit the visible graph; offscreen cards/edges are culled.
- Checked real mouse selection, card dragging, persisted positions, creating/rejecting
  connections, pan/zoom, both themes and smaller windows in headless Chrome. Native
  desktop pointer feel remains a manual check.
- Verified: 269 frontend tests passed; TypeScript, Biome, the production build and
  diff checks passed. No new dependencies or backend changes.

### Responsive sidebar shortcuts (2026-11-05)

- Inbox, Today, Calendar and All tasks form a square 2×2 grid of tiles in the wide
  sidebar, with icons, counts and active states. They switch to a single-column list
  when its content is narrower than 216px. Lineage and Metrics stay below the group.
- The expanded sidebar adapts between 208px and 264px with the window width; the
  Windows title bar uses the same width. Manual collapse keeps the existing 60px rail.
- Visually checked both themes at 1440px and 1000px window widths, navigation and
  the collapsed rail in headless Chrome.
- Verified: 260 frontend tests, TypeScript, Biome and the production build passed.

### Calendar picker and menu consistency (2026-11-05)

- Replaced native date popups with a shared themed calendar on task pages, side
  panels, list rows and epic target dates. Includes quick choices, clearing, validated
  typed dates and keyboard navigation. Constrains height to the available window space.
- Matched the tag picker to shared menu/input colors, spacing, selected states and
  focus styling; migrated Lineage's two native dropdowns to the shared Select. Select
  menus now bound their height, offer scroll controls and mark the current choice.
- Escape dismisses an open calendar/menu before the app closes the task side panel.
- Checked calendar, priority and tag popups in headless Chrome in light/dark themes
  and calendar placement in a narrow window. Native WebView rendering remains manual.
- Verified: 260 frontend tests passed; TypeScript, Biome, the production build,
  the full Rust test suite and Clippy passed.

### Sync sign-in callback ports (2026-11-05)

- Sign-in failed on Windows with "port 47823 is used by another program" although nothing
  listened: WSL mirrored networking reserves its port range (here 44620-48715) on Windows.
  The desktop now tries ports 47823, 38823, 28823 and skips a busy port nobody answers on
  at once; a waiting sign-in on a port is still taken over. The provider must register all
  three redirect URIs (docs/server.md; homelab Authelia config needs the two new ones).
- Rust test covers skipping a reserved port.

### Release 0.6.0 (2026-11-05)

- Version 0.6.0 for the desktop and the sync server (one workspace version, one tag).
  Notes: docs/releases/0.6.0.md. Since 0.5.0: Lineage and task dependencies (migration
  0009), epic appearance (0008), Google Calendar deadlines as all-day "Due:" events
  (two-way), shared DatePicker, redesigned tag picker, All tasks search, delete from
  quick capture, sync sign-in takeover, and the GHCR server image (ADR 016).
- Homelab: bump `task-master` to v0.6.0 together with the desktops (schema 9).

### Sync sign-in retry (2026-11-05)

- A sign-in that finds the callback port 47823 busy now asks the waiting attempt (in this
  instance or another one) to stop, then takes over the port within 3 seconds. Another
  program holding the port gets a clear error. The browser wait no longer holds the sync
  round and Calendar locks, so syncing continues meanwhile. Settings → Sync shows
  **Start over** while waiting and ignores the replaced attempt's result.
- Rust tests cover the takeover and a foreign port holder. A UI test covers Start over.

### Server image on GHCR and homelab deploy (2026-11-05)

- Homelab PR #146 deployed the sync server stack. The first deploy failed: hosts pull
  anonymously and the KnowledgeSystem org is private. ADR 016 moves the image to
  `ghcr.io/alexanderjacquot/task-master-server`, built by
  `.github/workflows/server-image.yml`. The Forgejo workflow and `REGISTRY_TOKEN` are no
  longer used. server.md now documents the Authelia claims policy as well.

### Delete from expanded quick capture (2026-11-05)

- Added a visible Delete task button beside Done in the expanded global capture
  popup. It uses the existing soft-delete command and closes after deletion succeeds;
  a failed deletion keeps the editor open with an error and allows retrying.
- Done and Close keep the saved task. Regression tests cover deletion, failure/retry
  and both ways of closing without deletion.
- Verified: 251 frontend tests passed; TypeScript, Biome, the full Rust test suite
  and Clippy passed. Native popup appearance remains a manual check.

### Task dependency lineage (2026-11-05)

- Added Lineage to the expanded sidebar and collapsed rail. The graph shows task
  prerequisites flowing left to right through chains, branches and joins, with project
  and connected-task filters, zoom, scroll, selection and task-detail access.
- Select a task to add/search/remove prerequisites or dependents, or use “Connect on
  graph” and choose its dependent. Edits use the existing optimistic command path and
  undo/redo. Visible graph nodes and long relationship lists are virtualized.
- Migration 0009 adds dependency IDs to tasks; updates validate live endpoints and
  reject self-links and cycles atomically in core. Dependencies persist through
  export/import and sync; deleting a prerequisite preserves its link for undo/restore.
- Covered graph layout, editing, branches/joins, cycle prevention, failed-save rollback,
  core undo/redo, export/import and sync with automated tests. Full Rust suite, Clippy,
  TypeScript, Biome, all 247 frontend tests and the Vite production build pass. Native
  desktop visual and pointer checks remain manual.

### All tasks search row (2026-11-05)

- Split the All tasks creation row equally with a title/description search field and
  Search button on wide windows; stack the controls on smaller windows. Search filters
  list and board results through the existing core search, respects view filters, and
  clears back to all tasks. Added loading, empty and error states and stale-response guards.
- Interaction tests cover submission, clearing, board filtering, failures and stale responses.
- Verified: 243 frontend tests passed; TypeScript, Biome and diff checks passed.

### Sidebar description drop caps (2026-11-05)

- Applied the full task page’s rubric drop caps to rendered descriptions in the right
  sidebar, scaled to its existing text size. Editing still uses the plain markdown editor.

### Board resize handle visibility (2026-11-05)

- Gave column resize handles a persistent subtle rubric red accent, stronger on hover
  and keyboard focus, so the drag target is visible before interacting.

### Calendar date typography (2026-11-05)

- Slightly enlarged weekday labels and date numbers in day/week and month views;
  used the existing rubric red for weekdays and regular dates. Today keeps its filled
  accent highlight and dates outside the current month remain muted.

### Epic appearance (2026-11-05)

- Added persistent epic color and shape choices on the epic page, shown in the sidebar,
  page title, board cards and task epic selector. Default remains the violet diamond.
- Added migration 0008 and command fields with undo/redo and sync support; regenerated
  bindings. UI interaction and core roundtrip tests cover appearance updates.
- Verified: 240 frontend tests passed, full Rust test suite passed, TypeScript,
  Biome and Clippy passed.

### Complete v0.5.0 and server Calendar (2026-11-05)

- Merged `worktree-capture-expand` (three commits); every local and fetched remote
  branch is now an ancestor of main. All other registered worktrees were clean.
- Committed application artwork, asset generators and illustrated UI icons; fixed SVG
  titles in both source and generators. Ignore nested tooling worktrees in Git/Biome.
- Shared Google provider in `crates/client::google`; server worker, authenticated runner
  and cache endpoints, durable credentials/ownership, exclusive renewed device leases.
- Settings → Calendar switches This device / Server, transfers credentials, waits for
  in-flight rounds, relinks existing events and shows the server's status/calendars.
- Account changes serialize with Calendar; disconnecting task sync pauses Google locally.
- Regression tests: handoff in both directions without duplicate events; Google edits
  reaching a second desktop; shown server events; persistence/0600; authorization and
  secret-free status; denied lease blocks token requests; active round blocks handoff.
- Validation: 141 Rust tests and 239 UI tests; all-target Clippy, formatting, typecheck,
  Biome, frontend production build, server release build and Linux debug `.deb` pass.
- Configured Forgejo `REGISTRY_TOKEN` with a new package-write-only token; GitHub
  update signing secrets are present. v0.5.0 tagging and remote publication follow.
- Live Google sign-in still needs the user's OAuth account; regression tests use the
  real sync HTTP server and a deterministic fake Calendar provider.

### M13 desktop sync and v0.5.0 review (2026-11-05)

- Integrated M12/M13 with main, preserving the metrics dashboard changes.
- Desktop worker, Settings → Sync, merge/replace, OIDC sign-in, token auth, attachments.
- Fixed recovery when only a replica with received ops survives; account changes racing
  network rounds; silently skipped operations; local workflow columns surviving replace;
  missing auth/join information after restart; SSE subscription race.
- Added outside-writer detection with `PRAGMA data_version` and full UI reload events.
- Bumped workspace, desktop package and Tauri versions to 0.5.0; release notes in
  `docs/releases/0.5.0.md`. Server Calendar handoff remains unimplemented and is documented.
- Validation: 137 Rust tests and 231 UI tests pass (2 opt-in perf tests skipped in
  each suite); Clippy for all workspace targets, Rust format, Biome, TypeScript,
  frontend production build, server release build, and Linux debug `.deb` build pass.
  Generated bindings match M13. Docker image and Windows/macOS installers were not
  exercised locally; Docker Desktop is not connected to this WSL distro.
- Release workflow now requires the reusable CI checks before publishing installers.
  Pending release scope: whether to ship device sync now with Calendar on one desktop,
  or implement the server Calendar runner before tagging.

### M12 Sync server (2026-11-05)

ADR 015 (implementation notes); setup `docs/server.md` (now matches the code).
- `crates/server` (`task-master-server`): axum. Routes `/health`, `/info`, `/sync/push`
  (schema check, 409 on mismatch), `/sync/pull` (pages of up to 1000), `/events` (SSE
  heads, keep-alive, ends on shutdown), `/blobs/{hash}` (HEAD/GET/PUT, hash checked, 50 MB),
  `/auth/oidc`. Auth modes none/token/oidc; scopes sync, api:read, api:write. Config from
  `TM_*`. Hourly backup thread: daily copy in `/data/backups`, upload of the copy and
  attachment content to S3 once each (`uploaded.txt`). CLI `serve`, `health`,
  `token add|list|revoke`, `version`. Graceful stop on SIGTERM.
- `crates/client` (`taskmaster_client`): `Client` and `sync()` (see the ADR).
- Core: wire types; `Store::last_seq`, `schema_version`, `clear_for_replace` (M13 join),
  `restart_sync`.
- `crates/server/Dockerfile` (distroless), `.dockerignore` additions,
  `.forgejo/workflows/server-image.yml` (homelab runner, `REGISTRY_TOKEN`).
- Tests: server 13 integration (two devices through the server, paging, attachments,
  tokens and scopes, schema refusal, events, clock offset, OIDC against a fake provider
  with refusals for audience/expiry/group/issuer/signature, lost-server refill, backups
  with a fake S3) + 5 unit; core +1 (replace). Found and fixed while testing: a fake S3
  that answered before reading the body broke the upload pipe (test fake only).
  Smoke run of the binary: token add/list, `/info`, 401 without a token, `health`, exit 0
  on SIGTERM. The Docker build itself is not run here (no Docker in this WSL); the locked
  release build of the package is (10 MB).
- New dependencies (server only, agreed in ADR 015): axum 0.8.9, tokio 1.54,
  jsonwebtoken 11.1 (rust_crypto), futures-util (already in the tree).
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

- Lineage: drag a task from the side panel onto the canvas (left/right half of a card =
  prerequisite/dependent). Left out for now: HTML5 drag and drop is unreliable in the
  Windows webview while Tauri's file drop is on; the panel's link chips cover it.

- Lineage: a "Ready (not blocked)" filter for list and board views needs a new
  `ViewFilter` field in core (spec, bindings); only the Lineage canvas has it so far.
- Sync: op compaction together with the 30-day purge. Device sync, outside-writer
  reload, server Calendar and its runner handoff are implemented.

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

- Send to agent: a Model selector (Default/Opus/Sonnet/Haiku). Stored per session
  (`agent_sessions.model`, migration 0012) so follow-ups reuse it. Not yet run: cargo/pnpm checks.

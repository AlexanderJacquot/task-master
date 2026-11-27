# ADR 006: Quick capture, parser, command palette

Date: 2026-11-04 · Status: accepted

## Context

M5 makes capture fast: a global hotkey and window, an inline syntax, a command palette,
shortcuts, full-text search in the UI, and "Plan my day". The plan puts the parser in the
core (`parse`) so the CLI and MCP read lines the same way, with `insta` snapshot tests.

## Decisions

**Dependencies (approved).** `tauri-plugin-global-shortcut` 2.4.1 (the 3.0 alphas target
Tauri 3) in the shell, Rust side only; `insta` 1.49 (yaml) as a core dev-dependency.

**Parser.** `core::parse(text, today)` is pure: `#tag`, `@Project` / `@"Two words"`,
`+epic:Name`, `!urgent|high|normal|low` (and `u h n l`, `1`..`4`), `^today ^tomorrow
^mon..^sun ^+3d ^+2w ^YYYY-MM-DD ^MM-DD`. Markers only count as whole words; anything
unreadable stays in the title with a warning (`bob@example.com`, `C#` are left alone).
Last marker wins for single-valued fields. Weekdays mean the next one, today included;
`^MM-DD` rolls to next year once passed. Date math is local (no date crate).
`resolve` matches names: tags exactly (case-insensitive); projects (non-archived) and
epics exactly, else by unique prefix, else by unique whole word (`+epic:IaC`).

**IPC.** One read-only command, `parse_capture(text, today)`, like `task_activity`.
Saving still goes through `execute`: the UI turns a `Capture` into `create_tag` /
`create_project` / `create_epic` + `create_task` in one undoable batch, with client ids
and optimistic entities. An unknown project or epic needs a second Enter (the plan's
"unknown projects prompt"); unknown tags are created silently.

**One capture box.** `CaptureBox` replaces the plain input on every view (markers win
over the view's defaults) and is the whole UI of the capture window.

**Capture window.** A second window `capture` (640×180, undecorated, always on top,
hidden, skip taskbar) loads the same page; `main.tsx` renders only `CaptureWindow` when
the window label is `capture`. The hotkey (`Ctrl+Shift+Space`) shows, centers and
focuses it and emits `capture-opened` to reset it. It hides on Escape, after saving and
on blur. It has its own store; writes reach the main window as foreign change events.
Registration failure (Wayland, policy) is logged, not fatal; `n` still works in the app.

**Palette.** `Ctrl+K` (also inside text fields) opens a Radix Dialog. Actions, built-in
and saved views, projects, epics and tags are ranked locally (`lib/palette.ts`: word
starts, keywords, inner text of 3+ letters); tasks come from the core's FTS `search`
over titles and descriptions, debounced, in the core's order. This is the search UI.

**Shortcuts.** `g i / g t / g a` navigation and a `?` overlay listing every shortcut,
alongside `n`, undo/redo and Escape.

**Plan my day.** `lib/planDay.ts` suggests up to 9 open tasks not picked for today:
overdue, due within 3 days, urgent/high, or in progress, most pressing first, with
reasons. Shown on the Today view (`?plan=1`, from the header or the palette); `1`–`9`
or the button sets `today_on`.

## Consequences

- On Linux the hotkey needs X11; under WSLg it only fires while a WSLg window has focus.
  "Under 3 s from any app" can be verified on a native Linux session or Windows.
- The parser is the contract for the future `tk add` and MCP capture; snapshot changes
  need review.

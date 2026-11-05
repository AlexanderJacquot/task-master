# ADR 008: Visual redesign, dark and parchment themes, full task page

Date: 2026-11-05 · Status: accepted

## Context

After the first Windows build the user found the UI "super ugly and very rudimentary" and
asked for a dark theme in the spirit of current Apple-style apps, a sidebar that is easier
to reach, and a dedicated task page with room to write. Their time goes to four flows:
working inside a project, jumping between projects, creating tasks, and writing in a task.
A clickable mockup (claude.ai canvas "task-master redesign") was agreed before coding,
including the user's choice of typefaces and a parchment light theme.

## Decisions

**Themes as variables.** Every color is a CSS variable (`--tm-*`) that each theme fills in
(`index.css`). Components use semantic Tailwind colors defined over them: `canvas`,
`sidebar`, `raised`, `overlay`, `ink`/`ink-2`/`ink-3`, `line`/`line-strong`, `hover`,
`selected`, `accent`/`accent-hover`/`accent-ink`, `danger`. To restyle the long tail of
older markup without rewriting it, the `neutral-*` scale is remapped to each theme's tones
and the `blue-*` scale (only ever used as the accent) to the accent ramp.

- **Dark** (default): near-black layers (#0e0e10 / #141416 / #1b1b1f), soft white ink,
  faint white borders, gold accent (#d9a54a).
- **Parchment** (the light theme, stored as `light`): warm vellum (#f3eada), brown-black
  ink (#2b2116), rubric red accent (#8b2e1f). Texture is CSS only (`tex-canvas`,
  `tex-sidebar`, `tex-sheet`: radial vignettes and faint repeating grain), no image.
- Headings (list groups, board columns, section labels, description headings) use
  `--tm-rubric`: rubric red on parchment, bright ink in the dark, as in the mockups.
  Priorities use `--tm-urgent` and `--tm-high`, tuned per theme (added 2026-11-05).
- "Follow the system" switches between the two. The `dark` class mechanism is unchanged.

**Typefaces (bundled, offline).** MedievalSharp for titles, section headers and primary
buttons (`font-display`); Source Serif 4 (variable, optical sizes) for everything else.
MedievalSharp is never used below ~13px. New dependencies, OFL licensed:
`@fontsource/medievalsharp` 5.3.0, `@fontsource-variable/source-serif-4` 5.3.0.

**Icons.** `lucide-react` 1.61.0 (ISC), tree-shaken, replaces text glyphs (▸ ✎ ☆ …).

**Navigation.** The sidebar leads with New task and Jump to (Ctrl+K), then Inbox, Today
and All tasks, then projects (the main body; hover shows + add task and ⋯ with rename,
color, archive, delete; right-click opens the same menu; double-click renames). Epics,
saved views and tags fold away (state remembered per machine). The sidebar collapses to a
rail of icons and project dots. Ctrl+1 to Ctrl+9 jump to the first nine projects.

**Creating tasks.** One `CaptureBox` with three looks: the dashed "Add a task" line above
each list, a New task dialog (sidebar button, Ctrl+N, `n` where there is no inline line;
it takes the current page's project, epic, tag or Today), and the quick-capture window.
Shift+Enter adds and opens the task's full page.

**Full task page.** Route `/task/$taskId`. The same editor as the side panel
(`TaskEditor`, variants `panel` and `page`): on the page, a large display-face title,
properties as pills (native selects inside, so keyboard and accessibility are unchanged),
a tall description editor at 17px, subtasks, and activity folded away. Open it from the
panel's Open button or Shift+Enter on a row; Escape goes back. The sidebar is a rail there.

**View header.** A large title (with the project's area above it), the task count, a
List/Board switch, and two menus: Display (group, sort, swimlanes, subtasks, cancelled,
Save as view) and Filter (shows the filter bar; it also shows whenever a filter is set).

## Consequences

- Colors are themable in one place; a third theme is a block of variables.
- The `neutral`/`blue` remap is a bridge: new markup should use the semantic names.
- Drop caps from the mockup are left out: CodeMirror measures lines, and a floated first
  letter would break cursor placement. Noted under Later.
- Serif body text at list density is a deliberate choice of the user; a sans option can
  be added later as one variable (`--font-sans`).

# ADR 034: Roadmap images, drawn by the core

Date: 2026-11-21 · Status: proposed (implemented on branch `roadmap-export-image`)

## Context

The Roadmap (ADR 031) is a page to plan on; people also want to show it: in a document, a
chat, a status update. A screenshot only holds the part that is scrolled into view, and
drags in the empty rows kept for scheduling. The backlog also has a server endpoint that
renders a roadmap image for integrations, which should draw the same picture without a
browser.

## Decisions

**One renderer, in the core.** `taskmaster_core::render_roadmap(&RoadmapImage)` returns an
SVG (text, width, height). It is a pure function with no dependency: the core's date
arithmetic, a character-width table to place text, fixed palettes. The desktop asks for it
over a read-only IPC command, `roadmap_svg`; the sync server can call the same function
for its endpoint.

**The image's input is what the page shows, not the data.** `RoadmapImage` holds the rows
the page has worked out (ADR 031 keeps bars, starts and grouping in `features/roadmap/`):
groups with their span and count, epics or tasks with their bar, depth, done, progress and
color, the dependency links, the target date, the timescale and today. The renderer works
out the rest: the range, the scale, the arrows and what is flagged (late links, overdue
bars, bars past the target date), as the page does. A server endpoint will need the
roadmap's rows built from its own copy of the data; that logic is the page's today.

**Only what is on the timeline.** Epics without a target date, tasks without a due date,
and groups with none of them are left out, so the image is all bars. The page builds the
image's rows from its scheduled items only, so group counts and spans are theirs. Folded
groups stay folded (their header and span bar).

**The whole timeline, and only it.** The range covers the bars and the target date, with
16 px of room on each side, reaching out to the whole week, month or quarter when that adds
at most 72 px, and at least 480 px wide. Today is drawn (a line, tagged on the scale) when
it falls inside, but does not stretch the range: a plan for next quarter is not padded
back to today. A label too long for its bar goes beside it, and the range grows to hold it.

**Themes are the app's.** Light (parchment), dark and clean, as fixed colors (no CSS
variables, no `rgb(… / a)`: hex colors with opacity attributes, which every SVG viewer
reads). The page passes the theme it is shown in.

**PNG and the clipboard in the webview.** The UI rasterizes the SVG on a canvas at twice
the size (less when the canvas would pass 16,384 px a side or 64 Mpx) and copies it with
`navigator.clipboard.write`, giving `ClipboardItem` a promise so WebKit keeps the click's
permission while the core draws. Saving goes through the save dialog and `save_image`
(the path's `.png` or `.svg` decides; PNG bytes arrive base64; 64 MB at most). No new
dependency: no rasterizer or clipboard crate in the shell.

**Text is not measured.** The image names Inter, then the system's sans-serif; a viewer
uses what it has (a PNG drawn in the webview cannot load the app's web font). Labels are
placed with a generous width estimate, so they fit in any common sans-serif.

## Consequences

- "Export image" in the Roadmap's header (both levels, saved roadmap views too): Copy as
  PNG, Save as PNG…, Save as SVG…. Off while nothing is scheduled.
- The IPC surface gains `roadmap_svg` (a read, like `parse_capture`) and `save_image`.
- The server endpoint (backlog) calls `render_roadmap`; for PNG it will need a rasterizer
  (e.g. `resvg`) and fonts in its image, its own decision.
- Where the clipboard does not take images (some Linux WebKitGTK versions), Copy reports it
  and saving still works.
- Month and weekday names in the image are English, whatever the system's locale.

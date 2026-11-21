# ADR 035: Roadmap images from the sync server

Date: 2026-11-21 · Status: proposed (SVG implemented on branch `roadmap-server-image`;
PNG and share links are proposals below, not built)

## Context

ADR 034 put the roadmap image's renderer in the core (`render_roadmap`), but its input,
the rows the Roadmap page shows, was still worked out by the page in TypeScript (ADR 031:
which epics or tasks, their bars, groups, folds, links). Integrations want the same
picture without a desktop: a status page, a wiki, a chat bot posting the plan each week.
The sync server already holds a full replica of the data (ADR 015).

## Decisions

**The roadmap's model moves to the core too, as a port.** `taskmaster_core::roadmap_image(
RoadmapData, &ViewSpec, &RoadmapOptions) -> RoadmapImage` (`crates/core/src/roadmap.rs`;
`Store::roadmap_image` reads the live data itself) builds what the page builds: on the
roadmap of epics the projects filter (an epic without a home project shows with the
projects of its tasks), active or all epics, grouping by project and folds; on an epic's
timeline the tags, completion (open, all, ready) and subtasks filters. Agents' own tasks
stay out. Bars as ADR 031: the spec's start, else the task's estimate in working days at
8 hours a day (at least one), else for an epic its earliest task's start, else 10 working
days before its target date; a start after the end is pulled back to it. Only bars go in
the image (ADR 034). The title, subtitle ("Epics across projects · 5 epics · Nov 21,
2026"), name column, deadline, timescale and theme are the page's.

The page keeps its TypeScript: it computes the same model on every drag, from its draft
filters, and the IPC round trip would buy nothing. The TypeScript moved into pure functions
(`features/roadmap/model.ts`: `roadmapItems`, `roadmapImage`, `imageFromSpec`) so both
sides can be checked against **one fixture**, `crates/core/test-vectors/roadmap.json`
(like `rank.json`): a data set and eleven specs with the image model each must produce,
read by `roadmap.rs`'s tests and `model.test.ts`. The fixture's specs are built by the
page's own `roadmapSpec`, and its `defaults` are the plain page's (`DEFAULT_FILTER`), which
the core has as `default_roadmap_spec(epic)`. A change to either side that the other does
not make fails a test.

Two fixes on the way, so the sides could agree exactly:

- The Roadmap sorted ranks, ids and group keys with `localeCompare`, which puts `Zz` after
  `a1`; ranks are base-62 keys meant to sort by code unit, as the rest of the app and the
  core do. It now uses `compareStrings` (exported from `lib/views.ts`).
- On an epic's timeline, "Ready" counted a done prerequisite that is an agent's task as
  open (the closed set was built without agents' tasks). It is now built from every task.

**Starts the server cannot see.** The plain (unsaved) Roadmap keeps where bars start in
the desktop's local storage (ADR 031); it never syncs. The server honours starts kept in a
saved roadmap view only; a roadmap asked for by query parameters uses the default starts,
so it can differ from what a desktop shows for the same filters. Save the roadmap as a
view to publish the plan as drawn.

**`GET /roadmap.svg`.** Either a saved view (`view=<id>`: its filters, timescale, starts
and folds; its name is the heading) or the plain roadmap's filters: `epic`, `projects`
and `group` (epics), `tags` and `subtasks` (an epic's tasks), `completion`. With either:
`zoom`, `theme` (`clean` by default, as an image for documents; `light`, `dark`) and
`today` (the server's UTC date by default, since it does not know the reader's time
zone). Ids are comma-separated; `none` stands for no project or no tag. Mixing a view with
filters, filters of the other level, an unknown parameter or value, or a roadmap with
nothing scheduled is `400`; an unknown view or epic `404`. The answer is
`image/svg+xml; charset=utf-8` with `Cache-Control: private, no-store`, `nosniff` and a CSP
that lets the image load and run nothing when opened on its own.

**Who may read it.** The same bearer tokens as the rest of the server (ADR 015): an
`api:read` or `api:write` token (the integrations' scopes, which nothing else served until
now) or a `sync` token (a desktop). On a server with `TM_AUTH=none` it is open, like
everything else there. The route sits outside the device-only group and checks the token
itself.

## Proposals (not built; for a decision)

**PNG (`GET /roadmap.png`).** Chat apps and many wikis take PNG, not SVG. The server image
is a static binary with no system fonts, so it needs a rasterizer and a font of its own:

- `resvg` (with `usvg` and `tiny-skia`; pure Rust, no C toolchain, which keeps the
  image's build as it is; licenses to check when adding, last known Apache-2.0 OR MIT,
  tiny-skia BSD-3-Clause) in `crates/server` only, so the desktop does not grow. Its font
  database loads only the bundled font, never the system's.
- Inter (SIL Open Font License 1.1) regular, medium and semibold, the weights the image
  uses, about 1 MB of TTF embedded with `include_bytes!` (or one variable font). The SVG
  already names Inter first, so the PNG would look as the app does.
- Twice the size by default (`scale=1..3`), capped as the desktop caps it (16,384 px a
  side, 64 Mpx), with `Content-Type: image/png`.

Cost: a few hundred KB of code and the font in the binary, a new dependency tree to keep
updated. Adding it needs a yes first (CLAUDE.md); then this ADR is amended.

**Share links (a per-view read-only token).** An `<img>` tag, a wiki embed or a chat
unfurl cannot send an `Authorization` header, so a bearer token does not help them. A
share token would be minted for one roadmap view (`task-master-server share add <view>`,
or later from the desktop), stored hashed beside the API tokens, and accepted as
`/roadmap.svg?share=<token>` for that view's image only: no other view, no data, no
filters but `zoom`, `theme` and `today`. Revocable, and listed with when it was last used.
The risk is the URL itself: it leaks through logs, referrers and forwarded links, and
whoever has it sees that roadmap's names and dates until it is revoked. Not built.

## Consequences

- The core gains `roadmap_image`, `default_roadmap_spec`, `RoadmapData`, `RoadmapOptions`
  and `Store::roadmap_image`; no schema change, no new dependency.
- The sync server gains `GET /roadmap.svg` (docs/server.md, "Roadmap images").
- Two implementations of the roadmap's model must stay in step; the shared fixture is the
  guard, and a new filter or rule needs a case there.
- Month names and the date in the subtitle are English on the server; the desktop's
  subtitle follows the system's locale.

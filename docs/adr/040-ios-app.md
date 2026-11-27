# ADR 040: iPhone app

Date: 2026-11-10 · Status: accepted. Plan and milestones: `docs/ios-plan.md`.

## Context

The user wants task-master on the phone as a native app that uses what iOS offers
(widgets, Shortcuts, share sheet, notifications), is fluid, and shares the backend of the
desktops. `docs/plan.md` section 7 foresaw a responsive layout shipped as a Tauri mobile
build or a PWA. Development starts with no Mac and no Apple developer account.

## Decisions

**A SwiftUI app over the Rust core.** The phone embeds `taskmaster-core` with its own
SQLite file and is one more replica of ADR 015: local-first, syncing `ops` with the same
server through `crates/client`. No new backend and no second data model.

**`crates/mobile` is the only FFI surface, generated with UniFFI.** New dependency
(`uniffi`, added in P1, version pinned). The crate alone lifts the workspace's
`unsafe_code = "forbid"`, for the generated scaffolding only. It exposes one `App` object:
commands, undo, search, capture parsing, sync, a change callback, and screen queries.

**Screen queries live in Rust.** The phone asks the core for rows ready to draw (a view,
a board, Today, a task) instead of holding a normalized store and evaluating views in
Swift. View evaluation (`ViewSpec` to rows) therefore moves into `crates/core`; the
desktop keeps its TypeScript evaluation for now, and shared JSON vectors in
`crates/core/test-vectors` keep the two in agreement.

**The sync schedule leaves the Tauri shell.** The worker loop of
`src-tauri/src/server_sync.rs` becomes a shell-agnostic engine in `crates/client`, used by
the desktop and the phone. What differs per shell (account storage, status events,
opening a sign-in page) sits behind a trait.

**Swift is split in two.** `TaskMasterKit` (a Swift package without SwiftUI: screen
models over the bindings) builds and tests on Linux. The app target holds SwiftUI views
only. The Xcode project is generated from a checked-in spec (XcodeGen) and never edited.

**iOS 26 and later.** System-native look in light and dark; the textured themes are not
ported for now.

**Built in CI.** `.github/workflows/ios.yml` on a macOS runner builds for the simulator,
runs tests, publishes screenshots and flow videos. Signing and TestFlight are added when
the developer account exists; the App Store is the final target.

**Not on the phone:** starting agent sessions, the Lineage canvas, Metrics, backup
settings, the calendar sync runner (the server or a desktop keeps that role).

## Rejected

- **Tauri 2 mobile with the React UI**: a web view; widgets, intents and the share
  extension would need native code anyway, and scrolling and gestures would not feel native.
- **PWA served by the sync server**: no offline database, no system integration.
- **A Swift reimplementation talking to `/api/v1`**: a second copy of the merge and
  command logic, and no offline use.
- **A Swift normalized store mirroring the desktop's**: view logic written a third time,
  and none of it testable on Linux.
- **`swift-bridge` or a hand-written C ABI**: more manual work than UniFFI. A C ABI
  carrying JSON remains the fallback if UniFFI fails with the workspace's toolchain.
- **xtool or a rented Mac for now**: deferred by the user.

## Consequences

- View logic exists in Rust and TypeScript until the desktop moves to the core queries.
- Motion and gesture quality stay unverified until the app runs on a device.
- The schema lockstep of ADR 015 does not survive App Store review delays: before the
  store release the server must accept the previous schema version (plan, P8).
- The AGPL (ADR 020) and the App Store: fine while the user holds all the copyright;
  outside contributions to code the phone uses need an agreement first.

## Addendum (2026-11-22): team spaces on the phone

Team spaces (ADR 033) came after this decision. The phone follows the desktop's model:

- A member's phone keeps the team space as a second database (`team/` in the app's
  folder, with its own attachments and `member.json`), opened when the server's `/info`
  says the token belongs to a member and deleted when it no longer does. It opens offline
  from the saved copy at the next start.
- It syncs through the shared engine's hooks (`Host::after_round`, `pending_elsewhere`,
  `Engine::watch_team`), the same ones the desktop uses since the merge of 0.28; team
  attachments come down on demand from the team's routes.
- Every read and write goes through the core's `Spaces`: reads merge both spaces the way
  the desktop's store does (statuses stay personal, plus any only the team has), and the
  views leave team tasks out of the Inbox (`ViewOptions::team_tasks`, the desktop's
  `ViewContext.teamIds`). One undo history spans both spaces.
- Rows carry `team` and the assignee's name; the navigation has a `TeamNav` (name,
  members, the team's statuses); pickers offer the task's own space only. A team task's
  due date reminds its assignee only; time blocks are personal and always remind.

## Addendum (2026-11-22): calendar events on the phone

Calendar events stay outside the ops log (ADR 014), so they never replicate. The phone
reads them from the server when the server runs the calendar sync: it fetches the coming
two weeks after a sync round (at most every five minutes) or when the day plan asks, and
keeps them in `calendar.json` for offline use. When a desktop runs the calendar sync
(classic Outlook always does) the phone has no events and says so; carrying them over
would need the desktop to upload them, which is not decided.

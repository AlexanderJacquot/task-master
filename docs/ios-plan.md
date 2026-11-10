# task-master for iPhone: preparation and development plan

Date: 2026-11-10 · Status: agreed (decisions in section 9); architecture in ADR 022.

## 1. Summary

- **A SwiftUI app over the existing Rust core.** The phone is one more replica: it embeds
  `taskmaster-core` with its own SQLite file, works offline, and syncs `ops` with the same
  sync server as the desktops (ADR 015). No new backend, no second data model.
- **Rust is exposed to Swift through UniFFI.** A new crate holds the phone's whole
  non-visual behaviour (screen queries, commands, sync engine), so most of the work is
  written and tested on Linux. Swift only draws and handles gestures.
- **No Mac and no Apple developer account are needed to start.** GitHub's macOS runners
  build the app for the simulator, run its tests, render every screen to screenshots and
  record short videos of the main flows. The repo is public, so those runners are free.
  Simulator builds need no signing.
- **The app reaches a real iPhone later**, when the Apple Developer Program is joined
  (TestFlight from CI) or a Mac is bought (direct install), whichever comes first. Until
  then nothing is felt in the hand, so motion and gesture quality stay unverified.
- **A Mac is needed** for what CI cannot give: profiling scroll and animation
  smoothness, interactive debugging, SwiftUI previews, and extension debugging. The plan
  keeps a list for the first Mac session.

This replaces the phone line in `docs/plan.md` section 7 (responsive layout as a Tauri
mobile build or PWA).

## 2. What the codebase gives us today

| Asset | State | Consequence for the phone |
| --- | --- | --- |
| `crates/core` | All logic and data; `rusqlite` (bundled SQLite), no UI or Tauri types | Compiles for iOS as is; one write path (`Store::execute`) |
| `crates/client` | Blocking sync client (`ureq`, rustls + ring): `sync()` is one full round, `watch()` is the SSE stream | Reusable; ring and bundled SQLite are C code, so iOS builds need the Apple toolchain (CI) |
| Sync server | Token, OIDC or no auth; refuses pushes from another schema version | Works unchanged for a phone; version lockstep needs a policy (section 4.4) |
| Sync worker | `apps/desktop/src-tauri/src/server_sync.rs`, 796 lines, tied to Tauri (`AppHandle`, events, config, loopback OIDC) | The schedule (push 2 s after an edit, pull on SSE, focus, 5 min) must move out of the shell to be shared |
| View logic | TypeScript: `lib/views.ts` (410 lines), `lib/board.ts`, `lib/calendar.ts`, `lib/planner.ts` | Not reusable from Swift. Must exist in Rust (already wanted: "compile `ViewSpec` to SQL" in progress.md Later, and M14) |
| Outside writers | Core handles a second process on the same database (`PRAGMA data_version`, clock from `MAX(ops.hlc)`) | Exactly what widgets and the share extension need |
| Workspace lint | `unsafe_code = "forbid"` | UniFFI's generated scaffolding needs `unsafe`; the FFI crate alone opts out |

Gaps with no code today: attachments are all downloaded during sync (a phone wants them on
demand), OIDC sign-in assumes a loopback redirect, and the server is deployed as
`exposure: private` (LAN/VPN only).

## 3. Architecture

```
┌───────────────────────────── iPhone ─────────────────────────────┐
│ SwiftUI app          Widgets          Share ext.     App Intents │
│      └──────────────┬───┴────────────────┴───────────────┘       │
│              TaskMasterKit (Swift package, no SwiftUI)           │
│                     │ UniFFI (generated Swift)                   │
│              crates/mobile  (Rust: FFI facade, sync engine)      │
│                     │                                            │
│     crates/core  ───┴───  crates/client                          │
│     SQLite in the App Group container                            │
└─────────────────────────────┬────────────────────────────────────┘
                              │ push / pull ops, SSE, blobs (HTTPS)
                       sync server (unchanged)  ←→  desktops, MCP
```

### 3.1 Rust side

- **`crates/mobile`** (new, `staticlib` + `lib`): the only crate that knows UniFFI. It
  exposes one `App` object:
  - `open(dir)`, `execute(command)`, `undo()`, `search`, `parse_capture`, `task_activity`;
  - **screen queries** that return rows ready to draw (`today()`, `view(spec)`,
    `board(spec)`, `task_detail(id)`, `project_tree()`, `day(date)`), so Swift never
    filters, groups or sorts;
  - a change callback (from `Store::subscribe`) so screens reload what changed;
  - sync: `connect`, `sign_in`, `sync_now`, `status`, foreground and background entry points.
- **View evaluation moves into the core** (`crates/core/src/query.rs`): `ViewSpec` →
  rows, with the grouping and ordering now in `views.ts` and `board.ts`. The desktop keeps
  its TypeScript version for now; a shared set of JSON test vectors
  (`crates/core/test-vectors`, already used for ranks) keeps the two in agreement.
- **A shell-agnostic sync engine** in `crates/client`: the scheduling loop from
  `server_sync.rs` behind a small trait for what differs per shell (where the account is
  stored, how status is announced, how a sign-in page is opened). The desktop moves onto
  it first, which proves the extraction before any phone code depends on it.

Why screen queries in Rust instead of a Swift store that mirrors the desktop's normalized
store: SQLite on the phone answers these queries in well under a frame, the logic gets
written once, and it is all testable on Linux. Swift keeps only short-lived optimistic
state for gestures in flight (a drag, a swipe-to-complete).

### 3.2 Swift side

- **`TaskMasterKit`** (Swift package, imports no SwiftUI or UIKit): observable models per
  screen over the generated bindings, formatting, navigation state. It builds and tests
  with the Swift toolchain on Linux against a Linux build of `crates/mobile`.
- **The app target**: SwiftUI views only. Native navigation, lists, sheets, context
  menus, swipe actions, haptics, Dynamic Type, VoiceOver. Deployment target iOS 26, no
  older version supported.
- **Extensions** (later milestones): widgets, share extension, intents. They open the
  same database in the App Group container through the same library.

### 3.3 What the phone uses from iOS

| Capability | Use | Milestone |
| --- | --- | --- |
| Swipe actions, context menus, haptics, pull to refresh | Complete, schedule, move, sync | P2–P3 |
| Local notifications | Due dates and time blocks, scheduled on device from local data | P4 |
| Background app refresh | A sync round when iOS grants time (not guaranteed, not instant) | P4 |
| Share extension | Capture a link, text or image into the Inbox from any app | P5 |
| App Intents (Shortcuts, Siri, Action button) | "Add task", "Show Today", complete a task | P5 |
| Widgets (home and lock screen), Control Center control | Today list, next block, quick capture | P5 |
| Spotlight | Find tasks from system search | P5 |
| Camera and photo picker, Quick Look | Attach photos, preview attachments | P5 |
| Live Activity | The running time block on the lock screen | Later |
| Face ID lock | Optional app lock | Later |

Not planned for the phone: starting agent sessions (no Claude Code on iOS; showing a
session's state and notes is possible later since they sync), the Lineage canvas, Metrics,
backup settings, the calendar sync runner (the server or a desktop keeps that role), the
planner in its first version, and the textured themes (start with a system-native look in
light and dark; decide on Parchment later).

## 4. Preparation (all on Linux, before any Swift)

### 4.1 Accounts and infrastructure (you, none of it blocks the start)

1. **Apple Developer Program** (99 USD a year), later. Enrolment works from the web or
   the Apple Developer app on the iPhone; no Mac needed. Required for TestFlight, the App
   Store, App Groups, push and widgets on a device. When you join: reserve the bundle id
   (proposal `space.solarnexus.taskmaster`), an App Group
   (`group.space.solarnexus.taskmaster`), create the app record, and an **API key** for
   CI (key, issuer id and key id go into GitHub secrets).
2. **Server reachability**: Tailscale on the phone for now. The server becomes public
   later, so the phone signs in with OIDC from the start (token auth stays for tests).
3. **OIDC**: register a redirect for the phone in Authelia (a custom scheme such as
   `taskmaster://oidc/callback`, used with the system sign-in sheet), before P4.

### 4.2 Core and client work (me, milestone P0)

1. View evaluation in the core with shared test vectors (section 3.1). Also unblocks M14
   and the CLI/MCP item in Later.
2. Sync engine extracted from the Tauri shell into `crates/client`; desktop moved onto
   it; existing server tests extended to run it.
3. OIDC exchange accepts a redirect given by the shell instead of assuming loopback.
4. Attachments on demand: a client option to skip downloads during sync and fetch one
   blob when it is opened.
5. Core paths: confirm `Store::open` and `FileStore` take every path from the caller (the
   App Group container), with no home-directory assumptions.

### 4.3 Toolchain and CI (me, milestone P1)

1. `crates/mobile` with UniFFI; `unsafe_code` allowed in that crate only. New dependency,
   so ADR 022 records it (alternatives: `swift-bridge`, a hand-written C ABI, Tauri 2
   mobile).
2. Swift toolchain on Linux (`swiftly`), `TaskMasterKit` package, `swift test` in
   `ci.yml` on the existing Linux job.
3. `.github/workflows/ios.yml` on a macOS runner:
   - build `crates/mobile` for `aarch64-apple-ios` and `aarch64-apple-ios-sim`, package
     an XCFramework (cached by Cargo.lock and source hash);
   - generate the Xcode project from a checked-in spec (XcodeGen), so no `.xcodeproj` is
     ever edited by hand;
   - build, unit tests, UI tests in the simulator;
   - **screenshot run**: every screen in light, dark and two text sizes, uploaded as an
     artifact and published as a gallery page;
   - **flow videos**: the UI tests' main flows recorded in the simulator
     (`simctl io recordVideo`), so transitions and gestures can at least be watched;
   - once the developer account exists: sign with the API key and upload to TestFlight on
     `v*` tags and on demand. The job is written but skipped until its secrets are set.
4. Forgejo keeps its manual-only stub; nothing changes there (ADR 010).

### 4.4 Version policy

The server refuses pushes from a different schema version, and a phone build takes longer
to arrive than a desktop update (TestFlight processing; App Store review later). Rules:

- Once the phone app is distributed, its build is part of the release train:
  `release.yml` triggers `ios.yml` on the same tag, so every version exists for all
  platforms.
- A release with a migration is installed on the phone before the server is upgraded,
  and the phone shows "update the app to sync" (it keeps working offline) when it is
  behind.
- App Store review adds days between a tag and the phone update, so before the App Store
  release the server must accept the previous schema version for additive migrations.
  Not built now; planned with P8.

## 5. How development runs without a Mac

| Loop | Where | Time | What it answers |
| --- | --- | --- | --- |
| Rust: logic, queries, sync | Linux, `cargo test` | seconds | Is the behaviour right |
| Swift models (`TaskMasterKit`) | Linux, `swift test` | seconds | Do screens get the right state |
| SwiftUI compiles, tests, screenshots, flow videos | CI macOS runner (simulator) | 10–15 min a push | Does it build, does it look right, does it move roughly right |
| On your iPhone | Later: TestFlight from CI, or a Mac | 20–40 min | Does it feel right |

Consequences I want to be plain about:

- **I write SwiftUI without running it locally.** Compile errors cost a CI round each.
  Keeping the views thin (section 3) is what makes this tolerable.
- **Fluidity cannot be judged until the app is on a device.** Screenshots prove layout,
  and simulator videos show that a transition exists, not how it feels or performs. Until
  then I stick to constructs with known cost (lazy lists, stable identities, no work in
  view bodies) and build in frame-time logging (a debug screen), so the first device
  session has numbers straight away. Each UI milestone ends with a gallery and videos for
  you to review; the hands-on review of everything built so far happens in one go when
  the device loop opens.
- **UX is settled before SwiftUI is written.** For each screen group I first build a
  phone-sized interactive mockup in HTML (cheap to change, you open it on the phone),
  and only the agreed flow is implemented natively. The mockup settles structure and
  flow, not the native feel.

Not used for now: xtool (iOS builds on Linux) and rented cloud Macs. Revisit only if
the CI loop proves too slow before the Mac arrives.

### When the Mac arrives

A "first Mac session" list is kept in progress.md and grows during development. Expected
contents: Instruments passes on the board, long lists and the calendar; SwiftUI previews
set up for every screen; extension debugging (widgets and share sheet are hard to debug
blind); keyboard and focus behaviour; memory under background limits; then a polish
round on animations and gestures. Expect that round to rework some views; the Rust layer
and `TaskMasterKit` should not change.

## 6. Milestones

One branch each, same rules as the rest of the repo (tests with every change, ADR for
dependencies, progress.md updated).

| | Milestone | Content | Done when |
| --- | --- | --- | --- |
| P0 | `p0-phone-core` | Section 4.2: views in core, sync engine out of the shell, OIDC redirect, blobs on demand | Desktop behaves as before on the shared engine; vectors pass in Rust and TypeScript |
| P1 | `p1-ios-walking-skeleton` | `crates/mobile`, UniFFI, `TaskMasterKit`, `ios.yml` (simulator). App: server URL and token, sync, show a plain list of tasks | CI builds the app, and a UI test syncs with a test server started in the job and screenshots the list |
| P2 | `p2-ios-read` | Mockups, then: Today, Inbox, projects and epics, saved views as lists, task detail (markdown rendered), search | You can find and read anything, offline |
| P3 | `p3-ios-write` | Capture with the quick-capture parser, complete, edit fields, reorder, subtasks, undo (shake and button), board as one column with a status switcher, drag between statuses | UI tests edit on the phone and a second replica in the job receives every change, and the reverse |
| P4 | `p4-ios-background` | Sync on foreground and background refresh, SSE while open, notifications, OIDC sign-in, "update to sync" state, sync status screen | Edits from the desktop are there when the phone is opened; reminders fire |
| P5 | `p5-ios-system` | App Group move, share extension, App Intents, widgets, Spotlight, attachments (camera, Quick Look) | Capture from the share sheet and a widget on the home screen work (needs the developer account to run on a device) |
| P6 | `p6-ios-calendar` | Day and agenda views of time blocks, move and resize, outcomes | Today's plan is usable from the phone |
| P7 | `p7-ios-polish` | With the Mac: profiling, previews, animation and gesture pass, accessibility audit | Scrolling and transitions hold the display's frame rate on your device |
| P8 | `p8-ios-app-store` | Server accepts the previous schema version, privacy manifest and labels, store listing and screenshots, review submission | The app is on the App Store |

**Device gate.** The first install on your iPhone (developer account or Mac) can come at
any point; when it does, the next step is a hands-on pass over everything built so far
before new screens. P5's extensions are hard to get right unseen, so if the gate has not
opened by then, P6 goes first.

P0 is useful on its own and carries no phone risk. P1 is where the unknowns are (UniFFI
with edition 2024, ring and SQLite cross-builds on the runner); it is kept deliberately
small so they surface before any UI is designed. Signing from CI stays an unknown until
the developer account exists.

## 7. Repo layout

```
crates/mobile/                 FFI facade (UniFFI), sync engine glue
apps/ios/
  project.yml                  XcodeGen spec (the Xcode project is generated)
  TaskMasterKit/               Swift package: models, no SwiftUI; tests run on Linux
  App/                         SwiftUI views
  Widgets/  Share/  Intents/   from P5
  UITests/                     simulator tests and the screenshot run
  mockups/                     HTML mockups per screen group
scripts/ios/                   build-xcframework.sh, generate-bindings.sh
.github/workflows/ios.yml
docs/adr/022-ios-app.md        after this plan is agreed
```

`CLAUDE.md` gains a short iOS section when P1 lands (generated bindings are never edited,
logic goes in Rust first, every screen has a screenshot test).

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Motion and gesture quality cannot be verified without a device, and several milestones may pile up unfelt | Simulator videos; in-app frame timing; the device gate (section 6); P7 reserved for the Mac |
| CI-only compile loop is slow | Thin views, logic on Linux, XCFramework cache |
| Signing and TestFlight from CI | Tried with whatever exists the day the developer account is opened, before anything depends on it |
| iOS kills an app that holds a file lock in a shared container while suspended | Finish or cancel sync and checkpoint the WAL before suspension; extensions open briefly, write, close |
| Background sync is best effort on iOS | Sync on open is the guarantee; silent push from the server is a later option (needs an APNs key on the server) |
| Schema lockstep between phone, desktop and server | Section 4.4 |
| TypeScript and Rust view logic drift | Shared test vectors; moving the desktop to the core queries is a later option |
| AGPL and App Store terms (the App Store is the goal) | You hold all the copyright, so you can distribute your own app there. Outside contributions to the code the phone uses would need a contributor agreement first; settle that before accepting any |
| UniFFI on edition 2024 with the pinned toolchain | Checked in the first hour of P1; fallback is a small hand-written C ABI over JSON, which the `Command` types already support |

## 9. Decisions (2026-11-10)

1. Native SwiftUI over the Rust core. No Tauri mobile build.
2. Apple Developer Program: later. Everything that can be done without it comes first.
3. Server: reached over Tailscale for now, public later; the phone uses OIDC.
4. Distribution: TestFlight first, the App Store at the end (P8).
5. iOS 26 and later only.
6. xtool: not now.
7. System-native look first; Parchment considered later.

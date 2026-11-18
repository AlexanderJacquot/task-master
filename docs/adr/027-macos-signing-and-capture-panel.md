# ADR 027: macOS ad-hoc signing, and quick capture as a panel over full-screen apps

Date: 2026-11-18 · Status: accepted

## Context

Two macOS problems from daily use:

1. **Signing.** Release builds carried no signing identity, so a downloaded app was
   ad-hoc signed by the linker at best, not sealed as a bundle. Apple Silicon calls such
   an app "damaged" once it is quarantined, so the app had to be re-signed or have its
   quarantine flag stripped before it would open. A Developer ID certificate (Apple
   Developer Program, paid) plus notarization is the only way to open with no warning.
   There is no account yet.
2. **Quick capture.** `Ctrl+Shift+Space` showed the capture window, then `set_focus`
   activated task-master. macOS then switched away from a full-screen app's Space to
   the one holding the main window, or kept the window off the full-screen Space. Capture
   must appear over whatever is in front, full-screen apps included.

## Decisions

**Ad-hoc signing now, Developer ID later.** `src-tauri/tauri.macos.conf.json` sets
`bundle.macOS.signingIdentity` to `"-"`, so the Tauri bundler signs the whole `.app`,
the `task-master-mcp` sidecar included, with one ad-hoc signature. `release.yml` checks
it after each macOS build (`codesign --verify --deep --strict`, `Signature=adhoc`).
Gatekeeper still asks once (System Settings → Privacy & Security → Open Anyway).
Developer ID signing and notarization are a backlog task. When they come, the `APPLE_*`
secrets go to tauri-action on the macOS jobs only when set, and the check expects the
Developer ID signature instead. One cost of ad-hoc signing: each release has a new code
hash, so macOS privacy grants (e.g. the microphone for Scribe, ADR 026) are asked for
again after an update.

**Capture window as a non-activating `NSPanel`.** This is how Spotlight-style launchers
show over full-screen apps. At startup the capture window's `NSWindow` (tao's
`TaoWindow`) gets its class swapped for `TaskMasterCapturePanel`, an `NSPanel` subclass
that can become key but not main. It then gets the `NonactivatingPanel` style, the
status window level, `CanJoinAllSpaces | FullScreenAuxiliary`, and
`hidesOnDeactivate = NO`. On macOS `show_capture` calls `show()` (`makeKeyAndOrderFront`)
and no longer `set_focus()`, which activates the app. The panel takes the keyboard while
the other app stays active on its Space. Hiding it hands the keyboard straight back to
that app. Its blur-to-hide still works, since resigning key still fires
`Focused(false)`. Windows and Linux are unchanged.

**Where the unsafe code lives.** The workspace forbids unsafe code (ADR 026: FFI stays in
third-party crates). The class swap needs a few lines of it, so it lives in its own
workspace crate, `crates/macos-panel` (`taskmaster-macos-panel`), whose lints allow
unsafe but deny undocumented unsafe blocks. Its one function takes a
`tauri::WebviewWindow` and checks the main thread, so its API is safe and the shell
stays free of unsafe code. Dependencies: `objc2` 0.6 and `objc2-app-kit` 0.3, already in
the tree through tao (no new crates in `Cargo.lock`). `tauri-nspanel` does the same, but
it is a git dependency.

Swapping an object's class requires both classes to have the same instance size
(objc2 asserts it in debug builds). `TaoWindow` adds one `AtomicBool` to `NSWindow`, and
`NSPanel` adds nothing, so the panel class declares a mirror of that ivar, which is never
read. tao keeps reading its own at the same offset. The crate compares the sizes before
swapping. If a tao update changes them, the error is logged and capture stays an ordinary
window.

**Dev environment.** `devenv.nix` / `devenv.yaml` / `.envrc` give the pinned Rust
toolchain (rust-overlay), Node 24 and pnpm (corepack, `packageManager`). All caches
(cargo, corepack, pnpm store) stay in `.devenv/state` inside the checkout. On Linux it
also brings the WebKitGTK libraries. CI does not use it. A release bundle built inside it links Nix's
`libiconv` and will not launch under the hardened runtime (library validation), so try
release-only behaviour on CI builds. `pnpm dev` works.

## Consequences

- macOS: capture opens over full-screen apps and on every Space without moving the user
  off it, and never brings the main window forward (confirmed on a dev build, 2026-11-18).
- The file picker and drag and drop work in the capture editor (tried 2026-11-18). Drops
  needed two fixes found on the way: the capture window now mounts `useFileDrop`, and on
  macOS drag positions are taken as CSS pixels (wry reports points, which Tauri labels
  physical), in the main window too.
- If a tao update gives `TaoWindow` behaviour the panel class drops (today:
  `canBecomeKeyWindow`, `canBecomeMainWindow`, a `sendEvent:` override for
  drag-by-background, unused by the capture window), re-check this crate.
- `server_sync::tests::a_busy_port_nobody_answers_on_is_skipped_at_once` fails on macOS
  (port reuse differs from Linux and Windows). Since 0.23.1 it runs on Linux only (Windows
  lets a listener bind there too), as the `native` CI job runs the desktop tests on both.

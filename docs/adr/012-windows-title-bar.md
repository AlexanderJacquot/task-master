# ADR 012: The app's own title bar on Windows

Date: 2026-11-05 · Status: accepted

## Context

On Windows the system title bar is a white or grey strip above the dark or parchment app.
The user wants the app's colors up to the window's top edge. Options weighed: recolor the
system bar through DWM (cheap, Windows 11 only, still a separate strip) or draw our own.
The user chose our own.

## Decisions

**Frameless on Windows only.** `tauri.windows.conf.json` (merged by Tauri on Windows
builds) sets `decorations: false` and `shadow: true` on the main window. Tauri merges it as
a JSON merge patch, which replaces the whole window list, so the file repeats both windows;
a shell test fails if it differs from `tauri.conf.json` in anything else. macOS keeps the
native frame for now (its native "overlay" title bar style would be the cheap route there
later). Linux: see the amendment below.

**The strip.** `TitleBar` (32 px) sits above the sidebar and the main area: its left part
is as wide as the sidebar (open or folded) and has its background, the rest shows the
canvas, so the app's colors reach the top. It is a `data-tauri-drag-region="deep"`:
dragging moves the window with Aero Snap, a double-click maximizes; buttons inside stay
clickable. Minimize, Maximize/Restore (following the real state through resize events) and
Close are drawn with the Segoe Fluent Icons / MDL2 glyphs at Windows' sizes (46 × 32,
red close on hover) and dim while the window is unfocused. It also shows on the loading
and error screens, so the window can always be moved and closed.

**Detection.** `usesCustomTitleBar()`: inside Tauri, a Windows user agent, the main
window. No platform plugin needed. The window calls sit behind `WindowControls` so tests
fake them.

**Permissions.** `core:window:allow-start-dragging`, `allow-internal-toggle-maximize`,
`allow-minimize`, `allow-toggle-maximize`, `allow-close`.

**Closing quits.** Closing the main window now exits the app. Before, the hidden capture
window kept the process alive with no window and no way to quit, and a relaunch started a
second instance on the same database.

## Consequences

- No new dependency.
- Not native: the Windows 11 snap layout flyout on hovering Maximize is missing (Win+Z
  and dragging to screen edges still work). Getting it needs Win32 hit-testing
  (`WM_NCHITTEST` → `HTMAXBUTTON`) or a community plugin; revisit if it is missed.
- Resize borders and the shadow rely on Tauri's handling of frameless windows on Windows;
  to be checked by hand.

## Amendment (2026-11-07): Linux too

On Wayland (KDE Plasma here) GTK draws its own client-side title bar, a dark strip above
the app like the one on Windows. `tauri.linux.conf.json` now drops the main window's frame
the same way (`decorations: false`, no `shadow`: Tauri ignores it on Linux); a second shell
test guards the drift. Tauri 2.12 (`tauri-runtime-wry`'s `undecorated_resizing`) gives
frameless GTK windows resize edges and cursors, and drag regions use the compositor's own
move, so snapping and double-click maximize keep working.

`titleBarStyleFor(userAgent)` picks the buttons: `windows` as above, `linux` for a Linux
user agent: round 24 px buttons with SVG line icons (no icon font is guaranteed), red disc
on close hover, minimize / maximize / close on the right, the KDE and GNOME default order.

Known limits on Linux: the compositor draws no shadow and no rounded corners for a
frameless window, the window menu (Alt+Space or right-click on the bar) and the user's
button order and theme from system settings are not followed.

## Amendment (2026-11-18): macOS too

macOS kept its native title bar: a grey strip above the app, unlike Windows and Linux.
`tauri.macos.conf.json` (which also holds the ad-hoc signing of ADR 027) now gives the main
window the native **overlay** title bar: `titleBarStyle: "Overlay"`, `hiddenTitle`, and
`trafficLightPosition` `{14, 14}`, which centers the lights on the 32 px strip. The frame,
shadow, rounded corners, resize edges and traffic lights stay native, and the webview fills
the window. The third shell test guards the window list against drift, like the other two.

`titleBarStyleFor` returns `macos` for a Macintosh user agent, and `TitleBar` then draws the
same drag strip with no buttons of its own (the traffic lights sit on its left). Two macOS
cases: the folded sidebar (60 px) is narrower than the lights, so over it the strip is all
canvas rather than have the lights straddle the rail's edge; and in full screen, where macOS
hides the title bar, the strip goes too (`isFullscreen`, checked on resize). Checked on a
debug build with the sidebar open and folded; full screen only in unit tests.

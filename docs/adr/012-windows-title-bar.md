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
a shell test fails if it differs from `tauri.conf.json` in anything else. Linux keeps the
native frame (window managers vary too much); macOS too for now (its native "overlay"
title bar style would be the cheap route there later).

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

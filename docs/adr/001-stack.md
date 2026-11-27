# ADR 001: Stack

Date: 2026-11-04 · Status: accepted

## Context

task-master is a local-first desktop task manager. Its core must later be reused by a
CLI, an MCP server, a sync server and a phone client (plan, sections 1 and 7).

## Decision

| Layer | Choice |
| --- | --- |
| Shell | Tauri 2 (Windows, macOS, Linux; mobile targets later) |
| Core | Rust library crate `crates/core`, owning all logic and data |
| Storage | SQLite in WAL mode via `rusqlite`, FTS5 for search, append-only `ops` log |
| UI | React 19 + TypeScript + Vite |
| UI state | Zustand, normalized, hydrated from a core snapshot |
| Type bridge | `tauri-specta` generating `bindings.ts` (fallback: `ts-rs`) |
| Tooling | Cargo + pnpm workspaces, clippy/rustfmt, Biome, Vitest |

Principles: offline-first with sync as an add-on; every mutation is a command that
writes rows and an `ops` entry in one transaction; the core never knows about the UI.

## Alternatives rejected

- **Obsidian plugin**: markdown-as-database causes slowness and duplicates; weak mobile UX.
- **Electron**: same UI, heavier memory and installers, no natural native core.
- **Web app + server**: needs hosting first, and still needs a local agent for folders/terminals.
- **Svelte / Solid**: lighter, but weaker library coverage for kanban and calendar.

## CI deviation from the plan

The plan names a GitHub Actions matrix (windows, ubuntu, macos). The repo is hosted on
Forgejo, so M0 ships a Linux-only Forgejo workflow (lint, tests, Tauri build). The 3-OS
build and release matrix moves to M6, through a GitHub mirror or other runners, since
Forgejo has no macOS runners.

## Consequences

- One engine for every front end; adding the CLI or MCP never touches the data model.
- `tauri-specta` is on a release candidate: its version is pinned exactly.
- Windows and macOS builds are not verified by CI until M6; check them by hand before then.

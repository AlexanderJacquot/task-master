# ADR 007: Backups, remote upload, export/import, settings, installers

Date: 2026-11-04 · Status: accepted

## Context

M6 hardens the MVP: daily backups, JSON export/import, a settings screen (statuses, theme,
data folder, backups), a 10k-task performance check, and installers for three OSes. The
user also asked for saves to a self-hosted service when it is reachable.

## Decisions

**Local backups.** `Store::daily_backup` writes `backups/daily-YYYY-MM-DD.sqlite` (UTC
date) with `VACUUM INTO` (consistent and compacted while the app runs; no rusqlite feature
needed after all) and keeps the newest 14. The shell runs a cycle 20 s after start, then
every 15 minutes; a backup is also written before every import (`pre-import-<ms>.sqlite`).

**Remote backup (approved instead of a sync server for now).** The newest daily backup is
uploaded to an S3-compatible bucket, Garage at `s3.solarnexus.space` in the homelab, with a
presigned path-style PUT (`rusty-s3` 0.10.2 for signing, `ureq` 3.4.3 for HTTP, `url`).
Key: `<prefix>/<device id>/daily-YYYY-MM-DD.sqlite`. One-way and best effort: when the
bucket is unreachable (off the LAN), the error is shown in settings and the next cycle
retries; a backup is uploaded once (forced by "Back up now"). Restore is an import or a
copy back. The real multi-device sync server stays Phase 5 (it builds on the ops log).

**Per-device config outside the database.** `<app config>/config.json` (mode 0600) holds
the data folder and the remote settings, including the secret key. The settings screen
never receives the secret (`has_secret`); an empty field keeps it. Changing the data
folder copies the database there (or adopts an existing one) and restarts the app.
`settings` in the DB keeps only the device id, which must not travel in exports.
The theme (system/light/dark) is per machine in `localStorage`, applied as a `dark` class
(Tailwind `@custom-variant dark`).

**Export/import.** `Store::export` dumps every user table (statuses, tags, projects, epics,
tasks, task_tags, views, ops) as JSON rows with the schema version. `Store::import`
replaces all of them in one transaction (foreign keys deferred, then checked), refusing a
file from another schema version or with unknown columns; the FTS index is rebuilt by its
triggers. Import is not undoable: it clears the history, re-seeds the clock and emits a
change event so every window re-reads. Native pickers: `tauri-plugin-dialog` 2.8.3.

**Statuses become entities.** Migration 0003 adds timestamps and `deleted_at`. Commands
`create_status`, `update_status` (name, category, color, rank, WIP limit 1–999) and
`delete_status` go through ops and undo. Guards: a column with tasks cannot be deleted or
change category (its tasks' `completed_at` would disagree); the last `todo` and the last
`done` column cannot go. Deleted statuses cannot receive tasks.

**IPC additions.** Read/side-effect commands outside `execute` for things that are not
data edits: `get_config`, `set_remote_backup`, `test_remote_backup`, `backup_status`,
`backup_now`, `export_to`, `import_from`, `set_data_dir`. Data edits still go through
`execute` only.

**Performance.** `crates/core/tests/perf.rs` (ignored; run in release) seeds 10k tasks:
snapshot + JSON serialization ~23 ms (budget 300 ms), ~75 µs per write.
`src/perf.test.ts` (opt-in `PERF=1`): board with filter and swimlanes ~1 ms, grouped list
rows ~4 ms (budget 16 ms). Rendering in the webview is checked by hand with the seed tool.

**Installers.** The repo is on Forgejo only (Linux runner). `.github/workflows/release.yml`
builds Linux (.deb, .AppImage, .rpm), Windows (NSIS/MSI) and macOS (arm64, x86_64) with
`tauri-apps/tauri-action` v1.0.0 into a draft GitHub release on `v*` tags. It runs once
the user creates a GitHub repo and a Forgejo push mirror (docs/release.md). Unsigned.

## Consequences

- Purging soft-deleted rows after 30 days is deferred to the sync work: it would break
  undo of older ops.
- Remote retention is up to the bucket (Garage lifecycle rules) or manual cleanup.
- The secret key sits in a user-only file until an OS keychain integration is added.

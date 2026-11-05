# ADR 011: Markdown preview and attachments

Date: 2026-11-05 · Status: accepted

## Context

Task descriptions were raw markdown in an editor; the plan asks for a preview (section 6).
The user also wants to paste images into a task's description and attach documents to
tasks. Design proposed and agreed before building: rendered by default and click to edit,
50 MB per file.

## Decisions

**Content outside SQLite, by hash.** Files live in `<data folder>/attachments/<sha256>`
(`taskmaster_core::FileStore`), written to a temporary name and renamed, so a file is
complete or absent. The same content is stored once. Rejected: blobs in SQLite, which
would copy every image into each of the 14 daily backups and grow the daily remote upload.

**Rows through commands.** Migration 0004 adds `attachments` (task, hash, name, MIME
type, size, timestamps, soft delete). `CreateAttachment`, `UpdateAttachment` (rename) and
`DeleteAttachment` write ops like every other command, so undo and the activity feed
(`attach`, `detach`, `rename_attachment`) work for free; each one bumps the task's
`updated_at`, as tag changes do. `execute` refuses an attachment whose hash is not stored.
Deleting an attachment, or the task, leaves the file, so undo always finds it again.
Deleted tasks hide their attachments in the snapshot without extra ops.

**Two steps over IPC.** Storing content is not a data edit: `store_file(path)` (dialog
pick or OS drop; streamed, never in memory whole) and `store_data(name, mime, base64)`
(clipboard paste) return `{hash, size, name, mime}`; the UI then sends
`create_attachment` through `execute` with a client id. Base64 because tauri-specta cannot
type a raw-body command; pastes are mostly screenshots, so the overhead is small.

**Reading files.** A `tm:` URI scheme (`tm://localhost/<attachment id>`, on Windows
`http://tm.localhost/<id>`) serves content by attachment id only, never by path, with the
stored MIME type, `nosniff` and an immutable cache header, on a worker thread. The CSP's
`img-src` gains `tm: http://tm.localhost`. `open_attachment` copies the file under its own
name to a temp folder and opens it with the default app (`tauri-plugin-opener`, used from
Rust only, so no JS permission); `save_attachment` writes a copy where the user picks.
`open_url` opens description links (`http`, `https`, `mailto` only) outside the app
instead of navigating the window away.

**Markdown.** `react-markdown` 10.1.0 + `remark-gfm` 4.0.1 (tables, task lists,
strikethrough, autolinks). It builds React elements and does not render raw HTML, so no
sanitizer is needed. `![name](attachment:<id>)` shows an image, `[name](attachment:<id>)`
links a file; other images are not loaded (no network reads from user text). Ticking a
task-list box edits that source line. The description shows rendered text; clicking it (or
the pencil) opens CodeMirror, and leaving it or Esc saves and renders again.

**Paste and drop.** Pasting or dropping files in the editor stores, attaches and inserts
them at the cursor. Tauri intercepts OS file drops, so `useFileDrop` forwards the dropped
paths to the `[data-file-drop]` element under the pointer: the description (attach and
insert) or the Attachments section (attach only).

**Backups and export.** Daily backups mirror new files into `backups/attachments/`
(never rotated, so every kept database finds its files). The remote backup uploads each
file once to `<prefix>/attachments/<hash>`, shared by devices, recorded in
`backups/attachments-uploaded.txt`. Export writes `<name>-attachments/` beside the JSON;
import takes those files in first (each checked against its hash) and reports
`missing_files` when the folder was not copied along.

**Limits.** 50 MiB per file (`MAX_ATTACHMENT_BYTES`), checked in the UI, the file store
and the command.

## Consequences

- New dependencies: `sha2` 0.11.1 (core), `base64` 0.23.1 and `tauri-plugin-opener` 2.7.2
  (shell), `react-markdown`, `remark-gfm` (UI). `sha2` and `base64` were already in the
  build through other crates.
- The IPC surface grows by `store_file`, `store_data`, `open_attachment`,
  `save_attachment` and `open_url` (beyond ADR 007's list).
- Files no longer used by any attachment stay on disk, and in the backup mirror, until a
  purge exists (the 30-day purge in "Later" should collect them).
- Phase 5 sync can move files by hash without schema changes.

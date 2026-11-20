# ADR 032: Notes in the sidebar, linked to tasks

Date: 2026-11-20 · Status: proposed (implemented on branch `notes-page`)

## Context

The user wanted a simple place to write markdown in the app, organized in simple folders,
reachable from the sidebar, and integrated with tasks without a strong coupling: "maybe a
note is attached to a task?". Task descriptions are per task; meeting notes belong to
meetings. Neither is a free page.

## Decisions

**Two new entities, ordinary like the others.** Migration 18 adds `note_folders` (`name`,
`rank`) and `notes` (`title`, `body` markdown, `folder_id`, `task_id`, `rank`). Both go
through `execute` (ops with inverses, undo, sync, soft delete, export/import) and are in
the snapshot and in `Changes`. The core lives in `crates/core/src/notes.rs`.

- Commands: `CreateNote`, `UpdateNote` (`Title`, `Body`, `FolderId`, `TaskId`, `Rank`),
  `DeleteNote`, `CreateNoteFolder`, `UpdateNoteFolder` (`Name`, `Rank`), `DeleteNoteFolder`.
- A title may be blank ("Untitled"); its whitespace is tidied to single spaces (at most 300
  characters). A body holds at most 1,000,000 characters. A folder name cannot be blank.
- Folders are one level deep. Deleting one moves its notes to the end of the top level, in
  their order (one batch, so one undo puts everything back).
- Moving a note to a folder without a rank puts it at the end of that folder.

**The link to a task is loose, in two ways.**

1. *Attached*: `notes.task_id`, at most one task. A note outlives its task (like meetings).
2. *Linked*: inside the text, `[text](task:<id>)` and `[text](project:<id>)`. The core keeps
   them as text; the markdown view renders them as chips (a task's open/done mark, a
   project's mark) that open the task or project. Typing `[[` in any markdown editor (task
   descriptions and meeting notes too) opens a task search that inserts such a link.

A task's panel and page list its notes: attached ones first, then those whose text links
to it ("links here"), with "New note", which writes one attached to the task and titled
like it. Backlinks are computed in the UI from the notes in the store; nothing is stored.

**The UI.** The sidebar has a Notes section (open by default, above Epics): folders with
their notes, then notes outside any folder; + writes a note, a folder's + or ⋯ writes one
in it, ⋯ / right-click moves a note or deletes it, double-click renames a folder, "New
folder" at the end. `/note/<id>` is a clean page: a large title on top (saved after a short
pause in typing, so the sidebar follows), then the markdown body (`DescriptionEditor`,
rendered until clicked). Its bar has the folder (a menu that moves it), the attached task
(attach, change, detach) and delete. Enter in the title moves to the body.

## Consequences

- Schema 18: the sync server must be updated with the app (clients push only with the same
  schema).
- Not in this first version, noted in progress.md under "Later": notes in the command
  palette and in search, attachments (images) in notes, drag and drop between folders,
  MCP tools for agents to read and write notes, a project's notes on its page.

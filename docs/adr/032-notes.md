# ADR 032: Notes in the sidebar, linked to tasks

Date: 2026-11-20 · Status: proposed (implemented on branch `notes-page`; follow-ups on `notes-integrations`)

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
- Not in this first version: the follow-ups below (branch `notes-integrations`).

## Follow-ups (2026-11-21, branch `notes-integrations`)

**Search.** Migration 19 adds `notes_fts` (title, body), kept by triggers like
`tasks_fts`. `Store::search_notes` matches every word as a prefix, best first (a title
match weighs 4×), with a snippet. A new IPC read, `search_notes`, feeds the command
palette: a Notes group lists every note by title, and those the search finds by their
body, with the words around the match; an action writes a new note.

**Files in notes.** The same migration lets an attachment belong to a note
(`attachments.note_id`; the CHECK now asks for exactly one of task, meeting or note, so the
table is rebuilt as in 0015). A note page takes pasted and dropped files like a task
description (`![name](attachment:<id>)`), lists them under the body, and Settings → Files
names the note holding a file. A deleted note hides its files (purgeable), undo brings
them back.

**Drag and drop.** A note's row in the sidebar drags onto a folder (to its end), next to
another note (into that note's folder, before or after it) or onto a "Drop here for no
folder" strip. One `UpdateNote` with the folder and the rank.

**A project's notes.** The project page lists the notes about it once there is one:
linking it, attached to one of its tasks or linking one (an area's include its
projects'). Its "New note" writes a note that starts with a link to the project: the link
is the relation, so notes keep no project field.

**MCP.** `list_notes`, `get_note`, `create_note`, `update_note`, `delete_note`;
`attach_file` and the attachment tools take notes; `search` lists matching notes after
tasks. Writing a note is always allowed (it is the user's at once, like a project);
changing or deleting the user's follows Settings → Agents, except notes the server wrote.

- Schema 19 (with 18): the sync server must be updated with the app.

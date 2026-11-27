# ADR 042: Meeting reports in nested Notes folders; notes link epics and meetings

Date: 2026-11-27 · Status: proposed

## Context

Scribe (ADR 025) and Notes (ADR 032) do not know each other. A meeting holds its own notes,
transcript and summary; the follow-up session (ADR 040) writes the summary on the meeting and
creates tasks, but nothing lands in Notes. A note can be attached to a task and link tasks
and projects, not epics or meetings. Notes folders are one level deep. The user asked:

- a note can be linked to an epic;
- the follow-up session also writes the meeting's report in Notes, in a folder kept for meeting
  reports, under the meeting's project and epic: `Project / Epic / Meeting notes`, the
  folders made by the first report that needs them;
- during that same round trip, the session files the meeting under the right project and epic
  when the meeting has none yet.

The summary only exists once the session wrote it, so a "write a note" button on the meeting page
would make a note without it; the user chose to drop it.

## Decisions

**Notes link epics and meetings, still as text.** Besides `task:<id>` and `project:<id>`, a
note body (and any markdown the app renders) may hold `[text](epic:<id>)` and
`[text](meeting:<id>)`. The core keeps them as text; the markdown view draws them as chips
(the epic's mark, the Scribe mark) that open the epic or the meeting. `[[` searches tasks,
projects, epics and meetings. Notes still have no project, epic or meeting field: the link
is the relation (ADR 032).

**Where a note shows (computed in the UI, nothing stored).** An epic's page lists the notes
linking the epic or one of its meetings, attached to one of its tasks or linking one (a
subtask counts for its parent's epic), with "New note". A project's page adds the notes
linking one of its epics or meetings. A meeting's page lists the notes linking it, when
there is one.

**Folders nest.** Migration 24 adds `note_folders.parent_id` (null: at the top). Each level
is ordered by rank among its siblings.

- `CreateNoteFolder` takes a `parent_id`; `UpdateNoteFolder` gains `ParentId`, which moves a
  folder (to the end of its new siblings unless a rank comes with it) and refuses a move
  into itself or one of its own subfolders, and nesting deeper than 8 levels.
- Deleting a folder moves its notes and its subfolders up into its parent, at the end, in
  their order (one batch, one undo), instead of to the top level.
- The sidebar draws the tree; a folder's menu adds "New folder inside" and "Move to…"; the
  note menus and the note page's folder menu list folders by path (`Data / Onboarding`).
- Synced like the rest. Schema 24: the sync server must be updated with the app.

**The MCP takes folder paths.** Wherever a tool takes a folder (`create_note`,
`update_note`, `list_notes`), it accepts an id, a name, or a path with ` / ` or `/` between
levels; a path that does not exist is created (for writes). Listings and `get_note` show a
note's folder as its path.

**A meeting's report.** The follow-up session (ADR 040) is asked, in its prefilled and
editable instructions:

1. read the meeting with its transcript;
2. when the meeting has no project or no epic, choose them from the user's projects and
   epics (by the title, participants and what was said) and set them with the new
   `link_meeting` tool; a link already set is never replaced, and when nothing fits it is
   left empty;
3. write the summary;
4. create the tasks it calls for in the meeting's project;
5. write the report with `create_note`: titled with the meeting's title and day, starting
   with a line of links (meeting, task, epic, project), then the participants, the summary
   and the meeting's notes, attached to the meeting's task, in the folder
   `<project name> / <epic name> / Meeting notes` (without the epic or the project when the
   meeting has none; `Meeting notes` alone at the top otherwise);
6. finish the session.

The folders are found by name and made when missing, so the first report creates them and
nothing exists before. Renaming a project or an epic later starts a new folder on the next
report; the older reports stay where they are.

**`link_meeting`** sets a meeting's project and epic (and keeps an epic consistent with its
project, as the meeting page does). It is allowed when `set_meeting_summary` is (the
session's task is the meeting's task or under it, or editing the user's tasks is on) and
refuses to replace a link already set.

## Consequences

- Schema 24 (with the sync server). No new IPC, no new dependency.
- Older apps show the new links as plain links that do nothing.
- A report copies the summary at the time it is written; editing the meeting later means
  editing the note too.
- Deleting an epic or a meeting leaves the links in notes, drawn struck through.

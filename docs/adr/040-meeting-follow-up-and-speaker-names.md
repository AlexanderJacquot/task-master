# ADR 040: Send a meeting to Claude; name voices from the participants

Date: 2026-11-26 · Status: accepted (asked for by the user on the task "Scribe overhaul
fixes"; built in an agent session, to confirm on review)

## Context

The user asked for three changes to Scribe's transcript (ADR 025): pick a voice's name
from the meeting's participants instead of typing it, deduce the other voices once one is
named, and a button that sends the meeting to Claude to summarize it and create the tasks
it calls for in the project. ADR 025 already planned the summary as the only step that
sends the transcript off the device, on an explicit click, and kept the MCP read-only for
meetings. The meeting's `summary` column existed but nothing wrote it or showed it.

## Decisions

**Names are picked.** A voice's name is a picklist: the participants, the voice's current
name if it is not among them, "Someone else…" (a text field), and the unnamed label. A
meeting that lists nobody keeps the text field. A typed name for a voice other than "Me"
joins the participants in the same command. Picking a name another voice already has
merges the two voices (`ReassignSpeaker`) rather than giving two keys one name.

**Deduction is by elimination only.** When exactly one voice other than "Me" has no name
and exactly one participant's name is unused (names compared trimmed and without case), that
voice is that participant. Naming a voice applies it in the same `UpdateMeeting` command
(one undo takes back both); the speaker list also offers it as a one-click "Bob?" whenever it
holds, which covers a one-to-one meeting before any naming and the state after a merge.
"Me" is never deduced: it is this device's microphone, and the user's own name is often not
among the participants. Recognising a voice from one meeting to the next would need the
speaker embeddings that diarization computes and discards today: storing them is a schema
and privacy change, left for later.

**Send to Claude starts a normal agent session (ADR 017) on a task of its own.** The
meeting page's Summary section opens the Send to agent dialog with instructions prefilled
(editable): read the meeting with its transcript, write the summary, create a task of the
user's own in the meeting's project for each action item (agent tasks if that is refused),
finish with `complete_session`. The task, "Follow up: <title>", is created only on Start, so
Cancel leaves nothing behind; it sits under the meeting's linked task when there is one, and
otherwise becomes the meeting's task. It is never the linked task itself: the session's end
moves its task to Review and the work timer runs on it.

**The MCP gains two things for this.** `get_meeting` takes `transcript: true` and adds one
`[m:ss] Name: text` line per segment (names as the app shows them; a note when the transcript
is not validated yet). `set_meeting_summary` writes the summary, the one meeting field an
agent may write. Both are allowed when the session's task is the meeting's task or under it,
or when editing the user's tasks is on (Settings → Agents); otherwise refused. The summary
shows on the meeting page, editable like the notes.

## Consequences

- The transcript leaves the device through the session the user starts with "Send to
  Claude", or through an agent (local or the server's remote MCP) while the user lets agents
  edit their tasks, which already lets them read and change everything else. With that
  setting off, only the meeting's own session gets it.
- Pressing "Send to Claude" again starts another follow-up task, under the first one (the
  meeting now points at it).
- No new IPC, no schema change: the dialog and the core commands already existed.

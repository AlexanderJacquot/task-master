import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { FileTextIcon } from "../../components/TaskIcons";
import { cx, SectionLabel } from "../../components/ui";
import { type MeetingNoteLinks, notesForMeeting, noteTitle } from "../../lib/notes";
import type { Epic, Meeting, Project, Task } from "../../lib/types";
import { useStoreState } from "../../store/context";
import { excerpt } from "./TaskNotes";

/** What a meeting's note links besides the meeting: its task, epic and project, when live. */
export function meetingNoteLinks(
  s: {
    tasks: Record<string, Task>;
    epics: Record<string, Epic>;
    projects: Record<string, Project>;
  },
  meeting: Meeting,
): MeetingNoteLinks {
  const task = meeting.task_id ? s.tasks[meeting.task_id] : undefined;
  const liveTask = task && task.deleted_at === null ? task : undefined;
  const epicId = meeting.epic_id ?? liveTask?.epic_id ?? null;
  const epic = epicId ? s.epics[epicId] : undefined;
  const projectId = meeting.project_id ?? liveTask?.project_id ?? epic?.project_id ?? null;
  const project = projectId ? s.projects[projectId] : undefined;
  return {
    task: liveTask,
    epic: epic && epic.deleted_at === null ? epic : undefined,
    project: project && project.deleted_at === null ? project : undefined,
  };
}

/**
 * A meeting's notes in Notes (ADR 042): the notes that link it, such as the report the
 * meeting's follow-up session writes (ADR 040). Hidden when there is none.
 */
export function MeetingNotes({ meeting }: { meeting: Meeting }) {
  const notes = useStoreState((s) => s.notes);
  const list = useMemo(
    () => notesForMeeting(Object.values(notes), meeting.id),
    [notes, meeting.id],
  );
  if (!list.length) return null;
  return (
    <section aria-label="In Notes" className="pl-10">
      <div className="mb-1 flex items-center gap-3">
        <SectionLabel>In Notes</SectionLabel>
        <span className="text-[12px] text-ink-3">{list.length}</span>
      </div>
      <ul className="flex flex-col">
        {list.map((note) => {
          const text = excerpt(note.body);
          return (
            <li key={note.id} className="min-w-0">
              <Link
                to="/note/$noteId"
                params={{ noteId: note.id }}
                search={{}}
                className="flex min-w-0 items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-hover"
              >
                <FileTextIcon size={15} className="mt-0.5 shrink-0 text-ink-3" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cx(
                      "min-w-0 truncate text-[14px]",
                      !note.title.trim() && "text-ink-3 italic",
                    )}
                  >
                    {noteTitle(note)}
                  </span>
                  {text && <span className="truncate text-[12.5px] text-ink-3">{text}</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

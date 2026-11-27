import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { FileTextIcon, AddIcon as Plus } from "../../components/TaskIcons";
import { cx, SectionLabel } from "../../components/ui";
import {
  epicLinkMarkdown,
  type NoteAbout,
  notesForEpic,
  notesForProject,
  noteTitle,
  projectLinkMarkdown,
} from "../../lib/notes";
import type { Epic, Project } from "../../lib/types";
import { useStoreState } from "../../store/context";
import { useNewNote } from "./NotesTree";
import { excerpt } from "./TaskNotes";

/** Rows shown before "Show all". */
const FOLDED = 4;

/** Writes a note about the project: it starts with a link to it, so it lists here. */
export function useNewProjectNote(project: Project) {
  const newNote = useNewNote();
  return () => newNote({ body: `${projectLinkMarkdown(project)}\n\n` });
}

/** Writes a note about the epic: it starts with a link to it, so it lists on its page. */
export function useNewEpicNote(epic: Epic) {
  const newNote = useNewNote();
  return () => newNote({ body: `${epicLinkMarkdown(epic)}\n\n` });
}

/**
 * Notes about a project (ADR 032, ADR 042), on its page: those linking to it, to one of its
 * epics or meetings, attached to one of its tasks or linking one (an area's include its
 * projects'). Shown once there is one; "New note" (also in the project's ⋯ menu) writes one
 * that links the project.
 */
export function ProjectNotes({ project, className }: { project: Project; className?: string }) {
  const notes = useStoreState((s) => s.notes);
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const epics = useStoreState((s) => s.epics);
  const meetings = useStoreState((s) => s.meetings);
  const newNote = useNewProjectNote(project);
  const list = useMemo(() => {
    const ids = new Set([project.id]);
    for (const p of Object.values(projects)) if (p.parent_id === project.id) ids.add(p.id);
    return notesForProject(Object.values(notes), tasks, ids, epics, meetings);
  }, [notes, tasks, projects, epics, meetings, project.id]);
  return <AboutNotes list={list} onNew={newNote} {...(className && { className })} />;
}

/**
 * Notes about an epic (ADR 042), on its page: those linking to it or to one of its
 * meetings, attached to one of its tasks or linking one. Shown once there is one; the
 * page's "New note" writes one that links the epic.
 */
export function EpicNotes({
  epic,
  className,
  full,
}: {
  epic: Epic;
  className?: string;
  /** The epic page's Notes layout: every note, with an empty state. */
  full?: boolean;
}) {
  const notes = useStoreState((s) => s.notes);
  const tasks = useStoreState((s) => s.tasks);
  const meetings = useStoreState((s) => s.meetings);
  const newNote = useNewEpicNote(epic);
  const list = useMemo(
    () => notesForEpic(Object.values(notes), tasks, epic.id, meetings),
    [notes, tasks, meetings, epic.id],
  );
  return <AboutNotes list={list} onNew={newNote} full={full} {...(className && { className })} />;
}

/** Why a note shows here, in a few words, or null when it links the page's subject. */
function useWhy() {
  const tasks = useStoreState((s) => s.tasks);
  const epics = useStoreState((s) => s.epics);
  const meetings = useStoreState((s) => s.meetings);
  return ({ reason, taskId, meetingId, epicId }: NoteAbout): string | null => {
    const task = taskId ? tasks[taskId] : undefined;
    if (reason === "attached" && task) return `on ${task.title}`;
    if (reason === "links-task" && task) return `links ${task.title}`;
    const meeting = meetingId ? meetings[meetingId] : undefined;
    if (reason === "links-meeting" && meeting) return `from ${meeting.title.trim() || "a meeting"}`;
    const epic = epicId ? epics[epicId] : undefined;
    if (reason === "links-epic" && epic) return `on ${epic.name}`;
    return null;
  };
}

/** A page's list of notes about it, with "New note". */
function AboutNotes({
  list,
  onNew,
  className,
  full = false,
}: {
  list: NoteAbout[];
  onNew: () => unknown;
  className?: string;
  /** Every note at once, in one column, and an empty state instead of nothing. */
  full?: boolean;
}) {
  const [shownAll, setAll] = useState(false);
  const all = full || shownAll;
  const whyOf = useWhy();
  const newNote = onNew;
  if (!list.length) {
    if (!full) return null;
    return (
      <div className={cx("flex flex-col items-start gap-2 text-[13.5px] text-ink-3", className)}>
        No notes about this yet: notes linking it, attached to one of its tasks, or written from one
        of its meetings show here.
        <button
          type="button"
          onClick={() => void newNote()}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          <Plus size={13} /> New note
        </button>
      </div>
    );
  }
  const shown = all ? list : list.slice(0, FOLDED);
  return (
    <section aria-label="Notes" className={className}>
      <div className="mb-1.5 flex items-center gap-2">
        <SectionLabel>Notes</SectionLabel>
        <span className="text-[12px] text-ink-3">{list.length}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void newNote()}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          <Plus size={13} /> New note
        </button>
      </div>
      <ul className={cx("grid grid-cols-1 gap-x-4", !full && "sm:grid-cols-2")}>
        {shown.map((about) => {
          const { note } = about;
          const text = excerpt(note.body);
          const why = whyOf(about);
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
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span
                      className={cx(
                        "min-w-0 truncate text-[14px]",
                        !note.title.trim() && "text-ink-3 italic",
                      )}
                    >
                      {noteTitle(note)}
                    </span>
                    {why && (
                      <span className="min-w-0 shrink truncate text-[11.5px] text-ink-3">
                        {why}
                      </span>
                    )}
                  </span>
                  {text && <span className="truncate text-[12.5px] text-ink-3">{text}</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {!full && list.length > FOLDED && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="mt-0.5 rounded-md px-2 py-0.5 text-[12.5px] text-ink-3 hover:bg-hover hover:text-ink"
        >
          {all ? "Show fewer" : `Show all ${list.length}`}
        </button>
      )}
    </section>
  );
}

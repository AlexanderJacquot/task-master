import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { FileTextIcon, AddIcon as Plus } from "../../components/TaskIcons";
import { cx, SectionLabel } from "../../components/ui";
import { notesForProject, noteTitle, projectLinkMarkdown } from "../../lib/notes";
import type { Project } from "../../lib/types";
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

/**
 * Notes about a project (ADR 032), on its page: those linking to it, attached to one of
 * its tasks or linking one (an area's include its projects'). Shown once there is one;
 * "New note" (also in the project's ⋯ menu) writes one that links the project.
 */
export function ProjectNotes({ project, className }: { project: Project; className?: string }) {
  const notes = useStoreState((s) => s.notes);
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const newNote = useNewProjectNote(project);
  const [all, setAll] = useState(false);
  const list = useMemo(() => {
    const ids = new Set([project.id]);
    for (const p of Object.values(projects)) if (p.parent_id === project.id) ids.add(p.id);
    return notesForProject(Object.values(notes), tasks, ids);
  }, [notes, tasks, projects, project.id]);
  if (!list.length) return null;
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
      <ul className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
        {shown.map(({ note, reason, taskId }) => {
          const text = excerpt(note.body);
          const task = taskId ? tasks[taskId] : undefined;
          const why =
            reason === "attached" && task
              ? `on ${task.title}`
              : reason === "links-task" && task
                ? `links ${task.title}`
                : null;
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
      {list.length > FOLDED && (
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

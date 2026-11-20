import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { FileTextIcon, AddIcon as Plus } from "../../components/TaskIcons";
import { cx, SectionLabel } from "../../components/ui";
import { notesForTask, noteTitle } from "../../lib/notes";
import type { Task } from "../../lib/types";
import { useStoreState } from "../../store/context";
import { useNewNote } from "./NotesTree";

/** The first line of text in a note's body, without markdown marks. */
function excerpt(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^[-*_]{3,}$/.test(l));
  if (!line) return "";
  return line
    .replace(/^#+\s*|^[-*+]\s+(\[[ xX]\]\s+)?|^\d+\.\s+|^>\s*/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "");
}

/**
 * Notes about a task (ADR 032), on its panel and page: those attached to it, then those
 * whose text links to it. "New note" writes one attached to the task.
 */
export function TaskNotes({ task, page }: { task: Task; page: boolean }) {
  const notes = useStoreState((s) => s.notes);
  const newNote = useNewNote();
  const list = useMemo(() => notesForTask(Object.values(notes), task.id), [notes, task.id]);
  return (
    <section aria-label="Notes" className={cx(page && "pl-10")}>
      <div className="mb-1.5 flex items-center gap-2">
        {page ? (
          <span className="font-display text-[17px] tracking-wide text-rubric">Notes</span>
        ) : (
          <SectionLabel>Notes</SectionLabel>
        )}
        {list.length > 0 && <span className="text-[12px] text-ink-3">{list.length}</span>}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void newNote({ title: task.title, task_id: task.id })}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          <Plus size={13} /> New note
        </button>
      </div>
      {list.length > 0 && (
        <ul className="flex flex-col">
          {list.map(({ note, attached }) => {
            const text = excerpt(note.body);
            return (
              <li key={note.id}>
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
                      {!attached && (
                        <span className="shrink-0 text-[11.5px] text-ink-3">links here</span>
                      )}
                    </span>
                    {text && <span className="truncate text-[12.5px] text-ink-3">{text}</span>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

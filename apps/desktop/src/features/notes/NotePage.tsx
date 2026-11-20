import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { NotebookPen, X } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftIcon as ArrowLeft,
  FolderOpenIcon,
  DeleteIcon as Trash2,
} from "../../components/TaskIcons";
import { cx, IconButton, MENU, MENU_ITEM, MENU_LABEL, MENU_SEPARATOR } from "../../components/ui";
import { tidy } from "../../lib/notes";
import type { Note, NoteChange } from "../../lib/types";
import { deleteNote, moveNote, updateNote } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { AttachmentList } from "../task-detail/AttachmentList";
import { DescriptionEditor } from "../task-detail/DescriptionEditor";
import { TaskPicker } from "../task-detail/TaskPicker";
import { fitHeight, TitleField } from "../task-detail/TitleField";
import { useNoteAttachments, useNoteFiles } from "../task-detail/useTaskFiles";

/** Typing pauses this long before the title is saved (and the sidebar shows it). */
const TITLE_SAVE_MS = 500;

/** The folder the note is in, as a menu that moves it. */
function FolderMenu({ note }: { note: Note }) {
  const store = useTaskStore();
  const folders = useStoreState((s) => s.note_folders);
  const sorted = Object.values(folders).sort((a, b) => (a.rank < b.rank ? -1 : 1));
  const current = note.folder_id ? folders[note.folder_id] : undefined;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        title="Move to a folder"
        className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-ink"
      >
        <FolderOpenIcon size={14} />
        {current?.name ?? "No folder"}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={cx(MENU, "min-w-44")}>
          <div className={MENU_LABEL}>Move to</div>
          <DropdownMenu.Item
            className={MENU_ITEM}
            disabled={!note.folder_id}
            onSelect={() => void moveNote(store, note.id, null)}
          >
            No folder
          </DropdownMenu.Item>
          {sorted.length > 0 && <DropdownMenu.Separator className={MENU_SEPARATOR} />}
          {sorted.map((f) => (
            <DropdownMenu.Item
              key={f.id}
              className={MENU_ITEM}
              disabled={f.id === note.folder_id}
              onSelect={() => void moveNote(store, note.id, f.id)}
            >
              {f.name}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The task the note is attached to: open it, change it or detach it. */
function AttachedTask({ note, change }: { note: Note; change(c: NoteChange[]): void }) {
  const store = useTaskStore();
  const task = useStoreState((s) => (note.task_id ? s.tasks[note.task_id] : undefined));
  const candidates = () =>
    Object.values(store.getState().tasks).sort((a, b) => b.updated_at - a.updated_at);
  if (!task) {
    return (
      <TaskPicker
        label="Attach to a task"
        trigger="Attach to a task…"
        triggerClassName="rounded-md px-1.5 py-0.5 text-accent hover:bg-hover"
        candidates={candidates}
        onPick={(t) => change([{ task_id: t.id }])}
      />
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-0.5 rounded-md border border-line-strong pl-2 text-ink">
      <span className="text-ink-3">Task</span>
      <Link
        to="/task/$taskId"
        params={{ taskId: task.id }}
        search={{}}
        title="Open the task"
        className="max-w-64 truncate rounded px-1 hover:underline"
      >
        {task.title}
      </Link>
      <TaskPicker
        label="Attach to another task"
        trigger="Change"
        triggerClassName="rounded px-1 text-[12.5px] text-ink-3 hover:text-ink"
        candidates={candidates}
        onPick={(t) => change([{ task_id: t.id }])}
      />
      <button
        type="button"
        aria-label="Detach from the task"
        title="Detach from the task"
        onClick={() => change([{ task_id: null }])}
        className="inline-flex size-6 items-center justify-center rounded text-ink-3 hover:bg-hover hover:text-ink"
      >
        <X size={13} />
      </button>
    </span>
  );
}

/** The note's title: saved as you pause typing, so the sidebar follows it. */
function NoteTitle({
  note,
  autoFocus,
  onEnter,
  change,
}: {
  note: Note;
  autoFocus: boolean;
  onEnter(): void;
  change(c: NoteChange[]): void;
}) {
  const [draft, setDraft] = useState(note.title);
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saved = useRef(note.title);

  const save = (value: string) => {
    clearTimeout(timer.current);
    const next = tidy(value);
    if (next !== saved.current) {
      saved.current = next;
      change([{ title: next }]);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // Saves a pending edit when the page closes.
  useEffect(() => () => saveRef.current(ref.current?.value ?? saved.current), []);

  // Edits from elsewhere (undo, another window) show unless the title is being typed in.
  useEffect(() => {
    saved.current = note.title;
    const el = ref.current;
    if (el && document.activeElement !== el) {
      setDraft(note.title);
      requestAnimationFrame(() => fitHeight(el));
    }
  }, [note.title]);

  return (
    <TitleField
      ref={ref}
      value={draft}
      aria-label="Title"
      placeholder="Untitled"
      autoFocus={autoFocus}
      className="w-full resize-none overflow-hidden bg-transparent font-display text-[40px] leading-[1.15] tracking-wide placeholder:text-ink-3/60 focus:outline-none"
      onChange={(e) => {
        const value = e.currentTarget.value;
        setDraft(value);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => save(value), TITLE_SAVE_MS);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          save(e.currentTarget.value);
          onEnter();
        }
      }}
      onBlur={(e) => save(e.currentTarget.value)}
    />
  );
}

function NoteEditor({ note }: { note: Note }) {
  const store = useTaskStore();
  const fresh = !note.title && !note.body;
  // Enter in the title opens the body's editor (remounted with the cursor in it).
  const [bodyFocus, setBodyFocus] = useState(0);
  const change = (changes: NoteChange[]) => void updateNote(store, note.id, changes);
  const files = useNoteFiles(note.id);
  const attachments = useNoteAttachments(note.id);
  const attachmentsById = useStoreState((s) => s.attachments);
  return (
    <div className="flex flex-col gap-4">
      <NoteTitle
        note={note}
        autoFocus={fresh}
        onEnter={() => setBodyFocus((n) => n + 1)}
        change={change}
      />
      <DescriptionEditor
        key={bodyFocus}
        value={note.body}
        onSave={(body) => body !== note.body && change([{ body }])}
        size="page"
        attachments={attachmentsById}
        actions={files.actions}
        upload={files.uploader}
        autoFocus={bodyFocus > 0}
        placeholder="Write freely… Markdown works. Type [[ to link a task; paste or drop images and files."
      />
      <AttachmentList
        attachments={attachments}
        files={files}
        page
        onInsert={(markdown) => {
          const text = store.getState().notes[note.id]?.body.replace(/\s+$/, "") ?? "";
          change([{ body: text ? `${text}\n\n${markdown}` : markdown }]);
        }}
      />
    </div>
  );
}

/** A note on its own page (ADR 032): a title on top, then the markdown body. */
export function NotePage({ noteId }: { noteId: string }) {
  const store = useTaskStore();
  const navigate = useNavigate();
  const router = useRouter();
  const note = useStoreState((s) => s.notes[noteId]);
  if (!note) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-ink-3">
        This note no longer exists.
        <Link to="/inbox" search={{}} className="text-accent hover:underline">
          Back to the Inbox
        </Link>
      </div>
    );
  }
  const change = (changes: NoteChange[]) => void updateNote(store, note.id, changes);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-6 py-3 text-[13.5px] text-ink-2">
        <button
          type="button"
          title="Back"
          onClick={() => router.history.back()}
          className="flex items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-ink"
        >
          <ArrowLeft size={15} />
          <NotebookPen size={14} />
          Notes
        </button>
        <FolderMenu note={note} />
        <span className="flex-1" />
        <AttachedTask note={note} change={change} />
        <IconButton
          label="Delete note (Ctrl+Z to undo)"
          onClick={() => {
            void deleteNote(store, note.id);
            if (note.task_id && store.getState().tasks[note.task_id])
              void navigate({ to: "/task/$taskId", params: { taskId: note.task_id }, search: {} });
            else void navigate({ to: "/inbox", search: {} });
          }}
          className="hover:text-danger"
        >
          <Trash2 size={15} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        <article className="tex-sheet mx-auto min-h-[60vh] max-w-[820px] rounded-xl border border-line bg-raised px-10 py-11 shadow-xl shadow-black/10 sm:px-14 clean:border-transparent clean:pt-4 clean:shadow-none">
          <NoteEditor key={note.id} note={note} />
        </article>
      </div>
    </div>
  );
}

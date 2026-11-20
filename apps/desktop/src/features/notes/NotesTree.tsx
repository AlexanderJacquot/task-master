import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Folder, FolderPlus } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { type MouseEvent, type ReactNode, useCallback, useMemo, useState } from "react";
import {
  FileTextIcon,
  FolderOpenIcon,
  MoreIcon as MoreHorizontal,
  EditIcon as Pencil,
  AddIcon as Plus,
  DeleteIcon as Trash2,
} from "../../components/TaskIcons";
import {
  cx,
  FOCUS,
  IconButton,
  InlineInput,
  MENU,
  MENU_DANGER,
  MENU_ITEM,
  MENU_LABEL,
  MENU_SEPARATOR,
} from "../../components/ui";
import { noteTitle, noteTree } from "../../lib/notes";
import type { Note, NoteFolder } from "../../lib/types";
import {
  createNote,
  createNoteFolder,
  deleteNote,
  deleteNoteFolder,
  moveNote,
  updateNoteFolder,
} from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { activeClass, rowBaseClass } from "../sidebar/rows";

const FOLDERS_KEY = "task-master.note-folders-open";

function loadOpenFolders(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Which folders are unfolded, remembered per machine. Folders start open. */
function useOpenFolders(): [(id: string) => boolean, (id: string, open: boolean) => void] {
  const [open, setOpen] = useState(loadOpenFolders);
  const set = (id: string, value: boolean) => {
    const next = { ...open, [id]: value };
    setOpen(next);
    try {
      localStorage.setItem(FOLDERS_KEY, JSON.stringify(next));
    } catch {
      // Not remembered; fine.
    }
  };
  return [(id) => open[id] ?? true, set];
}

/** Creates a note and opens it, ready for its title. */
export function useNewNote() {
  const store = useTaskStore();
  const navigate = useNavigate();
  return useCallback(
    async (input: Parameters<typeof createNote>[1] = {}) => {
      const id = await createNote(store, input);
      if (id) void navigate({ to: "/note/$noteId", params: { noteId: id }, search: {} });
      return id;
    },
    [store, navigate],
  );
}

const toolClass = cx(
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink",
  "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
  FOCUS,
);

/** A note's ⋯ menu (also on right-click): move to a folder, delete. */
function NoteMenu({
  note,
  folders,
  open,
  onOpenChange,
}: {
  note: Note;
  folders: NoteFolder[];
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const store = useTaskStore();
  const navigate = useNavigate();
  const here = useRouterState({ select: (r) => r.location.pathname === `/note/${note.id}` });
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenu.Trigger
        aria-label={`${noteTitle(note)} actions`}
        title="Move, delete"
        className={toolClass}
      >
        <MoreHorizontal size={15} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={cx(MENU, "min-w-44")}>
          {folders.length > 0 && (
            <>
              <div className={MENU_LABEL}>Move to</div>
              {note.folder_id && (
                <DropdownMenu.Item
                  className={MENU_ITEM}
                  onSelect={() => void moveNote(store, note.id, null)}
                >
                  <FileTextIcon size={14} /> No folder
                </DropdownMenu.Item>
              )}
              {folders
                .filter((f) => f.id !== note.folder_id)
                .map((f) => (
                  <DropdownMenu.Item
                    key={f.id}
                    className={MENU_ITEM}
                    onSelect={() => void moveNote(store, note.id, f.id)}
                  >
                    <Folder size={14} /> {f.name}
                  </DropdownMenu.Item>
                ))}
              <DropdownMenu.Separator className={MENU_SEPARATOR} />
            </>
          )}
          <DropdownMenu.Item
            className={cx(MENU_ITEM, MENU_DANGER)}
            onSelect={() => {
              void deleteNote(store, note.id);
              if (here) void navigate({ to: "/inbox", search: {} });
            }}
          >
            <Trash2 size={14} /> Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function NoteRow({ note, folders }: { note: Note; folders: NoteFolder[] }) {
  const [menu, setMenu] = useState(false);
  const active = useRouterState({ select: (r) => r.location.pathname === `/note/${note.id}` });
  const untitled = !note.title.trim();
  return (
    <div className={cx(rowBaseClass, "pr-1", active && activeClass)}>
      <Link
        to="/note/$noteId"
        params={{ noteId: note.id }}
        search={{}}
        title={noteTitle(note)}
        className={cx("flex min-w-0 flex-1 items-center gap-2.5 py-[5px]", FOCUS)}
        onContextMenu={(e: MouseEvent<HTMLAnchorElement>) => {
          e.preventDefault();
          setMenu(true);
        }}
      >
        <FileTextIcon size={14} className="shrink-0" />
        <span className={cx("min-w-0 flex-1 truncate", untitled && "text-ink-3 italic")}>
          {noteTitle(note)}
        </span>
      </Link>
      <NoteMenu note={note} folders={folders} open={menu} onOpenChange={setMenu} />
    </div>
  );
}

/** A folder's ⋯ menu (also on right-click): new note, rename, delete. */
function FolderMenu({
  folder,
  open,
  onOpenChange,
  onNewNote,
  onRename,
}: {
  folder: NoteFolder;
  open: boolean;
  onOpenChange(open: boolean): void;
  onNewNote(): void;
  onRename(): void;
}) {
  const store = useTaskStore();
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenu.Trigger
        aria-label={`${folder.name} actions`}
        title="New note, rename, delete"
        className={toolClass}
      >
        <MoreHorizontal size={15} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={cx(MENU, "min-w-48")}>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={onNewNote}>
            <Plus size={14} /> New note here
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={onRename}>
            <Pencil size={14} /> Rename
          </DropdownMenu.Item>
          <DropdownMenu.Separator className={MENU_SEPARATOR} />
          <DropdownMenu.Item
            className={cx(MENU_ITEM, MENU_DANGER)}
            title="Its notes move out of the folder"
            onSelect={() => void deleteNoteFolder(store, folder.id)}
          >
            <Trash2 size={14} /> Delete folder
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function FolderRow({
  folder,
  count,
  open,
  onToggle,
  children,
}: {
  folder: NoteFolder;
  count: number;
  open: boolean;
  onToggle(open: boolean): void;
  children: ReactNode;
}) {
  const store = useTaskStore();
  const newNote = useNewNote();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const add = () => {
    onToggle(true);
    void newNote({ folder_id: folder.id });
  };
  return (
    <div>
      {renaming ? (
        <InlineInput
          initial={folder.name}
          placeholder="Folder name"
          autoFocus
          className="my-px"
          onCommit={(name) => {
            setRenaming(false);
            const next = name.trim();
            if (next && next !== folder.name)
              void updateNoteFolder(store, folder.id, [{ name: next }]);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <div className={cx(rowBaseClass, "pr-1")}>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => onToggle(!open)}
            onDoubleClick={() => setRenaming(true)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(true);
            }}
            className={cx("flex min-w-0 flex-1 items-center gap-2.5 py-[5px] text-left", FOCUS)}
          >
            {open ? (
              <FolderOpenIcon size={14} className="shrink-0" />
            ) : (
              <Folder size={14} className="shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            {open ? (
              <ChevronDown size={12} className="shrink-0 text-ink-3" />
            ) : (
              <ChevronRight size={12} className="shrink-0 text-ink-3" />
            )}
          </button>
          <IconButton
            label={`New note in ${folder.name}`}
            onClick={add}
            className="size-6 w-0 shrink-0 overflow-hidden opacity-0 group-hover:w-6 group-hover:opacity-100 focus-visible:w-6 focus-visible:opacity-100"
          >
            <Plus size={14} />
          </IconButton>
          <FolderMenu
            folder={folder}
            open={menu}
            onOpenChange={setMenu}
            onNewNote={add}
            onRename={() => setRenaming(true)}
          />
          <span className="w-5 text-right text-[12.5px] text-ink-3 tabular-nums">
            {count > 0 ? count : ""}
          </span>
        </div>
      )}
      {open && (
        <div className="ml-3 flex flex-col gap-px border-l border-line pl-1.5">
          {children}
          {count === 0 && <p className="px-2.5 py-1 text-[12.5px] text-ink-3">Empty folder</p>}
        </div>
      )}
    </div>
  );
}

/**
 * The sidebar's Notes (ADR 032): folders, one level deep, then the notes outside any
 * folder. Each note opens its own page.
 */
export function NotesTree() {
  const store = useTaskStore();
  const notes = useStoreState((s) => s.notes);
  const folders = useStoreState((s) => s.note_folders);
  const [isOpen, setOpen] = useOpenFolders();
  const [addingFolder, setAddingFolder] = useState(false);
  const tree = useMemo(
    () => noteTree(Object.values(notes), Object.values(folders)),
    [notes, folders],
  );
  const folderList = tree.folders.map((f) => f.folder);
  const empty = !tree.loose.length && !tree.folders.length;
  return (
    <>
      {tree.folders.map(({ folder, notes: inside }) => (
        <FolderRow
          key={folder.id}
          folder={folder}
          count={inside.length}
          open={isOpen(folder.id)}
          onToggle={(open) => setOpen(folder.id, open)}
        >
          {inside.map((n) => (
            <NoteRow key={n.id} note={n} folders={folderList} />
          ))}
        </FolderRow>
      ))}
      {tree.loose.map((n) => (
        <NoteRow key={n.id} note={n} folders={folderList} />
      ))}
      {empty && !addingFolder && (
        <p className="px-2.5 py-1 text-[12.5px] text-ink-3">
          Markdown pages that can link your tasks. Use + to write one.
        </p>
      )}
      {addingFolder ? (
        <InlineInput
          initial=""
          placeholder="Folder name"
          autoFocus
          className="mt-1"
          onCommit={(name) => {
            setAddingFolder(false);
            void createNoteFolder(store, name);
          }}
          onCancel={() => setAddingFolder(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAddingFolder(true)}
          className={cx(
            "flex items-center gap-2 rounded-lg px-2.5 py-1 text-left text-[12.5px] text-ink-3 hover:bg-hover hover:text-ink",
            FOCUS,
          )}
        >
          <FolderPlus size={13} /> New folder
        </button>
      )}
    </>
  );
}

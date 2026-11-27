import {
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Folder, FolderPlus } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import {
  type MouseEvent,
  type PointerEventHandler,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  type FolderNode,
  folderAndInside,
  folderOptions,
  type NoteDropTarget,
  notePlacement,
  notesInside,
  noteTitle,
  noteTree,
} from "../../lib/notes";
import type { Note, NoteFolder, Space } from "../../lib/types";
import {
  createNote,
  createNoteFolder,
  deleteNote,
  deleteNoteFolder,
  moveNote,
  placeNote,
  updateNoteFolder,
} from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { DROP_OVER_CLASS } from "../shell/taskDrop";
import { FOLD_CHILDREN_CLASS, FoldChevron } from "../sidebar/FoldChevron";
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
  folders: FolderChoice[];
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
                .filter((f) => f.folder.id !== note.folder_id)
                .map((f) => (
                  <DropdownMenu.Item
                    key={f.folder.id}
                    className={MENU_ITEM}
                    onSelect={() => void moveNote(store, note.id, f.folder.id)}
                  >
                    <Folder size={14} /> <span className="truncate">{f.path}</span>
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

/** A folder as menus offer it: with its path from the top (ADR 042). */
type FolderChoice = ReturnType<typeof folderOptions>[number];

/** Droppable ids: a note's row, a folder's header, the top level (`folder:`). */
const NOTE_PREFIX = "note:";
const FOLDER_PREFIX = "folder:";

function NoteRow({
  note,
  folders,
  hint,
}: {
  note: Note;
  folders: FolderChoice[];
  /** Where a note dragged over this row would land. */
  hint: "before" | "after" | null;
}) {
  const [menu, setMenu] = useState(false);
  const active = useRouterState({ select: (r) => r.location.pathname === `/note/${note.id}` });
  const untitled = !note.title.trim();
  const drag = useDraggable({ id: `${NOTE_PREFIX}${note.id}` });
  const drop = useDroppable({ id: `${NOTE_PREFIX}${note.id}` });
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      data-note-row={note.id}
      // Pointer drag only: the link keeps Enter and keyboard focus to itself.
      onPointerDown={drag.listeners?.onPointerDown as PointerEventHandler | undefined}
      className={cx(
        rowBaseClass,
        "relative pr-1",
        active && activeClass,
        drag.isDragging && "opacity-40",
        hint === "before" &&
          "before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded before:bg-accent",
        hint === "after" &&
          "after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded after:bg-accent",
      )}
    >
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

/**
 * A folder's ⋯ menu (also on right-click): new note, new folder inside, rename, move to
 * another folder (ADR 042), delete.
 */
function FolderMenu({
  folder,
  folders,
  open,
  onOpenChange,
  onNewNote,
  onNewFolder,
  onRename,
}: {
  folder: NoteFolder;
  folders: FolderChoice[];
  open: boolean;
  onOpenChange(open: boolean): void;
  onNewNote(): void;
  onNewFolder(): void;
  onRename(): void;
}) {
  const store = useTaskStore();
  const all = useStoreState((s) => s.note_folders);
  const blocked = folderAndInside(all, folder.id);
  const targets = folders.filter(
    (f) => !blocked.has(f.folder.id) && f.folder.id !== folder.parent_id,
  );
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenu.Trigger
        aria-label={`${folder.name} actions`}
        title="New note, new folder, rename, move, delete"
        className={toolClass}
      >
        <MoreHorizontal size={15} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={cx(MENU, "min-w-48")}>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={onNewNote}>
            <Plus size={14} /> New note here
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={onNewFolder}>
            <FolderPlus size={14} /> New folder inside
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={onRename}>
            <Pencil size={14} /> Rename
          </DropdownMenu.Item>
          {(targets.length > 0 || folder.parent_id) && (
            <>
              <DropdownMenu.Separator className={MENU_SEPARATOR} />
              <div className={MENU_LABEL}>Move to</div>
              {folder.parent_id && (
                <DropdownMenu.Item
                  className={MENU_ITEM}
                  onSelect={() => void updateNoteFolder(store, folder.id, [{ parent_id: null }])}
                >
                  <Folder size={14} /> Top level
                </DropdownMenu.Item>
              )}
              {targets.map((f) => (
                <DropdownMenu.Item
                  key={f.folder.id}
                  className={MENU_ITEM}
                  onSelect={() =>
                    void updateNoteFolder(store, folder.id, [{ parent_id: f.folder.id }])
                  }
                >
                  <Folder size={14} /> <span className="truncate">{f.path}</span>
                </DropdownMenu.Item>
              ))}
            </>
          )}
          <DropdownMenu.Separator className={MENU_SEPARATOR} />
          <DropdownMenu.Item
            className={cx(MENU_ITEM, MENU_DANGER)}
            title="Its notes and folders move up one level"
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
  folders,
  count,
  empty,
  open,
  onToggle,
  space,
  children,
}: {
  folder: NoteFolder;
  folders: FolderChoice[];
  /** Notes inside, subfolders included. */
  count: number;
  /** Nothing inside at all. */
  empty: boolean;
  open: boolean;
  onToggle(open: boolean): void;
  space: Space;
  children: ReactNode;
}) {
  const store = useTaskStore();
  const newNote = useNewNote();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [addingFolder, setAddingFolder] = useState(false);
  const drop = useDroppable({ id: `${FOLDER_PREFIX}${folder.id}` });
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
        <div
          ref={drop.setNodeRef}
          data-note-folder={folder.id}
          className={cx(rowBaseClass, "relative pr-1", drop.isOver && DROP_OVER_CLASS)}
        >
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
            <FoldChevron open={open} size={12} />
            {open ? (
              <FolderOpenIcon size={14} className="shrink-0" />
            ) : (
              <Folder size={14} className="shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
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
            folders={folders}
            open={menu}
            onOpenChange={setMenu}
            onNewNote={add}
            onNewFolder={() => {
              onToggle(true);
              setAddingFolder(true);
            }}
            onRename={() => setRenaming(true)}
          />
          <span className="w-5 text-right text-[12.5px] text-ink-3 tabular-nums">
            {count > 0 ? count : ""}
          </span>
        </div>
      )}
      {open && (
        <div className={FOLD_CHILDREN_CLASS}>
          {children}
          {addingFolder && (
            <InlineInput
              initial=""
              placeholder="Folder name"
              autoFocus
              className="my-px"
              onCommit={(name) => {
                setAddingFolder(false);
                void createNoteFolder(store, name, space, folder.id);
              }}
              onCancel={() => setAddingFolder(false)}
            />
          )}
          {empty && !addingFolder && (
            <p className="px-2.5 py-1 text-[12.5px] text-ink-3">Empty folder</p>
          )}
        </div>
      )}
    </div>
  );
}

/** While a note in a folder is dragged: a strip that takes it out of any folder. Dropping
 * next to a note outside any folder does the same, at that place. */
function TopLevelDrop() {
  const drop = useDroppable({ id: FOLDER_PREFIX });
  return (
    <p
      ref={drop.setNodeRef}
      data-note-folder=""
      className={cx(
        "rounded-lg border border-dashed border-line-strong px-2.5 py-1 text-[12.5px] text-ink-3",
        drop.isOver && DROP_OVER_CLASS,
      )}
    >
      Drop here for no folder
    </p>
  );
}

/** What the pointer is over during a drag, as a target for the dragged note. */
function targetOf(event: DragMoveEvent | DragEndEvent): NoteDropTarget | null {
  const over = event.over;
  if (!over) return null;
  const key = String(over.id);
  if (key.startsWith(FOLDER_PREFIX)) {
    return { kind: "folder", id: key.slice(FOLDER_PREFIX.length) || null };
  }
  if (!key.startsWith(NOTE_PREFIX)) return null;
  const moved = event.active.rect.current.translated;
  const middle = over.rect.top + over.rect.height / 2;
  const after = moved ? moved.top + moved.height / 2 > middle : false;
  return { kind: "note", id: key.slice(NOTE_PREFIX.length), after };
}

/**
 * The sidebar's Notes (ADR 032): the folder tree (folders nest, ADR 042), then the notes
 * outside any folder. Each note opens its own page. The section header owns the New folder button;
 * `addingFolder` shows the name input under the tree.
 */
export function NotesTree({
  space = "personal",
  addingFolder: shownAdding,
  onAddingFolder,
}: {
  space?: Space;
  /** Set by a header that owns the New folder button; without it the tree shows its own. */
  addingFolder?: boolean;
  onAddingFolder?: (adding: boolean) => void;
} = {}) {
  const store = useTaskStore();
  const notes = useStoreState((s) => s.notes);
  const folders = useStoreState((s) => s.note_folders);
  const teamIds = useStoreState((s) => s.teamIds);
  const [isOpen, setOpen] = useOpenFolders();
  const [ownAdding, setOwnAdding] = useState(false);
  const addingFolder = shownAdding ?? ownAdding;
  const setAddingFolder = onAddingFolder ?? setOwnAdding;
  // Personal and team notes show in their own sections (ADR 033).
  const tree = useMemo(() => {
    const mine = (id: string) => (teamIds[id] === true) === (space === "team");
    return noteTree(
      Object.values(notes).filter((n) => mine(n.id)),
      Object.values(folders).filter((f) => mine(f.id)),
    );
  }, [notes, folders, teamIds, space]);
  const choices = useMemo(() => {
    const mine = Object.fromEntries(
      Object.entries(folders).filter(([id]) => (teamIds[id] === true) === (space === "team")),
    );
    return folderOptions(mine);
  }, [folders, teamIds, space]);
  const empty = !tree.loose.length && !tree.folders.length;

  // Drag a note onto a folder (to its end), next to another note, or onto the top level.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [dragged, setDragged] = useState<string | null>(null);
  const [target, setTarget] = useState<NoteDropTarget | null>(null);
  // A drop ends with a click on the dragged link: cancel its navigation (see ProjectTree).
  const droppedAt = useRef(0);
  useEffect(() => {
    const onClick = (e: globalThis.MouseEvent) => {
      if (Date.now() - droppedAt.current < 250) e.preventDefault();
    };
    window.addEventListener("click", onClick, { capture: true });
    return () => window.removeEventListener("click", onClick, { capture: true });
  }, []);
  const noteId = (key: string | number) => String(key).slice(NOTE_PREFIX.length);
  const end = () => {
    droppedAt.current = Date.now();
    setDragged(null);
    setTarget(null);
  };
  const onDragEnd = (event: DragEndEvent) => {
    const id = noteId(event.active.id);
    const to = targetOf(event);
    end();
    if (!to) return;
    const s = store.getState();
    const place = notePlacement(s.notes, s.note_folders, id, to);
    if (!place) return;
    if (place.folderId) setOpen(place.folderId, true);
    void placeNote(store, id, place);
  };
  const hintFor = (id: string) =>
    dragged && target?.kind === "note" && target.id === id && target.id !== dragged
      ? target.after
        ? "after"
        : "before"
      : null;
  const draggedNote = dragged ? notes[dragged] : undefined;
  const renderFolder = (node: FolderNode): ReactNode => (
    <FolderRow
      key={node.folder.id}
      folder={node.folder}
      folders={choices}
      count={notesInside(node)}
      empty={!node.notes.length && !node.children.length}
      open={isOpen(node.folder.id)}
      onToggle={(open) => setOpen(node.folder.id, open)}
      space={space}
    >
      {node.children.map((child) => renderFolder(child))}
      {node.notes.map((n) => (
        <NoteRow key={n.id} note={n} folders={choices} hint={hintFor(n.id)} />
      ))}
    </FolderRow>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={(event: DragStartEvent) => {
        // Armed for the whole drag: the drop's click can arrive before onDragEnd runs.
        droppedAt.current = Number.POSITIVE_INFINITY;
        setDragged(noteId(event.active.id));
      }}
      onDragMove={(event: DragMoveEvent) => setTarget(targetOf(event))}
      onDragEnd={onDragEnd}
      onDragCancel={end}
    >
      {tree.folders.map((node) => renderFolder(node))}
      {tree.loose.map((n) => (
        <NoteRow key={n.id} note={n} folders={choices} hint={hintFor(n.id)} />
      ))}
      {draggedNote?.folder_id && <TopLevelDrop />}
      <DragOverlay dropAnimation={null}>
        {draggedNote && (
          <div className="flex items-center gap-2.5 rounded-lg border border-line-strong bg-overlay px-2.5 py-[5px] text-ink shadow-lg shadow-black/20">
            <FileTextIcon size={14} className="shrink-0" />
            <span className="max-w-52 truncate">{noteTitle(draggedNote)}</span>
          </div>
        )}
      </DragOverlay>
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
            void createNoteFolder(store, name, space);
          }}
          onCancel={() => setAddingFolder(false)}
        />
      ) : (
        shownAdding === undefined && (
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
        )
      )}
    </DndContext>
  );
}

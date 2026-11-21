// Notes (ADR 032): markdown pages in the sidebar, in folders one level deep. A note may be
// attached to a task, and its body links tasks and projects with `[text](task:<id>)` and
// `[text](project:<id>)`. Pure helpers shared by the sidebar, the note page, the markdown
// view and the task panel.

import type { Note, NoteChange, NoteFolder } from "./types";

export const TASK_SCHEME = "task:";
export const PROJECT_SCHEME = "project:";

const ID = /^[0-9a-f-]{36}$/i;

/** The task or project a `task:<id>` / `project:<id>` link points at, else null. */
export function entityLink(
  url: string | null | undefined,
): { kind: "task" | "project"; id: string } | null {
  if (!url) return null;
  for (const [kind, scheme] of [
    ["task", TASK_SCHEME],
    ["project", PROJECT_SCHEME],
  ] as const) {
    if (url.startsWith(scheme)) {
      const id = url.slice(scheme.length);
      return ID.test(id) ? { kind, id } : null;
    }
  }
  return null;
}

/** Brackets and backslashes would end the link text early. */
function linkText(text: string): string {
  return text.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/** The markdown linking a task (what `[[` inserts). */
export function taskLinkMarkdown(task: { id: string; title: string }): string {
  return `[${linkText(task.title.trim() || "Untitled task")}](${TASK_SCHEME}${task.id})`;
}

/** Whitespace (line breaks included) tidied to single spaces, as the core stores titles. */
export function tidy(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** A note's title as shown: blank ones read "Untitled". */
export function noteTitle(note: Pick<Note, "title">): string {
  return note.title.trim() || "Untitled";
}

/** The note with `changes` applied, as the core would store it. */
export function applyNoteChanges(note: Note, changes: NoteChange[], now: number): Note {
  const next = { ...note, updated_at: now };
  for (const change of changes) {
    if ("title" in change && change.title !== undefined) next.title = tidy(change.title);
    else if ("body" in change && change.body !== undefined) next.body = change.body;
    else if ("folder_id" in change) next.folder_id = change.folder_id ?? null;
    else if ("task_id" in change) next.task_id = change.task_id ?? null;
    else if ("rank" in change && change.rank !== undefined) next.rank = change.rank;
  }
  return next;
}

/** Ids of the tasks a note's body links to, in order, without repeats. */
export function linkedTaskIds(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(/\]\(task:([0-9a-f-]{36})\)/gi))
    ids.add((m[1] as string).toLowerCase());
  return [...ids];
}

/**
 * The notes about a task: those attached to it first, then those that link to it, each
 * group most recently edited first.
 */
export function notesForTask(
  notes: Iterable<Note>,
  taskId: string,
): { note: Note; attached: boolean }[] {
  const attached: Note[] = [];
  const linking: Note[] = [];
  const needle = `](${TASK_SCHEME}${taskId})`.toLowerCase();
  for (const note of notes) {
    if (note.task_id === taskId) attached.push(note);
    else if (note.body.toLowerCase().includes(needle)) linking.push(note);
  }
  const recent = (a: Note, b: Note) => b.updated_at - a.updated_at;
  return [
    ...attached.sort(recent).map((note) => ({ note, attached: true })),
    ...linking.sort(recent).map((note) => ({ note, attached: false })),
  ];
}

export interface NoteTree {
  folders: { folder: NoteFolder; notes: Note[] }[];
  /** Notes at the top level (or in a folder that no longer exists). */
  loose: Note[];
}

function compareRank(a: { rank: string; id: string }, b: { rank: string; id: string }) {
  return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Folders in order with their notes in order, and the top-level notes. */
export function noteTree(notes: Iterable<Note>, folders: Iterable<NoteFolder>): NoteTree {
  const byFolder = new Map<string, Note[]>();
  const sortedFolders = [...folders].sort(compareRank);
  for (const f of sortedFolders) byFolder.set(f.id, []);
  const loose: Note[] = [];
  for (const note of notes) {
    const list = note.folder_id ? byFolder.get(note.folder_id) : undefined;
    (list ?? loose).push(note);
  }
  return {
    folders: sortedFolders.map((folder) => ({
      folder,
      notes: (byFolder.get(folder.id) ?? []).sort(compareRank),
    })),
    loose: loose.sort(compareRank),
  };
}

/** Where a dragged note is dropped in the sidebar: on a folder (`null`: the top level), or
 * just before or after another note. */
export type NoteDropTarget =
  | { kind: "folder"; id: string | null }
  | { kind: "note"; id: string; after: boolean };

/** The folder a dragged note lands in and the ranks either side of its new place. */
export interface NotePlace {
  folderId: string | null;
  before: string | null;
  after: string | null;
}

/**
 * Where `draggedId` goes when dropped on `target`, or null when it would not move. On a
 * folder it goes to the end; on a note, into that note's folder next to it.
 */
export function notePlacement(
  notes: Record<string, Note>,
  folders: Record<string, NoteFolder>,
  draggedId: string,
  target: NoteDropTarget,
): NotePlace | null {
  const dragged = notes[draggedId];
  if (!dragged) return null;
  const folderOf = (n: Note) => (n.folder_id && folders[n.folder_id] ? n.folder_id : null);
  const from = folderOf(dragged);
  const inFolder = (folderId: string | null) =>
    Object.values(notes)
      .filter((n) => folderOf(n) === folderId)
      .sort(compareRank);

  if (target.kind === "folder") {
    if (target.id !== null && !folders[target.id]) return null;
    if (target.id === from) return null;
    const last = inFolder(target.id).at(-1);
    return { folderId: target.id, before: last?.rank ?? null, after: null };
  }
  const anchor = notes[target.id];
  if (!anchor || anchor.id === draggedId) return null;
  const folderId = folderOf(anchor);
  const all = inFolder(folderId);
  const at = all.findIndex((n) => n.id === anchor.id);
  const slot = target.after ? at + 1 : at;
  // Already right there: the dragged note is the neighbour on that side.
  if (folderId === from && (all[slot]?.id === draggedId || all[slot - 1]?.id === draggedId))
    return null;
  const others = all.filter((n) => n.id !== draggedId);
  const i = others.findIndex((n) => n.id === anchor.id);
  const [prev, next] = target.after ? [others[i], others[i + 1]] : [others[i - 1], others[i]];
  return { folderId, before: prev?.rank ?? null, after: next?.rank ?? null };
}

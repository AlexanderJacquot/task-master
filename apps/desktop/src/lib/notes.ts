// Notes (ADR 032): markdown pages in the sidebar, in folders one level deep. A note may be
// attached to a task, and its body links tasks, projects, epics and meetings with
// `[text](task:<id>)`, `[text](project:<id>)`, `[text](epic:<id>)` and
// `[text](meeting:<id>)` (ADR 042). Pure helpers shared by the sidebar, the note page, the
// markdown view, the task panel and the project, epic and meeting pages.

import { isoDate } from "./dates";
import type { Meeting, Note, NoteChange, NoteFolder } from "./types";

export const TASK_SCHEME = "task:";
export const PROJECT_SCHEME = "project:";
export const EPIC_SCHEME = "epic:";
export const MEETING_SCHEME = "meeting:";

/** What a link in a note can point at. */
export type EntityKind = "task" | "project" | "epic" | "meeting";

const SCHEMES: readonly (readonly [EntityKind, string])[] = [
  ["task", TASK_SCHEME],
  ["project", PROJECT_SCHEME],
  ["epic", EPIC_SCHEME],
  ["meeting", MEETING_SCHEME],
];

const schemeOf = (kind: EntityKind) => SCHEMES.find(([k]) => k === kind)?.[1] ?? TASK_SCHEME;

const ID = /^[0-9a-f-]{36}$/i;

/** The task, project, epic or meeting a `<kind>:<id>` link points at, else null. */
export function entityLink(
  url: string | null | undefined,
): { kind: EntityKind; id: string } | null {
  if (!url) return null;
  for (const [kind, scheme] of SCHEMES) {
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

const UNTITLED: Record<EntityKind, string> = {
  task: "Untitled task",
  project: "Untitled project",
  epic: "Untitled epic",
  meeting: "Meeting",
};

/** The markdown linking a task, project, epic or meeting (what `[[` inserts). */
export function linkMarkdown(kind: EntityKind, id: string, label: string): string {
  return `[${linkText(label.trim() || UNTITLED[kind])}](${schemeOf(kind)}${id})`;
}

/** The markdown linking a task. */
export function taskLinkMarkdown(task: { id: string; title: string }): string {
  return linkMarkdown("task", task.id, task.title);
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

/** Ids a note's body links with `kind` links, lowercase, in order, without repeats. */
export function linkedIds(body: string, kind: EntityKind): string[] {
  const pattern = new RegExp(`\\]\\(${schemeOf(kind)}([0-9a-f-]{36})\\)`, "gi");
  const ids = new Set<string>();
  for (const m of body.matchAll(pattern)) ids.add((m[1] as string).toLowerCase());
  return [...ids];
}

/** Ids of the tasks a note's body links to, in order, without repeats. */
export function linkedTaskIds(body: string): string[] {
  return linkedIds(body, "task");
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

/** A folder with its notes and the folders inside it, each in order (ADR 042). */
export interface FolderNode {
  folder: NoteFolder;
  notes: Note[];
  children: FolderNode[];
}

export interface NoteTree {
  /** The top-level folders (or those whose parent no longer exists). */
  folders: FolderNode[];
  /** Notes at the top level (or in a folder that no longer exists). */
  loose: Note[];
}

function compareRank(a: { rank: string; id: string }, b: { rank: string; id: string }) {
  return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The folder tree in order, with each folder's notes in order, and the top-level notes. */
export function noteTree(notes: Iterable<Note>, folders: Iterable<NoteFolder>): NoteTree {
  const list = [...folders].sort(compareRank);
  const nodes = new Map<string, FolderNode>(
    list.map((folder) => [folder.id, { folder, notes: [], children: [] }]),
  );
  const loose: Note[] = [];
  for (const note of notes) {
    const node = note.folder_id ? nodes.get(note.folder_id) : undefined;
    (node?.notes ?? loose).push(note);
  }
  for (const node of nodes.values()) node.notes.sort(compareRank);
  // Attach each folder under its parent; a missing parent, or a loop a bad merge left,
  // puts it at the top.
  const placed = new Set<string>();
  const roots: FolderNode[] = [];
  const attach = (node: FolderNode, seen: Set<string>) => {
    if (placed.has(node.folder.id)) return;
    const parentId = node.folder.parent_id ?? null;
    const parent = parentId && !seen.has(parentId) ? nodes.get(parentId) : undefined;
    if (parent) {
      attach(parent, new Set([...seen, node.folder.id]));
      if (placed.has(parent.folder.id)) {
        parent.children.push(node);
        placed.add(node.folder.id);
        return;
      }
    }
    roots.push(node);
    placed.add(node.folder.id);
  };
  for (const node of nodes.values()) attach(node, new Set([node.folder.id]));
  for (const node of nodes.values()) node.children.sort((a, b) => compareRank(a.folder, b.folder));
  roots.sort((a, b) => compareRank(a.folder, b.folder));
  return { folders: roots, loose: loose.sort(compareRank) };
}

/** A folder's path from the top, `Data / Onboarding`. */
export function folderPath(folders: Record<string, NoteFolder>, id: string): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let current: string | null | undefined = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const folder: NoteFolder | undefined = folders[current];
    if (!folder) break;
    names.unshift(folder.name);
    current = folder.parent_id;
  }
  return names.join(" / ");
}

/** Every folder in tree order with its path and depth (0 at the top), for menus. */
export function folderOptions(
  folders: Record<string, NoteFolder>,
): { folder: NoteFolder; path: string; depth: number }[] {
  const out: { folder: NoteFolder; path: string; depth: number }[] = [];
  const walk = (nodes: FolderNode[], depth: number, prefix: string) => {
    for (const node of nodes) {
      const path = prefix ? `${prefix} / ${node.folder.name}` : node.folder.name;
      out.push({ folder: node.folder, path, depth });
      walk(node.children, depth + 1, path);
    }
  };
  walk(noteTree([], Object.values(folders)).folders, 0, "");
  return out;
}

/** The folder and every folder inside it, at any depth. */
export function folderAndInside(folders: Record<string, NoteFolder>, id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of Object.values(folders))
      if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
  }
  return out;
}

/** Notes in a folder node and every folder inside it. */
export function notesInside(node: FolderNode): number {
  return node.notes.length + node.children.reduce((n, c) => n + notesInside(c), 0);
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

/** Why a note shows on a project's or an epic's page. */
export type NoteReason =
  | "links-project"
  | "links-epic"
  | "links-meeting"
  | "attached"
  | "links-task";

/** A note on a project's or an epic's page, and why it is there. */
export interface NoteAbout {
  note: Note;
  reason: NoteReason;
  /** The task it is attached to or links ("attached", "links-task"). */
  taskId: string | null;
  /** The meeting it links ("links-meeting"). */
  meetingId: string | null;
  /** The epic it links ("links-epic"). */
  epicId: string | null;
}

const lowered = (ids: Iterable<string>) => new Set([...ids].map((id) => id.toLowerCase()));

/**
 * The notes about a set of things, most recently edited first: those linking one of
 * `direct`'s ids, linking one of `meetings`, attached to a task `ofTask` accepts, or
 * linking one. Ids are compared lowercase.
 */
function notesAbout(
  notes: Iterable<Note>,
  direct: { kind: EntityKind; ids: ReadonlySet<string>; reason: NoteReason }[],
  meetings: ReadonlySet<string>,
  ofTask: (taskId: string) => boolean,
): NoteAbout[] {
  const out: NoteAbout[] = [];
  for (const note of notes) {
    const none = { taskId: null, meetingId: null, epicId: null };
    let hit: NoteAbout | null = null;
    for (const d of direct) {
      const id = linkedIds(note.body, d.kind).find((x) => d.ids.has(x));
      if (id) {
        hit = { note, reason: d.reason, ...none, ...(d.kind === "epic" && { epicId: id }) };
        break;
      }
    }
    if (hit) {
      out.push(hit);
      continue;
    }
    const meeting = linkedIds(note.body, "meeting").find((id) => meetings.has(id));
    if (meeting) out.push({ note, reason: "links-meeting", ...none, meetingId: meeting });
    else if (note.task_id && ofTask(note.task_id))
      out.push({ note, reason: "attached", ...none, taskId: note.task_id });
    else {
      const linked = linkedTaskIds(note.body).find(ofTask);
      if (linked) out.push({ note, reason: "links-task", ...none, taskId: linked });
    }
  }
  return out.sort((a, b) => b.note.updated_at - a.note.updated_at);
}

/** Finds a store entry by an id that may have lost its case in a link. */
function byId<T>(record: Record<string, T>): (id: string) => T | undefined {
  const lower = new Map(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]));
  return (id) => record[id] ?? lower.get(id.toLowerCase());
}

/**
 * The notes about a project (on its page): those linking to it, to one of its epics or
 * meetings, attached to one of its tasks, or linking one of its tasks, most recently edited
 * first. `projectIds` are the project and, for an area, its projects.
 */
export function notesForProject(
  notes: Iterable<Note>,
  tasks: Record<string, { project_id: string | null }>,
  projectIds: ReadonlySet<string>,
  epics: Record<string, { project_id: string | null }> = {},
  meetings: Record<string, { project_id: string | null; deleted_at: number | null }> = {},
): NoteAbout[] {
  const inProject = (id: string | null | undefined) => !!id && projectIds.has(id);
  const task = byId(tasks);
  return notesAbout(
    notes,
    [
      { kind: "project", ids: lowered(projectIds), reason: "links-project" },
      {
        kind: "epic",
        ids: lowered(
          Object.entries(epics)
            .filter(([, e]) => inProject(e.project_id))
            .map(([id]) => id),
        ),
        reason: "links-epic",
      },
    ],
    lowered(
      Object.entries(meetings)
        .filter(([, m]) => m.deleted_at === null && inProject(m.project_id))
        .map(([id]) => id),
    ),
    (taskId) => inProject(task(taskId)?.project_id),
  );
}

/**
 * The notes about an epic (on its page): those linking to it or to one of its meetings,
 * attached to one of its tasks, or linking one (a subtask counts for its parent's epic),
 * most recently edited first.
 */
export function notesForEpic(
  notes: Iterable<Note>,
  tasks: Record<string, { epic_id: string | null; parent_id: string | null }>,
  epicId: string,
  meetings: Record<string, { epic_id: string | null; deleted_at: number | null }> = {},
): NoteAbout[] {
  const task = byId(tasks);
  const ofEpic = (taskId: string) => {
    const t = task(taskId);
    if (!t) return false;
    return t.epic_id === epicId || (!!t.parent_id && task(t.parent_id)?.epic_id === epicId);
  };
  return notesAbout(
    notes,
    [{ kind: "epic", ids: lowered([epicId]), reason: "links-epic" }],
    lowered(
      Object.entries(meetings)
        .filter(([, m]) => m.deleted_at === null && m.epic_id === epicId)
        .map(([id]) => id),
    ),
    ofEpic,
  );
}

/** The notes that link a meeting (on its page), most recently edited first. */
export function notesForMeeting(notes: Iterable<Note>, meetingId: string): Note[] {
  const id = meetingId.toLowerCase();
  return [...notes]
    .filter((n) => linkedIds(n.body, "meeting").includes(id))
    .sort((a, b) => b.updated_at - a.updated_at);
}

/** What a meeting note's first line links besides the meeting. */
export interface MeetingNoteLinks {
  task?: { id: string; title: string } | undefined;
  epic?: { id: string; name: string } | undefined;
  project?: { id: string; name: string } | undefined;
}

/** A meeting note's line of links: the meeting, then its task, epic and project when set. */
export function meetingNoteHeader(meeting: Meeting, links: MeetingNoteLinks): string {
  const parts = [linkMarkdown("meeting", meeting.id, meeting.title)];
  if (links.task) parts.push(linkMarkdown("task", links.task.id, links.task.title));
  if (links.epic) parts.push(linkMarkdown("epic", links.epic.id, links.epic.name));
  if (links.project) parts.push(linkMarkdown("project", links.project.id, links.project.name));
  return parts.join(" · ");
}

/** The title of the note a meeting writes: its title and day. */
export function meetingNoteTitle(meeting: Meeting): string {
  return `${meeting.title.trim() || "Meeting"} (${isoDate(new Date(meeting.started_at))})`;
}

/** The markdown linking a project, as a note about it starts. */
export function projectLinkMarkdown(project: { id: string; name: string }): string {
  return linkMarkdown("project", project.id, project.name);
}

/** The markdown linking an epic, as a note about it starts. */
export function epicLinkMarkdown(epic: { id: string; name: string }): string {
  return linkMarkdown("epic", epic.id, epic.name);
}

/**
 * A note search snippet as plain words: link targets (`(task:<id>)`, cut short too) and
 * markdown marks dropped, the match brackets removed.
 */
export function noteSnippet(snippet: string): string {
  return snippet
    .replace(/\]?\((?:task|project|epic|meeting|attachment|https?|mailto):[^)\s]*(?:\)|…|$)/gi, "")
    .replace(/[[\]]/g, "")
    .replace(/(^|\s)(?:#{1,6}|[-*+]|>|\d+\.)\s+/g, "$1")
    .replace(/[*_`~!]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

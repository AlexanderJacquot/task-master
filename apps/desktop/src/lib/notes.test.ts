import { describe, expect, it } from "vitest";
import { note, noteFolder } from "../test/fixtures";
import {
  applyNoteChanges,
  entityLink,
  linkedTaskIds,
  notePlacement,
  noteSnippet,
  notesForProject,
  notesForTask,
  noteTitle,
  noteTree,
  projectLinkMarkdown,
  taskLinkMarkdown,
} from "./notes";

const TASK = "0192f0c6-0000-7000-8000-000000000001";
const OTHER = "0192f0c6-0000-7000-8000-000000000002";

describe("note links", () => {
  it("reads task and project links, and nothing else", () => {
    expect(entityLink(`task:${TASK}`)).toEqual({ kind: "task", id: TASK });
    expect(entityLink(`project:${OTHER}`)).toEqual({ kind: "project", id: OTHER });
    expect(entityLink("task:not-an-id")).toBeNull();
    expect(entityLink("https://example.com")).toBeNull();
    expect(entityLink(undefined)).toBeNull();
  });

  it("writes a task link with its brackets escaped", () => {
    expect(taskLinkMarkdown({ id: TASK, title: "Fix [urgent] bug" })).toBe(
      `[Fix \\[urgent\\] bug](task:${TASK})`,
    );
    expect(taskLinkMarkdown({ id: TASK, title: "  " })).toBe(`[Untitled task](task:${TASK})`);
  });

  it("lists the tasks a body links to, once each", () => {
    const body = `See [a](task:${TASK}), [b](task:${OTHER}) and [a again](task:${TASK}).`;
    expect(linkedTaskIds(body)).toEqual([TASK, OTHER]);
  });
});

describe("notes of a task", () => {
  it("puts attached notes first, then the ones linking to it, newest first", () => {
    const old = note({ task_id: TASK, updated_at: 1 });
    const recent = note({ task_id: TASK, updated_at: 5 });
    const linking = note({ body: `About [it](task:${TASK})`, updated_at: 9 });
    const unrelated = note({ body: `[x](task:${OTHER})` });
    const list = notesForTask([old, linking, unrelated, recent], TASK);
    expect(list.map((n) => [n.note.id, n.attached])).toEqual([
      [recent.id, true],
      [old.id, true],
      [linking.id, false],
    ]);
  });
});

describe("the notes tree", () => {
  it("orders folders and notes by rank; notes of a missing folder are loose", () => {
    const b = noteFolder({ name: "B", rank: "a2" });
    const a = noteFolder({ name: "A", rank: "a1" });
    const inA2 = note({ folder_id: a.id, rank: "a2" });
    const inA1 = note({ folder_id: a.id, rank: "a1" });
    const loose = note({ rank: "a5" });
    const orphan = note({ folder_id: "gone", rank: "a1" });
    const tree = noteTree([inA2, loose, inA1, orphan], [b, a]);
    expect(tree.folders.map((f) => f.folder.name)).toEqual(["A", "B"]);
    expect(tree.folders[0]?.notes.map((n) => n.id)).toEqual([inA1.id, inA2.id]);
    expect(tree.folders[1]?.notes).toEqual([]);
    expect(tree.loose.map((n) => n.id)).toEqual([orphan.id, loose.id]);
  });
});

describe("note edits", () => {
  it("applies changes as the core stores them", () => {
    const n = note({ title: "Old" });
    const next = applyNoteChanges(
      n,
      [{ title: "  New\n title " }, { body: "# Hi" }, { task_id: TASK }, { folder_id: null }],
      42,
    );
    expect(next).toMatchObject({ title: "New title", body: "# Hi", task_id: TASK, updated_at: 42 });
    expect(noteTitle({ title: " " })).toBe("Untitled");
  });
});

describe("dropping a dragged note", () => {
  const f = noteFolder({ id: "f", rank: "m" });
  const a = note({ id: "a", rank: "b" });
  const b = note({ id: "b", rank: "d" });
  const c = note({ id: "c", rank: "f" });
  const x = note({ id: "x", rank: "c", folder_id: "f" });
  const y = note({ id: "y", rank: "e", folder_id: "f" });
  const notes = Object.fromEntries([a, b, c, x, y].map((n) => [n.id, n]));
  const folders = { f };

  it("goes to the end of a folder dropped on, or of the top level", () => {
    expect(notePlacement(notes, folders, "a", { kind: "folder", id: "f" })).toEqual({
      folderId: "f",
      before: "e",
      after: null,
    });
    expect(notePlacement(notes, folders, "x", { kind: "folder", id: null })).toEqual({
      folderId: null,
      before: "f",
      after: null,
    });
    // Its own folder, or a folder that is gone: nothing moves.
    expect(notePlacement(notes, folders, "x", { kind: "folder", id: "f" })).toBeNull();
    expect(notePlacement(notes, folders, "a", { kind: "folder", id: "gone" })).toBeNull();
  });

  it("goes before or after a note dropped on, in that note's folder", () => {
    expect(notePlacement(notes, folders, "c", { kind: "note", id: "a", after: false })).toEqual({
      folderId: null,
      before: null,
      after: "b",
    });
    expect(notePlacement(notes, folders, "a", { kind: "note", id: "b", after: true })).toEqual({
      folderId: null,
      before: "d",
      after: "f",
    });
    expect(notePlacement(notes, folders, "a", { kind: "note", id: "x", after: true })).toEqual({
      folderId: "f",
      before: "c",
      after: "e",
    });
    expect(notePlacement(notes, folders, "y", { kind: "note", id: "c", after: true })).toEqual({
      folderId: null,
      before: "f",
      after: null,
    });
  });

  it("does nothing when it would land where it is", () => {
    expect(notePlacement(notes, folders, "a", { kind: "note", id: "a", after: true })).toBeNull();
    expect(notePlacement(notes, folders, "a", { kind: "note", id: "b", after: false })).toBeNull();
    expect(notePlacement(notes, folders, "b", { kind: "note", id: "a", after: true })).toBeNull();
    expect(notePlacement(notes, folders, "missing", { kind: "folder", id: "f" })).toBeNull();
  });
});

describe("notes of a project", () => {
  const P = "0192f0c6-0000-7000-8000-0000000000aa";
  const CHILD = "0192f0c6-0000-7000-8000-0000000000ab";
  const T = "0192f0c6-0000-7000-8000-0000000000b1";
  const U = "0192f0c6-0000-7000-8000-0000000000b2";
  const tasks = { [T]: { project_id: P }, [U]: { project_id: CHILD }, other: { project_id: null } };

  it("lists notes linking it, attached to its tasks or linking them, newest first", () => {
    const linking = note({ body: `About [the app](project:${P.toUpperCase()})`, updated_at: 5 });
    const attached = note({ task_id: T, updated_at: 9 });
    const viaTask = note({ body: `see [u](task:${U})`, updated_at: 7 });
    const unrelated = note({ task_id: "other", body: "nothing" });
    const all = [linking, attached, viaTask, unrelated];
    expect(
      notesForProject(all, tasks, new Set([P])).map((n) => [n.note.id, n.reason, n.taskId]),
    ).toEqual([
      [attached.id, "attached", T],
      [linking.id, "links-project", null],
    ]);
    // An area's page includes its projects' notes.
    expect(notesForProject(all, tasks, new Set([P, CHILD])).map((n) => n.reason)).toEqual([
      "attached",
      "links-task",
      "links-project",
    ]);
  });

  it("writes a project link with its brackets escaped", () => {
    expect(projectLinkMarkdown({ id: P, name: "App [v2]" })).toBe(`[App \\[v2\\]](project:${P})`);
  });
});

describe("note snippets", () => {
  it("reads as plain words, without link targets or markdown marks", () => {
    expect(
      noteSnippet(
        "[Budget] approved. First: [Order seeds](task:01a1fb6d-87a8-7000-8000-0000000000aa) then",
      ),
    ).toBe("Budget approved. First: Order seeds then");
    expect(noteSnippet("## Plan\n- **[seed]** list [x](task:01a1fb6d-87a8…")).toBe(
      "Plan seed list x",
    );
  });
});

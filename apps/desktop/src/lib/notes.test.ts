import { describe, expect, it } from "vitest";
import { note, noteFolder } from "../test/fixtures";
import {
  applyNoteChanges,
  entityLink,
  linkedTaskIds,
  notesForTask,
  noteTitle,
  noteTree,
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

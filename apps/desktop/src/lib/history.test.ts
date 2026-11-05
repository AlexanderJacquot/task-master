import { describe, expect, it } from "vitest";
import { STATUS, task } from "../test/fixtures";
import { diffLines } from "./diff";
import { isEmptyPlan, isRestorable, type Known, planRestore } from "./history";
import type { Activity } from "./types";

let seq = 100;
function entry(kind: string, fields: Array<[string, unknown, unknown]>): Activity {
  seq -= 1;
  return {
    seq,
    at: seq * 1000,
    batch_id: null,
    kind,
    fields: fields.map(([field, before, after]) => ({
      field,
      before: JSON.stringify(before),
      after: JSON.stringify(after),
    })),
  } as Activity;
}

const known: Known = {
  statuses: new Set([STATUS.todo, STATUS.done]),
  projects: new Set(["p-live"]),
  epics: new Set(),
  tags: new Set(["tag-a"]),
};

describe("planRestore", () => {
  // Newest first, as task_activity returns them. History:
  //   created "Draft" → title "Plan" → priority high → tag a added → title "Final"
  const now = task({ title: "Final", priority: "high", tag_ids: ["tag-a"] });
  const entries = [
    entry("update", [["title", "Plan", "Final"]]),
    entry("link", [["tag_id", null, "tag-a"]]),
    entry("update", [["priority", "normal", "high"]]),
    entry("update", [["title", "Draft", "Plan"]]),
    entry("create", []),
  ];

  it("undoes every later change, field by field, back to the chosen version", () => {
    expect(planRestore(now, entries, 3, known)).toEqual({
      changes: [{ priority: "normal" }, { title: "Plan" }],
      addTags: [],
      removeTags: ["tag-a"],
      skipped: [],
    });
    // The version right after creation: the first title wins over later ones.
    expect(planRestore(now, entries, 4, known).changes).toEqual([
      { title: "Draft" },
      { priority: "normal" },
    ]);
  });

  it("undoing the last change only touches that change", () => {
    expect(planRestore(now, entries, 1, known)).toMatchObject({
      changes: [{ title: "Plan" }],
      addTags: [],
      removeTags: [],
    });
  });

  it("skips values that point at deleted things, and files", () => {
    const t = task({ project_id: "p-live" });
    const list = [
      entry("attach", [["name", null, "a.pdf"]]),
      entry("update", [["project_id", "p-gone", "p-live"]]),
      entry("create", []),
    ];
    const plan = planRestore(t, list, 2, known);
    expect(plan.changes).toEqual([]);
    expect(plan.skipped).toEqual(["files", "a deleted project"]);
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it("knows which entries a restore can act on", () => {
    expect(isRestorable(entries[0] as Activity)).toBe(true);
    expect(isRestorable(entries[1] as Activity)).toBe(true);
    expect(isRestorable(entries[4] as Activity)).toBe(false);
    expect(isRestorable(entry("update", [["rank", "a", "b"]]))).toBe(false);
  });
});

describe("diffLines", () => {
  it("marks removed and added lines around the common ones", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
    expect(diffLines("", "new")).toEqual([
      { kind: "del", text: "" },
      { kind: "add", text: "new" },
    ]);
  });
});

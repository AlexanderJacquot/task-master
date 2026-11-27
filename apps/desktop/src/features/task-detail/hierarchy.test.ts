import { describe, expect, it } from "vitest";
import { STATUS, statuses, task } from "../../test/fixtures";
import { ancestorIds, parentCandidates, rankCandidates, subtaskCandidates } from "./hierarchy";

// root > mid > leaf, plus an unrelated task and an agent's task.
const root = task({ id: "root", title: "Root" });
const mid = task({ id: "mid", title: "Mid", parent_id: "root" });
const leaf = task({ id: "leaf", title: "Leaf", parent_id: "mid" });
const other = task({ id: "other", title: "Other" });
const bot = task({ id: "bot", title: "Bot", owner: "agent" });
const tasks = Object.fromEntries([root, mid, leaf, other, bot].map((t) => [t.id, t]));
const ids = (list: { id: string }[]) => list.map((t) => t.id).sort();

describe("ancestorIds", () => {
  it("walks up to the top, nearest first", () => {
    expect(ancestorIds("leaf", tasks)).toEqual(["mid", "root"]);
    expect(ancestorIds("root", tasks)).toEqual([]);
  });

  it("stops on a cycle", () => {
    const a = task({ id: "a", parent_id: "b" });
    const b = task({ id: "b", parent_id: "a" });
    expect(ancestorIds("a", { a, b })).toEqual(["b"]);
  });
});

describe("parentCandidates", () => {
  it("excludes the task, its subtasks, its current parent and agent tasks", () => {
    expect(ids(parentCandidates("mid", tasks))).toEqual(["other"]);
    expect(ids(parentCandidates("root", tasks))).toEqual(["other"]);
    expect(ids(parentCandidates("leaf", tasks))).toEqual(["other", "root"]);
  });
});

describe("subtaskCandidates", () => {
  it("excludes the parent, its ancestors, its direct subtasks and agent tasks", () => {
    expect(ids(subtaskCandidates("mid", tasks))).toEqual(["other"]);
    // A grandchild can be pulled up to be a direct subtask.
    expect(ids(subtaskCandidates("root", tasks))).toEqual(["leaf", "other"]);
    expect(ids(subtaskCandidates("other", tasks))).toEqual(["leaf", "mid", "root"]);
  });
});

describe("rankCandidates", () => {
  it("matches every word, open tasks first, then the most recent", () => {
    const old = task({ id: "old", title: "Write release notes", updated_at: 1 });
    const recent = task({ id: "recent", title: "Release notes draft", updated_at: 5 });
    const done = task({
      id: "done",
      title: "Notes for release",
      status_id: STATUS.done,
      updated_at: 9,
    });
    const miss = task({ id: "miss", title: "Release party" });
    const found = rankCandidates([old, done, miss, recent], "notes RELEASE", statuses);
    expect(found.map((t) => t.id)).toEqual(["recent", "old", "done"]);
  });
});

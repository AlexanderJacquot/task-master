import { describe, expect, it } from "vitest";
import type { Row } from "../../lib/views";
import { task } from "../../test/fixtures";
import { listDragGroup } from "./TaskList";

const a = task({ title: "a" });
const b = task({ title: "b" });
const c = task({ title: "c" });
const row = (t: typeof a): Row => ({
  type: "task",
  task: t,
  depth: 0,
  childCount: 0,
  childDone: 0,
  visibleChildren: 0,
  expanded: false,
});
const rows = [row(a), row(b), row(c)];

describe("listDragGroup", () => {
  it("drags one task when it is not in a selection of several", () => {
    expect(listDragGroup(rows, new Set(), a.id)).toBeNull();
    expect(listDragGroup(rows, new Set([a.id]), a.id)).toBeNull();
    expect(listDragGroup(rows, new Set([a.id, b.id]), c.id)).toBeNull();
  });

  it("drags the selection in list order, picked tasks off screen last", () => {
    expect(listDragGroup(rows, new Set(["hidden", c.id, a.id]), c.id)).toEqual([
      a.id,
      c.id,
      "hidden",
    ]);
  });
});

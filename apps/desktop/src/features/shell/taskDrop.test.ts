import { describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { isoDate } from "../../lib/dates";
import type { Changes, Command, Task } from "../../lib/types";
import { createTaskStore } from "../../store/store";
import { fakeParse, snapshot, task } from "../../test/fixtures";
import { applyTaskDrop, canDrop, dropKey, parseDropKey, type TaskDropTarget } from "./taskDrop";

async function setup(tasks: Task[]) {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot({ tasks }),
    execute: async (commands) => {
      executed.push(commands);
      return {
        batch_id: `b${executed.length}`,
        op_seq: executed.length,
        tasks: [],
        projects: [],
        epics: [],
        tags: [],
        views: [],
        attachments: [],
        time_blocks: [],
        agent_sessions: [],
        agent_notes: [],
        statuses: [],
      } as Changes;
    },
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
  };
  const store = createTaskStore(api);
  await store.getState().hydrate();
  return { store, executed };
}

const byId = (...tasks: Task[]) => Object.fromEntries(tasks.map((t) => [t.id, t]));

describe("drop keys", () => {
  it("round-trips every target", () => {
    const targets: TaskDropTarget[] = [
      { kind: "project", id: "p1" },
      { kind: "epic", id: "e1" },
      { kind: "today" },
      { kind: "subtask-of", id: "t1" },
      { kind: "parent-of", id: "t2" },
    ];
    for (const t of targets) expect(parseDropKey(dropKey(t))).toEqual(t);
  });

  it("rejects unknown keys", () => {
    expect(parseDropKey("tag:x")).toBeNull();
    expect(parseDropKey("project:")).toBeNull();
    expect(parseDropKey("nonsense")).toBeNull();
  });
});

describe("canDrop", () => {
  it("skips a drop that changes nothing", () => {
    const a = task({ project_id: "p1", epic_id: "e1", today_on: isoDate() });
    const tasks = byId(a);
    expect(canDrop({ kind: "project", id: "p1" }, a.id, tasks)).toBe(false);
    expect(canDrop({ kind: "project", id: "p2" }, a.id, tasks)).toBe(true);
    expect(canDrop({ kind: "epic", id: "e1" }, a.id, tasks)).toBe(false);
    expect(canDrop({ kind: "today" }, a.id, tasks)).toBe(false);
  });

  it("refuses a task on itself, its current parent, or a cycle", () => {
    const root = task();
    const mid = task({ parent_id: root.id });
    const leaf = task({ parent_id: mid.id });
    const other = task();
    const tasks = byId(root, mid, leaf, other);
    // Subtask of: not of itself, not of its parent already, not under its own subtree.
    expect(canDrop({ kind: "subtask-of", id: root.id }, root.id, tasks)).toBe(false);
    expect(canDrop({ kind: "subtask-of", id: mid.id }, leaf.id, tasks)).toBe(false);
    expect(canDrop({ kind: "subtask-of", id: leaf.id }, root.id, tasks)).toBe(false);
    expect(canDrop({ kind: "subtask-of", id: leaf.id }, other.id, tasks)).toBe(true);
    // Parent of: not when it already is, not of one of its own ancestors.
    expect(canDrop({ kind: "parent-of", id: leaf.id }, mid.id, tasks)).toBe(false);
    expect(canDrop({ kind: "parent-of", id: root.id }, leaf.id, tasks)).toBe(false);
    expect(canDrop({ kind: "parent-of", id: root.id }, other.id, tasks)).toBe(true);
  });
});

describe("applyTaskDrop", () => {
  it("moves a task to a project, an epic or today", async () => {
    const a = task();
    const { store, executed } = await setup([a]);
    await applyTaskDrop(store, a.id, { kind: "project", id: "p9" });
    await applyTaskDrop(store, a.id, { kind: "epic", id: "e9" });
    await applyTaskDrop(store, a.id, { kind: "today" });
    expect(executed).toEqual([
      [{ type: "update_task", id: a.id, changes: [{ project_id: "p9" }] }],
      [{ type: "update_task", id: a.id, changes: [{ epic_id: "e9" }] }],
      [{ type: "update_task", id: a.id, changes: [{ today_on: isoDate() }] }],
    ]);
    const after = store.getState().tasks[a.id];
    expect([after?.project_id, after?.epic_id, after?.today_on]).toEqual(["p9", "e9", isoDate()]);
  });

  it("makes the dragged task a subtask or the parent", async () => {
    const open = task();
    const dragged = task();
    const { store, executed } = await setup([open, dragged]);
    await applyTaskDrop(store, dragged.id, { kind: "subtask-of", id: open.id });
    expect(store.getState().tasks[dragged.id]?.parent_id).toBe(open.id);
    // Now its subtask, it cannot also become its parent (a cycle): nothing is sent.
    await applyTaskDrop(store, dragged.id, { kind: "parent-of", id: open.id });
    expect(executed).toEqual([[{ type: "set_parent", id: dragged.id, parent_id: open.id }]]);
  });

  it("makes the dragged task the parent of the open one", async () => {
    const open = task();
    const dragged = task();
    const { store, executed } = await setup([open, dragged]);
    await applyTaskDrop(store, dragged.id, { kind: "parent-of", id: open.id });
    expect(executed).toEqual([[{ type: "set_parent", id: open.id, parent_id: dragged.id }]]);
    expect(store.getState().tasks[open.id]?.parent_id).toBe(dragged.id);
  });
});

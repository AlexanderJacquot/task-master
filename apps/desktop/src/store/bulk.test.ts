import { describe, expect, it } from "vitest";
import type { Api } from "../lib/api";
import type { Changes, Command, Task } from "../lib/types";
import { fakeParse, project, STATUS, snapshot, task } from "../test/fixtures";
import { deleteTasks, setTaggedMany, updateTasks } from "./actions";
import { createTaskStore } from "./store";

/** Confirms every write with nothing; the optimistic state is what the tests read. */
async function setup(tasks: Task[], extra: Parameters<typeof snapshot>[0] = {}) {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot({ tasks, ...extra }),
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

describe("bulk edits", () => {
  it("sets the status of several tasks in one batch, skipping those already there", async () => {
    const a = task();
    const b = task();
    const c = task({ status_id: STATUS.done, completed_at: 5 });
    const { store, executed } = await setup([a, b, c]);
    await updateTasks(store, [a.id, b.id, c.id], [{ status_id: STATUS.done }]);
    expect(executed).toEqual([
      [
        { type: "update_task", id: a.id, changes: [{ status_id: STATUS.done }] },
        { type: "update_task", id: b.id, changes: [{ status_id: STATUS.done }] },
      ],
    ]);
    const s = store.getState();
    expect(s.tasks[a.id]?.status_id).toBe(STATUS.done);
    expect(s.tasks[a.id]?.completed_at).not.toBeNull();
    expect(s.tasks[c.id]?.completed_at).toBe(5);
  });

  it("sends nothing when no task would change", async () => {
    const a = task({ priority: "high" });
    const { store, executed } = await setup([a]);
    expect(await updateTasks(store, [a.id], [{ priority: "high" }])).toBeNull();
    expect(executed).toEqual([]);
  });

  it("moves tasks to a project and clears due dates", async () => {
    const p = project();
    const a = task({ due_date: "2026-11-20" });
    const b = task();
    const { store, executed } = await setup([a, b], { projects: [p] });
    await updateTasks(store, [a.id, b.id], [{ project_id: p.id }, { due_date: null }]);
    expect(executed[0]).toEqual([
      { type: "update_task", id: a.id, changes: [{ project_id: p.id }, { due_date: null }] },
      { type: "update_task", id: b.id, changes: [{ project_id: p.id }] },
    ]);
    expect(store.getState().tasks[a.id]?.due_date).toBeNull();
    expect(store.getState().tasks[b.id]?.project_id).toBe(p.id);
  });

  it("tags only the tasks without the tag, and untags only those with it", async () => {
    const a = task({ tag_ids: ["g1"] });
    const b = task();
    const tag = { id: "g1", name: "x", color: null, created_at: 1, updated_at: 1 };
    const tags = [{ ...tag, deleted_at: null }];
    const { store, executed } = await setup([a, b], { tags });
    await setTaggedMany(store, [a.id, b.id], "g1", true);
    expect(executed[0]).toEqual([{ type: "tag_task", task_id: b.id, tag_id: "g1" }]);
    expect(store.getState().tasks[b.id]?.tag_ids).toEqual(["g1"]);
    await setTaggedMany(store, [a.id, b.id], "g1", false);
    expect(executed[1]).toEqual([
      { type: "untag_task", task_id: a.id, tag_id: "g1" },
      { type: "untag_task", task_id: b.id, tag_id: "g1" },
    ]);
  });

  it("deletes picked tasks once, letting subtasks go with their picked parent", async () => {
    const parent = task();
    const child = task({ parent_id: parent.id });
    const grandchild = task({ parent_id: child.id });
    const other = task();
    const kept = task();
    const { store, executed } = await setup([parent, child, grandchild, other, kept]);
    await deleteTasks(store, [grandchild.id, parent.id, other.id]);
    expect(executed[0]).toEqual([
      { type: "delete_task", id: parent.id },
      { type: "delete_task", id: other.id },
    ]);
    expect(Object.keys(store.getState().tasks)).toEqual([kept.id]);
  });
});

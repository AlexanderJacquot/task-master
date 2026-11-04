import { describe, expect, it } from "vitest";
import type { Api } from "../lib/api";
import type { Changes, Command, Epic, Project, Task } from "../lib/types";
import { fakeParse, project, snapshot, task } from "../test/fixtures";
import { deleteEpic, moveProject, updateEpic, updateProject } from "./actions";
import { createTaskStore, type TaskStore } from "./store";

/** Confirms every write with nothing; the optimistic state is what the tests read. */
async function setup(data: { tasks?: Task[]; projects?: Project[]; epics?: Epic[] }) {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot(data),
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
  const store: TaskStore = createTaskStore(api);
  await store.getState().hydrate();
  return { store, executed };
}

const epic = (overrides: Partial<Epic> = {}): Epic => ({
  id: "e1",
  project_id: null,
  name: "Launch",
  description: null,
  target_date: null,
  state: "active",
  rank: "a0",
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
  ...overrides,
});

describe("project actions", () => {
  it("reorders a project between its new neighbours", async () => {
    const a = project({ rank: "a0" });
    const b = project({ rank: "a1" });
    const c = project({ rank: "a2" });
    const { store, executed } = await setup({ projects: [a, b, c] });
    await moveProject(store, c.id, null, a.id, b.id);
    const rank = store.getState().projects[c.id]?.rank as string;
    expect(rank > "a0" && rank < "a1").toBe(true);
    expect(executed[0]).toEqual([{ type: "update_project", id: c.id, changes: [{ rank }] }]);
  });

  it("moves a project into an area at its end", async () => {
    const area = project({ rank: "a0" });
    const inside = project({ rank: "a0", parent_id: area.id });
    const loose = project({ rank: "a1" });
    const { store, executed } = await setup({ projects: [area, inside, loose] });
    await moveProject(store, loose.id, area.id, null, null);
    const moved = store.getState().projects[loose.id];
    expect(moved?.parent_id).toBe(area.id);
    expect((moved?.rank as string) > "a0").toBe(true);
    expect(executed[0]?.[0]).toMatchObject({
      changes: [{ parent_id: area.id }, { rank: moved?.rank }],
    });
  });

  it("archives and unarchives", async () => {
    const p = project();
    const { store } = await setup({ projects: [p] });
    await updateProject(store, p.id, [{ archived: true }]);
    expect(store.getState().projects[p.id]?.archived_at).not.toBeNull();
    await updateProject(store, p.id, [{ archived: false }]);
    expect(store.getState().projects[p.id]?.archived_at).toBeNull();
  });
});

describe("epic actions", () => {
  it("edits fields optimistically", async () => {
    const { store } = await setup({ epics: [epic()] });
    await updateEpic(store, "e1", [{ state: "done" }, { target_date: "2026-12-01" }]);
    expect(store.getState().epics.e1).toMatchObject({ state: "done", target_date: "2026-12-01" });
  });

  it("deletes the epic and detaches its tasks", async () => {
    const t = task({ epic_id: "e1" });
    const { store, executed } = await setup({ epics: [epic()], tasks: [t] });
    await deleteEpic(store, "e1");
    expect(store.getState().epics.e1).toBeUndefined();
    expect(store.getState().tasks[t.id]?.epic_id).toBeNull();
    expect(executed[0]).toEqual([{ type: "delete_epic", id: "e1" }]);
  });
});

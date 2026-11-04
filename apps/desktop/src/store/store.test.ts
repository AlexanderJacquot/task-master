import { beforeEach, describe, expect, it } from "vitest";
import type { Api } from "../lib/api";
import type { Changed, Changes, Command, Snapshot, Task } from "../lib/types";
import { fakeParse, STATUS, snapshot, task } from "../test/fixtures";
import { createTask, deleteTask, moveSubtask, setTagged, toggleDone, updateTask } from "./actions";
import { createTaskStore, type TaskStore } from "./store";

/** A fake core: every `execute` waits until the test settles it. */
class FakeCore implements Api {
  snapshots = 0;
  snap: Snapshot = snapshot();
  executed: Command[][] = [];
  private waiting: Array<{ resolve: (c: Changes) => void; reject: (e: unknown) => void }> = [];
  private listener: ((e: Changed) => void) | null = null;
  undoResult: Changes | null = null;

  snapshot = async () => {
    this.snapshots += 1;
    return this.snap;
  };
  execute = (commands: Command[]) => {
    this.executed.push(commands);
    return new Promise<Changes>((resolve, reject) => this.waiting.push({ resolve, reject }));
  };
  undo = async () => this.undoResult;
  redo = async () => null;
  search = async () => [];
  taskActivity = async () => [];
  parseCapture = async (text: string) => fakeParse(text);
  onChanged = async (handler: (e: Changed) => void) => {
    this.listener = handler;
    return () => {
      this.listener = null;
    };
  };

  get inFlight() {
    return this.waiting.length;
  }
  succeed(partial: Partial<Changes> = {}) {
    const next = this.waiting.shift();
    if (!next) throw new Error("no pending execute");
    next.resolve({
      batch_id: "b1",
      op_seq: 1,
      tasks: [],
      projects: [],
      epics: [],
      tags: [],
      views: [],
      statuses: [],
      ...partial,
    });
  }
  fail(message = "refused") {
    const next = this.waiting.shift();
    if (!next) throw new Error("no pending execute");
    next.reject(new Error(message));
  }
  emit(batchId: string) {
    this.listener?.({ batch_id: batchId, op_seq: 1, entities: [] });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

let core: FakeCore;
let store: TaskStore;

async function setup(tasks: Task[] = []) {
  core = new FakeCore();
  core.snap = snapshot({ tasks });
  store = createTaskStore(core);
  await store.getState().hydrate();
  await store.getState().connect();
  core.snapshots = 0;
}

beforeEach(() => setup());

describe("hydrate", () => {
  it("normalizes the snapshot", async () => {
    const t = task();
    await setup([t]);
    const s = store.getState();
    expect(s.ready).toBe(true);
    expect(s.tasks[t.id]).toEqual(t);
    expect(s.statuses.map((st) => st.name)[0]).toBe("Backlog");
  });

  it("reports load errors", async () => {
    core = new FakeCore();
    core.snapshot = async () => {
      throw new Error("db locked");
    };
    store = createTaskStore(core);
    await store.getState().hydrate();
    expect(store.getState().loadError).toBe("db locked");
  });
});

describe("optimistic writes", () => {
  it("shows a created task at once, sends its id and rank, then keeps the core's version", async () => {
    const created = createTask(store, { title: "  Write tests ", project_id: null });
    await tick();
    const local = Object.values(store.getState().tasks);
    expect(local).toHaveLength(1);
    const optimistic = local[0] as Task;
    expect(optimistic).toMatchObject({ title: "Write tests", status_id: STATUS.todo, rank: "a0" });

    const sent = core.executed[0]?.[0];
    expect(sent).toMatchObject({
      type: "create_task",
      task: { id: optimistic.id, title: "Write tests", rank: "a0", status_id: STATUS.todo },
    });

    const confirmed = { ...optimistic, created_at: 42, updated_at: 42 };
    core.succeed({ tasks: [confirmed] });
    await expect(created).resolves.toBe(optimistic.id);
    expect(store.getState().tasks[optimistic.id]).toEqual(confirmed);
    expect(store.getState().pending).toBe(0);
  });

  it("rolls a failed create back and reports the error", async () => {
    const created = createTask(store, { title: "Doomed" });
    await tick();
    core.fail("title cannot be empty");
    await expect(created).resolves.toBeNull();
    expect(store.getState().tasks).toEqual({});
    expect(store.getState().lastError).toBe("title cannot be empty");
    store.getState().dismissError();
    expect(store.getState().lastError).toBeNull();
  });

  it("restores the previous version when an update fails", async () => {
    const t = task({ title: "Before" });
    await setup([t]);
    const update = updateTask(store, t.id, [{ title: "After" }]);
    expect(store.getState().tasks[t.id]?.title).toBe("After");
    await tick();
    core.fail();
    await update;
    expect(store.getState().tasks[t.id]).toEqual(t);
  });

  it("deletes subtasks with their parent and brings them back on failure", async () => {
    const parent = task();
    const child = task({ parent_id: parent.id });
    const grandchild = task({ parent_id: child.id });
    await setup([parent, child, grandchild]);
    const deletion = deleteTask(store, parent.id);
    expect(store.getState().tasks).toEqual({});
    expect(core.executed).toHaveLength(0); // queued behind nothing, sent on next tick
    await tick();
    expect(core.executed[0]).toEqual([{ type: "delete_task", id: parent.id }]);
    core.fail();
    await deletion;
    expect(Object.keys(store.getState().tasks).sort()).toEqual(
      [parent.id, child.id, grandchild.id].sort(),
    );
  });

  it("drops entities the core reports as deleted", async () => {
    const t = task();
    await setup([t]);
    const deletion = deleteTask(store, t.id);
    await tick();
    core.succeed({ tasks: [{ ...t, deleted_at: 5 }] });
    await deletion;
    expect(store.getState().tasks).toEqual({});
  });

  it("sends writes one at a time, in order", async () => {
    const a = task();
    await setup([a]);
    const first = updateTask(store, a.id, [{ title: "One" }]);
    const second = updateTask(store, a.id, [{ title: "Two" }]);
    await tick();
    expect(core.inFlight).toBe(1);
    core.succeed({ tasks: [{ ...a, title: "One" }] });
    await first;
    await tick();
    expect(core.executed).toHaveLength(2);
    core.succeed({ tasks: [{ ...a, title: "Two" }] });
    await second;
    expect(store.getState().tasks[a.id]?.title).toBe("Two");
  });

  it("toggles done with completed_at, and back", async () => {
    const t = task();
    await setup([t]);
    void toggleDone(store, t.id);
    const done = store.getState().tasks[t.id];
    expect(done?.status_id).toBe(STATUS.done);
    expect(done?.completed_at).not.toBeNull();
    await tick();
    expect(core.executed[0]).toEqual([
      { type: "update_task", id: t.id, changes: [{ status_id: STATUS.done }] },
    ]);
    core.succeed({ tasks: [done as Task] });
    await tick();
    void toggleDone(store, t.id);
    expect(store.getState().tasks[t.id]).toMatchObject({
      status_id: STATUS.todo,
      completed_at: null,
    });
  });

  it("moves a subtask between its neighbours", async () => {
    const parent = task();
    const a = task({ parent_id: parent.id, rank: "a1" });
    const b = task({ parent_id: parent.id, rank: "a2" });
    const c = task({ parent_id: parent.id, rank: "a3" });
    await setup([parent, a, b, c]);
    void moveSubtask(store, c.id, -1);
    const moved = store.getState().tasks[c.id]?.rank as string;
    expect(moved > "a1" && moved < "a2").toBe(true);
    expect(await moveSubtask(store, a.id, -1)).toBeNull(); // already first
  });

  it("tags and untags without duplicates", async () => {
    const t = task();
    await setup([t]);
    void setTagged(store, t.id, "tag-1", true);
    expect(store.getState().tasks[t.id]?.tag_ids).toEqual(["tag-1"]);
    expect(await setTagged(store, t.id, "tag-1", true)).toBeNull();
  });
});

describe("history and events", () => {
  it("applies what undo returns", async () => {
    const t = task();
    await setup([t]);
    const restored = task();
    core.undoResult = {
      batch_id: "u1",
      op_seq: 2,
      tasks: [{ ...t, deleted_at: 9 }, restored],
      projects: [],
      epics: [],
      tags: [],
      views: [],
      statuses: [],
    };
    await store.getState().undo();
    expect(Object.keys(store.getState().tasks)).toEqual([restored.id]);
  });

  it("ignores events for its own batches, whenever they arrive", async () => {
    const t = task();
    await setup([t]);
    // Event after the response.
    const one = updateTask(store, t.id, [{ title: "x" }]);
    await tick();
    core.succeed({ batch_id: "mine-1", tasks: [t] });
    await one;
    core.emit("mine-1");
    // Event before the response.
    const two = updateTask(store, t.id, [{ title: "y" }]);
    await tick();
    core.emit("mine-2");
    core.succeed({ batch_id: "mine-2", tasks: [t] });
    await two;
    await tick();
    expect(core.snapshots).toBe(0);
  });

  it("re-reads everything after a write made elsewhere", async () => {
    core.snap = snapshot({ tasks: [task({ title: "From the CLI" })] });
    core.emit("someone-else");
    await tick();
    expect(core.snapshots).toBe(1);
    expect(Object.values(store.getState().tasks)[0]?.title).toBe("From the CLI");
  });
});

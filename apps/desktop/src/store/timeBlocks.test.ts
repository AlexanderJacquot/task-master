import { describe, expect, it } from "vitest";
import type { Api } from "../lib/api";
import type { Changes, Command, Task, TimeBlock } from "../lib/types";
import { fakeParse, STATUS, snapshot, task, timeBlock } from "../test/fixtures";
import { deleteBlock, moveBlock, scheduleTask, setBlockOutcome } from "./actions";
import { createTaskStore } from "./store";

function setup(data: { tasks?: Task[]; time_blocks?: TimeBlock[] }, refuse = false) {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot(data),
    execute: (commands) => {
      executed.push(commands);
      if (refuse) return Promise.reject(new Error("a time block must end after it starts"));
      return Promise.resolve({
        batch_id: `b${executed.length}`,
        op_seq: executed.length,
        tasks: [],
        projects: [],
        epics: [],
        tags: [],
        views: [],
        attachments: [],
        time_blocks: [],
        statuses: [],
      } as Changes);
    },
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
  };
  const store = createTaskStore(api);
  return { store, executed, ready: store.getState().hydrate() };
}

const NINE = new Date(2026, 10, 5, 9).getTime();
const HOUR = 3_600_000;

describe("time block actions", () => {
  it("schedules a task with a client id, shown at once", async () => {
    const t = task();
    const { store, executed, ready } = setup({ tasks: [t] });
    await ready;
    const pending = scheduleTask(store, t.id, NINE, NINE + HOUR);
    const shown = Object.values(store.getState().time_blocks);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ task_id: t.id, start_at: NINE, outcome: "planned" });
    const id = await pending;
    expect(id).toBe(shown[0]?.id);
    expect(executed).toEqual([
      [
        {
          type: "create_time_block",
          block: { id, task_id: t.id, start_at: NINE, end_at: NINE + HOUR, outcome: "planned" },
        },
      ],
    ]);
  });

  it("rolls back a refused block", async () => {
    const t = task();
    const { store, ready } = setup({ tasks: [t] }, true);
    await ready;
    expect(await scheduleTask(store, t.id, NINE, NINE + HOUR)).toBeNull();
    expect(store.getState().time_blocks).toEqual({});
    expect(store.getState().lastError).toContain("end after");
  });

  it("moves and resizes with only the fields that changed", async () => {
    const t = task();
    const b = timeBlock({ task_id: t.id, start_at: NINE, end_at: NINE + HOUR });
    const { store, executed, ready } = setup({ tasks: [t], time_blocks: [b] });
    await ready;
    await moveBlock(store, b.id, NINE, NINE + 2 * HOUR);
    await moveBlock(store, b.id, NINE + HOUR, NINE + 3 * HOUR);
    expect(executed).toEqual([
      [{ type: "update_time_block", id: b.id, changes: [{ end_at: NINE + 2 * HOUR }] }],
      [
        {
          type: "update_time_block",
          id: b.id,
          changes: [{ start_at: NINE + HOUR }, { end_at: NINE + 3 * HOUR }],
        },
      ],
    ]);
    expect(store.getState().time_blocks[b.id]?.start_at).toBe(NINE + HOUR);
    expect(await moveBlock(store, b.id, NINE + HOUR, NINE + 3 * HOUR)).toBeNull();
    expect(executed).toHaveLength(2);
  });

  it("completes the task when a block is marked done, in one batch", async () => {
    const t = task({ status_id: STATUS.todo });
    const b = timeBlock({ task_id: t.id });
    const { store, executed, ready } = setup({ tasks: [t], time_blocks: [b] });
    await ready;
    const pending = setBlockOutcome(store, b.id, "done");
    expect(store.getState().tasks[t.id]?.status_id).toBe(STATUS.done);
    expect(store.getState().time_blocks[b.id]?.outcome).toBe("done");
    await pending;
    expect(executed[0]).toEqual([
      { type: "update_time_block", id: b.id, changes: [{ outcome: "done" }] },
      { type: "update_task", id: t.id, changes: [{ status_id: STATUS.done }] },
    ]);
  });

  it("logs worked time without touching the task's status", async () => {
    const t = task({ status_id: STATUS.inProgress });
    const b = timeBlock({ task_id: t.id });
    const { store, executed, ready } = setup({ tasks: [t], time_blocks: [b] });
    await ready;
    await setBlockOutcome(store, b.id, "worked");
    expect(executed[0]).toEqual([
      { type: "update_time_block", id: b.id, changes: [{ outcome: "worked" }] },
    ]);
    expect(store.getState().tasks[t.id]?.status_id).toBe(STATUS.inProgress);
  });

  it("removes a block", async () => {
    const t = task();
    const b = timeBlock({ task_id: t.id });
    const { store, executed, ready } = setup({ tasks: [t], time_blocks: [b] });
    await ready;
    await deleteBlock(store, b.id);
    expect(store.getState().time_blocks).toEqual({});
    expect(store.getState().tasks[t.id]).toBeDefined();
    expect(executed[0]).toEqual([{ type: "delete_time_block", id: b.id }]);
  });
});

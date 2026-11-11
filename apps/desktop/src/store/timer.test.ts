import { beforeEach, describe, expect, it } from "vitest";
import type { Api } from "../lib/api";
import { getTimer, setTimer } from "../lib/timer";
import type { Changes, Command, Task } from "../lib/types";
import { fakeParse, STATUS, snapshot, task } from "../test/fixtures";
import { logWork, startTimer, stopTimer } from "./actions";
import { createTaskStore } from "./store";

function setup(tasks: Task[]) {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot({ tasks }),
    execute: (commands) => {
      executed.push(commands);
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
        agent_sessions: [],
        agent_notes: [],
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
const MIN = 60_000;

describe("work timer", () => {
  beforeEach(() => setTimer(null));

  it("starts on a task and moves a to-do task in progress", async () => {
    const t = task({ status_id: STATUS.todo });
    const { store, executed, ready } = setup([t]);
    await ready;
    await startTimer(store, t.id, NINE);
    expect(getTimer()).toEqual({ task_id: t.id, started_at: NINE });
    expect(store.getState().tasks[t.id]?.status_id).toBe(STATUS.inProgress);
    expect(executed).toEqual([
      [{ type: "update_task", id: t.id, changes: [{ status_id: STATUS.inProgress }] }],
    ]);
  });

  it("leaves a task's status alone once it is started or finished", async () => {
    const doing = task({ status_id: STATUS.waiting });
    const done = task({ status_id: STATUS.done });
    const { store, executed, ready } = setup([doing, done]);
    await ready;
    await startTimer(store, doing.id, NINE);
    setTimer(null);
    await startTimer(store, done.id, NINE);
    expect(executed).toEqual([]);
  });

  it("logs the run as a worked block on stop", async () => {
    const t = task({ status_id: STATUS.inProgress });
    const { store, executed, ready } = setup([t]);
    await ready;
    await startTimer(store, t.id, NINE);
    const [id] = await stopTimer(store, NINE + 25 * MIN);
    expect(getTimer()).toBeNull();
    expect(executed).toEqual([
      [
        {
          type: "create_time_block",
          block: { id, task_id: t.id, start_at: NINE, end_at: NINE + 25 * MIN, outcome: "worked" },
        },
      ],
    ]);
    expect(store.getState().time_blocks[id as string]?.outcome).toBe("worked");
  });

  it("logs nothing for a run under a minute", async () => {
    const t = task({ status_id: STATUS.inProgress });
    const { store, executed, ready } = setup([t]);
    await ready;
    await startTimer(store, t.id, NINE);
    expect(await stopTimer(store, NINE + 30_000)).toEqual([]);
    expect(getTimer()).toBeNull();
    expect(executed).toEqual([]);
  });

  it("stops the running timer when another task's starts", async () => {
    const a = task({ status_id: STATUS.inProgress });
    const b = task({ status_id: STATUS.inProgress });
    const { store, executed, ready } = setup([a, b]);
    await ready;
    await startTimer(store, a.id, NINE);
    await startTimer(store, b.id, NINE + 10 * MIN);
    expect(getTimer()).toEqual({ task_id: b.id, started_at: NINE + 10 * MIN });
    expect(executed).toHaveLength(1);
    expect(executed[0]?.[0]).toMatchObject({
      type: "create_time_block",
      block: { task_id: a.id, start_at: NINE, end_at: NINE + 10 * MIN },
    });
  });

  it("splits a run over a day into blocks in one batch", async () => {
    const t = task({ status_id: STATUS.inProgress });
    const { store, executed, ready } = setup([t]);
    await ready;
    expect(await logWork(store, t.id, NINE, NINE + 30 * 60 * MIN)).toHaveLength(2);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toHaveLength(2);
  });
});

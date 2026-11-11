import { beforeEach, describe, expect, it } from "vitest";
import { sessionChanges } from "../features/agents/SendToAgentDialog";
import type { Api } from "../lib/api";
import { getTimer, setTimer } from "../lib/timer";
import type { AgentSession, Changes, Command, Task } from "../lib/types";
import { agentSession, fakeParse, STATUS, snapshot, task } from "../test/fixtures";
import { agentTimerEnd, followAgentTimer, logWork, startTimer, stopTimer } from "./actions";
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

describe("work timer of an agent session", () => {
  beforeEach(() => setTimer(null));

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("stops when the session ends", () => {
    const timer = { task_id: "t0", started_at: NINE, session_id: "s" };
    const at = (state: AgentSession["state"], ended_at: number | null) => ({
      s: agentSession({ id: "s", state, ended_at, updated_at: NINE }),
    });
    expect(agentTimerEnd(timer, at("running", null))).toBeNull();
    expect(agentTimerEnd(timer, at("terminal", null))).toBeNull();
    for (const state of ["done", "failed", "cancelled", "interrupted"] as const) {
      expect(agentTimerEnd(timer, at(state, NINE + 5 * MIN))).toBe(NINE + 5 * MIN);
    }
    // An end from before a follow-up was sent: the session is not marked running yet.
    expect(agentTimerEnd(timer, at("done", NINE - MIN))).toBeNull();
    // A timer not following a session, or a session not loaded.
    expect(agentTimerEnd({ task_id: "t0", started_at: NINE }, at("done", NINE + MIN))).toBeNull();
    expect(agentTimerEnd(timer, {})).toBeNull();
  });

  it("starts with the session and logs the run up to its end", async () => {
    const t = task({ status_id: STATUS.todo });
    const { store, executed, ready } = setup([t]);
    await ready;
    const stop = followAgentTimer(store);
    const running = agentSession({ task_id: t.id, state: "running", ended_at: null });
    store.getState().record(sessionChanges(running));
    await startTimer(store, t.id, NINE, running.id);
    expect(getTimer()).toEqual({ task_id: t.id, started_at: NINE, session_id: running.id });
    expect(store.getState().tasks[t.id]?.status_id).toBe(STATUS.inProgress);

    const failed = { ...running, state: "failed" as const, ended_at: NINE + 40 * MIN };
    store.getState().record(sessionChanges(failed));
    await flush();
    expect(getTimer()).toBeNull();
    expect(executed.at(-1)?.[0]).toMatchObject({
      type: "create_time_block",
      block: { task_id: t.id, start_at: NINE, end_at: NINE + 40 * MIN, outcome: "worked" },
    });
    stop();
  });

  it("keeps a follow-up's timer through the old end, and leaves a hand-started one", async () => {
    const t = task({ status_id: STATUS.inProgress });
    const { store, executed, ready } = setup([t]);
    await ready;
    const ended = agentSession({ task_id: t.id, state: "done", ended_at: NINE - 10 * MIN });
    store.getState().record(sessionChanges(ended));
    const stop = followAgentTimer(store);
    await startTimer(store, t.id, NINE, ended.id);
    store.getState().record(sessionChanges({ ...ended, updated_at: NINE }));
    await flush();
    expect(getTimer()?.session_id).toBe(ended.id);

    // The user times another task by hand: the session's end leaves that timer alone.
    setTimer({ task_id: "other", started_at: NINE + MIN });
    store.getState().record(sessionChanges({ ...ended, ended_at: NINE + 5 * MIN }));
    await flush();
    expect(getTimer()).toEqual({ task_id: "other", started_at: NINE + MIN });
    expect(executed).toEqual([]);
    stop();
  });

  it("follows the session when the task's timer already runs", async () => {
    const t = task({ status_id: STATUS.inProgress });
    const { store, ready } = setup([t]);
    await ready;
    await startTimer(store, t.id, NINE);
    await startTimer(store, t.id, NINE + 5 * MIN, "s9");
    expect(getTimer()).toEqual({ task_id: t.id, started_at: NINE, session_id: "s9" });
  });
});

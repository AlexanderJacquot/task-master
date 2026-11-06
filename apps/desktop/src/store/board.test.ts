import { describe, expect, it } from "vitest";
import type { Api } from "../lib/api";
import { buildBoard } from "../lib/board";
import { rankBetween } from "../lib/rank";
import type { Changes, Command, Task } from "../lib/types";
import { EMPTY_FILTER, type ViewContext } from "../lib/views";
import { fakeParse, STATUS, snapshot, statuses, task } from "../test/fixtures";
import { moveCard } from "./actions";
import { createTaskStore, type TaskStore } from "./store";

/** A core that confirms every write with the entities the store showed optimistically. */
function confirmingApi(getStore: () => TaskStore, tasks: Task[]) {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot({ tasks }),
    execute: async (commands) => {
      executed.push(commands);
      const live = getStore().getState().tasks;
      const ids = commands.flatMap((c) => ("id" in c ? [c.id] : []));
      return {
        batch_id: `b${executed.length}`,
        op_seq: executed.length,
        tasks: ids.flatMap((id) => (live[id] ? [live[id]] : [])),
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
  return { api, executed };
}

const COLUMNS = [STATUS.backlog, STATUS.todo, STATUS.inProgress, STATUS.done];
const ctx: ViewContext = {
  today: "2026-11-04",
  statuses: Object.fromEntries(statuses.map((s) => [s.id, s])),
  projects: {},
};

function boardColumns(store: TaskStore): string[][] {
  const board = buildBoard(
    Object.values(store.getState().tasks),
    {
      scope: { kind: "all" },
      filter: EMPTY_FILTER,
      swimlane: "none",
      show_subtasks: true,
      show_cancelled: false,
      show_agent_tasks: false,
    },
    ctx,
    statuses,
    { projects: {}, epics: {} },
  );
  return COLUMNS.map((id) => (board.lanes[0]?.cells[id] ?? []).map((c) => c.task.id));
}

describe("moveCard", () => {
  it("sends one move_task with a rank between the new neighbours", async () => {
    const a = task({ rank: "a0" });
    const b = task({ rank: "a1" });
    const m = task({ rank: "a0", status_id: STATUS.backlog });
    let store: TaskStore = createTaskStore({} as Api);
    const fake = confirmingApi(() => store, [a, b, m]);
    store = createTaskStore(fake.api);
    await store.getState().hydrate();

    await moveCard(store, { id: m.id, statusId: STATUS.todo, order: [a.id, m.id, b.id] });
    expect(fake.executed).toHaveLength(1);
    const [command] = fake.executed[0] ?? [];
    expect(command).toMatchObject({ type: "move_task", id: m.id, status_id: STATUS.todo });
    expect(boardColumns(store)[1]).toEqual([a.id, m.id, b.id]);
  });

  it("folds a lane change into the same update and skips no-op lane changes", async () => {
    const t = task({ priority: "normal" });
    let store: TaskStore = createTaskStore({} as Api);
    const fake = confirmingApi(() => store, [t]);
    store = createTaskStore(fake.api);
    await store.getState().hydrate();

    await moveCard(store, {
      id: t.id,
      statusId: STATUS.inProgress,
      order: [t.id],
      laneChanges: [{ priority: "urgent" }],
    });
    expect(fake.executed[0]).toEqual([
      {
        type: "update_task",
        id: t.id,
        changes: [{ status_id: STATUS.inProgress }, { rank: "a0" }, { priority: "urgent" }],
      },
    ]);
    expect(store.getState().tasks[t.id]?.priority).toBe("urgent");

    await moveCard(store, {
      id: t.id,
      statusId: STATUS.todo,
      order: [t.id],
      laneChanges: [{ priority: "urgent" }],
    });
    expect(fake.executed[1]?.[0]).toMatchObject({ type: "move_task" });
  });

  /** Plan M3 "done when": 50 drags in a row never reorder wrongly. */
  it("keeps the board in the dropped order over 50 random drags", async () => {
    // Duplicate ranks on purpose: drops between them must still land where shown.
    let key: string | null = null;
    const tasks = Array.from({ length: 14 }, (_, i) => {
      key = rankBetween(key, null);
      return task({ status_id: COLUMNS[i % COLUMNS.length], rank: i % 3 === 0 ? "a5" : key });
    });
    let store: TaskStore = createTaskStore({} as Api);
    const fake = confirmingApi(() => store, tasks);
    store = createTaskStore(fake.api);
    await store.getState().hydrate();

    let seed = 0x2545f491;
    const next = (n: number) => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % n;
    };
    const model = boardColumns(store);
    for (let drag = 0; drag < 50; drag += 1) {
      const id = tasks[next(tasks.length)]?.id as string;
      const to = next(COLUMNS.length);
      for (const col of model) {
        const i = col.indexOf(id);
        if (i >= 0) col.splice(i, 1);
      }
      const target = model[to] as string[];
      target.splice(next(target.length + 1), 0, id);

      await moveCard(store, { id, statusId: COLUMNS[to] as string, order: [...target] });
      expect(boardColumns(store), `after drag ${drag}`).toEqual(model);
    }
    expect(fake.executed).toHaveLength(50);
  });
});

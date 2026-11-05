import { describe, expect, it } from "vitest";
import type { Api } from "../lib/api";
import type { Changes, Command } from "../lib/types";
import { fakeParse, STATUS, snapshot } from "../test/fixtures";
import { createStatus, deleteStatus, moveStatus, updateStatus } from "./actions";
import { createTaskStore } from "./store";

async function setup(fail = false) {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot(),
    execute: (commands) => {
      executed.push(commands);
      if (fail) return Promise.reject(new Error("refused by core"));
      return Promise.resolve({
        batch_id: "b",
        op_seq: 1,
        tasks: [],
        projects: [],
        epics: [],
        tags: [],
        views: [],
        attachments: [],
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
  await store.getState().hydrate();
  return { store, executed };
}

const names = (store: Awaited<ReturnType<typeof setup>>["store"]) =>
  store.getState().statuses.map((s) => s.name);

describe("status actions", () => {
  it("adds a column at the end and keeps workflow order on moves", async () => {
    const { store, executed } = await setup();
    await createStatus(store, "Review", "in_progress");
    expect(names(store).at(-1)).toBe("Review");
    expect(executed[0]?.[0]).toMatchObject({
      type: "create_status",
      status: { name: "Review", category: "in_progress" },
    });

    await moveStatus(store, STATUS.done, -1);
    expect(names(store)).toEqual([
      "Backlog",
      "To do",
      "In progress",
      "Done",
      "Waiting",
      "Cancelled",
      "Review",
    ]);
    await moveStatus(store, STATUS.backlog, -1);
    expect(executed).toHaveLength(2);
  });

  it("edits fields, and deletes optimistically", async () => {
    const { store } = await setup();
    await updateStatus(store, STATUS.inProgress, [{ name: "Doing" }, { wip_limit: 3 }]);
    expect(store.getState().statuses.find((s) => s.id === STATUS.inProgress)).toMatchObject({
      name: "Doing",
      wip_limit: 3,
    });
    await deleteStatus(store, STATUS.cancelled);
    expect(store.getState().statuses.some((s) => s.id === STATUS.cancelled)).toBe(false);
  });

  it("rolls back a refused delete in place", async () => {
    const { store } = await setup(true);
    const before = names(store);
    await deleteStatus(store, STATUS.waiting);
    expect(names(store)).toEqual(before);
    expect(store.getState().lastError).toBe("refused by core");
  });
});

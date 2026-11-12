// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { getTimers, type RunningTimer, setTimers } from "../../lib/timer";
import type { Changes, Command, Task } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeParse, STATUS, snapshot, task } from "../../test/fixtures";

async function renderTaskPage(t: Task) {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot({ tasks: [t] }),
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
  const router = createAppRouter(createMemoryHistory({ initialEntries: [`/task/${t.id}`] }));
  render(
    <StoreProvider store={store} api={api}>
      <RouterProvider router={router} />
    </StoreProvider>,
  );
  await screen.findByRole("region", { name: "Description" });
  return { executed, store };
}

const getTimer = () => getTimers()[0] ?? null;
const setTimer = (t: RunningTimer | null) => setTimers(t ? [t] : []);

afterEach(() => {
  cleanup();
  setTimer(null);
  localStorage.clear();
});

describe("work timer", () => {
  it("starts from the task page, shows in the sidebar and moves the task in progress", async () => {
    const t = task({ title: "Write the report", status_id: STATUS.todo });
    const { store } = await renderTaskPage(t);
    fireEvent.click(screen.getByRole("button", { name: "Start timer" }));
    await waitFor(() => expect(getTimer()?.task_id).toBe(t.id));
    expect(store.getState().tasks[t.id]?.status_id).toBe(STATUS.inProgress);
    const pill = await screen.findByRole("region", { name: "Timers" });
    expect(within(pill).getByRole("button", { name: /0:0\d/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Stop\s*\d/ })).toBeTruthy();
  });

  it("logs the run as worked time on stop and shows the total", async () => {
    const t = task({ title: "Write the report", status_id: STATUS.inProgress });
    setTimer({ task_id: t.id, started_at: Date.now() - 25 * 60_000 });
    const { executed } = await renderTaskPage(t);
    fireEvent.click(screen.getByRole("button", { name: /^Stop\s*\d/ }));
    await screen.findByText(/25 min logged/);
    expect(getTimer()).toBeNull();
    expect(screen.queryByRole("region", { name: "Timers" })).toBeNull();
    expect(executed).toHaveLength(1);
    expect(executed[0]?.[0]).toMatchObject({
      type: "create_time_block",
      block: { task_id: t.id, outcome: "worked" },
    });
  });
});

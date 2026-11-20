// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { saveCloseOnDone } from "../../lib/detailPrefs";
import type { Changes, Task } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore, type TaskStore } from "../../store/store";
import { fakeParse, STATUS, snapshot, task } from "../../test/fixtures";

let store: TaskStore;

/** A core that confirms every write with what the store optimistically showed. */
async function renderAt(path: string, t: Task) {
  const api: Api = {
    snapshot: async () => snapshot({ tasks: [t] }),
    execute: async () =>
      ({
        batch_id: "b",
        op_seq: 1,
        tasks: [store.getState().tasks[t.id]],
        projects: [],
        epics: [],
        tags: [],
        views: [],
        attachments: [],
        time_blocks: [],
        agent_sessions: [],
        agent_notes: [],
        meetings: [],
        transcript_segments: [],
        terminal_sessions: [],
        statuses: [],
      }) as Changes,
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
  };
  store = createTaskStore(api);
  await store.getState().hydrate();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <StoreProvider store={store} api={api}>
      <RouterProvider router={router} />
    </StoreProvider>,
  );
  return router;
}

const panel = () => screen.queryByRole("complementary", { name: "Task details" });

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("marking a task done from its detail", () => {
  it("closes the side panel by default", async () => {
    const t = task({ title: "Renew passport", status_id: STATUS.todo });
    await renderAt(`/inbox?task=${t.id}`, t);
    const open = await screen.findByRole("complementary", { name: "Task details" });
    fireEvent.click(within(open).getByRole("checkbox", { name: "Mark done" }));
    await waitFor(() => expect(panel()).toBeNull());
    expect(store.getState().tasks[t.id]?.status_id).toBe(STATUS.done);
  });

  it("keeps the side panel open when the setting is off, and on reopening", async () => {
    saveCloseOnDone(false);
    const t = task({ title: "Renew passport", status_id: STATUS.todo });
    await renderAt(`/inbox?task=${t.id}`, t);
    const open = await screen.findByRole("complementary", { name: "Task details" });
    fireEvent.click(within(open).getByRole("checkbox", { name: "Mark done" }));
    await waitFor(() => expect(store.getState().tasks[t.id]?.status_id).toBe(STATUS.done));
    expect(panel()).toBeTruthy();

    saveCloseOnDone(true);
    fireEvent.click(within(open).getByRole("checkbox", { name: "Reopen" }));
    await waitFor(() => expect(store.getState().tasks[t.id]?.status_id).toBe(STATUS.todo));
    expect(panel(), "reopening never closes").toBeTruthy();
  });

  it("leaves the full page for the list it came from", async () => {
    const t = task({ title: "Renew passport", status_id: STATUS.todo });
    const router = await renderAt(`/task/${t.id}`, t);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Mark done" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/inbox"));
  });
});

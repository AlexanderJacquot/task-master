// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import type { Changes, Command, Epic } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeParse, snapshot } from "../../test/fixtures";

async function renderEpic(p: Epic) {
  const executed: Command[][] = [];
  const empty = async () => null;
  const api: Api = {
    snapshot: async () => snapshot({ epics: [p] }),
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
        statuses: [],
      } as Changes;
    },
    undo: empty,
    redo: empty,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
  } as Api;
  const store = createTaskStore(api);
  await store.getState().hydrate();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [`/epic/${p.id}`] }));
  render(
    <StoreProvider store={store} api={api}>
      <RouterProvider router={router} />
    </StoreProvider>,
  );
  await screen.findByRole("combobox", { name: "Epic icon shape" });
  return { executed, store };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("changes an epic's color and shape through its controls", async () => {
  const epic: Epic = {
    id: "e1",
    name: "Launch",
    project_id: null,
    description: null,
    target_date: null,
    state: "active",
    rank: "a0",
    color: null,
    icon: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  };
  const { store, executed } = await renderEpic(epic);
  fireEvent.click(screen.getByRole("combobox", { name: "Epic icon shape" }));
  fireEvent.click(await screen.findByRole("option", { name: "Star" }));
  await waitFor(() => expect(store.getState().epics.e1?.icon).toBe("star"));
  fireEvent.click(screen.getByRole("combobox", { name: "Epic color" }));
  fireEvent.click(await screen.findByRole("option", { name: "#ef4444" }));
  await waitFor(() => expect(store.getState().epics.e1?.color).toBe("#ef4444"));
  expect(executed.flat()).toEqual([
    { type: "update_epic", id: "e1", changes: [{ icon: "star" }] },
    { type: "update_epic", id: "e1", changes: [{ color: "#ef4444" }] },
  ]);
});

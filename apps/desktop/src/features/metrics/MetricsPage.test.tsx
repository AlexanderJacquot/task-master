// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { isoDate } from "../../lib/dates";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeParse, project, STATUS, snapshot, task } from "../../test/fixtures";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("opens from navigation, shows project/tag/AI statistics, and refreshes after task changes", async () => {
  const p = project({ name: "Dashboard project" });
  const ai = {
    id: "ai",
    name: "AI handled",
    color: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  };
  const done = task({
    project_id: p.id,
    tag_ids: [ai.id],
    status_id: STATUS.done,
    created_at: Date.now() - 86_400_000,
    completed_at: Date.now(),
  });
  localStorage.setItem("task-master.metrics-ai-tag", ai.id);
  const api: Api = {
    snapshot: async () => snapshot({ projects: [p], tags: [ai], tasks: [done] }),
    execute: async () => {
      throw new Error("Metrics must be read only");
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
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/metrics"] }));
  render(
    <StoreProvider store={store} api={api}>
      <RouterProvider router={router} />
    </StoreProvider>,
  );
  expect(await screen.findByRole("heading", { name: "Metrics" })).toBeTruthy();
  expect(
    within(screen.getByRole("navigation")).getByRole("link", { name: "Metrics" }),
  ).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "AI handled tag" }).textContent).toContain(
    "AI handled",
  );
  const projectTable = screen
    .getAllByRole("table")
    .find((table) => within(table).queryByRole("columnheader", { name: "Project" }));
  expect(projectTable).toBeTruthy();
  const row = within(projectTable as HTMLElement)
    .getByRole("rowheader", { name: p.name })
    .closest("tr") as HTMLElement;
  expect(
    within(row)
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  ).toEqual(["1", "1", "0", "1", "100%"]);
  act(() =>
    store.setState({
      tasks: {
        [done.id]: { ...done, status_id: STATUS.todo, completed_at: null, due_date: isoDate() },
      },
    }),
  );
  expect(
    within(row)
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  ).toEqual(["1", "0", "1", "0", "—"]);
});

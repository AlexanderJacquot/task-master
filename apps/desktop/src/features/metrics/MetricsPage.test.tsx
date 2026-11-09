// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

it("focuses a project from the URL or its row, and shows its burn-down", async () => {
  const p = project({ name: "Keep" });
  const other = project({ name: "Other keep" });
  const created_at = Date.now() - 3 * 86_400_000;
  const tasks = [
    task({ project_id: p.id, created_at }),
    task({ project_id: other.id, created_at }),
    task({ project_id: other.id, created_at }),
  ];
  const api: Api = {
    snapshot: async () => snapshot({ projects: [p, other], tasks }),
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
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [`/metrics?project=${p.id}`] }),
  );
  render(
    <StoreProvider store={store} api={api}>
      <RouterProvider router={router} />
    </StoreProvider>,
  );
  const openNow = () => {
    const burn = screen.getByRole("region", { name: "Burn-down" });
    return within(burn).getByText("Open now").nextSibling?.textContent;
  };
  const focus = await screen.findByRole("region", { name: "Focused project" });
  expect(within(focus).getByRole("heading", { name: "Keep" })).toBeTruthy();
  expect(openNow()).toBe("1");

  fireEvent.click(within(focus).getByRole("button", { name: /Show all projects/ }));
  const focusPanel = () => screen.queryByRole("region", { name: "Focused project" });
  await waitFor(() => expect(focusPanel()).toBeNull());
  expect(openNow()).toBe("3");

  const byProject = screen.getByRole("region", { name: "By project" });
  fireEvent.click(within(byProject).getByRole("button", { name: "Other keep" }));
  const refocused = await screen.findByRole("region", { name: "Focused project" });
  expect(within(refocused).getByRole("heading", { name: "Other keep" })).toBeTruthy();
  expect(openNow()).toBe("2");
});

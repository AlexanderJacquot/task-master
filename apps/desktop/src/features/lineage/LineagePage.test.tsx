// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import type { Command, Task } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeParse, snapshot, task } from "../../test/fixtures";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function setup(tasks: Task[], fail = false) {
  const commands: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot({ tasks }),
    execute: async (batch) => {
      commands.push(batch);
      if (fail) throw new Error("Dependency save failed");
      return {
        batch_id: "batch",
        op_seq: 1,
        tasks: [],
        projects: [],
        epics: [],
        tags: [],
        views: [],
        statuses: [],
        attachments: [],
        time_blocks: [],
      };
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
  render(
    <StoreProvider store={store} api={api}>
      <RouterProvider
        router={createAppRouter(createMemoryHistory({ initialEntries: ["/lineage"] }))}
      />
    </StoreProvider>,
  );
  await screen.findByRole("heading", { name: "Lineage" });
  return { store, commands };
}

it("edits chains and branches from the graph and removes connections", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build", dependency_ids: [a.id] });
  const c = task({ title: "Ship" });
  const { store, commands } = await setup([a, b, c]);
  expect(
    within(screen.getByRole("navigation")).getByRole("link", { name: "Lineage" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Select Build" }));
  expect(screen.getByRole("button", { name: "Remove prerequisite Plan" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Connect on graph" }));
  fireEvent.click(screen.getByRole("button", { name: "Select Ship" }));
  await waitFor(() => expect(store.getState().tasks[c.id]?.dependency_ids).toEqual([b.id]));
  await waitFor(() => expect(store.getState().pending).toBe(0));
  fireEvent.click(screen.getByRole("button", { name: "Select Plan" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Connection type" }), {
    target: { value: "dependent" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Find task to connect" }), {
    target: { value: "Ship" },
  });
  fireEvent.click(screen.getByRole("button", { name: "+ Ship" }));
  await waitFor(() =>
    expect(store.getState().tasks[c.id]?.dependency_ids).toEqual([a.id, b.id].sort()),
  );
  await waitFor(() => expect(store.getState().pending).toBe(0));
  fireEvent.click(screen.getByRole("button", { name: "Remove dependent Ship" }));
  await waitFor(() => expect(store.getState().tasks[c.id]?.dependency_ids).toEqual([b.id]));
  expect(commands).toHaveLength(3);
});

it("rejects circular links and rolls back failed edits", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build", dependency_ids: [a.id] });
  const { store, commands } = await setup([a, b], true);
  fireEvent.click(screen.getByRole("button", { name: "Select Build" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect on graph" }));
  fireEvent.click(screen.getByRole("button", { name: "Select Plan" }));
  expect(screen.getByRole("alert").textContent).toContain("circular chain");
  expect(commands).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove prerequisite Plan" }));
  await waitFor(() => expect(store.getState().lastError).toBe("Dependency save failed"));
  expect(store.getState().tasks[b.id]?.dependency_ids).toEqual([a.id]);
});

// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Api } from "./lib/api";
import type { Changes, Command, Task } from "./lib/types";
import { createAppRouter } from "./router";
import { StoreProvider } from "./store/context";
import { createTaskStore, type TaskStore } from "./store/store";
import { STATUS, snapshot, task } from "./test/fixtures";

/** A core that confirms every write with what the store optimistically showed. */
function fakeApi(getStore: () => TaskStore, tasks: Task[]) {
  const executed: Command[][] = [];
  let undos = 0;
  const api: Api = {
    snapshot: async () => snapshot({ tasks }),
    execute: async (commands) => {
      executed.push(commands);
      const ids = commands.flatMap((c) => ("task" in c ? [c.task.id] : "id" in c ? [c.id] : []));
      const live = getStore().getState().tasks;
      const confirmed = ids.flatMap((id) => (id && live[id] ? [live[id]] : []));
      return {
        batch_id: `b${executed.length}`,
        op_seq: executed.length,
        tasks: confirmed,
        projects: [],
        epics: [],
        tags: [],
        views: [],
      } as Changes;
    },
    undo: async () => {
      undos += 1;
      return null;
    },
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    onChanged: async () => () => {},
  };
  return { api, executed, undos: () => undos };
}

let store: TaskStore;
let fake: ReturnType<typeof fakeApi>;
const existing = task({ title: "Renew passport", status_id: STATUS.todo });

async function renderApp(path = "/inbox") {
  fake = fakeApi(() => store, [existing]);
  store = createTaskStore(fake.api);
  await store.getState().hydrate();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <StoreProvider store={store} api={fake.api}>
      <RouterProvider router={router} />
    </StoreProvider>,
  );
  await screen.findByRole("heading", { name: "Inbox" });
  return router;
}

beforeEach(() => renderApp());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("the app", () => {
  it("lists inbox tasks grouped by status, with counts in the sidebar", async () => {
    expect(await screen.findByText("Renew passport")).toBeTruthy();
    expect(screen.getByRole("button", { name: /To do/ })).toBeTruthy();
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: /Inbox/ }).textContent).toContain("1");
  });

  it("captures a task from the input", async () => {
    const input = screen.getByPlaceholderText(/New task/);
    fireEvent.change(input, { target: { value: "Call the bank" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Call the bank")).toBeTruthy();
    await waitFor(() => expect(fake.executed).toHaveLength(1));
    expect(fake.executed[0]?.[0]).toMatchObject({
      type: "create_task",
      task: { title: "Call the bank" },
    });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("opens the detail panel and saves field edits", async () => {
    fireEvent.click(await screen.findByText("Renew passport"));
    const panel = await screen.findByRole("complementary", { name: "Task details" });
    expect((within(panel).getByLabelText("Title") as HTMLTextAreaElement).value).toBe(
      "Renew passport",
    );

    fireEvent.change(within(panel).getByLabelText("Priority"), { target: { value: "urgent" } });
    await waitFor(() =>
      expect(fake.executed.at(-1)).toEqual([
        { type: "update_task", id: existing.id, changes: [{ priority: "urgent" }] },
      ]),
    );

    fireEvent.click(within(panel).getByRole("button", { name: /Add to today/ }));
    await waitFor(() => expect(store.getState().tasks[existing.id]?.today_on).not.toBeNull());

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Task details" })).toBeNull(),
    );
  });

  it("adds a subtask from the detail panel", async () => {
    fireEvent.click(await screen.findByText("Renew passport"));
    const panel = await screen.findByRole("complementary", { name: "Task details" });
    const input = within(panel).getByPlaceholderText("Add subtask…");
    fireEvent.change(input, { target: { value: "Book photo booth" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fake.executed.at(-1)?.[0]).toMatchObject({ type: "create_task" }));
    const created = fake.executed.at(-1)?.[0];
    expect(created).toMatchObject({ task: { parent_id: existing.id, title: "Book photo booth" } });
    expect(await within(panel).findByText("Book photo booth")).toBeTruthy();
  });

  it("undoes with Ctrl+Z outside text fields", async () => {
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });
    await waitFor(() => expect(fake.undos()).toBe(1));
  });

  it("checks a task off from the list", async () => {
    fireEvent.click(await screen.findByLabelText("Done: Renew passport"));
    await waitFor(() =>
      expect(fake.executed.at(-1)).toEqual([
        { type: "update_task", id: existing.id, changes: [{ status_id: STATUS.done }] },
      ]),
    );
    // Done tasks leave the inbox.
    await waitFor(() => expect(screen.queryByText("Renew passport")).toBeNull());
  });
});

describe("the board", () => {
  async function openBoard() {
    fireEvent.click(screen.getByRole("button", { name: "board" }));
    return screen.findByRole("list", { name: "To do" });
  }

  it("shows cards in status columns and remembers the layout per view", async () => {
    const todo = await openBoard();
    expect(within(todo).getByRole("button", { name: "Renew passport" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "In progress" })).toBeTruthy();
    expect(localStorage.getItem("task-master.view.inbox")).toContain('"board"');
  });

  it("moves a focused card to the next column with Alt+→, as one move_task", async () => {
    const todo = await openBoard();
    const card = within(todo).getByRole("button", { name: "Renew passport" });
    fireEvent.keyDown(card, { key: "ArrowRight", altKey: true });
    await waitFor(() =>
      expect(fake.executed.at(-1)).toEqual([
        { type: "move_task", id: existing.id, status_id: STATUS.inProgress, rank: "a0" },
      ]),
    );
    const inProgress = screen.getByRole("list", { name: "In progress" });
    expect(await within(inProgress).findByRole("button", { name: "Renew passport" })).toBeTruthy();
  });

  it("opens the detail panel when a card is clicked", async () => {
    const todo = await openBoard();
    fireEvent.click(within(todo).getByRole("button", { name: "Renew passport" }));
    expect(await screen.findByRole("complementary", { name: "Task details" })).toBeTruthy();
  });

  it("splits the board into lanes", async () => {
    await openBoard();
    fireEvent.change(screen.getByLabelText("Swimlanes"), { target: { value: "priority" } });
    expect(await screen.findByRole("region", { name: "Lane Normal" })).toBeTruthy();
  });
});

describe("saved views", () => {
  it("saves the current view, reopens it from the sidebar and saves edits", async () => {
    fireEvent.click(screen.getByRole("button", { name: "board" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as view" }));
    const name = screen.getByPlaceholderText("Name of the new view");
    fireEvent.change(name, { target: { value: "Triage board" } });
    fireEvent.keyDown(name, { key: "Enter" });

    await waitFor(() => expect(fake.executed.at(-1)?.[0]).toMatchObject({ type: "create_view" }));
    const created = fake.executed.at(-1)?.[0];
    expect(created).toMatchObject({
      view: {
        name: "Triage board",
        spec: { version: 1, scope: { kind: "inbox" }, layout: "board" },
      },
    });
    expect(await screen.findByRole("button", { name: "Triage board" })).toBeTruthy();
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Triage board" })).toBeTruthy();

    // Edits are a draft until saved.
    fireEvent.change(screen.getByLabelText("Filter by due date"), { target: { value: "overdue" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save view" }));
    await waitFor(() => expect(fake.executed.at(-1)?.[0]).toMatchObject({ type: "update_view" }));
    expect(fake.executed.at(-1)?.[0]).toMatchObject({
      changes: [{ spec: { filter: { due: "overdue" }, layout: "board" } }],
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save view" })).toBeNull());
  });
});

describe("organization", () => {
  it("opens a tag's view from the sidebar and captures tagged tasks there", async () => {
    cleanup();
    const tagged = task({ title: "Tagged one", tag_ids: ["g1"] });
    fake = fakeApi(() => store, [existing, tagged]);
    fake.api.snapshot = async () =>
      snapshot({
        tasks: [existing, tagged],
        tags: [
          { id: "g1", name: "quick", color: null, created_at: 1, updated_at: 1, deleted_at: null },
        ],
      });
    store = createTaskStore(fake.api);
    await store.getState().hydrate();
    render(
      <StoreProvider store={store} api={fake.api}>
        <RouterProvider
          router={createAppRouter(createMemoryHistory({ initialEntries: ["/inbox"] }))}
        />
      </StoreProvider>,
    );
    fireEvent.click(await screen.findByRole("link", { name: /#quick/ }));
    expect(await screen.findByRole("heading", { name: "#quick" })).toBeTruthy();
    expect(screen.getByText("Tagged one")).toBeTruthy();
    expect(screen.queryByText("Renew passport")).toBeNull();

    const input = screen.getByPlaceholderText(/New task/);
    fireEvent.change(input, { target: { value: "Also quick" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(fake.executed.at(-1)?.[0]).toMatchObject({
        type: "create_task",
        task: { title: "Also quick", tag_ids: ["g1"] },
      }),
    );
  });
});

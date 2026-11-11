// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultsForPath } from "./features/shell/Layout";
import type { Api } from "./lib/api";
import { reloadKeymap } from "./lib/keymap";
import type { Changes, Command, Task } from "./lib/types";
import { createUpdateStore, UpdateProvider } from "./lib/updater";
import { createAppRouter } from "./router";
import { StoreProvider } from "./store/context";
import { createTaskStore, type TaskStore } from "./store/store";
import { fakeParse, project, STATUS, snapshot, task } from "./test/fixtures";
import { pickOption } from "./test/select";

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
        attachments: [],
        time_blocks: [],
        agent_sessions: [],
        agent_notes: [],
        statuses: [],
      } as Changes;
    },
    undo: async () => {
      undos += 1;
      return null;
    },
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
  };
  return { api, executed, undos: () => undos };
}

let store: TaskStore;
let fake: ReturnType<typeof fakeApi>;
const existing = task({ title: "Renew passport", status_id: STATUS.todo });

async function renderApp(path = "/inbox", tasks: Task[] = [existing]) {
  fake = fakeApi(() => store, tasks);
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
  reloadKeymap();
});

describe("the app", () => {
  it("dismisses the calendar with Escape before closing the task editor", async () => {
    fireEvent.click(await screen.findByText("Renew passport"));
    const panel = await screen.findByRole("complementary", { name: "Task details" });
    const trigger = within(panel).getByRole("button", { name: "Due date" });
    fireEvent.click(trigger);
    const calendar = await screen.findByRole("dialog", { name: "Choose due date" });
    fireEvent.keyDown(within(calendar).getByRole("button", { name: "Next month" }), {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Choose due date" })).toBeNull(),
    );
    expect(screen.getByRole("complementary", { name: "Task details" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.keyDown(trigger, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Task details" })).toBeNull(),
    );
  });

  it("lists inbox tasks grouped by status, with counts in the sidebar", async () => {
    expect(await screen.findByText("Renew passport")).toBeTruthy();
    expect(screen.getByRole("button", { name: /To do/ })).toBeTruthy();
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: /Inbox/ }).textContent).toContain("1");
  });

  it("captures a task from the input", async () => {
    const input = screen.getByRole("textbox", { name: "New task" });
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

  it("captures a task with the Add task button", async () => {
    const add = screen.getByRole("button", { name: "Add task" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "New task" }), {
      target: { value: "Water plants" },
    });
    fireEvent.click(add);
    expect(await screen.findByText("Water plants")).toBeTruthy();
    await waitFor(() =>
      expect(fake.executed.at(-1)?.[0]).toMatchObject({
        type: "create_task",
        task: { title: "Water plants" },
      }),
    );
  });

  it("says so when a capture cannot be read, instead of dropping it", async () => {
    fake.api.parseCapture = () => Promise.reject(new Error("ipc down"));
    const input = screen.getByRole("textbox", { name: "New task" });
    fireEvent.change(input, { target: { value: "Lost task" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not read/);
    expect((input as HTMLInputElement).value).toBe("Lost task");
    expect(fake.executed).toHaveLength(0);
  });

  it("opens the detail panel and saves field edits", async () => {
    fireEvent.click(await screen.findByText("Renew passport"));
    const panel = await screen.findByRole("complementary", { name: "Task details" });
    expect((within(panel).getByLabelText("Title") as HTMLTextAreaElement).value).toBe(
      "Renew passport",
    );

    await pickOption(within(panel).getByRole("combobox", { name: "Priority" }), "Urgent");
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

  it("makes an existing task a subtask from the detail panel", async () => {
    const input = screen.getByRole("textbox", { name: "New task" });
    fireEvent.change(input, { target: { value: "Book photo booth" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Book photo booth");
    await waitFor(() => expect(fake.executed).toHaveLength(1));
    const tasks = Object.values(store.getState().tasks);
    const child = tasks.find((t) => t.title === "Book photo booth");

    fireEvent.click(screen.getByText("Renew passport"));
    const panel = await screen.findByRole("complementary", { name: "Task details" });
    // The panel is replaced once just after opening: look it up again and retry the click
    // until the picker is open.
    const picker = await waitFor(() => {
      const current = screen.getByRole("complementary", { name: "Task details" });
      const trigger = within(current).getByRole("button", { name: "Add an existing task…" });
      if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
      return screen.getByRole("dialog", { name: "Add an existing task as a subtask" });
    });
    // The task itself is not offered.
    expect(within(picker).queryByRole("button", { name: /Renew passport/ })).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: /Book photo booth/ }));

    await waitFor(() =>
      expect(fake.executed.at(-1)).toEqual([
        { type: "set_parent", id: child?.id, parent_id: existing.id },
      ]),
    );
    expect(store.getState().tasks[child?.id ?? ""]?.parent_id).toBe(existing.id);
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
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    await pickOption("Swimlanes", "Lanes by priority");
    expect(await screen.findByRole("region", { name: "Lane Normal" })).toBeTruthy();
  });

  it("adds a task to a lane from the + by its name", async () => {
    await openBoard();
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    await pickOption("Swimlanes", "Lanes by priority");
    const lane = await screen.findByRole("region", { name: "Lane Normal" });
    fireEvent.click(within(lane).getByRole("button", { name: "Add a task to Normal" }));
    const input = within(lane).getByPlaceholderText("New task in Normal…");
    fireEvent.change(input, { target: { value: "Book the photo booth" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(fake.executed.at(-1)?.[0]).toMatchObject({
        type: "create_task",
        task: { title: "Book the photo booth", priority: "normal", status_id: STATUS.todo },
      }),
    );
    expect(await within(lane).findByRole("button", { name: "Book the photo booth" })).toBeTruthy();
    // The field stays for the next task; Escape closes it.
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(within(lane).queryByPlaceholderText("New task in Normal…")).toBeNull();
  });

  it("collapses a lane to a strip of drop targets, remembers it, and opens it again", async () => {
    await openBoard();
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    await pickOption("Swimlanes", "Lanes by priority");
    const lane = await screen.findByRole("region", { name: "Lane Normal" });
    const toggle = within(lane).getByRole("button", { name: /Normal/, expanded: true });
    fireEvent.click(toggle);
    expect(within(lane).queryByRole("list", { name: "To do, Normal" })).toBeNull();
    expect(within(lane).queryByRole("button", { name: "Renew passport" })).toBeNull();
    expect(within(lane).getByRole("group", { name: "To do, Normal (collapsed)" })).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("task-master.board.lanes")).toBe('{"priority:normal":true}');
    fireEvent.click(toggle);
    expect(await within(lane).findByRole("list", { name: "To do, Normal" })).toBeTruthy();
    expect(localStorage.getItem("task-master.board.lanes")).toBe('{"priority:normal":false}');
  });

  it("starts lanes with nothing left to do collapsed, until opened by hand", async () => {
    cleanup();
    const finished = task({
      title: "File the receipts",
      priority: "low",
      status_id: STATUS.done,
      completed_at: Date.now(),
    });
    fake = fakeApi(() => store, [existing, finished]);
    store = createTaskStore(fake.api);
    await store.getState().hydrate();
    render(
      <StoreProvider store={store} api={fake.api}>
        <RouterProvider
          router={createAppRouter(createMemoryHistory({ initialEntries: ["/inbox"] }))}
        />
      </StoreProvider>,
    );
    await screen.findByRole("heading", { name: "Inbox" });
    await openBoard();
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    await pickOption("Swimlanes", "Lanes by priority");
    // Low has only a done card; Normal has an open one.
    const normal = await screen.findByRole("region", { name: "Lane Normal" });
    expect(within(normal).getByRole("button", { name: /Normal/, expanded: true })).toBeTruthy();
    const low = screen.getByRole("region", { name: "Lane Low" });
    const toggle = within(low).getByRole("button", { name: /Low/, expanded: false });
    expect(within(low).queryByRole("button", { name: "File the receipts" })).toBeNull();
    fireEvent.click(toggle);
    expect(await within(low).findByRole("button", { name: "File the receipts" })).toBeTruthy();
    expect(localStorage.getItem("task-master.board.lanes")).toBe('{"priority:low":false}');
  });

  it("collapses a column to a strip, remembers it, and expands it again", async () => {
    await openBoard();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Waiting" }));
    expect(screen.queryByRole("list", { name: "Waiting" })).toBeNull();
    expect(localStorage.getItem("task-master.board.columns")).toContain('"collapsed":true');
    // The other columns stay open.
    expect(screen.getByRole("list", { name: "To do" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand Waiting" }));
    expect(await screen.findByRole("list", { name: "Waiting" })).toBeTruthy();
    expect(localStorage.getItem("task-master.board.columns")).toBe("{}");
  });

  it("moves a card into a collapsed column with Alt+→, on top", async () => {
    const todo = await openBoard();
    fireEvent.click(screen.getByRole("button", { name: "Collapse In progress" }));
    const card = within(todo).getByRole("button", { name: "Renew passport" });
    fireEvent.keyDown(card, { key: "ArrowRight", altKey: true });
    await waitFor(() =>
      expect(fake.executed.at(-1)).toEqual([
        { type: "move_task", id: existing.id, status_id: STATUS.inProgress, rank: "a0" },
      ]),
    );
    expect(within(todo).queryByRole("button", { name: "Renew passport" })).toBeNull();
  });

  it("resizes a column and lays cards side by side once it is wide", async () => {
    const todo = await openBoard();
    expect(todo.dataset.lanes).toBe("1");
    const handle = screen.getByRole("separator", { name: "Resize To do" });
    // The columns fit the test viewport until a width is chosen by hand.
    const initialWidth = Number(handle.getAttribute("aria-valuenow"));
    expect(initialWidth).toBe(224);
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(handle.getAttribute("aria-valuenow")).toBe(String(initialWidth + 64));
    fireEvent.keyDown(handle, { key: "End" });
    expect(screen.getByRole("list", { name: "To do" }).dataset.lanes).toBe("3");
    expect(within(todo).getByRole("button", { name: "Renew passport" })).toBeTruthy();
    expect(localStorage.getItem("task-master.board.columns")).toContain('"width":960');
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe(String(initialWidth));
    expect(localStorage.getItem("task-master.board.columns")).toBe("{}");
  });
});

describe("multi-select", () => {
  const a = task({ title: "Alpha", status_id: STATUS.todo, rank: "a1" });
  const b = task({ title: "Bravo", status_id: STATUS.todo, rank: "a2" });
  const c = task({ title: "Charlie", status_id: STATUS.todo, rank: "a3" });

  beforeEach(async () => {
    cleanup();
    await renderApp("/inbox", [a, b, c]);
    await screen.findByText("Charlie");
  });

  /** The title button of a list row (the open panel may show the same title). */
  const row = (title: string) => {
    const rows = screen.getAllByTestId("task-row");
    const el = rows.find((r) => within(r).queryByRole("button", { name: title }));
    if (!el) throw new Error(`no row ${title}`);
    return within(el).getByRole("button", { name: title });
  };
  const picked = () =>
    screen
      .getAllByTestId("task-row")
      .filter((r) => r.dataset.picked)
      .map((r) => [a, b, c].find((t) => r.textContent?.includes(t.title))?.title);

  it("picks tasks with Ctrl and Shift+click and sets their status in one batch", async () => {
    fireEvent.click(row("Alpha"), { ctrlKey: true });
    fireEvent.click(row("Charlie"), { shiftKey: true });
    const bar = await screen.findByRole("toolbar", { name: "Selected tasks" });
    expect(within(bar).getByText("3 selected")).toBeTruthy();
    // Ctrl+click takes one back out.
    fireEvent.click(row("Bravo"), { ctrlKey: true });
    expect(within(bar).getByText("2 selected")).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Task details" })).toBeNull();

    fireEvent.keyDown(within(bar).getByRole("button", { name: "Status" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "In progress" }));
    await waitFor(() =>
      expect(fake.executed.at(-1)).toEqual([
        { type: "update_task", id: a.id, changes: [{ status_id: STATUS.inProgress }] },
        { type: "update_task", id: c.id, changes: [{ status_id: STATUS.inProgress }] },
      ]),
    );
  });

  it("clears with Esc, and a plain click opens the task instead", async () => {
    fireEvent.click(row("Alpha"), { ctrlKey: true });
    await screen.findByRole("toolbar", { name: "Selected tasks" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Selected tasks" })).toBeNull());

    fireEvent.click(row("Alpha"), { ctrlKey: true });
    fireEvent.click(row("Bravo"));
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Selected tasks" })).toBeNull());
    expect(await screen.findByRole("complementary", { name: "Task details" })).toBeTruthy();
  });

  it("starts from the open task, and keeps the panel open on Esc", async () => {
    fireEvent.click(row("Alpha"));
    await screen.findByRole("complementary", { name: "Task details" });
    fireEvent.click(row("Bravo"), { shiftKey: true });
    await waitFor(() => expect(picked()).toEqual(["Alpha", "Bravo"]));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(picked()).toEqual([]));
    expect(screen.getByRole("complementary", { name: "Task details" })).toBeTruthy();
  });

  it("selects every task with Ctrl+A and deletes them as one undoable batch", async () => {
    fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
    const bar = await screen.findByRole("toolbar", { name: "Selected tasks" });
    expect(within(bar).getByText("3 selected")).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(fake.executed.at(-1)).toEqual([
        { type: "delete_task", id: a.id },
        { type: "delete_task", id: b.id },
        { type: "delete_task", id: c.id },
      ]),
    );
    await waitFor(() => expect(screen.queryByText("Alpha")).toBeNull());
    expect(screen.queryByRole("toolbar", { name: "Selected tasks" })).toBeNull();
  });

  it("picks cards on the board too", async () => {
    fireEvent.click(screen.getByRole("button", { name: "board" }));
    const todo = await screen.findByRole("list", { name: "To do" });
    fireEvent.click(within(todo).getByRole("button", { name: "Alpha" }), { ctrlKey: true });
    fireEvent.click(within(todo).getByRole("button", { name: "Bravo" }), { metaKey: true });
    const bar = await screen.findByRole("toolbar", { name: "Selected tasks" });
    expect(within(bar).getByText("2 selected")).toBeTruthy();
    expect(within(todo).getByRole("button", { name: "Alpha" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.keyDown(within(bar).getByRole("button", { name: "Priority" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
    await waitFor(() =>
      expect(fake.executed.at(-1)).toEqual([
        { type: "update_task", id: a.id, changes: [{ priority: "high" }] },
        { type: "update_task", id: b.id, changes: [{ priority: "high" }] },
      ]),
    );
  });
});

describe("saved views", () => {
  it("saves the current view, reopens it from the sidebar and saves edits", async () => {
    fireEvent.click(screen.getByRole("button", { name: "board" }));
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save as view" }));
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
    fireEvent.click(within(nav).getByRole("button", { name: /Saved views/ }));
    expect(within(nav).getByRole("link", { name: "Triage board" })).toBeTruthy();

    // Edits are a draft until saved.
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await pickOption("Filter by due date", "Overdue");
    fireEvent.click(await screen.findByRole("button", { name: "Save view" }));
    await waitFor(() => expect(fake.executed.at(-1)?.[0]).toMatchObject({ type: "update_view" }));
    expect(fake.executed.at(-1)?.[0]).toMatchObject({
      changes: [{ spec: { filter: { due: "overdue" }, layout: "board" } }],
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save view" })).toBeNull());
  });
});

describe("organization", () => {
  it("renames a project from its page with the Rename button", async () => {
    cleanup();
    const home = project({ id: "p1", name: "Home" });
    fake = fakeApi(() => store, [existing]);
    fake.api.snapshot = async () => snapshot({ tasks: [existing], projects: [home] });
    store = createTaskStore(fake.api);
    await store.getState().hydrate();
    render(
      <StoreProvider store={store} api={fake.api}>
        <RouterProvider
          router={createAppRouter(createMemoryHistory({ initialEntries: ["/project/p1"] }))}
        />
      </StoreProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Rename Home" }));
    const input = screen.getByDisplayValue("Home");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "House" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(fake.executed.at(-1)?.[0]).toMatchObject({ type: "update_project", id: "p1" }),
    );
    expect(store.getState().projects.p1?.name).toBe("House");
  });

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
    fireEvent.click(await screen.findByRole("button", { name: /Tags/ }));
    fireEvent.click(await screen.findByRole("link", { name: /quick/ }));
    expect(await screen.findByRole("heading", { name: "#quick" })).toBeTruthy();
    expect(screen.getByText("Tagged one")).toBeTruthy();
    expect(screen.queryByText("Renew passport")).toBeNull();

    const input = screen.getByRole("textbox", { name: "New task" });
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

describe("speed", () => {
  it("previews capture markers and asks before creating an unknown project", async () => {
    const input = screen.getByRole("textbox", { name: "New task" });
    fireEvent.change(input, { target: { value: "Plan trip #travel @Holidays !high" } });
    const preview = await screen.findByTestId("capture-preview");
    expect(within(preview).getByText(/@Holidays/).textContent).toContain("new project");
    expect(within(preview).getByText(/#travel/)).toBeTruthy();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(fake.executed).toHaveLength(0);

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fake.executed).toHaveLength(1));
    expect(fake.executed[0]?.map((c) => c.type)).toEqual([
      "create_tag",
      "create_project",
      "create_task",
    ]);
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("opens the palette with Ctrl+K and jumps to a task found by search", async () => {
    fake.api.search = async () => [existing.id];
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const command = await screen.findByLabelText("Command");
    fireEvent.change(command, { target: { value: "passport" } });
    const results = screen.getByRole("list", { name: "Results" });
    expect(await within(results).findByText("Renew passport")).toBeTruthy();
    fireEvent.keyDown(command, { key: "ArrowDown" });
    fireEvent.change(command, { target: { value: "renew" } });
    await within(results).findByText("Renew passport");
    fireEvent.keyDown(command, { key: "Enter" });
    expect(await screen.findByRole("complementary", { name: "Task details" })).toBeTruthy();
  });

  it("navigates with g then a letter, and shows shortcuts on ?", async () => {
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "t" });
    expect(await screen.findByRole("heading", { name: "Today" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "?" });
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });

  it("plans the day: number keys add suggestions to Today", async () => {
    cleanup();
    const urgent = task({ title: "Call the plumber", priority: "urgent" });
    fake = fakeApi(() => store, [urgent]);
    store = createTaskStore(fake.api);
    await store.getState().hydrate();
    render(
      <StoreProvider store={store} api={fake.api}>
        <RouterProvider
          router={createAppRouter(createMemoryHistory({ initialEntries: ["/today"] }))}
        />
      </StoreProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Plan my day" }));
    const panel = await screen.findByRole("region", { name: "Plan my day" });
    expect(within(panel).getByText("Call the plumber")).toBeTruthy();
    fireEvent.keyDown(window, { key: "1" });
    await waitFor(() =>
      expect(fake.executed.at(-1)?.[0]).toMatchObject({
        type: "update_task",
        id: urgent.id,
        changes: [{ today_on: expect.any(String) }],
      }),
    );
    expect(await within(panel).findByText(/Nothing pressing/)).toBeTruthy();
  });
});

describe("keyboard shortcuts", () => {
  it("opens the list from the ? box in the sidebar, and links to Settings", async () => {
    expect(screen.queryByText("G S")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByText("Go to Settings")).toBeTruthy();
    expect(within(dialog).getByText("Ctrl+,")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Change shortcuts" }));
    expect(await screen.findByRole("heading", { name: "Keyboard shortcuts" })).toBeTruthy();
  });

  it("remaps a shortcut in Settings and uses it right away", async () => {
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Shortcuts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add a shortcut for Go to Today" }));
    fireEvent.keyDown(window, { key: "t", altKey: true });
    expect(
      await screen.findByRole("button", { name: "Remove Alt+T from Go to Today" }),
    ).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("task-master.shortcuts") ?? "{}")).toEqual({
      goToday: ["G T", "Alt+T"],
    });

    // Taken from another action: it moves, with a note.
    fireEvent.click(screen.getByRole("button", { name: "Add a shortcut for Go to Inbox" }));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByText("Ctrl+K moved from “Jump to anything”.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Ctrl+K from Go to Inbox" }));

    // Kept for typing: refused.
    fireEvent.click(screen.getByRole("button", { name: "Add a shortcut for Undo" }));
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    expect(await screen.findByText("Ctrl+C: kept for typing and lists.")).toBeTruthy();

    fireEvent.keyDown(window, { key: "t", altKey: true });
    expect(await screen.findByRole("heading", { name: "Today" })).toBeTruthy();
  });
});

describe("settings", () => {
  it("edits the workflow, and the board shows the WIP limit", async () => {
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "s" });
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Workflow" }));
    const limit = await screen.findByLabelText("To do WIP limit");
    fireEvent.change(limit, { target: { value: "0" } });
    fireEvent.change(limit, { target: { value: "1" } });
    fireEvent.blur(limit);
    await waitFor(() =>
      expect(fake.executed.at(-1)).toEqual([
        { type: "update_status", id: STATUS.todo, changes: [{ wip_limit: 1 }] },
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    const name = screen.getByPlaceholderText(/Column name/);
    fireEvent.change(name, { target: { value: "Review" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() => expect(fake.executed.at(-1)?.[0]).toMatchObject({ type: "create_status" }));
    expect(screen.getAllByTestId("status-row")).toHaveLength(7);
  });
});

/** Renders the app at `path` with these projects (and the usual inbox task). */
async function renderWith(path: string, projects: ReturnType<typeof project>[] = []) {
  cleanup();
  fake = fakeApi(() => store, [existing]);
  fake.api.snapshot = async () => snapshot({ tasks: [existing], projects });
  store = createTaskStore(fake.api);
  await store.getState().hydrate();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <StoreProvider store={store} api={fake.api}>
      <RouterProvider router={router} />
    </StoreProvider>,
  );
  return router;
}

describe("redesign", () => {
  it("gives a new task the page's project, epic, tag or today", () => {
    expect(defaultsForPath("/project/p1", "2026-11-05")).toEqual({ project_id: "p1" });
    expect(defaultsForPath("/epic/e1", "2026-11-05")).toEqual({ epic_id: "e1" });
    expect(defaultsForPath("/tag/t1", "2026-11-05")).toEqual({ tag_ids: ["t1"] });
    expect(defaultsForPath("/today", "2026-11-05")).toEqual({ today_on: "2026-11-05" });
    expect(defaultsForPath("/inbox", "2026-11-05")).toEqual({});
  });

  it("opens a task as a full page from the panel and edits it there", async () => {
    const router = await renderWith(`/inbox?task=${existing.id}`);
    const panel = await screen.findByRole("complementary", { name: "Task details" });
    fireEvent.click(within(panel).getByRole("button", { name: /Open/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/task/${existing.id}`));
    expect(router.state.location.search).toEqual({});
    // The page replaces the panel and collapses the sidebar to a rail.
    expect(screen.queryByRole("complementary", { name: "Task details" })).toBeNull();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
    const title = (await screen.findByLabelText("Title")) as HTMLTextAreaElement;
    expect(title.value).toBe("Renew passport");
    await pickOption("Priority", "High priority");
    await waitFor(() =>
      expect(fake.executed.at(-1)?.[0]).toMatchObject({
        type: "update_task",
        id: existing.id,
        changes: [{ priority: "high" }],
      }),
    );
  });

  it("opens a subtask's full page when it is clicked on the full page", async () => {
    cleanup();
    const child = task({ title: "Book the photo", status_id: STATUS.todo, parent_id: existing.id });
    fake = fakeApi(() => store, [existing, child]);
    fake.api.snapshot = async () => snapshot({ tasks: [existing, child] });
    store = createTaskStore(fake.api);
    await store.getState().hydrate();
    const router = createAppRouter(
      createMemoryHistory({ initialEntries: [`/task/${existing.id}`] }),
    );
    render(
      <StoreProvider store={store} api={fake.api}>
        <RouterProvider router={router} />
      </StoreProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Book the photo" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/task/${child.id}`));
    expect(router.state.location.search).toEqual({});
    const title = (await screen.findByLabelText("Title")) as HTMLTextAreaElement;
    await waitFor(() => expect(title.value).toBe("Book the photo"));
  });

  it("opens the full page with Shift+Enter on a list row", async () => {
    const router = await renderWith("/inbox");
    const row = await screen.findByRole("button", { name: "Renew passport" });
    fireEvent.keyDown(row, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/task/${existing.id}`));
    // Only a task just created opens with the cursor in its description.
    const description = await screen.findByRole("region", { name: "Description" });
    expect(description.contains(document.activeElement)).toBe(false);
  });

  it("puts the cursor in the description of a task added with Shift+Enter", async () => {
    const router = await renderWith("/inbox");
    const input = await screen.findByRole("textbox", { name: "New task" });
    fireEvent.change(input, { target: { value: "Draft the brief" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/task\//));
    const description = await screen.findByRole("region", { name: "Description" });
    await waitFor(() => expect(description.contains(document.activeElement)).toBe(true));
    expect(document.activeElement?.classList.contains("cm-content")).toBe(true);
  });

  it("opens a task added from the top row in the side panel, ready to describe", async () => {
    const router = await renderWith("/inbox");
    const input = await screen.findByRole("textbox", { name: "New task" });
    fireEvent.change(input, { target: { value: "Book the venue" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const panel = await screen.findByRole("complementary", { name: "Task details" });
    expect((within(panel).getByLabelText("Title") as HTMLTextAreaElement).value).toBe(
      "Book the venue",
    );
    expect(router.state.location.pathname).toBe("/inbox");
    const description = within(panel).getByRole("region", { name: "Description" });
    await waitFor(() => expect(description.contains(document.activeElement)).toBe(true));

    // The next task opened from the list does not take the cursor.
    fireEvent.click(screen.getByRole("button", { name: "Renew passport" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ task: existing.id }));
    const next = await screen.findByRole("complementary", { name: "Task details" });
    expect(
      within(next).getByRole("region", { name: "Description" }).contains(document.activeElement),
    ).toBe(false);
  });

  it("keeps the cursor in the description when a new task's panel opens the full page", async () => {
    const router = await renderWith("/inbox");
    const input = await screen.findByRole("textbox", { name: "New task" });
    fireEvent.change(input, { target: { value: "Plan the trip" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const panel = await screen.findByRole("complementary", { name: "Task details" });
    fireEvent.click(within(panel).getByRole("button", { name: /Open/ }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/task\//));
    expect(router.state.location.search).toEqual({ focus: "description" });
    const description = await screen.findByRole("region", { name: "Description" });
    await waitFor(() => expect(description.contains(document.activeElement)).toBe(true));
    expect(document.activeElement?.classList.contains("cm-content")).toBe(true);
  });

  it("keeps the panel closed when Settings turns that off", async () => {
    const router = await renderWith("/settings");
    const box = await screen.findByRole("checkbox", { name: /top row in the side panel/ });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    expect(localStorage.getItem("task-master.capture.open-in-panel")).toBe("0");

    await router.navigate({ to: "/inbox" });
    const input = await screen.findByRole("textbox", { name: "New task" });
    fireEvent.change(input, { target: { value: "Water the plants" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(fake.executed.at(-1)?.[0]).toMatchObject({
        type: "create_task",
        task: { title: "Water the plants" },
      }),
    );
    expect(screen.queryByRole("complementary", { name: "Task details" })).toBeNull();
    expect(router.state.location.search).toEqual({});
  });

  it("shows one Settings category at a time, picked from the side nav or the URL hash", async () => {
    const router = await renderWith("/settings");
    const nav = await screen.findByRole("navigation", { name: "Settings categories" });
    expect(within(nav).getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Workflow" })).toBeNull();

    fireEvent.click(within(nav).getByRole("button", { name: "Workflow" }));
    expect(await screen.findByRole("heading", { name: "Workflow" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Appearance" })).toBeNull();
    expect(router.state.location.hash).toBe("workflow");

    await router.navigate({ to: "/settings", search: {}, hash: "shortcuts" });
    expect(await screen.findByRole("heading", { name: "Keyboard shortcuts" })).toBeTruthy();
  });

  it("installs from the sidebar Update pill, then restarts from it", async () => {
    cleanup();
    fake = fakeApi(() => store, [existing]);
    store = createTaskStore(fake.api);
    await store.getState().hydrate();
    let finish: () => void = () => {};
    let relaunched = 0;
    const updates = createUpdateStore({
      check: async () => ({
        version: "9.9.9",
        notes: null,
        date: null,
        install: (progress) =>
          new Promise<void>((resolve) => {
            progress(0.4);
            finish = resolve;
          }),
      }),
      relaunch: async () => {
        relaunched += 1;
      },
    });
    await updates.getState().check();
    const router = createAppRouter(createMemoryHistory({ initialEntries: ["/inbox"] }));
    render(
      <UpdateProvider value={updates}>
        <StoreProvider store={store} api={fake.api}>
          <RouterProvider router={router} />
        </StoreProvider>
      </UpdateProvider>,
    );
    fireEvent.click(await screen.findByRole("link", { name: "Update to 9.9.9" }));
    // It starts the download and shows it in Settings → About.
    await waitFor(() => expect(router.state.location.hash).toBe("about"));
    expect((await screen.findByRole("progressbar")).getAttribute("aria-valuenow")).toBe("40");
    expect(screen.getByRole("link", { name: "Downloading 9.9.9 · 40%" })).toBeTruthy();
    await act(async () => finish());
    fireEvent.click(await screen.findByRole("link", { name: "Restart to use 9.9.9" }));
    await waitFor(() => expect(relaunched).toBe(1));
  });

  it("does the same from the New task dialog", async () => {
    await renderWith("/inbox");
    await screen.findByRole("heading", { name: "Inbox" });
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    const input = within(dialog).getByRole("textbox", { name: "New task" });
    fireEvent.change(input, { target: { value: "Call the bank" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    const description = await screen.findByRole("region", { name: "Description" });
    await waitFor(() => expect(description.contains(document.activeElement)).toBe(true));
  });

  it("adds a task from the sidebar's New task button into the current project", async () => {
    await renderWith("/project/pw", [project({ id: "pw", name: "Website" })]);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const dialog = await screen.findByRole("dialog", { name: "New task in Website" });
    const input = within(dialog).getByRole("textbox", { name: "New task" });
    fireEvent.change(input, { target: { value: "Fix the footer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(fake.executed.at(-1)?.[0]).toMatchObject({
        type: "create_task",
        task: { title: "Fix the footer", project_id: "pw" },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the New task dialog with Ctrl+N and jumps to projects with Ctrl+1–9", async () => {
    const router = await renderWith("/inbox", [
      project({ id: "pa", name: "Alpha", rank: "a1" }),
      project({ id: "pb", name: "Beta", rank: "a2" }),
    ]);
    await screen.findByRole("heading", { name: "Inbox" });
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    await waitFor(() => expect(router.state.location.pathname).toBe("/project/pb"));
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "New task in Beta" })).toBeTruthy();
  });

  it("renames a project from the sidebar with a double-click", async () => {
    await renderWith("/inbox", [project({ id: "pa", name: "Alpha" })]);
    const nav = await screen.findByRole("navigation");
    fireEvent.doubleClick(within(nav).getByRole("link", { name: "Alpha" }));
    const input = within(nav).getByDisplayValue("Alpha");
    fireEvent.change(input, { target: { value: "Alpha site" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(store.getState().projects.pa?.name).toBe("Alpha site"));
    expect(fake.executed.at(-1)?.[0]).toMatchObject({ type: "update_project", id: "pa" });
  });
});

describe("Task search", () => {
  it("searches within a scoped view's board as well as All tasks", async () => {
    await renderWith("/inbox");
    await screen.findByRole("heading", { name: "Inbox" });
    fireEvent.click(screen.getByRole("button", { name: "board" }));
    const input = screen.getByRole("searchbox", { name: "Search tasks" });
    fake.api.search = async (text) => (text === "passport" ? [existing.id] : []);
    fireEvent.change(input, { target: { value: "passport" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("1 matching task");
    expect(screen.getByRole("button", { name: "Renew passport" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("0 matching tasks");
    expect(screen.queryByRole("button", { name: "Renew passport" })).toBeNull();
  });

  it("ignores an older search response after the search is cleared", async () => {
    await renderWith("/all");
    const input = await screen.findByRole("searchbox", { name: "Search tasks" });
    let resolveSearch: (ids: string[]) => void = () => {};
    fake.api.search = () =>
      new Promise<string[]>((resolve) => {
        resolveSearch = resolve;
      });
    fireEvent.change(input, { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.queryAllByText("Searching…").length).toBeGreaterThan(0));
    fireEvent.change(input, { target: { value: "" } });
    await act(async () => {
      resolveSearch([]);
    });
    expect(screen.getByRole("button", { name: "Renew passport" })).toBeTruthy();
    expect(screen.queryByText("No matching tasks.")).toBeNull();
  });

  it("searches from the split top row and clears back to all tasks", async () => {
    await renderWith("/all");
    await screen.findByRole("heading", { name: "All tasks" });
    expect(screen.getByRole("textbox", { name: "New task" })).toBeTruthy();
    const input = screen.getByRole("searchbox", { name: "Search tasks" });
    const calls: string[] = [];
    fake.api.search = async (text) => {
      calls.push(text);
      return text === "passport" ? [existing.id] : [];
    };
    fireEvent.change(input, { target: { value: "passport" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("1 matching task");
    expect(calls).toContain("passport");
    expect(screen.getByRole("button", { name: "Renew passport" })).toBeTruthy();

    fireEvent.change(input, { target: { value: "missing" } });
    fireEvent.submit(screen.getByRole("form", { name: "Search tasks" }));
    await screen.findByText("No matching tasks.");
    expect(screen.queryByRole("button", { name: "Renew passport" })).toBeNull();
    fireEvent.change(input, { target: { value: "" } });
    await screen.findByRole("button", { name: "Renew passport" });
  });

  it("filters board cards and reports search failures", async () => {
    await renderWith("/all");
    await screen.findByRole("heading", { name: "All tasks" });
    fireEvent.click(screen.getByRole("button", { name: "board" }));
    const input = screen.getByRole("searchbox", { name: "Search tasks" });
    fake.api.search = async () => [];
    fireEvent.change(input, { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("0 matching tasks");
    expect(screen.queryByRole("button", { name: "Renew passport" })).toBeNull();
    fake.api.search = async () => {
      throw new Error("Unavailable");
    };
    fireEvent.change(input, { target: { value: "failure" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Could not search tasks. Clear the search and try again.");
    fireEvent.change(input, { target: { value: "" } });
    await screen.findByRole("button", { name: "Renew passport" });
  });
});

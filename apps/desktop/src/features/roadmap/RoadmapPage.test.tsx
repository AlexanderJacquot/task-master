// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { isoDate } from "../../lib/dates";
import type { Command, Epic, Task } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeParse, STATUS, snapshot, task } from "../../test/fixtures";
import { pickOption } from "../../test/select";
import { LAYOUT_KEY, loadLayout } from "./saved";
import { addDays, addWorkingDays, DAY_WIDTH, dayNumber } from "./timeline";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const today = isoDate();
const day = (n: number) => addDays(today, n);

function epic(overrides: Partial<Epic>): Epic {
  return {
    id: "e",
    project_id: null,
    name: "Epic",
    color: null,
    icon: null,
    description: null,
    target_date: null,
    state: "active",
    rank: "a",
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    ...overrides,
  };
}

async function setup(tasks: Task[], epics: Epic[] = [], path = "/roadmap") {
  const commands: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot({ tasks, epics }),
    execute: async (batch) => {
      commands.push(batch);
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
        agent_sessions: [],
        agent_notes: [],
        meetings: [],
        transcript_segments: [],
        terminal_sessions: [],
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
      <RouterProvider router={createAppRouter(createMemoryHistory({ initialEntries: [path] }))} />
    </StoreProvider>,
  );
  if (path === "/roadmap") await screen.findByRole("heading", { name: "Roadmap" });
  return { store, commands };
}

const timeline = () => screen.getByRole("application", { name: "Roadmap timeline" });
const bar = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}, `) });
const left = (title: string) => Number.parseFloat(bar(title).style.left);

function drag(from: HTMLElement, startX: number, endX: number, finish = true) {
  fireEvent.pointerDown(from, { button: 0, pointerId: 1, clientX: startX, clientY: 10 });
  fireEvent.pointerMove(timeline(), { pointerId: 1, clientX: endX, clientY: 10 });
  if (finish) fireEvent.pointerUp(timeline(), { pointerId: 1, clientX: endX, clientY: 10 });
}

it("is next to Lineage in the sidebar and moves a bar's due date by dragging it", async () => {
  const plan = task({ title: "Plan", due_date: day(3), estimate_min: 2 * 480 });
  const { store, commands } = await setup([plan]);
  const nav = screen.getByRole("navigation");
  const links = within(nav)
    .getAllByRole("link")
    .map((link) => link.textContent);
  expect(links.indexOf("Roadmap")).toBe(links.indexOf("Lineage") + 1);

  const width = DAY_WIDTH.week;
  const before = left("Plan");
  // An unfinished drag only previews; Escape puts the bar back without saving.
  drag(bar("Plan"), 100, 100 + 2 * width, false);
  expect(left("Plan")).toBe(before + 2 * width);
  fireEvent.keyDown(timeline(), { key: "Escape" });
  expect(left("Plan")).toBe(before);
  expect(commands).toHaveLength(0);

  drag(bar("Plan"), 100, 100 + 2 * width);
  await waitFor(() => expect(store.getState().tasks[plan.id]?.due_date).toBe(day(5)));
  expect(commands.at(-1)).toEqual([
    { type: "update_task", id: plan.id, changes: [{ due_date: day(5) }] },
  ]);
  // The start is the roadmap's, kept on this machine; the bar keeps its length.
  expect(loadLayout().starts[plan.id]).toBe(addDays(addWorkingDays(day(3), -1), 2));
  expect(left("Plan")).toBe(before + 2 * width);
});

it("resizes a bar from its end and its start, and moves it from the keyboard", async () => {
  const build = task({ title: "Build", due_date: day(10) });
  const { store, commands } = await setup([build]);
  const width = DAY_WIDTH.week;
  // Dragging the start handle widens the bar to the left; the due date stays.
  const startHandle = bar("Build").querySelector("[data-handle='start']") as HTMLElement;
  drag(startHandle, 200, 200 - 3 * width);
  await waitFor(() => expect(loadLayout().starts[build.id]).toBe(day(7)));
  expect(commands).toHaveLength(0);
  const endHandle = bar("Build").querySelector("[data-handle='end']") as HTMLElement;
  drag(endHandle, 200, 200 + width);
  await waitFor(() => expect(store.getState().tasks[build.id]?.due_date).toBe(day(11)));
  await waitFor(() => expect(store.getState().pending).toBe(0));

  fireEvent.keyDown(bar("Build"), { key: "ArrowRight" });
  await waitFor(() => expect(store.getState().tasks[build.id]?.due_date).toBe(day(12)));
  expect(loadLayout().starts[build.id]).toBe(day(8));
  await waitFor(() => expect(store.getState().pending).toBe(0));
  fireEvent.keyDown(bar("Build"), { key: "ArrowLeft", altKey: true, shiftKey: true });
  await waitFor(() => expect(loadLayout().starts[build.id]).toBe(day(1)));
  expect(store.getState().tasks[build.id]?.due_date).toBe(day(12));
});

it("schedules a task by drawing across its row or from its Schedule button", async () => {
  const draw = task({ title: "Draw me" });
  const click = task({ title: "Click me", estimate_min: 480 * 2 });
  const { store } = await setup([draw, click]);
  expect(screen.queryByRole("button", { name: /^Draw me, / })).toBeNull();
  const track = document.querySelector(`[data-track='${draw.id}']`) as HTMLElement;
  const width = DAY_WIDTH.week;
  drag(track, 10 * width + 1, 13 * width + 1);
  await waitFor(() => expect(store.getState().tasks[draw.id]?.due_date).toBeTruthy());
  const due = store.getState().tasks[draw.id]?.due_date ?? "";
  expect(dayNumber(due) - dayNumber(loadLayout().starts[draw.id] ?? "")).toBe(3);
  expect(bar("Draw me")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Schedule Click me from today" }));
  await waitFor(() => expect(store.getState().tasks[click.id]?.due_date).toBeTruthy());
  expect(loadLayout().starts[click.id]).toBe(today);

  // Unscheduled tasks can be left out.
  fireEvent.click(screen.getByRole("checkbox", { name: "Unscheduled tasks" }));
  expect(screen.getByText("2 tasks · 2 scheduled")).toBeTruthy();
});

it("draws dependency arrows and flags a task that starts before its prerequisite ends", async () => {
  const a = task({ title: "Design", due_date: day(4) });
  const b = task({ title: "Develop", due_date: day(4), dependency_ids: [a.id] });
  const c = task({ title: "Release", due_date: day(9), dependency_ids: [b.id] });
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ starts: { [c.id]: day(6) } }));
  await setup([a, b, c]);
  expect(document.querySelectorAll("[data-link]")).toHaveLength(2);
  expect(document.querySelectorAll("[data-late]")).toHaveLength(1);
  expect(screen.getByText(/1 task starts before a prerequisite ends/)).toBeTruthy();
  expect(bar("Develop").title).toContain("“Design”");
});

it("groups by epic, folds a group, and moves an epic's target date", async () => {
  const launch = epic({ id: "e1", name: "Launch", target_date: day(14) });
  const a = task({ title: "Write", epic_id: "e1", due_date: day(2) });
  const b = task({ title: "Loose end", due_date: day(3) });
  const { store, commands } = await setup([a, b], [launch]);
  expect(screen.getByRole("button", { name: "Fold No epic" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Fold Launch" }));
  expect(screen.queryByRole("button", { name: /^Write, / })).toBeNull();
  expect(loadLayout().collapsed).toEqual(["e1"]);
  fireEvent.click(screen.getByRole("button", { name: "Unfold Launch" }));
  expect(bar("Write")).toBeTruthy();

  const target = screen.getByRole("button", { name: /^Target date of Launch/ });
  fireEvent.keyDown(target, { key: "ArrowRight", shiftKey: true });
  await waitFor(() => expect(store.getState().epics.e1?.target_date).toBe(day(21)));
  expect(commands.at(-1)).toEqual([
    { type: "update_epic", id: "e1", changes: [{ target_date: day(21) }] },
  ]);

  await pickOption(screen.getByRole("combobox", { name: "Group roadmap" }), "No groups");
  expect(screen.queryByRole("button", { name: "Fold Launch" })).toBeNull();
  expect(bar("Write")).toBeTruthy();
});

it("saves the roadmap as a view, reopens it, and saves, reverts or deletes edits", async () => {
  const plan = task({ title: "Plan", due_date: day(5) });
  const done = task({ title: "Shipped", due_date: day(1), status_id: STATUS.done });
  const { commands } = await setup([plan, done]);
  // Done tasks are left out by default.
  expect(screen.queryByRole("button", { name: /^Shipped, / })).toBeNull();
  await pickOption(screen.getByRole("combobox", { name: "Timescale" }), "Days");
  fireEvent.keyDown(bar("Plan"), { key: "ArrowLeft", altKey: true });
  fireEvent.click(screen.getByRole("button", { name: "Save as view" }));
  const name = screen.getByPlaceholderText("Name of the new view");
  fireEvent.change(name, { target: { value: "Q1 plan" } });
  fireEvent.keyDown(name, { key: "Enter" });

  await waitFor(() => expect(commands.at(-1)?.[0]).toMatchObject({ type: "create_view" }));
  expect(commands.at(-1)?.[0]).toMatchObject({
    view: {
      name: "Q1 plan",
      spec: {
        scope: { kind: "all" },
        lineage: null,
        roadmap: {
          zoom: "day",
          group: "epic",
          completion: "open",
          starts: { [plan.id]: day(4) },
          hide_unscheduled: false,
        },
      },
    },
  });

  expect(await screen.findByRole("heading", { name: /Q1 plan/ })).toBeTruthy();
  const nav = screen.getByRole("navigation");
  fireEvent.click(within(nav).getByRole("button", { name: /Saved views/ }));
  expect(within(nav).getByRole("link", { name: "Q1 plan" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save view" })).toBeNull();

  // Moving a bar's start is a draft: Revert puts it back; this machine's roadmap is untouched.
  const before = left("Plan");
  fireEvent.keyDown(bar("Plan"), { key: "ArrowLeft", altKey: true });
  expect(left("Plan")).toBe(before - DAY_WIDTH.day);
  expect(loadLayout().starts[plan.id]).toBe(day(4));
  fireEvent.click(await screen.findByRole("button", { name: "Revert" }));
  await waitFor(() => expect(left("Plan")).toBe(before));
  expect(screen.queryByRole("button", { name: "Save view" })).toBeNull();

  // A filter change is a draft too.
  fireEvent.click(screen.getByRole("checkbox", { name: "Show subtasks" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save view" }));
  await waitFor(() => expect(commands.at(-1)?.[0]).toMatchObject({ type: "update_view" }));
  expect(commands.at(-1)?.[0]).toMatchObject({ changes: [{ spec: { show_subtasks: false } }] });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Save view" })).toBeNull());

  fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
  await waitFor(() => expect(commands.at(-1)?.[0]).toMatchObject({ type: "delete_view" }));
  expect(await screen.findByRole("heading", { name: "Roadmap" })).toBeTruthy();
});

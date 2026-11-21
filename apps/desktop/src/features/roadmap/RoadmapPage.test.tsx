// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Api } from "../../lib/api";
import { isoDate } from "../../lib/dates";
import type { Command, Epic, Project, RoadmapImage, Task } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeParse, project, STATUS, snapshot, task } from "../../test/fixtures";
import { pickOption } from "../../test/select";
import { LAYOUT_KEY, loadLayout } from "./saved";
import { addDays, addWorkingDays, DAY_WIDTH, dayNumber } from "./timeline";

// Exporting draws in the core and asks where to save: the test keeps what would be saved.
const exported = vi.hoisted(() => [] as { image: RoadmapImage; format: string }[]);
vi.mock("./exportImage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exportImage")>()),
  saveImageAs: async (image: RoadmapImage, format: string) => {
    exported.push({ image, format });
    return `/tmp/roadmap.${format}`;
  },
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  exported.length = 0;
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

async function setup(
  data: { tasks?: Task[]; epics?: Epic[]; projects?: Project[] },
  path = "/roadmap",
) {
  const commands: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot(data),
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
        notes: [],
        note_folders: [],
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
  await screen.findByRole("application", { name: "Roadmap timeline" }).catch(() => null);
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

// ---------------------------------------------------------------------------------------
// The roadmap of epics

it("is next to Lineage and shows epics across projects, moving a target date by dragging", async () => {
  const shop = project({ name: "Shop" });
  const launch = epic({ id: "e1", name: "Launch", project_id: shop.id, target_date: day(14) });
  const polish = epic({ id: "e2", name: "Polish", target_date: day(30), rank: "b" });
  const done = task({ epic_id: "e1", status_id: STATUS.done });
  const open = task({ epic_id: "e1" });
  const { store, commands } = await setup({
    epics: [launch, polish],
    projects: [shop],
    tasks: [done, open],
  });
  const links = within(screen.getByRole("navigation"))
    .getAllByRole("link")
    .map((link) => link.textContent);
  expect(links.indexOf("Roadmap")).toBe(links.indexOf("Lineage") + 1);
  expect(screen.getByRole("heading", { name: "Roadmap" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Fold Shop" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Fold No project" })).toBeTruthy();
  // Progress: one of its two tasks is done.
  expect(bar("Launch").querySelector("[data-progress]")?.getAttribute("data-progress")).toBe("50");

  const width = DAY_WIDTH.month;
  const before = left("Launch");
  drag(bar("Launch"), 100, 100 + 7 * width, false);
  expect(left("Launch")).toBe(before + 7 * width);
  fireEvent.keyDown(timeline(), { key: "Escape" });
  expect(left("Launch")).toBe(before);
  expect(commands).toHaveLength(0);

  drag(bar("Launch"), 100, 100 + 7 * width);
  await waitFor(() => expect(store.getState().epics.e1?.target_date).toBe(day(21)));
  expect(commands.at(-1)).toEqual([
    { type: "update_epic", id: "e1", changes: [{ target_date: day(21) }] },
  ]);
  // The start is the roadmap's, kept on this machine; the bar keeps its length.
  expect(loadLayout().starts.e1).toBe(addDays(addWorkingDays(day(14), -9), 7));
  expect(left("Launch")).toBe(before + 7 * width);
});

it("filters epics by project, with epics without one shown by their tasks, and hides done ones", async () => {
  const shop = project({ name: "Shop" });
  const blog = project({ name: "Blog" });
  const own = epic({ id: "e1", name: "Checkout", project_id: shop.id, target_date: day(5) });
  const shared = epic({ id: "e2", name: "Branding", target_date: day(6), rank: "b" });
  const elsewhere = epic({ id: "e3", name: "Posts", project_id: blog.id, target_date: day(7) });
  const finished = epic({ id: "e4", name: "Old", state: "done", target_date: day(-3) });
  const logo = task({ epic_id: "e2", project_id: shop.id });
  await setup({ epics: [own, shared, elsewhere, finished], projects: [shop, blog], tasks: [logo] });
  expect(screen.queryByRole("button", { name: /^Old, / })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Filter roadmap by project" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Shop" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Posts, / })).toBeNull());
  expect(bar("Checkout")).toBeTruthy();
  expect(bar("Branding")).toBeTruthy();
  await pickOption(
    screen.getByRole("combobox", { name: "Filter roadmap by state" }),
    "Active, done and dropped",
  );
  await pickOption(screen.getByRole("combobox", { name: "Group roadmap" }), "No groups");
  expect(screen.queryByRole("button", { name: "Fold Shop" })).toBeNull();
});

it("links epics through their tasks' prerequisites and flags one that starts too early", async () => {
  const api = epic({ id: "a", name: "API", target_date: day(10) });
  const app = epic({ id: "b", name: "App", target_date: day(12), rank: "b" });
  const endpoint = task({ epic_id: "a" });
  const screenTask = task({ epic_id: "b", dependency_ids: [endpoint.id] });
  await setup({ epics: [api, app], tasks: [endpoint, screenTask] });
  expect(document.querySelectorAll("[data-link]")).toHaveLength(1);
  expect(document.querySelectorAll("[data-late]")).toHaveLength(1);
  expect(screen.getByText(/1 epic starts before an epic it waits on ends/)).toBeTruthy();
  expect(bar("App").title).toContain("“API”");
});

it("schedules an epic from its Schedule button, and opens its timeline from its name", async () => {
  const later = epic({ id: "e1", name: "Later" });
  const { store } = await setup({ epics: [later] });
  fireEvent.click(screen.getByRole("button", { name: "Schedule Later from today" }));
  await waitFor(() =>
    expect(store.getState().epics.e1?.target_date).toBe(addWorkingDays(today, 9)),
  );
  expect(loadLayout().starts.e1).toBe(today);

  fireEvent.click(screen.getByRole("button", { name: "Open the timeline of Later" }));
  expect(await screen.findByRole("heading", { name: "Later" })).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Roadmap /" }));
  expect(await screen.findByRole("heading", { name: "Roadmap" })).toBeTruthy();
});

// ---------------------------------------------------------------------------------------
// An epic's task timeline

it("moves, resizes and nudges a task's bar on its epic's timeline", async () => {
  const launch = epic({ id: "e1", name: "Launch" });
  const build = task({ title: "Build", epic_id: "e1", due_date: day(10) });
  const other = task({ title: "Elsewhere", due_date: day(4) });
  const { store, commands } = await setup(
    { epics: [launch], tasks: [build, other] },
    "/roadmap?epic=e1",
  );
  expect(screen.getByRole("heading", { name: "Launch" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Elsewhere, / })).toBeNull();
  const width = DAY_WIDTH.week;
  drag(bar("Build"), 200, 200 + 2 * width);
  await waitFor(() => expect(store.getState().tasks[build.id]?.due_date).toBe(day(12)));
  expect(commands.at(-1)).toEqual([
    { type: "update_task", id: build.id, changes: [{ due_date: day(12) }] },
  ]);
  expect(loadLayout().starts[build.id]).toBe(day(12));
  await waitFor(() => expect(store.getState().pending).toBe(0));

  const startHandle = bar("Build").querySelector("[data-handle='start']") as HTMLElement;
  drag(startHandle, 200, 200 - 3 * width);
  await waitFor(() => expect(loadLayout().starts[build.id]).toBe(day(9)));
  expect(commands).toHaveLength(1);

  fireEvent.keyDown(bar("Build"), { key: "ArrowRight", ctrlKey: true });
  await waitFor(() => expect(store.getState().tasks[build.id]?.due_date).toBe(day(13)));
  await waitFor(() => expect(store.getState().pending).toBe(0));
  fireEvent.keyDown(bar("Build"), { key: "ArrowLeft", altKey: true, shiftKey: true });
  await waitFor(() => expect(loadLayout().starts[build.id]).toBe(day(2)));
  expect(store.getState().tasks[build.id]?.due_date).toBe(day(13));
});

it("schedules a task by drawing across its row, and lists subtasks under their parent", async () => {
  const launch = epic({ id: "e1", name: "Launch" });
  const parent = task({ title: "Parent", epic_id: "e1", due_date: day(6) });
  const child = task({ title: "Child", epic_id: "e1", parent_id: parent.id, due_date: day(2) });
  const draw = task({ title: "Draw me", epic_id: "e1" });
  const { store } = await setup(
    { epics: [launch], tasks: [parent, child, draw] },
    "/roadmap?epic=e1",
  );
  const names = screen
    .getAllByRole("button", { name: /^Open / })
    .map((button) => button.textContent);
  expect(names).toEqual(["Parent", "Child", "Draw me"]);

  const track = document.querySelector(`[data-track='${draw.id}']`) as HTMLElement;
  const width = DAY_WIDTH.week;
  drag(track, 10 * width + 1, 13 * width + 1);
  await waitFor(() => expect(store.getState().tasks[draw.id]?.due_date).toBeTruthy());
  const due = store.getState().tasks[draw.id]?.due_date ?? "";
  expect(dayNumber(due) - dayNumber(loadLayout().starts[draw.id] ?? "")).toBe(3);

  fireEvent.click(screen.getByRole("checkbox", { name: "Show subtasks" }));
  expect(screen.queryByRole("button", { name: "Open Child" })).toBeNull();
});

it("draws the epic's target date across its tasks, flags tasks past it, and moves it", async () => {
  const launch = epic({ id: "e1", name: "Launch", target_date: day(7) });
  const a = task({ title: "Design", epic_id: "e1", due_date: day(4) });
  const b = task({ title: "Develop", epic_id: "e1", due_date: day(9), dependency_ids: [a.id] });
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ starts: { [b.id]: day(3) } }));
  const { store, commands } = await setup({ epics: [launch], tasks: [a, b] }, "/roadmap?epic=e1");
  expect(screen.getByTestId("deadline-line")).toBeTruthy();
  expect(screen.getByText(/1 task ends after the target date/)).toBeTruthy();
  expect(screen.getByText(/1 task starts before a prerequisite ends/)).toBeTruthy();
  expect(bar("Develop").title).toContain("target date");

  const target = screen.getByRole("button", { name: /^Target date of Launch/ });
  fireEvent.keyDown(target, { key: "ArrowRight", shiftKey: true });
  await waitFor(() => expect(store.getState().epics.e1?.target_date).toBe(day(14)));
  expect(commands.at(-1)).toEqual([
    { type: "update_epic", id: "e1", changes: [{ target_date: day(14) }] },
  ]);
  await waitFor(() => expect(screen.queryByText(/ends after the target date/)).toBeNull());
});

it("opens an epic's timeline from the epic's page", async () => {
  const launch = epic({ id: "e1", name: "Launch" });
  await setup({ epics: [launch] }, "/epic/e1");
  fireEvent.click(await screen.findByRole("button", { name: "Timeline" }));
  expect(await screen.findByRole("link", { name: "Roadmap /" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Launch" })).toBeTruthy();
});

// ---------------------------------------------------------------------------------------
// Saved views

it("saves the roadmap as a view, reopens it, and saves, reverts or deletes edits", async () => {
  const launch = epic({ id: "e1", name: "Launch", target_date: day(20) });
  const { commands } = await setup({ epics: [launch] });
  await pickOption(screen.getByRole("combobox", { name: "Timescale" }), "Days");
  fireEvent.keyDown(bar("Launch"), { key: "ArrowLeft", altKey: true });
  fireEvent.click(screen.getByRole("button", { name: "Save as view" }));
  const name = screen.getByPlaceholderText("Name of the new view");
  fireEvent.change(name, { target: { value: "Q1 plan" } });
  fireEvent.keyDown(name, { key: "Enter" });

  await waitFor(() => expect(commands.at(-1)?.[0]).toMatchObject({ type: "create_view" }));
  const start = loadLayout().starts.e1 ?? "";
  expect(commands.at(-1)?.[0]).toMatchObject({
    view: {
      name: "Q1 plan",
      spec: {
        scope: { kind: "all" },
        lineage: null,
        roadmap: { epic: null, zoom: "day", group: "project", starts: { e1: start } },
      },
    },
  });

  expect(await screen.findByRole("heading", { name: /Q1 plan/ })).toBeTruthy();
  const nav = screen.getByRole("navigation");
  fireEvent.click(within(nav).getByRole("button", { name: /Saved views/ }));
  expect(within(nav).getByRole("link", { name: "Q1 plan" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save view" })).toBeNull();

  // Moving a bar's start is a draft: Revert puts it back; this machine's roadmap is untouched.
  const before = left("Launch");
  fireEvent.keyDown(bar("Launch"), { key: "ArrowLeft", altKey: true });
  expect(left("Launch")).toBe(before - DAY_WIDTH.day);
  expect(loadLayout().starts.e1).toBe(start);
  fireEvent.click(await screen.findByRole("button", { name: "Revert" }));
  await waitFor(() => expect(left("Launch")).toBe(before));

  // A filter change is a draft too.
  await pickOption(screen.getByRole("combobox", { name: "Group roadmap" }), "No groups");
  fireEvent.click(await screen.findByRole("button", { name: "Save view" }));
  await waitFor(() => expect(commands.at(-1)?.[0]).toMatchObject({ type: "update_view" }));
  expect(commands.at(-1)?.[0]).toMatchObject({
    changes: [{ spec: { roadmap: { group: "none" } } }],
  });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Save view" })).toBeNull());

  fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
  await waitFor(() => expect(commands.at(-1)?.[0]).toMatchObject({ type: "delete_view" }));
  expect(await screen.findByRole("heading", { name: "Roadmap" })).toBeTruthy();
});

it("saves an epic's timeline as a view that reopens on that epic", async () => {
  const launch = epic({ id: "e1", name: "Launch" });
  const build = task({ title: "Build", epic_id: "e1", due_date: day(3) });
  const { commands } = await setup({ epics: [launch], tasks: [build] }, "/roadmap?epic=e1");
  fireEvent.click(screen.getByRole("button", { name: "Save as view" }));
  const name = screen.getByPlaceholderText("Name of the new view");
  fireEvent.change(name, { target: { value: "Launch plan" } });
  fireEvent.keyDown(name, { key: "Enter" });
  await waitFor(() => expect(commands.at(-1)?.[0]).toMatchObject({ type: "create_view" }));
  expect(commands.at(-1)?.[0]).toMatchObject({
    view: { spec: { roadmap: { epic: "e1", zoom: "week" }, show_subtasks: true } },
  });
  expect(await screen.findByRole("heading", { name: /Launch plan/ })).toBeTruthy();
  expect(screen.getByText(/The tasks of Launch/)).toBeTruthy();
  expect(bar("Build")).toBeTruthy();
});

// ---------------------------------------------------------------------------------------
// Export image

it("exports the roadmap as an image of its bars only, leaving out unscheduled epics", async () => {
  const shop = project({ name: "Shop" });
  const later = project({ name: "Later", rank: "b" });
  const launch = epic({ id: "e1", name: "Launch", project_id: shop.id, target_date: day(14) });
  const idea = epic({ id: "e2", name: "Idea", project_id: later.id, rank: "b" });
  const loose = epic({ id: "e3", name: "Loose", project_id: shop.id, rank: "c" });
  await setup({ epics: [launch, idea, loose], projects: [shop, later] });
  // On the page (epics without a target date are shown by default): both groups, and the
  // epics without a target date as empty rows.
  expect(screen.getByRole("button", { name: "Fold Later" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Schedule Loose from today" })).toBeTruthy();

  fireEvent.keyDown(screen.getByRole("button", { name: /Export image/ }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Save as SVG…" }));
  await screen.findByText("Saved the image to /tmp/roadmap.svg");
  const saved = exported[0];
  expect(saved?.format).toBe("svg");
  expect(saved?.image.title).toBe("Roadmap");
  expect(saved?.image.name_header).toBe("Epic");
  expect(saved?.image.rows).toEqual([
    expect.objectContaining({ kind: "group", label: "Shop", count: 1, end: day(14) }),
    expect.objectContaining({ kind: "item", id: "e1", title: "Launch", end: day(14) }),
  ]);
  expect(saved?.image.subtitle).toMatch(/^Epics across projects · 1 epic · /);
});

it("exports an epic's timeline with its target date, and is off with nothing scheduled", async () => {
  const launch = epic({ id: "e1", name: "Launch", target_date: day(20) });
  const planned = task({ title: "Plan", epic_id: "e1", due_date: day(5) });
  const unplanned = task({ title: "Someday", epic_id: "e1" });
  await setup({ epics: [launch], tasks: [planned, unplanned] }, "/roadmap?epic=e1");
  fireEvent.keyDown(screen.getByRole("button", { name: /Export image/ }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Save as PNG…" }));
  await screen.findByText("Saved the image to /tmp/roadmap.png");
  const image = exported[0]?.image;
  expect(image?.title).toBe("Launch");
  expect(image?.deadline).toEqual({ date: day(20), label: "Launch" });
  expect(image?.rows.map((row) => row.kind === "item" && row.title)).toEqual(["Plan"]);
  cleanup();

  await setup({ epics: [epic({ id: "e2", name: "Bare" })] });
  const button = screen.getByRole("button", { name: /Export image/ }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
});

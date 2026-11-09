// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import type { Command, Epic, Project, Task } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeParse, project as makeProject, STATUS, snapshot, task } from "../../test/fixtures";
import { pickOption } from "../../test/select";
import { CANVAS_KEY, loadCanvas } from "./canvas";
import { LANE_HEADER } from "./lanes";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function setup(
  tasks: Task[],
  fail = false,
  path = "/lineage",
  extra: { projects?: Project[]; epics?: Epic[] } = {},
) {
  const commands: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot({ tasks, ...extra }),
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
        agent_sessions: [],
        agent_notes: [],
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
  if (path.startsWith("/lineage")) await screen.findByRole("heading", { name: "Lineage" });
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
  fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), {
    target: { value: "Ship" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add Ship as a dependent" }));
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

function place(tasks: Task[]) {
  localStorage.setItem(
    CANVAS_KEY,
    JSON.stringify({
      camera: { x: 0, y: 0, zoom: 1 },
      positions: Object.fromEntries(
        tasks.map((task, i) => [task.id, { x: 100 + i * 350, y: 100 }]),
      ),
    }),
  );
}

function drag(
  from: HTMLElement,
  start: { x: number; y: number },
  end: { x: number; y: number },
  finish = true,
) {
  const canvas = screen.getByRole("application", { name: "Task canvas" });
  fireEvent.pointerDown(from, { button: 0, pointerId: 1, clientX: start.x, clientY: start.y });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: end.x, clientY: end.y });
  if (finish) fireEvent.pointerUp(canvas, { pointerId: 1, clientX: end.x, clientY: end.y });
  return canvas;
}

it("moves cards freely, cancels unfinished moves, and restores their placement without changing task data", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build" });
  place([a, b]);
  const { commands } = await setup([a, b]);
  expect(screen.getByRole("complementary", { name: "Lineage panel" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Dependency editor" })).toBeNull();
  const card = screen.getByRole("button", { name: "Select Plan" });
  const node = card.parentElement as HTMLElement;
  const canvas = drag(card, { x: 180, y: 150 }, { x: 260, y: 230 }, false);
  expect(node.style.left).toBe("180px");
  fireEvent.keyDown(canvas, { key: "Escape" });
  expect(node.style.left).toBe("100px");
  expect(loadCanvas().positions[a.id]).toEqual({ x: 100, y: 100 });
  drag(card, { x: 180, y: 150 }, { x: 260, y: 230 });
  expect(loadCanvas().positions[a.id]).toEqual({ x: 180, y: 180 });
  expect(commands).toHaveLength(0);
  cleanup();
  await setup([a, b]);
  expect(
    (screen.getByRole("button", { name: "Select Plan" }).parentElement as HTMLElement).style.left,
  ).toBe("180px");
});

it("previews a dragged connection and commits it on drop without moving either card", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build" });
  place([a, b]);
  const { store, commands } = await setup([a, b]);
  const canvas = drag(
    screen.getByRole("button", { name: "Connect from Plan" }),
    { x: 332, y: 150 },
    { x: 450, y: 150 },
    false,
  );
  expect(screen.getByTestId("connection-preview").getAttribute("class")).toContain("text-done");
  expect(commands).toHaveLength(0);
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 450, clientY: 150 });
  await waitFor(() => expect(store.getState().tasks[b.id]?.dependency_ids).toEqual([a.id]));
  await waitFor(() => expect(store.getState().pending).toBe(0));
  expect(commands).toHaveLength(1);
  expect(loadCanvas().positions[b.id]).toEqual({ x: 450, y: 100 });
  expect(document.querySelector(`[data-lineage-edge="${a.id}:${b.id}"]`)).toBeTruthy();
});

it("connects backwards from an input, rejects circular drags, and cancels drops on empty space", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build" });
  place([a, b]);
  const { store, commands } = await setup([a, b]);
  drag(
    screen.getByRole("button", { name: "Connect to Build" }),
    { x: 450, y: 150 },
    { x: 200, y: 150 },
  );
  await waitFor(() => expect(store.getState().tasks[b.id]?.dependency_ids).toEqual([a.id]));
  await waitFor(() => expect(store.getState().pending).toBe(0));
  const canvas = drag(
    screen.getByRole("button", { name: "Connect from Build" }),
    { x: 682, y: 150 },
    { x: 200, y: 150 },
    false,
  );
  expect(screen.getByTestId("connection-preview").getAttribute("class")).toContain("text-danger");
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 200, clientY: 150 });
  expect(screen.getByRole("alert").textContent).toContain("circular chain");
  expect(commands).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  drag(
    screen.getByRole("button", { name: "Connect from Plan" }),
    { x: 332, y: 150 },
    { x: 900, y: 500 },
  );
  expect(screen.queryByTestId("connection-preview")).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(commands).toHaveLength(1);
});

it("rolls back a dragged connection when saving fails", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build" });
  place([a, b]);
  const { store } = await setup([a, b], true);
  drag(
    screen.getByRole("button", { name: "Connect from Plan" }),
    { x: 332, y: 150 },
    { x: 450, y: 150 },
  );
  await waitFor(() => expect(store.getState().pending).toBe(0));
  expect(store.getState().tasks[b.id]?.dependency_ids).toEqual([]);
  expect(document.querySelector(`[data-lineage-edge="${a.id}:${b.id}"]`)).toBeNull();
  expect(
    screen
      .getAllByRole("alert")
      .some((alert) => alert.textContent?.includes("Dependency save failed")),
  ).toBe(true);
});

it("pans and zooms the canvas without editing tasks and supports keyboard placement", async () => {
  const a = task({ title: "Plan" });
  place([a]);
  const { commands } = await setup([a]);
  const canvas = screen.getByRole("application", { name: "Task canvas" });
  drag(canvas, { x: 800, y: 600 }, { x: 720, y: 550 });
  expect(loadCanvas().camera).toEqual({ x: -80, y: -50, zoom: 1 });
  fireEvent.wheel(canvas, { clientX: 400, clientY: 300, deltaY: -60, ctrlKey: true });
  await waitFor(() => expect(loadCanvas().camera?.zoom).toBeGreaterThan(1));
  expect(loadCanvas().positions[a.id]).toEqual({ x: 100, y: 100 });
  fireEvent.keyDown(screen.getByRole("button", { name: "Select Plan" }), {
    key: "ArrowLeft",
    altKey: true,
  });
  expect(loadCanvas().positions[a.id]).toEqual({ x: 84, y: 100 });
  fireEvent.click(screen.getByRole("button", { name: "Auto arrange" }));
  expect(loadCanvas().positions[a.id]).toEqual({ x: 40, y: 40 });
  expect(commands).toHaveLength(0);
});

it("cancels connection mode and clears the inspector when a filter hides its task", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build", dependency_ids: [a.id] });
  const c = task({ title: "Other work" });
  place([a, b, c]);
  await setup([a, b, c]);
  fireEvent.click(screen.getByRole("button", { name: "Select Other work" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect on graph" }));
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Connected tasks only" }));
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Dependency editor" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Select Other work" })).toBeNull();
  expect(screen.getByRole("button", { name: "Select Build" })).toBeTruthy();
});

it("creates a linked task from a card's plus buttons and places it beside the card", async () => {
  const a = task({ title: "Plan", project_id: null });
  place([a]);
  const { store, commands } = await setup([a]);
  fireEvent.click(screen.getByRole("button", { name: "Add a task after Plan" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title of the dependent task" }), {
    target: { value: "Ship" },
  });
  fireEvent.click(screen.getByRole("button", { name: "+ Create “Ship”" }));
  await waitFor(() => expect(store.getState().pending).toBe(0));
  const ship = Object.values(store.getState().tasks).find((t) => t.title === "Ship");
  expect(ship?.dependency_ids).toEqual([a.id]);
  expect(commands[0]?.map((c) => c.type)).toEqual(["create_task", "update_task"]);
  await waitFor(() => expect(loadCanvas().positions[ship?.id ?? ""]?.x).toBeGreaterThan(100));
  expect(loadCanvas().positions[ship?.id ?? ""]?.y).toBe(100);

  fireEvent.click(screen.getByRole("button", { name: "Add a task before Plan" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title of the prerequisite" }), {
    target: { value: "Research" },
  });
  fireEvent.submit(screen.getByRole("form", { name: "New task before Plan" }));
  await waitFor(() => expect(store.getState().pending).toBe(0));
  const research = Object.values(store.getState().tasks).find((t) => t.title === "Research");
  expect(store.getState().tasks[a.id]?.dependency_ids).toEqual([research?.id]);
  expect(commands[1]?.[1]).toMatchObject({ type: "update_task", id: a.id });
});

it("links an existing task from a plus button", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build" });
  place([a, b]);
  const { store } = await setup([a, b]);
  fireEvent.click(screen.getByRole("button", { name: "Add a task before Build" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title of the prerequisite" }), {
    target: { value: "pla" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Link “Plan”" }));
  await waitFor(() => expect(store.getState().tasks[b.id]?.dependency_ids).toEqual([a.id]));
});

it("fades done tasks and filters by completion and readiness", async () => {
  const a = task({ title: "Plan", status_id: STATUS.done });
  const b = task({ title: "Build", dependency_ids: [a.id] });
  const c = task({ title: "Ship", dependency_ids: [b.id] });
  place([a, b, c]);
  await setup([a, b, c]);
  const node = (title: string) =>
    screen.queryByRole("button", { name: `Select ${title}` })?.parentElement ?? null;
  expect(node("Plan")?.dataset.closed).toBe("true");
  expect(node("Plan")?.className).toContain("opacity-45");
  expect(node("Build")?.dataset.closed).toBeUndefined();
  expect(
    document
      .querySelector(`[data-lineage-edge="${a.id}:${b.id}"]`)
      ?.getAttribute("stroke-dasharray"),
  ).toBe("5 5");
  expect(node("Ship")?.textContent).toContain("Blocked · 1");
  expect(node("Build")?.textContent).not.toContain("Blocked");
  await pickOption("Filter lineage by completion", "Open only");
  expect(node("Plan")).toBeNull();
  expect(node("Ship")).toBeTruthy();
  await pickOption("Filter lineage by completion", "Ready (not blocked)");
  expect(node("Build")).toBeTruthy();
  expect(node("Ship")).toBeNull();
});

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

it("filters by epics and tags, including tasks without any", async () => {
  const home = makeProject({ name: "Home" });
  const other = makeProject({ name: "Other" });
  const shared = epic({ id: "e-shared", name: "Shared" });
  const homeEpic = epic({ id: "e-home", name: "Home epic", project_id: home.id });
  const otherEpic = epic({ id: "e-other", name: "Other epic", project_id: other.id });
  const a = task({ title: "Plan", project_id: home.id, epic_id: shared.id, tag_ids: ["t"] });
  const b = task({ title: "Build", project_id: home.id, epic_id: homeEpic.id });
  const c = task({ title: "Loose", project_id: home.id });
  place([a, b, c]);
  await setup([a, b, c], false, "/lineage", {
    projects: [home, other],
    epics: [shared, homeEpic, otherEpic],
  });
  const shown = (title: string) => !!screen.queryByRole("button", { name: `Select ${title}` });
  /** Ticks an option of a filter chip, opening the chip when it is closed. */
  const tick = async (chip: string, option: string) => {
    const trigger = screen.getByRole("button", { name: chip });
    if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("checkbox", { name: option }));
  };
  await pickOption("Filter lineage by project", "Home");
  // The closed select hands focus back to its trigger later, which would close the chip.
  const projectSelect = screen.getByRole("combobox", { name: "Filter lineage by project" });
  await waitFor(() => expect(document.activeElement).toBe(projectSelect));
  fireEvent.click(screen.getByRole("button", { name: "Filter lineage by epic" }));
  // An epic without a home project is listed under any project; another project's is not.
  expect(await screen.findByRole("checkbox", { name: "Shared" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Home epic" })).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: "Other epic" })).toBeNull();
  await tick("Filter lineage by epic", "No epic");
  await waitFor(() => expect(shown("Plan")).toBe(false));
  expect(shown("Loose")).toBe(true);
  expect(shown("Build")).toBe(false);
  await tick("Filter lineage by epic", "Shared");
  await waitFor(() => expect(shown("Plan")).toBe(true));
  expect(shown("Build")).toBe(false);
  await tick("Filter lineage by epic", "No epic");
  await tick("Filter lineage by epic", "Shared");
  await waitFor(() => expect(shown("Build")).toBe(true));
  await tick("Filter lineage by tag", "No tag");
  await waitFor(() => expect(shown("Plan")).toBe(false));
  expect(shown("Build")).toBe(true);
  expect(shown("Loose")).toBe(true);
});

it("reads filters saved with a single epic and tag", async () => {
  const a = task({ title: "Plan", epic_id: "e-a" });
  const b = task({ title: "Build" });
  place([a, b]);
  localStorage.setItem("task-master.lineage-filter", JSON.stringify({ epic: "e-a", tag: "" }));
  await setup([a, b], false, "/lineage", { epics: [epic({ id: "e-a", name: "Alpha" })] });
  expect(screen.getByRole("button", { name: "Select Plan" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Select Build" })).toBeNull();
  expect(screen.getByRole("button", { name: "Filter lineage by epic" }).textContent).toBe(
    "Epic: Alpha",
  );
});

it("opens on one task's lineage and goes back to every task", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build", dependency_ids: [a.id] });
  const c = task({ title: "Elsewhere" });
  place([a, b, c]);
  await setup([a, b, c], false, `/lineage?around=${b.id}`);
  expect(screen.getByText("Lineage of “Build”")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Dependency editor" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Select Elsewhere" })).toBeNull();
  expect(screen.getByRole("button", { name: "Select Plan" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show all tasks" }));
  expect(await screen.findByRole("button", { name: "Select Elsewhere" })).toBeTruthy();
});

it("frames a task's lineage even when the saved camera and filters point elsewhere", async () => {
  const a = task({ title: "Backup", project_id: null });
  const b = task({ title: "Other" });
  place([a, b]);
  const saved = JSON.parse(localStorage.getItem(CANVAS_KEY) ?? "{}");
  localStorage.setItem(
    CANVAS_KEY,
    JSON.stringify({ ...saved, camera: { x: -50000, y: -50000, zoom: 1 } }),
  );
  localStorage.setItem(
    "task-master.lineage-filter",
    JSON.stringify({ project: "elsewhere", linkedOnly: true }),
  );
  await setup([a, b], false, `/lineage?around=${a.id}`);
  expect(await screen.findByRole("button", { name: "Select Backup" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Select Other" })).toBeNull();
  expect(loadCanvas().camera).not.toEqual({ x: -50000, y: -50000, zoom: 1 });
});

it("refits a saved camera that shows none of the cards", async () => {
  const a = task({ title: "Plan" });
  place([a]);
  const saved = JSON.parse(localStorage.getItem(CANVAS_KEY) ?? "{}");
  localStorage.setItem(
    CANVAS_KEY,
    JSON.stringify({ ...saved, camera: { x: -50000, y: -50000, zoom: 1 } }),
  );
  await setup([a]);
  expect(await screen.findByRole("button", { name: "Select Plan" })).toBeTruthy();
});

it("finds tasks from the side panel and links or creates prerequisites and dependents", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build" });
  const c = task({ title: "Bundle", dependency_ids: [b.id] });
  place([a, b, c]);
  const { store, commands } = await setup([a, b, c]);
  const search = screen.getByRole("searchbox", { name: "Search tasks" });
  fireEvent.change(search, { target: { value: "bu" } });
  const results = screen.getByRole("list", { name: "Search results" });
  const rows = within(results).getAllByRole("listitem");
  expect(rows.map((row) => row.textContent).sort()).toEqual(["Build", "Bundle"]);
  // Nothing selected: results only find tasks.
  expect(screen.queryByRole("button", { name: "Add Build as a prerequisite" })).toBeNull();
  fireEvent.click(within(results).getByRole("button", { name: "Build" }));
  const editor = screen.getByRole("region", { name: "Dependency editor" });
  expect(within(editor).getByRole("heading", { name: "Build" })).toBeTruthy();
  // Bundle already depends on Build, so it can't also be its prerequisite (circular chain).
  const bundle = screen.getByRole("button", { name: "Add Bundle as a prerequisite" });
  expect((bundle as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(search, { target: { value: "plan" } });
  fireEvent.click(screen.getByRole("button", { name: "Add Plan as a prerequisite" }));
  await waitFor(() => expect(store.getState().tasks[b.id]?.dependency_ids).toEqual([a.id]));
  await waitFor(() => expect(store.getState().pending).toBe(0));

  fireEvent.change(search, { target: { value: "Test" } });
  fireEvent.click(screen.getByRole("button", { name: "+ New dependent “Test”" }));
  await waitFor(() => expect(store.getState().pending).toBe(0));
  const created = Object.values(store.getState().tasks).find((t) => t.title === "Test");
  expect(created?.dependency_ids).toEqual([b.id]);
  expect(commands).toHaveLength(2);
  // Placed one column right of Build (x 450), not in the automatic layout.
  await waitFor(() => expect(loadCanvas().positions[created?.id ?? ""]?.x).toBeGreaterThan(450));
  expect((search as HTMLInputElement).value).toBe("");
});

it("makes tasks parents or subtasks from the side panel", async () => {
  const epic = task({ title: "Release" });
  const a = task({ title: "Write notes" });
  const b = task({ title: "Write changelog" });
  place([epic, a, b]);
  const { store, commands } = await setup([epic, a, b]);
  const search = screen.getByRole("searchbox", { name: "Search tasks" });
  fireEvent.change(search, { target: { value: "release" } });
  // The search result (a card's button is named "Select Release").
  fireEvent.click(screen.getByRole("button", { name: "Release" }));
  fireEvent.change(search, { target: { value: "write" } });
  fireEvent.click(screen.getByRole("button", { name: "Make Write notes a subtask" }));
  await waitFor(() => expect(store.getState().tasks[a.id]?.parent_id).toBe(epic.id));
  await waitFor(() => expect(store.getState().pending).toBe(0));
  expect(commands.at(-1)).toEqual([{ type: "set_parent", id: a.id, parent_id: epic.id }]);
  // Already its subtask: can't be added again, nor made its parent (a cycle).
  const again = screen.getByRole("button", { name: "Make Write notes a subtask" });
  expect((again as HTMLButtonElement).disabled).toBe(true);
  const cycle = screen.getByRole("button", { name: "Make Write notes the parent" });
  expect((cycle as HTMLButtonElement).disabled).toBe(true);

  // Select Write changelog, then put it under Write notes.
  fireEvent.click(screen.getByRole("button", { name: "Write changelog" }));
  fireEvent.click(screen.getByRole("button", { name: "Make Write notes the parent" }));
  await waitFor(() => expect(store.getState().tasks[b.id]?.parent_id).toBe(a.id));
  await waitFor(() => expect(store.getState().pending).toBe(0));
  const editor = screen.getByRole("region", { name: "Dependency editor" });
  expect(within(editor).getByText("Write notes")).toBeTruthy();
  fireEvent.click(within(editor).getByRole("button", { name: "Make it a top-level task" }));
  await waitFor(() => expect(store.getState().tasks[b.id]?.parent_id).toBeNull());
  expect(commands).toHaveLength(3);
});

it("hides and shows the side panel and remembers it", async () => {
  const a = task({ title: "Plan" });
  place([a]);
  await setup([a]);
  fireEvent.click(screen.getByRole("button", { name: "Hide the lineage panel" }));
  expect(screen.queryByRole("complementary", { name: "Lineage panel" })).toBeNull();
  cleanup();
  await setup([a]);
  expect(screen.queryByRole("complementary", { name: "Lineage panel" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show the lineage panel" }));
  expect(screen.getByRole("complementary", { name: "Lineage panel" })).toBeTruthy();
});

it("copies a task's project, epic and tags onto its dependents in one batch", async () => {
  const a = task({ title: "Plan", project_id: "p-a", epic_id: "e-a", tag_ids: ["t-a", "t-b"] });
  const b = task({ title: "Build", dependency_ids: [a.id], project_id: "p-b", tag_ids: ["t-b"] });
  const c = task({ title: "Ship", dependency_ids: [b.id], project_id: "p-b" });
  place([a, b, c]);
  const { store, commands } = await setup([a, b, c]);
  fireEvent.click(screen.getByRole("button", { name: "Select Plan" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply to 1 dependent" }));
  await waitFor(() => expect(store.getState().pending).toBe(0));
  expect(store.getState().tasks[b.id]).toMatchObject({
    project_id: "p-a",
    epic_id: "e-a",
    tag_ids: ["t-a", "t-b"],
  });
  expect(store.getState().tasks[c.id]?.project_id).toBe("p-b");
  expect(commands[0]).toEqual([
    { type: "update_task", id: b.id, changes: [{ project_id: "p-a" }, { epic_id: "e-a" }] },
    { type: "tag_task", task_id: b.id, tag_id: "t-a" },
  ]);
  expect(screen.getByRole("button", { name: "Dependents already match" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /whole chain/ }));
  fireEvent.click(screen.getByRole("button", { name: "Apply to 1 dependent" }));
  await waitFor(() => expect(store.getState().tasks[c.id]?.project_id).toBe("p-a"));
});

it("gives a task created from a plus button the card's tags", async () => {
  const a = task({ title: "Plan", tag_ids: ["t-a"] });
  place([a]);
  const { store } = await setup([a]);
  fireEvent.click(screen.getByRole("button", { name: "Add a task after Plan" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title of the dependent task" }), {
    target: { value: "Ship" },
  });
  fireEvent.submit(screen.getByRole("form", { name: "New task after Plan" }));
  await waitFor(() => expect(store.getState().pending).toBe(0));
  const ship = Object.values(store.getState().tasks).find((t) => t.title === "Ship");
  expect(ship?.tag_ids).toEqual(["t-a"]);
});

it("closes a plus button's popover on a click elsewhere on the canvas, even with text typed", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build" });
  place([a, b]);
  await setup([a, b]);
  const canvas = screen.getByRole("application", { name: "Task canvas" });
  fireEvent.click(screen.getByRole("button", { name: "Add a task after Plan" }));
  const input = screen.getByRole("textbox", { name: "Title of the dependent task" });
  fireEvent.change(input, { target: { value: "Ship" } });
  // Clicks inside the popover keep it open.
  fireEvent.pointerDown(input, { button: 0, pointerId: 1 });
  expect(screen.getByRole("form", { name: "New task after Plan" })).toBeTruthy();
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 900, clientY: 600 });
  fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: 900, clientY: 600 });
  expect(screen.queryByRole("form", { name: "New task after Plan" })).toBeNull();
  // Clicking another card closes it too.
  fireEvent.click(screen.getByRole("button", { name: "Add a task after Plan" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title of the dependent task" }), {
    target: { value: "Ship" },
  });
  const build = screen.getByRole("button", { name: "Select Build" });
  fireEvent.pointerDown(build, { button: 0, pointerId: 2 });
  expect(screen.queryByRole("form", { name: "New task after Plan" })).toBeNull();
});

it("shows what blocks a task on its page and opens Lineage on it", async () => {
  const a = task({ title: "Plan" });
  const d = task({ title: "Draft", status_id: STATUS.done });
  const b = task({ title: "Build", dependency_ids: [a.id, d.id] });
  const c = task({ title: "Ship", dependency_ids: [b.id] });
  await setup([a, b, c, d], false, `/task/${b.id}`);
  const section = await screen.findByRole("region", { name: "Lineage" });
  expect(section.textContent).toContain("Blocked by 1 open task");
  expect(within(section).getByRole("list", { name: "Prerequisites" }).textContent).toContain(
    "Draft",
  );
  expect(within(section).getByRole("list", { name: "Dependents" }).textContent).toContain("Ship");
  fireEvent.click(within(section).getByRole("button", { name: /Plan in Lineage/ }));
  expect(await screen.findByText("Lineage of “Build”")).toBeTruthy();
});

it("arranges cards in lanes by epic and moves a card to another epic by dropping it there", async () => {
  const alpha = epic({ id: "e-alpha", name: "Alpha", rank: "a" });
  const beta = epic({ id: "e-beta", name: "Beta", rank: "b" });
  const a = task({ title: "Plan", epic_id: alpha.id });
  const b = task({ title: "Build", epic_id: alpha.id, dependency_ids: [a.id] });
  const c = task({ title: "Loose" });
  place([a, b, c]);
  const { store, commands } = await setup([a, b, c], false, "/lineage", { epics: [alpha, beta] });
  const node = (title: string) =>
    screen.queryByRole("button", { name: `Select ${title}` })?.parentElement ?? null;
  // Freeform cards show their epic.
  expect(node("Plan")?.querySelector("[data-card-epic]")?.textContent).toBe("Alpha");
  await pickOption("Arrange lineage", "Lanes by epic");
  const lane = (name: string) => screen.getByRole("region", { name: `Lane ${name}` });
  expect(lane("Alpha")).toBeTruthy();
  expect(lane("Beta")).toBeTruthy();
  expect(lane("No epic")).toBeTruthy();
  // The lane names the epic, so the cards don't.
  expect(node("Plan")?.querySelector("[data-card-epic]")).toBeNull();
  const top = (element: HTMLElement | null) => Number.parseFloat(element?.style.top ?? "NaN");
  const alphaTop = top(lane("Alpha"));
  const alphaBottom = alphaTop + Number.parseFloat(lane("Alpha").style.height);
  expect(top(node("Plan"))).toBeGreaterThanOrEqual(alphaTop);
  expect(top(node("Build"))).toBeLessThan(alphaBottom);
  expect(top(node("Loose"))).toBeGreaterThanOrEqual(top(lane("No epic")));

  // Drop "Plan" into the Beta lane: it takes that epic.
  const zoom = loadCanvas().camera?.zoom ?? 1;
  const dy = (top(lane("Beta")) + LANE_HEADER - top(node("Plan"))) * zoom;
  const card = screen.getByRole("button", { name: "Select Plan" });
  drag(card, { x: 300, y: 300 }, { x: 300, y: 300 + dy });
  // The click that ends a drag in a browser (swallowed by the canvas).
  fireEvent.click(card);
  await waitFor(() => expect(store.getState().tasks[a.id]?.epic_id).toBe(beta.id));
  expect(commands.at(-1)).toEqual([
    { type: "update_task", id: a.id, changes: [{ epic_id: beta.id }] },
  ]);
  await waitFor(() => expect(top(node("Plan"))).toBeGreaterThanOrEqual(top(lane("Beta"))));

  // A collapsed lane hides its cards; the arrangement is remembered.
  fireEvent.click(screen.getByRole("button", { name: "Collapse lane No epic" }));
  expect(node("Loose")).toBeNull();
  expect(loadCanvas().collapsed.epic).toEqual(["none"]);
  fireEvent.click(screen.getByRole("button", { name: "Expand lane No epic" }));
  expect(node("Loose")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("task-master.lineage-filter") ?? "{}").arrange).toBe(
    "epic",
  );
});

it("arranges lanes by project and moves a card to another project", async () => {
  const home = makeProject({ name: "Home" });
  const work = makeProject({ name: "Work" });
  const a = task({ title: "Plan", project_id: home.id });
  const b = task({ title: "Build", project_id: work.id });
  place([a, b]);
  const { store } = await setup([a, b], false, "/lineage", { projects: [home, work] });
  await pickOption("Arrange lineage", "Lanes by project");
  const lane = (name: string) => screen.getByRole("region", { name: `Lane ${name}` });
  const top = (element: HTMLElement | null) => Number.parseFloat(element?.style.top ?? "NaN");
  const node = (title: string) =>
    screen.getByRole("button", { name: `Select ${title}` }).parentElement as HTMLElement;
  const zoom = loadCanvas().camera?.zoom ?? 1;
  const dy = (top(lane("Work")) + LANE_HEADER - top(node("Plan"))) * zoom;
  drag(
    screen.getByRole("button", { name: "Select Plan" }),
    { x: 300, y: 300 },
    { x: 300, y: 300 + dy },
  );
  await waitFor(() => expect(store.getState().tasks[a.id]?.project_id).toBe(work.id));
});

it("pins a card: it no longer drags and arranging leaves it in place", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build" });
  place([a, b]);
  await setup([a, b]);
  fireEvent.click(screen.getByRole("button", { name: "Pin Plan" }));
  expect(screen.getByRole("button", { name: "Unpin Plan" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(loadCanvas().pinned).toEqual([a.id]);
  const card = screen.getByRole("button", { name: "Select Plan" });
  drag(card, { x: 180, y: 150 }, { x: 260, y: 230 });
  expect(loadCanvas().positions[a.id]).toEqual({ x: 100, y: 100 });
  fireEvent.keyDown(card, { key: "ArrowLeft", altKey: true });
  expect(loadCanvas().positions[a.id]).toEqual({ x: 100, y: 100 });
  fireEvent.click(screen.getByRole("button", { name: "Auto arrange" }));
  expect(loadCanvas().positions[a.id]).toEqual({ x: 100, y: 100 });
  expect(loadCanvas().positions[b.id]).not.toEqual({ x: 450, y: 100 });
  fireEvent.click(screen.getByRole("button", { name: "Unpin Plan" }));
  expect(loadCanvas().pinned).toEqual([]);
});

it("suggests tasks from the same epic and project to link, without typing", async () => {
  const home = makeProject({ name: "Home" });
  const a = task({ title: "Plan", project_id: home.id, epic_id: "e-a" });
  const b = task({ title: "Build", project_id: home.id, epic_id: "e-a" });
  const c = task({ title: "Paint", project_id: home.id });
  const d = task({ title: "Far away" });
  place([a, b, c, d]);
  const { store } = await setup([a, b, c, d], false, "/lineage", {
    projects: [home],
    epics: [epic({ id: "e-a", name: "Alpha", project_id: home.id })],
  });
  // The side panel: the selected card's epic first, then its project.
  fireEvent.click(screen.getByRole("button", { name: "Select Plan" }));
  const list = screen.getByRole("list", { name: "Same epic, then same project" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows.map((row) => row.querySelector("button")?.textContent)).toEqual(["Build", "Paint"]);
  // The plus button's popover.
  fireEvent.click(screen.getByRole("button", { name: "Add a task after Plan" }));
  const form = await screen.findByRole("form", { name: "New task after Plan" });
  expect(within(form).queryByRole("button", { name: "Link “Far away”" })).toBeNull();
  expect(within(form).getByRole("button", { name: "Link “Paint”" })).toBeTruthy();
  fireEvent.click(within(form).getByRole("button", { name: "Link “Build”" }));
  await waitFor(() => expect(store.getState().tasks[b.id]?.dependency_ids).toEqual([a.id]));
});

it("lists the tasks the canvas leaves out when it shows connected tasks only", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build", dependency_ids: [a.id] });
  const c = task({ title: "Loner" });
  place([a, b, c]);
  await setup([a, b, c]);
  expect(screen.queryByRole("list", { name: "Not on the canvas" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Connected tasks only" }));
  const list = await screen.findByRole("list", { name: "Not on the canvas" });
  expect(list.textContent).toContain("Loner");
  expect(list.textContent).not.toContain("Plan");
});

it("removes a link with the × on its arrow, shown when hovering a linked card", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build", dependency_ids: [a.id] });
  place([a, b]);
  const { store, commands } = await setup([a, b]);
  const label = "Remove link from Plan to Build";
  expect(screen.queryByRole("button", { name: label })).toBeNull();
  const node = screen.getByRole("button", { name: "Select Build" }).parentElement as HTMLElement;
  fireEvent.pointerEnter(node);
  fireEvent.click(await screen.findByRole("button", { name: label }));
  await waitFor(() => expect(store.getState().tasks[b.id]?.dependency_ids).toEqual([]));
  expect(commands.at(-1)).toEqual([
    { type: "update_task", id: b.id, changes: [{ dependency_ids: [] }] },
  ]);
  expect(screen.queryByRole("button", { name: label })).toBeNull();
});

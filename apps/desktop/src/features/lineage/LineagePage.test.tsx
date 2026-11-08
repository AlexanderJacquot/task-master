// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import type { Command, Task } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeParse, STATUS, snapshot, task } from "../../test/fixtures";
import { pickOption } from "../../test/select";
import { CANVAS_KEY, loadCanvas } from "./canvas";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function setup(tasks: Task[], fail = false, path = "/lineage") {
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
  await pickOption("Connection type", "Add dependent");
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
  expect(screen.queryByRole("complementary", { name: "Dependency editor" })).toBeNull();
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
  expect(screen.queryByRole("complementary", { name: "Dependency editor" })).toBeNull();
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

it("opens on one task's lineage and goes back to every task", async () => {
  const a = task({ title: "Plan" });
  const b = task({ title: "Build", dependency_ids: [a.id] });
  const c = task({ title: "Elsewhere" });
  place([a, b, c]);
  await setup([a, b, c], false, `/lineage?around=${b.id}`);
  expect(screen.getByText("Lineage of “Build”")).toBeTruthy();
  expect(screen.getByRole("complementary", { name: "Dependency editor" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Select Elsewhere" })).toBeNull();
  expect(screen.getByRole("button", { name: "Select Plan" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show all tasks" }));
  expect(await screen.findByRole("button", { name: "Select Elsewhere" })).toBeTruthy();
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

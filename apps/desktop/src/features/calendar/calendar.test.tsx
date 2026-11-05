// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { addDays, atMinute } from "../../lib/calendar";
import { isoDate } from "../../lib/dates";
import type { Changes, Command, Task, TimeBlock } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore, type TaskStore } from "../../store/store";
import { fakeParse, snapshot, task, timeBlock } from "../../test/fixtures";

const today = isoDate();

function fakeApi(data: { tasks: Task[]; time_blocks: TimeBlock[] }) {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot(data),
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
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text) => fakeParse(text),
    onChanged: async () => () => {},
  };
  return { api, executed };
}

const planned = task({ title: "Write the report", today_on: today, estimate_min: 30 });
const due = task({ title: "Pay rent", due_date: addDays(today, 1) });
const other = task({ title: "Fix the gate" });
const blocked = task({ title: "Dentist" });
const block = timeBlock({
  task_id: blocked.id,
  start_at: atMinute(today, 10 * 60),
  end_at: atMinute(today, 11 * 60),
});

let store: TaskStore;
let fake: ReturnType<typeof fakeApi>;

async function renderCalendar(path = "/calendar") {
  fake = fakeApi({ tasks: [planned, due, other, blocked], time_blocks: [block] });
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

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("the calendar", () => {
  it("shows the week with blocks, day plans and the task tray", async () => {
    await renderCalendar();
    expect(await screen.findByRole("heading", { name: "Calendar" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "week" }) as HTMLElement).getAttribute("aria-pressed"),
    ).toBe("true");
    const column = screen.getByTestId(`time-column-${today}`);
    expect(within(column).getByRole("button", { name: /^Dentist, / })).toBeTruthy();
    expect(within(column).getByTestId("now-line")).toBeTruthy();
    // Planned today: in today's lane and in the tray's Today list.
    expect(
      within(screen.getByTestId(`day-lane-${today}`)).getByText("Write the report"),
    ).toBeTruthy();
    const tray = screen.getByRole("complementary", { name: "Tasks to schedule" });
    expect(
      within(within(tray).getByRole("list", { name: "Today's tasks" })).getByText(
        "Write the report",
      ),
    ).toBeTruthy();
    expect(
      within(within(tray).getByRole("list", { name: "Other tasks" })).getByText("Fix the gate"),
    ).toBeTruthy();
  });

  it("narrows the tray's other tasks by search", async () => {
    await renderCalendar();
    const list = await screen.findByRole("list", { name: "Other tasks" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a task" }), {
      target: { value: "gate" },
    });
    expect(within(list).getByText("Fix the gate")).toBeTruthy();
    expect(within(list).queryByText("Dentist")).toBeNull();
  });

  it("schedules a task from the tray at the next free quarter hour", async () => {
    await renderCalendar();
    fireEvent.click(await screen.findByRole("button", { name: "Schedule Write the report" }));
    await waitFor(() => expect(fake.executed).toHaveLength(1));
    const [command] = fake.executed[0] ?? [];
    expect(command).toMatchObject({ type: "create_time_block", block: { task_id: planned.id } });
    const created = command?.type === "create_time_block" ? command.block : null;
    expect(created && created.end_at - created.start_at).toBe(30 * 60_000);
    expect(created && created.start_at % (15 * 60_000)).toBe(0);
    // After now (late in the evening the slot stops at 23:45).
    expect(created && created.start_at >= Date.now() - 15 * 60_000).toBe(true);
    const blocks = screen.getAllByTestId("time-block").map((b) => b.getAttribute("aria-label"));
    expect(blocks.some((label) => label?.startsWith("Write the report"))).toBe(true);
  });

  it("sets a block's outcome and removes it from its menu", async () => {
    await renderCalendar();
    fireEvent.click(await screen.findByRole("button", { name: /^Dentist, / }));
    const menu = await screen.findByRole("dialog", { name: "Time block" });
    fireEvent.click(within(menu).getByRole("button", { name: "Worked" }));
    await waitFor(() =>
      expect(fake.executed[0]).toEqual([
        { type: "update_time_block", id: block.id, changes: [{ outcome: "worked" }] },
      ]),
    );
    fireEvent.click(within(menu).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(fake.executed[1]).toEqual([{ type: "delete_time_block", id: block.id }]),
    );
    expect(screen.queryByRole("button", { name: /^Dentist, / })).toBeNull();
  });

  it("opens the task from a block's menu", async () => {
    const router = await renderCalendar();
    fireEvent.click(await screen.findByRole("button", { name: /^Dentist, / }));
    fireEvent.click(await screen.findByRole("button", { name: "Open task" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ task: blocked.id }));
  });

  it("switches to month and day views, and remembers the choice", async () => {
    await renderCalendar();
    fireEvent.click(await screen.findByRole("button", { name: "month" }));
    const cell = screen.getByTestId(`month-cell-${today}`);
    expect(within(cell).getByText("Dentist")).toBeTruthy();
    expect(within(cell).getByText("Write the report")).toBeTruthy();
    expect(localStorage.getItem("task-master.calendar-mode")).toBe("month");

    // A day number opens that day.
    fireEvent.click(within(cell).getByRole("button", { name: /^Open / }));
    expect(
      (screen.getByRole("button", { name: "day" }) as HTMLElement).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getAllByTestId(/^time-column-/)).toHaveLength(1);
    expect(screen.getByTestId(`time-column-${today}`)).toBeTruthy();
  });

  it("moves by a period and comes back with Today", async () => {
    localStorage.setItem("task-master.calendar-mode", "day");
    await renderCalendar();
    await screen.findByTestId(`time-column-${today}`);
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    const tomorrow = addDays(today, 1);
    expect(screen.getByTestId(`time-column-${tomorrow}`)).toBeTruthy();
    // Due tomorrow: shown in that day's lane.
    expect(within(screen.getByTestId(`day-lane-${tomorrow}`)).getByText("Pay rent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByTestId(`time-column-${today}`)).toBeTruthy();
  });

  it("is in the sidebar and on g c", async () => {
    const router = await renderCalendar("/inbox");
    await screen.findByRole("heading", { name: "Inbox" });
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "c" });
    expect(await screen.findByRole("heading", { name: "Calendar" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/calendar");
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: /Calendar/ })).toBeTruthy();
  });
});

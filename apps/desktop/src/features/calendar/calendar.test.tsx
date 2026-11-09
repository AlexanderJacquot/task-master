// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { addDays, atMinute } from "../../lib/calendar";
import { isoDate } from "../../lib/dates";
import type { Changes, Command, Task, TimeBlock } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore, type TaskStore } from "../../store/store";
import { fakeCalendar } from "../../test/fakeCalendar";
import { fakeParse, snapshot, task, timeBlock } from "../../test/fixtures";

const today = isoDate();

function fakeApi(data: { tasks: Task[]; time_blocks: TimeBlock[] }, extra: Partial<Api> = {}) {
  const executed: Command[][] = [];
  const api: Api = {
    ...extra,
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
        agent_sessions: [],
        agent_notes: [],
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

async function renderCalendar(path = "/calendar", extra: Partial<Api> = {}) {
  fake = fakeApi({ tasks: [planned, due, other, blocked], time_blocks: [block] }, extra);
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

  it("moves a scheduled task from Other tasks to Today", async () => {
    await renderCalendar();
    const others = await screen.findByRole("list", { name: "Other tasks" });
    fireEvent.click(within(others).getByRole("button", { name: "Schedule Fix the gate" }));
    await waitFor(() => expect(fake.executed).toHaveLength(1));
    expect(within(others).queryByText("Fix the gate")).toBeNull();
    expect(
      within(screen.getByRole("list", { name: "Today's tasks" })).getByText("Fix the gate"),
    ).toBeTruthy();
  });

  it("removes tasks scheduled for another day from the tray and restores them when removed", async () => {
    localStorage.setItem("task-master.calendar-mode", "day");
    await renderCalendar();
    await screen.findByTestId(`time-column-${today}`);
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    const others = screen.getByRole("list", { name: "Other tasks" });
    fireEvent.click(within(others).getByRole("button", { name: "Schedule Fix the gate" }));
    await waitFor(() => expect(fake.executed).toHaveLength(1));
    const tray = screen.getByRole("complementary", { name: "Tasks to schedule" });
    expect(within(tray).queryByText("Fix the gate")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Fix the gate, / }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Time block" })).getByRole("button", {
        name: "Remove",
      }),
    );
    await waitFor(() => expect(within(others).getByText("Fix the gate")).toBeTruthy());
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

describe("creating a task on the grid", () => {
  // jsdom puts every column at the top of the viewport: clientY = minutes / 60 × 48 px.
  const y = (hour: number) => hour * 48;

  it("drags to set the time, then creates the task and its block in one batch", async () => {
    await renderCalendar();
    const column = await screen.findByTestId(`time-column-${today}`);
    fireEvent.pointerDown(column, { button: 0, clientY: y(9) });
    fireEvent.pointerMove(window, { clientY: y(10.75) });
    fireEvent.pointerUp(window, { clientY: y(10.75) });

    const box = await screen.findByRole("dialog", { name: "New task on the calendar" });
    expect(within(box).getByText(/2 h/)).toBeTruthy();
    const input = within(box).getByLabelText("New task");
    fireEvent.change(input, { target: { value: "Gym session" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fake.executed).toHaveLength(1));
    const [create, schedule] = fake.executed[0] ?? [];
    expect(create).toMatchObject({ type: "create_task", task: { title: "Gym session" } });
    expect(schedule).toMatchObject({
      type: "create_time_block",
      block: { start_at: atMinute(today, 9 * 60), end_at: atMinute(today, 11 * 60) },
    });
    expect(create?.type === "create_task" && schedule?.type === "create_time_block").toBe(true);
    if (create?.type === "create_task" && schedule?.type === "create_time_block") {
      expect(schedule.block.task_id).toBe(create.task.id);
    }
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New task on the calendar" })).toBeNull(),
    );
    const labels = screen.getAllByTestId("time-block").map((b) => b.getAttribute("aria-label"));
    expect(labels.some((l) => l?.startsWith("Gym session"))).toBe(true);
  });

  it("a click makes a one-hour slot, and Cancel leaves nothing behind", async () => {
    await renderCalendar();
    const column = await screen.findByTestId(`time-column-${today}`);
    fireEvent.pointerDown(column, { button: 0, clientY: y(14.2) });
    fireEvent.pointerUp(window, { clientY: y(14.2) });
    const box = await screen.findByRole("dialog", { name: "New task on the calendar" });
    expect(within(box).getByText(/1 h/)).toBeTruthy();
    fireEvent.click(within(box).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("draft-block")).toBeNull());
    expect(fake.executed).toHaveLength(0);
  });
});

describe("resizing a block", () => {
  const y = (hour: number) => hour * 48;
  const dentist = async () =>
    within(await screen.findByTestId(`time-column-${today}`)).getByRole("button", {
      name: /^Dentist, /,
    });

  it("drags the bottom edge to change the end, without opening the menu", async () => {
    await renderCalendar();
    const handle = within(await dentist()).getByTestId("resize-handle");
    fireEvent.pointerDown(handle, { button: 0, clientY: y(11) });
    fireEvent.pointerMove(window, { clientY: y(12.6) });
    expect((await dentist()).textContent).toContain("2 h 30");
    fireEvent.pointerUp(window, { clientY: y(12.6) });
    fireEvent.click(await dentist());
    await waitFor(() => expect(fake.executed).toHaveLength(1));
    expect(fake.executed[0]).toEqual([
      {
        type: "update_time_block",
        id: block.id,
        changes: [{ end_at: atMinute(today, 12 * 60 + 30) }],
      },
    ]);
    expect(screen.queryByRole("dialog", { name: "Time block" })).toBeNull();
  });

  it("drags the top edge to change the start, keeping at least a quarter hour", async () => {
    await renderCalendar();
    const handle = within(await dentist()).getByTestId("resize-handle-start");
    fireEvent.pointerDown(handle, { button: 0, clientY: y(10) });
    fireEvent.pointerMove(window, { clientY: y(11.5) });
    fireEvent.pointerUp(window, { clientY: y(11.5) });
    await waitFor(() => expect(fake.executed).toHaveLength(1));
    expect(fake.executed[0]).toEqual([
      {
        type: "update_time_block",
        id: block.id,
        changes: [{ start_at: atMinute(today, 10 * 60 + 45) }],
      },
    ]);
  });

  it("Shift+arrows lengthen and shorten a block by a quarter hour", async () => {
    await renderCalendar();
    fireEvent.keyDown(await dentist(), { key: "ArrowDown", shiftKey: true });
    await waitFor(() => expect(fake.executed).toHaveLength(1));
    expect(fake.executed[0]?.[0]).toMatchObject({
      changes: [{ end_at: atMinute(today, 11 * 60 + 15) }],
    });
  });
});

describe("events from Google Calendar", () => {
  const standup = {
    calendar_id: "me@example.com",
    id: "ev1",
    title: "Standup",
    start_at: atMinute(today, 10 * 60 + 30),
    end_at: atMinute(today, 10 * 60 + 45),
    start_date: null,
    end_date: null,
    location: "Room 4",
    link: "https://calendar.google.com/event?eid=1",
    color: "#0b8043",
  };
  const holiday = {
    ...standup,
    id: "ev2",
    title: "Holiday",
    start_at: null,
    end_at: null,
    start_date: today,
    end_date: addDays(today, 2),
    location: null,
  };
  const sources = [
    {
      id: "me@example.com",
      name: "Me",
      color: "#0b8043",
      primary: true,
      target: false,
      shown: true,
      synced_at: 1,
    },
  ];

  it("shows them read-only beside the blocks, with a link to Google", async () => {
    const calendar = fakeCalendar(
      { connected: true, last_sync_at: Date.now() - 120_000, sources },
      [standup, holiday],
    );
    const opened: string[] = [];
    await renderCalendar("/calendar", {
      calendar: calendar.api,
      files: {
        storeFile: async () => ({ hash: "", size: 0, name: "", mime: "" }),
        storeData: async () => ({ hash: "", size: 0, name: "", mime: "" }),
        open: async () => {},
        saveCopy: async () => false,
        openUrl: async (url) => {
          opened.push(url);
        },
        pickFiles: async () => [],
        url: (id) => id,
      },
    });
    const column = await screen.findByTestId(`time-column-${today}`);
    const event = await within(column).findByRole("button", { name: /^Standup, .*calendar event/ });
    // It overlaps the Dentist block (10:00 to 11:00): they share the column.
    expect(within(column).getByRole("button", { name: /^Dentist, / })).toBeTruthy();
    expect(within(screen.getByTestId(`day-lane-${today}`)).getByText("Holiday")).toBeTruthy();
    expect(screen.getByText(/Google Calendar synced 2 min ago/)).toBeTruthy();

    fireEvent.click(event);
    const details = await screen.findByRole("dialog", { name: "Calendar event" });
    expect(within(details).getByText("Room 4")).toBeTruthy();
    expect(within(details).getByText(/Me · read-only/)).toBeTruthy();
    fireEvent.click(within(details).getByRole("button", { name: "Open in Google Calendar" }));
    expect(opened).toEqual([standup.link]);

    // On Sunday, tomorrow belongs to the next displayed week.
    if (new Date(`${today}T12:00:00`).getDay() === 0) {
      fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    }
    expect(
      within(await screen.findByTestId(`day-lane-${addDays(today, 1)}`)).getByText("Holiday"),
    ).toBeTruthy();

    // The week's range was asked for.
    expect((calendar.ranges.at(-1)?.to_date ?? "") > today).toBe(true);
  });

  it("re-reads events after a sync and in the month view", async () => {
    const calendar = fakeCalendar({ connected: true, sources }, [standup]);
    await renderCalendar("/calendar", { calendar: calendar.api });
    await screen.findAllByTestId("calendar-event");
    const before = calendar.ranges.length;
    act(() => calendar.synced({ syncing: false, last_sync_at: Date.now() }));
    await waitFor(() => expect(calendar.ranges.length).toBe(before + 1));

    fireEvent.click(screen.getByRole("button", { name: "month" }));
    const cell = screen.getByTestId(`month-cell-${today}`);
    await waitFor(() => expect(within(cell).getByText("Standup")).toBeTruthy());
  });
});

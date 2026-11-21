// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import { atMinute } from "../../lib/calendar";
import { isoDate } from "../../lib/dates";
import type { Changes, Command, Meeting, Snapshot } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore, type TaskStore } from "../../store/store";
import { fakeParse, meeting, project, snapshot, task } from "../../test/fixtures";

const empty: Changes = {
  batch_id: "b",
  op_seq: 1,
  tasks: [],
  projects: [],
  epics: [],
  tags: [],
  views: [],
  attachments: [],
  time_blocks: [],
  agent_sessions: [],
  agent_notes: [],
  meetings: [],
  transcript_segments: [],
  terminal_sessions: [],
  notes: [],
  note_folders: [],
  statuses: [],
};

function fakeApi(data: Partial<Snapshot>) {
  const executed: Command[][] = [];
  const api: Api = {
    snapshot: async () => snapshot(data),
    execute: async (commands) => {
      executed.push(commands);
      return { ...empty, batch_id: `b${executed.length}`, op_seq: executed.length };
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

let store: TaskStore;
let fake: ReturnType<typeof fakeApi>;

async function renderApp(path: string, data: Partial<Snapshot> = {}) {
  fake = fakeApi(data);
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

const client = project({ name: "Client" });
const today = isoDate();

describe("Scribe", () => {
  it("lists meetings, upcoming first, and filters them", async () => {
    const soon = meeting({
      title: "Kick-off",
      started_at: Date.now() + 3_600_000,
      ended_at: Date.now() + 7_200_000,
      project_id: client.id,
    });
    const old = meeting({ title: "Retro", participants: ["Bob"], started_at: 1_000_000 });
    await renderApp("/scribe", { projects: [client], meetings: [soon, old] });
    const rows = await screen.findAllByRole("button", { name: /Kick-off|Retro/ });
    expect(rows.map((r) => r.textContent?.includes("Kick-off"))).toEqual([true, false]);
    expect(screen.getByText("Upcoming and now")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search meetings"), { target: { value: "bob" } });
    expect(screen.queryByText("Kick-off")).toBeNull();
    expect(screen.getByText("Retro")).toBeTruthy();
  });

  it("starts a meeting now and opens it", async () => {
    const router = await renderApp("/scribe");
    expect(await screen.findByText("No meetings yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Start meeting/ }));
    await waitFor(() => expect(fake.executed).toHaveLength(1));
    const [command] = fake.executed[0] ?? [];
    expect(command?.type).toBe("create_meeting");
    const created = (command as Extract<Command, { type: "create_meeting" }>).meeting;
    expect(created.state).toBe("held");
    expect(Math.abs((created.started_at ?? 0) - Date.now())).toBeLessThan(61_000);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/meeting/${created.id}`));
    expect(await screen.findByText("In progress")).toBeTruthy();
  });

  it("edits participants with suggestions from earlier meetings", async () => {
    const earlier = meeting({ participants: ["Ada Lovelace", "Grace Hopper"], started_at: 1 });
    const current = meeting({ title: "Planning", participants: [] });
    await renderApp(`/meeting/${current.id}`, { meetings: [earlier, current] });
    const input = await screen.findByLabelText("Add a participant");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "gra" } });
    const suggestions = screen.getByRole("list", { name: "Suggestions" });
    fireEvent.mouseDown(within(suggestions).getByRole("button", { name: "Grace Hopper" }));
    await waitFor(() => expect(fake.executed).toHaveLength(1));
    expect(fake.executed[0]).toEqual([
      { type: "update_meeting", id: current.id, changes: [{ participants: ["Grace Hopper"] }] },
    ]);

    // Typed names are added on Enter, several at once when pasted with commas.
    fireEvent.change(input, { target: { value: "Bob, Carol" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fake.executed).toHaveLength(2));
    const people = screen.getByRole("list", { name: "Participants" });
    expect(within(people).getByText("Bob")).toBeTruthy();
    expect(within(people).getByText("Carol")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove Bob" }));
    await waitFor(() => expect(fake.executed).toHaveLength(3));
    expect(store.getState().meetings[current.id]?.participants).toEqual(["Grace Hopper", "Carol"]);
  });

  it("links a project and keeps the length when the start moves", async () => {
    const start = atMinute(today, 9 * 60);
    const m = meeting({ started_at: start, ended_at: start + 3_600_000 });
    await renderApp(`/meeting/${m.id}`, { projects: [client], meetings: [m] });
    const startInput = await screen.findByLabelText("Start time");
    fireEvent.change(startInput, { target: { value: "14:00" } });
    await waitFor(() => expect(fake.executed).toHaveLength(1));
    const two = atMinute(today, 14 * 60);
    expect(fake.executed[0]).toEqual([
      {
        type: "update_meeting",
        id: m.id,
        changes: [{ started_at: two }, { ended_at: two + 3_600_000 }],
      },
    ]);
    fireEvent.change(screen.getByLabelText("End time"), { target: { value: "13:00" } });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(fake.executed).toHaveLength(1);
  });

  it("deletes a meeting and goes back to Scribe", async () => {
    const m = meeting({ title: "Old one" });
    const router = await renderApp(`/meeting/${m.id}`, { meetings: [m] });
    fireEvent.click(await screen.findByRole("button", { name: /Delete the meeting/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/scribe"));
    expect(fake.executed[0]).toEqual([{ type: "delete_meeting", id: m.id }]);
    expect(store.getState().meetings[m.id]).toBeUndefined();
  });

  it("shows a task's meetings on its page and plans one linked to it", async () => {
    const t = task({ title: "Prepare launch", project_id: client.id });
    const linked: Meeting = meeting({ title: "Launch sync", task_id: t.id });
    await renderApp(`/task/${t.id}`, { tasks: [t], projects: [client], meetings: [linked] });
    const section = await screen.findByRole("region", { name: "Meetings" });
    expect(within(section).getByText("Launch sync")).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: /Plan a meeting/ }));
    await waitFor(() => expect(fake.executed).toHaveLength(1));
    const command = fake.executed[0]?.[0] as Extract<Command, { type: "create_meeting" }>;
    expect(command.meeting).toMatchObject({
      task_id: t.id,
      project_id: client.id,
      state: "scheduled",
    });
  });

  it("draws meetings on the calendar and opens them", async () => {
    const start = atMinute(today, 11 * 60);
    const m = meeting({ title: "Standup", started_at: start, ended_at: start + 1_800_000 });
    const router = await renderApp("/calendar", { meetings: [m] });
    const item = await screen.findByTestId("calendar-meeting");
    expect(item.getAttribute("aria-label")).toContain("Standup");
    fireEvent.click(item);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/meeting/${m.id}`));
  });
});

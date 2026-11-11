// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Api } from "../../lib/api";
import type { Changes, Command, Snapshot } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeAgents } from "../../test/fakeAgents";
import { agentSession, fakeParse, project, snapshot, task } from "../../test/fixtures";
import { pickOption } from "../../test/select";
import { RESUME_MESSAGE } from "./sessions";

const none = (): Changes => ({
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
  statuses: [],
});

async function renderAt(
  path: string,
  snap: Partial<Snapshot>,
  agentOpts: Parameters<typeof fakeAgents>[0] = {},
) {
  const agents = fakeAgents(agentOpts);
  const executed: Command[][] = [];
  const api = {
    snapshot: async () => snapshot(snap),
    execute: async (commands: Command[]) => {
      executed.push(commands);
      return none();
    },
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async (text: string) => fakeParse(text),
    onChanged: async () => () => {},
    agents: agents.api,
  } as Api;
  const store = createTaskStore(api);
  await store.getState().hydrate();
  await store.getState().connect();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <StoreProvider store={store} api={api}>
      <RouterProvider router={router} />
    </StoreProvider>,
  );
  return { store, agents, executed };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("sends a task to the agent from its page and follows the run", async () => {
  const app = project({ id: "p1", name: "App" });
  const t = task({ title: "Fix the login", project_id: app.id });
  const { store, agents } = await renderAt(`/task/${t.id}`, { tasks: [t], projects: [app] });

  fireEvent.click(await screen.findByRole("button", { name: "Send to agent" }));
  const dialog = await screen.findByRole("dialog");
  const folder = within(dialog).getByRole("textbox", { name: "Folder" });
  // No session and no project folder yet: nothing to prefill.
  await waitFor(() => expect(folder).toHaveProperty("value", ""));
  expect(within(dialog).getByRole("button", { name: "Start" })).toHaveProperty("disabled", true);

  fireEvent.click(within(dialog).getByRole("button", { name: "Browse…" }));
  await waitFor(() => expect(folder).toHaveProperty("value", "/picked"));
  fireEvent.change(within(dialog).getByLabelText("Instructions (optional)"), {
    target: { value: "Keep the API as is" },
  });
  fireEvent.click(within(dialog).getByText("What the agent gets"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(agents.started).toEqual([
    {
      task_id: t.id,
      folder: "/picked",
      model: null,
      permission_mode: "acceptEdits",
      prompt: "Keep the API as is",
    },
  ]);
  // The folder becomes the project's on this device, since it had none.
  expect(agents.calls).toContain("folder p1 /picked");

  const card = await screen.findByTestId("session-card");
  expect(within(card).getByText("Running")).toBeTruthy();
  const [session] = Object.values(store.getState().agent_sessions);
  act(() => agents.activity(session?.id ?? "", "Editing login.ts"));
  expect(within(card).getByRole("status").textContent).toContain("Editing login.ts");

  // A run is taken over in a terminal (the shell stops the background run first).
  fireEvent.click(
    within(card).getByRole("button", { name: "Continue in terminal (stops the background run)" }),
  );
  await waitFor(() => expect(agents.calls).toContain(`terminal ${session?.id}`));
  fireEvent.click(within(card).getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(agents.calls).toContain(`cancel ${session?.id}`));
});

it("prefills the task's last folder and asks before running everything", async () => {
  const t = task();
  const earlier = agentSession({ task_id: t.id, folder: "/work/repo" });
  await renderAt(
    `/task/${t.id}`,
    { tasks: [t], agent_sessions: [earlier] },
    { settings: { permission_mode: "bypassPermissions" } },
  );
  fireEvent.click(await screen.findByRole("button", { name: "Send to agent" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() =>
    expect(within(dialog).getByRole("textbox", { name: "Folder" })).toHaveProperty(
      "value",
      "/work/repo",
    ),
  );
  const start = within(dialog).getByRole("button", { name: "Start" });
  expect(start).toHaveProperty("disabled", true);
  fireEvent.click(within(dialog).getByLabelText(/run commands without asking/));
  expect(start).toHaveProperty("disabled", false);
});

it("shows an ended session's summary and notes, and continues it with a follow-up", async () => {
  const t = task();
  const done = agentSession({
    task_id: t.id,
    summary: "Fixed the redirect and added a test.",
    cost_usd_micros: 1_250_000,
    turns: 7,
  });
  const note = {
    id: "n1",
    session_id: done.id,
    task_id: t.id,
    body: "Found the bug in redirect()",
    created_at: 2_000,
    updated_at: 2_000,
    deleted_at: null,
  };
  const { agents } = await renderAt(
    `/task/${t.id}`,
    { tasks: [t], agent_sessions: [done] },
    { notes: [note] },
  );
  const card = await screen.findByTestId("session-card");
  expect(within(card).getByTestId("session-summary").textContent).toBe(
    "Fixed the redirect and added a test.",
  );
  expect(await within(card).findByText("Found the bug in redirect()")).toBeTruthy();
  expect(card.textContent).toContain("$1.25");
  expect(card.textContent).toContain("7 turns");

  const terminal = within(card).getByRole("button", { name: "Open in terminal" });
  fireEvent.click(terminal);
  // Actions on a card run one at a time.
  await waitFor(() => expect(terminal).toHaveProperty("disabled", false));
  fireEvent.change(within(card).getByRole("textbox", { name: "Follow-up message" }), {
    target: { value: "Also update the docs" },
  });
  fireEvent.click(within(card).getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(agents.calls).toEqual([`terminal ${done.id}`, `send ${done.id} Also update the docs`]),
  );
});

it("puts a running session's activity on the task's row", async () => {
  const t = task({ title: "Write the docs" });
  const running = agentSession({ task_id: t.id, state: "running", ended_at: null });
  await renderAt(
    "/inbox",
    { tasks: [t], agent_sessions: [running] },
    { live: [{ session_id: running.id, activity: "Reading README.md" }] },
  );
  const chip = await screen.findByTestId("session-chip");
  expect(chip.textContent).toBe("Reading README.md");
});

it("lists sessions and the agents' tasks under the user's task they serve", async () => {
  const mine = task({ title: "Ship the release" });
  const step = task({ title: "Bump versions", parent_id: mine.id, owner: "agent" });
  const deeper = task({ title: "Check the changelog", parent_id: step.id, owner: "agent" });
  const running = agentSession({ task_id: mine.id, state: "running", ended_at: null });
  const failed = agentSession({
    task_id: mine.id,
    state: "failed",
    error: "claude not found",
    updated_at: Date.now(),
  });
  const { executed } = await renderAt("/agents", {
    tasks: [mine, step, deeper],
    agent_sessions: [running, failed],
  });

  const live = await screen.findByRole("region", { name: "Active" });
  expect(within(live).getByText("Ship the release")).toBeTruthy();
  const recent = screen.getByRole("region", { name: "Recent sessions" });
  expect(within(recent).getByText("claude not found")).toBeTruthy();

  const agentTasks = screen.getByRole("region", { name: "Agent tasks" });
  expect(within(agentTasks).getByText("For “Ship the release”")).toBeTruthy();
  expect(within(agentTasks).getByText("Bump versions")).toBeTruthy();
  expect(within(agentTasks).getByText("Check the changelog")).toBeTruthy();

  fireEvent.click(
    within(agentTasks).getAllByRole("button", { name: "Make it mine" })[0] as Element,
  );
  await waitFor(() => expect(executed.length).toBe(1));
  expect(executed[0]?.[0]).toMatchObject({ type: "update_task", changes: [{ owner: "me" }] });
});

it("resumes an interrupted session and ends one left in a terminal", async () => {
  const t = task();
  const interrupted = agentSession({ task_id: t.id, state: "interrupted", started_at: 1 });
  const { agents, executed } = await renderAt(`/task/${t.id}`, {
    tasks: [t],
    agent_sessions: [interrupted],
  });
  let card = await screen.findByTestId("session-card");
  expect(within(card).queryByRole("button", { name: "Mark done" })).toBeNull();
  fireEvent.click(within(card).getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(agents.calls).toEqual([`send ${interrupted.id} ${RESUME_MESSAGE}`]));
  cleanup();

  const terminal = agentSession({ task_id: t.id, state: "terminal", ended_at: null });
  const second = await renderAt(`/task/${t.id}`, { tasks: [t], agent_sessions: [terminal] });
  card = await screen.findByTestId("session-card");
  expect(within(card).getByText("In terminal")).toBeTruthy();
  expect(within(card).getByRole("status").textContent).toContain("Continuing in a terminal");
  // No follow-up, Resume or removal while the terminal has the conversation.
  expect(within(card).queryByRole("textbox", { name: "Follow-up message" })).toBeNull();
  expect(within(card).queryByRole("button", { name: "Resume" })).toBeNull();
  expect(within(card).queryByRole("button", { name: "Remove from history" })).toBeNull();
  fireEvent.click(within(card).getByRole("button", { name: "Mark done" }));
  await waitFor(() => expect(second.executed.length).toBe(1));
  expect(second.executed[0]).toEqual([
    { type: "update_agent_session", id: terminal.id, changes: [{ state: "done" }] },
  ]);
  expect(second.store.getState().agent_sessions[terminal.id]?.state).toBe("done");
  // Resuming started the work timer, which moved the to-do task to in progress.
  await waitFor(() => expect(executed.length).toBe(1));
  expect(executed[0]).toMatchObject([
    { type: "update_task", id: t.id, changes: [{ status_id: expect.any(String) }] },
  ]);
});

const NO_LIMITS = { day_usd_micros: null, week_usd_micros: null, month_usd_micros: null };

it("totals cost and agent time by project and period, and shows what limits leave", async () => {
  const app = project({ id: "p1", name: "App" });
  const site = project({ id: "p2", name: "Site" });
  const a = task({ title: "Fix the login", project_id: app.id });
  const b = task({ title: "New landing page", project_id: site.id });
  const now = Date.now();
  const sessions = [
    agentSession({
      task_id: a.id,
      updated_at: now,
      cost_usd_micros: 3_000_000,
      duration_ms: 10 * 60_000,
      summary: "Login fixed",
    }),
    agentSession({
      task_id: b.id,
      updated_at: now,
      cost_usd_micros: 1_000_000,
      duration_ms: 5 * 60_000,
      summary: "Page drafted",
    }),
    // Long ago: outside This month, inside All time.
    agentSession({ task_id: a.id, updated_at: 1, cost_usd_micros: 6_000_000, summary: "Old run" }),
  ];
  await renderAt(
    "/agents",
    { tasks: [a, b], projects: [app, site], agent_sessions: sessions },
    { settings: { limits: { ...NO_LIMITS, month_usd_micros: 10_000_000 } } },
  );

  const usage = await screen.findByRole("region", { name: "Usage" });
  expect(usage.textContent).toContain("$4.00");
  expect(usage.textContent).toContain("15 min");
  const limits = screen.getByRole("region", { name: "Spend limits" });
  await waitFor(() => expect(limits.textContent).toContain("$6.00 left"));
  const byProject = screen.getByRole("region", { name: "By project" });
  expect(within(byProject).getAllByRole("row")[1]?.textContent).toContain("App");

  // Focusing a project from its row filters the totals and the sessions.
  fireEvent.click(within(byProject).getByRole("button", { name: "App" }));
  await waitFor(() => expect(usage.textContent).toContain("$3.00"));
  expect(screen.queryByRole("region", { name: "By project" })).toBeNull();
  const recent = screen.getByRole("region", { name: "Recent sessions" });
  expect(within(recent).queryByText("Page drafted")).toBeNull();
  expect(within(recent).queryByText("Old run")).toBeNull();

  await pickOption("Period", "All time");
  await waitFor(() => expect(usage.textContent).toContain("$9.00"));
  expect(within(recent).getByText("Old run")).toBeTruthy();
  // The limits count every project, whatever the filter.
  expect(limits.textContent).toContain("$6.00 left");
});

it("asks before starting once a spend limit is used up", async () => {
  const t = task();
  const spent = agentSession({
    task_id: t.id,
    folder: "/work/repo",
    updated_at: Date.now(),
    cost_usd_micros: 2_500_000,
  });
  await renderAt(
    `/task/${t.id}`,
    { tasks: [t], agent_sessions: [spent] },
    { settings: { limits: { ...NO_LIMITS, day_usd_micros: 2_000_000 } } },
  );
  fireEvent.click(await screen.findByRole("button", { name: "Send to agent" }));
  const dialog = await screen.findByRole("dialog");
  const warning = await within(dialog).findByText(/spent today, over/);
  expect(warning.textContent).toBe("$2.50 spent today, over the $2.00 limit.");
  const start = within(dialog).getByRole("button", { name: "Start" });
  expect(start).toHaveProperty("disabled", true);
  fireEvent.click(within(dialog).getByLabelText("Start anyway"));
  expect(start).toHaveProperty("disabled", false);
});

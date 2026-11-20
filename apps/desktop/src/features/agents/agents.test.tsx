// @vitest-environment jsdom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Api } from "../../lib/api";
import type { Changes, Command, Epic, Snapshot } from "../../lib/types";
import { createAppRouter } from "../../router";
import { StoreProvider } from "../../store/context";
import { createTaskStore } from "../../store/store";
import { fakeAgents } from "../../test/fakeAgents";
import {
  agentSession,
  fakeParse,
  project,
  snapshot,
  task,
  terminalSession,
} from "../../test/fixtures";
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
  meetings: [],
  transcript_segments: [],
  terminal_sessions: [],
  notes: [],
  note_folders: [],
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
      surface: "background",
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

it("opens a session in the Claude desktop app on macOS and Windows, and ends it by hand", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  );
  const t = task({ title: "Redesign the header" });
  const { agents } = await renderAt(`/task/${t.id}`, { tasks: [t] });

  fireEvent.click(await screen.findByRole("button", { name: "Send to agent" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Browse…" }));
  await pickOption("Run", "In the Claude desktop app");
  // Permissions and model are the desktop app's.
  expect(within(dialog).queryByRole("combobox", { name: "Permissions" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Open in Claude" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(agents.started[0]?.surface).toBe("desktop");
  const card = await screen.findByTestId("session-card");
  expect(within(card).queryByRole("button", { name: "Open in terminal" })).toBeNull();
  // The state brings the conversation back up in the desktop app.
  fireEvent.click(within(card).getByRole("button", { name: "In desktop app" }));
  const id = agents.calls.find((c) => c.startsWith("start "))?.slice("start ".length);
  await waitFor(() => expect(agents.calls).toContain(`desktop ${id}`));
  fireEvent.click(within(card).getByRole("button", { name: "Mark done" }));
  await waitFor(() => expect(within(card).getByText("Done")).toBeTruthy());

  // Remembered for next time.
  fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
  expect((await screen.findByRole("combobox", { name: "Run" })).textContent).toContain(
    "In the Claude desktop app",
  );
  vi.restoreAllMocks();
});

it("says why a conversation cannot open in the desktop app, from the Agents page", async () => {
  const t = task({ title: "Redesign the header" });
  const open = agentSession({ task_id: t.id, state: "desktop", ended_at: null });
  const { agents } = await renderAt(
    "/agents",
    { tasks: [t], agent_sessions: [open] },
    { openDesktop: new Error("cannot find this conversation in the Claude desktop app") },
  );

  const live = await screen.findByRole("region", { name: "Active" });
  fireEvent.click(within(live).getByRole("button", { name: "In desktop app" }));
  expect((await within(live).findByRole("alert")).textContent).toContain(
    "cannot find this conversation",
  );
  expect(agents.calls).toContain(`desktop ${open.id}`);
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

it("starts with Cmd/Ctrl+Enter from the instructions, only once it can", async () => {
  const t = task();
  const { agents } = await renderAt(`/task/${t.id}`, { tasks: [t] });
  fireEvent.click(await screen.findByRole("button", { name: "Send to agent" }));
  const dialog = await screen.findByRole("dialog");
  const instructions = within(dialog).getByLabelText("Instructions (optional)");
  fireEvent.change(instructions, { target: { value: "Go" } });
  // No folder yet: nothing starts.
  fireEvent.keyDown(instructions, { key: "Enter", ctrlKey: true });
  expect(agents.started).toEqual([]);

  fireEvent.click(within(dialog).getByRole("button", { name: "Browse…" }));
  await waitFor(() =>
    expect(within(dialog).getByRole("textbox", { name: "Folder" })).toHaveProperty(
      "value",
      "/picked",
    ),
  );
  // Plain Enter is a new line, not a start.
  fireEvent.keyDown(instructions, { key: "Enter" });
  expect(agents.started).toEqual([]);
  fireEvent.keyDown(instructions, { key: "Enter", metaKey: true });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(agents.started.map((s) => s.prompt)).toEqual(["Go"]);
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

it("groups recent sessions by day and marks each with its task's project and epic", async () => {
  const app = project({ id: "p1", name: "App" });
  const epic: Epic = {
    id: "e1",
    name: "Login",
    project_id: app.id,
    description: null,
    target_date: null,
    state: "active",
    rank: "a0",
    color: null,
    icon: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  };
  const a = task({ title: "Fix the login", project_id: app.id, epic_id: epic.id });
  const b = task({ title: "Tidy the inbox" });
  const now = Date.now();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  const sessions = [
    agentSession({ task_id: a.id, started_at: now, updated_at: now, summary: "Login fixed" }),
    agentSession({
      task_id: b.id,
      started_at: yesterday.getTime(),
      updated_at: now,
      summary: "Inbox tidied",
    }),
  ];
  await renderAt("/agents", {
    tasks: [a, b],
    projects: [app],
    epics: [epic],
    agent_sessions: sessions,
  });

  const recent = await screen.findByRole("region", { name: "Recent sessions" });
  expect(within(recent).getByRole("heading", { name: /Today/ })).toBeTruthy();
  const today = within(recent).getByRole("list", { name: "Today" });
  expect(within(today).getByText("Login fixed")).toBeTruthy();
  expect(within(today).getByTitle("Project: App")).toBeTruthy();
  expect(within(today).getByTitle("Epic: Login")).toBeTruthy();
  const before = within(recent).getByRole("list", { name: "Yesterday" });
  expect(within(before).getByText("Inbox tidied")).toBeTruthy();
  expect(within(before).getByText("Inbox")).toBeTruthy();

  // Focused on one project, the rows stop repeating it but keep the epic.
  await pickOption("Project", "App");
  await waitFor(() => expect(within(recent).queryByText("Inbox tidied")).toBeNull());
  expect(within(recent).queryByTitle("Project: App")).toBeNull();
  expect(within(recent).getByTitle("Epic: Login")).toBeTruthy();
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

it("counts sessions run in a terminal, filed under a project by hand", async () => {
  const app = project({ id: "p1", name: "App" });
  const site = project({ id: "p2", name: "Site" });
  const a = task({ title: "Fix the login", project_id: app.id });
  const now = Date.now();
  const fromTask = agentSession({
    task_id: a.id,
    updated_at: now,
    started_at: now - 60_000,
    cost_usd_micros: 1_000_000,
    summary: "Login fixed",
  });
  const fromTerminal = terminalSession({
    title: "Redesign the header",
    project_id: app.id,
    started_at: now - 30_000,
    ended_at: now,
    cost_usd_micros: 2_500_000,
    duration_ms: 20 * 60_000,
  });
  const { agents, executed } = await renderAt(
    "/agents",
    {
      tasks: [a],
      projects: [app, site],
      agent_sessions: [fromTask],
      terminal_sessions: [fromTerminal],
    },
    { settings: { limits: { ...NO_LIMITS, day_usd_micros: 3_000_000 } } },
  );

  const usage = await screen.findByRole("region", { name: "Usage" });
  expect(usage.textContent).toContain("$3.50");
  const recent = screen.getByRole("region", { name: "Recent sessions" });
  expect(within(recent).getByText("Redesign the header")).toBeTruthy();
  // A terminal session's spend counts against the limits too.
  const limits = screen.getByRole("region", { name: "Spend limits" });
  await waitFor(() => expect(limits.textContent).toContain("Over by $0.50"));

  await pickOption("Sessions", "Run in a terminal");
  await waitFor(() => expect(usage.textContent).toContain("$2.50"));
  expect(within(recent).queryByText("Login fixed")).toBeNull();

  await pickOption("Project of “Redesign the header”", "Site");
  await waitFor(() =>
    expect(executed.at(-1)).toEqual([
      {
        type: "update_terminal_session",
        id: fromTerminal.id,
        changes: [{ project_id: site.id }, { task_id: null }],
      },
    ]),
  );

  fireEvent.click(within(usage).getByRole("button", { name: "read them now" }));
  await waitFor(() => expect(usage.textContent).toContain("Nothing new."));
  expect(agents.calls).toContain("scan terminal");

  fireEvent.click(
    within(recent).getByRole("button", { name: "Leave “Redesign the header” out of the totals" }),
  );
  await waitFor(() => expect(within(recent).queryByText("Redesign the header")).toBeNull());
  expect(executed.at(-1)).toEqual([{ type: "delete_terminal_session", id: fromTerminal.id }]);
});

it("shows the Claude plan's 5-hour and weekly usage, and why it cannot", async () => {
  const now = Date.now();
  const { agents } = await renderAt(
    "/agents",
    {},
    {
      planUsage: {
        plan: "max",
        fetched_at: now,
        windows: [
          {
            kind: "five_hour",
            label: "5-hour window",
            percent: 61,
            resets_at: now + 90 * 60_000,
          },
          { kind: "seven_day", label: "Week, all models", percent: 97, resets_at: null },
        ],
      },
    },
  );
  const plan = await screen.findByRole("region", { name: "Claude plan" });
  await waitFor(() => expect(plan.textContent).toContain("39% left"));
  expect(plan.textContent).toContain("Max plan");
  expect(plan.textContent).toContain("Resets in 1 h 30");
  expect(within(plan).getByRole("meter", { name: "Week, all models usage" })).toBeTruthy();
  expect(plan.textContent).toContain("3% left");
  expect(agents.calls).toContain("plan usage");
  cleanup();

  await renderAt("/agents", {}, { planUsage: new Error("Claude Code is not signed in") });
  const failed = await screen.findByRole("region", { name: "Claude plan" });
  await waitFor(() => expect(failed.textContent).toContain("not signed in"));
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

it("shows the release and branch of a project folder in a git repository, only then", async () => {
  const p = project({ name: "App" });
  const other = project({ name: "Notes" });
  const repo = {
    root: "/work/app",
    branch: "main",
    commit: "840216c",
    tag: "v0.16.1",
    commits_since_tag: 2,
    dirty: true,
  };
  const folders = [
    { project_id: p.id, path: "/work/app", runtime: "native" as const, updated_at: 1 },
    { project_id: other.id, path: "/work/notes", runtime: "native" as const, updated_at: 1 },
  ];
  const opts = { folders, repos: { "/work/app": repo } };
  const first = await renderAt(`/project/${p.id}`, { projects: [p, other] }, opts);
  const badge = await screen.findByTestId("project-repo");
  expect(badge.textContent).toContain("v0.16.1 +2 · main");
  expect(badge.getAttribute("title")).toContain("Commit: 840216c (uncommitted changes)");
  expect(first.agents.calls).toContain(`git ${p.id}`);
  cleanup();

  // A folder outside any repository: nothing about git.
  const second = await renderAt(`/project/${other.id}`, { projects: [p, other] }, opts);
  await waitFor(() => expect(second.agents.calls).toContain(`git ${other.id}`));
  expect(screen.queryByTestId("project-repo")).toBeNull();
});

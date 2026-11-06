import { expect, it } from "vitest";
import type { Api } from "../lib/api";
import type { Changes, Command } from "../lib/types";
import { fakeAgents } from "../test/fakeAgents";
import { agentSession, fakeParse, snapshot, task } from "../test/fixtures";
import { adoptTask, removeAgentSession } from "./actions";
import { createTaskStore } from "./store";

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

async function setup(snap = snapshot(), live: Parameters<typeof fakeAgents>[0] = {}) {
  const agents = fakeAgents(live);
  const executed: Command[][] = [];
  const api = {
    snapshot: async () => snap,
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
  const stop = await store.getState().connect();
  return { store, agents, executed, stop };
}

it("keeps the live activity of running sessions, from the window's start and from events", async () => {
  const { store, agents, stop } = await setup(snapshot(), {
    live: [
      { session_id: "s-a", activity: "Editing store.rs" },
      { session_id: "s-b", activity: null },
    ],
  });
  expect(store.getState().agentActivity).toEqual({ "s-a": "Editing store.rs" });

  agents.activity("s-c", "Starting");
  agents.activity("s-a", "Running `cargo test`");
  expect(store.getState().agentActivity).toEqual({
    "s-a": "Running `cargo test`",
    "s-c": "Starting",
  });

  // A run that stopped leaves no activity behind.
  agents.activity("s-a", null);
  expect(store.getState().agentActivity).toEqual({ "s-c": "Starting" });

  stop();
  agents.activity("s-d", "Late");
  expect(store.getState().agentActivity["s-d"]).toBeUndefined();
});

it("records sessions the shell wrote and removes ended ones through execute", async () => {
  const t = task();
  const running = agentSession({ task_id: t.id, state: "running", ended_at: null });
  const done = agentSession({ task_id: t.id });
  const { store, executed } = await setup(snapshot({ tasks: [t], agent_sessions: [done] }));
  store.getState().record({ ...none(), batch_id: null, op_seq: null, agent_sessions: [running] });
  expect(Object.keys(store.getState().agent_sessions).sort()).toEqual([done.id, running.id].sort());

  // A running session cannot be removed; it has to stop first.
  expect(await removeAgentSession(store, running.id)).toBeNull();
  await removeAgentSession(store, done.id);
  expect(store.getState().agent_sessions[done.id]).toBeUndefined();
  expect(executed).toEqual([[{ type: "delete_agent_session", id: done.id }]]);
});

it("adopting an agent's task makes it the user's", async () => {
  const t = task({ owner: "agent" });
  const { store, executed } = await setup(snapshot({ tasks: [t] }));
  await adoptTask(store, t.id);
  expect(store.getState().tasks[t.id]?.owner).toBe("me");
  expect(executed).toEqual([[{ type: "update_task", id: t.id, changes: [{ owner: "me" }] }]]);
});

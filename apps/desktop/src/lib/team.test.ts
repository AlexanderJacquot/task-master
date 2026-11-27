import { describe, expect, it } from "vitest";
import { createTaskStore } from "../store/store";
import { project, STATUS, snapshot, task } from "../test/fixtures";
import type { Api } from "./api";
import { initials, isTeamTask, memberName, teamWork } from "./team";
import type { Changes, Member, Snapshot } from "./types";
import { inView, type ViewContext } from "./views";

const member = (id: string, name: string): Member => ({
  id,
  name,
  color: null,
  created_at: 0,
  updated_at: 0,
  deleted_at: null,
});

const ctx = (overrides: Partial<ViewContext> = {}): ViewContext => ({
  today: "2026-11-21",
  statuses: Object.fromEntries(snapshot().statuses.map((s) => [s.id, s])),
  projects: {},
  ...overrides,
});

describe("team helpers", () => {
  it("knows a team task by its id, project or parent", () => {
    const ids = { p: true, t: true } as Record<string, true>;
    expect(isTeamTask(task({ id: "t" }), ids)).toBe(true);
    expect(isTeamTask(task({ id: "new", project_id: "p" }), ids)).toBe(true);
    expect(isTeamTask(task({ id: "sub", parent_id: "t" }), ids)).toBe(true);
    expect(isTeamTask(task({ id: "mine" }), ids)).toBe(false);
  });

  it("names members and their initials", () => {
    const members = { a: member("a", "Ada Lovelace") };
    expect(memberName(members, "a")).toBe("Ada Lovelace");
    expect(memberName(members, "gone")).toBe("Former member");
    expect(memberName(members, null)).toBeNull();
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("bob")).toBe("B");
  });

  it("groups the team's work by assignee, me first", () => {
    const members = { a: member("a", "Ada"), b: member("b", "Bob") };
    const now = Date.parse("2026-11-21T12:00:00Z");
    const tasks = [
      task({ id: "1", assignee_id: "b", status_id: STATUS.inProgress }),
      task({ id: "2", assignee_id: "b", due_date: "2026-11-01" }),
      task({ id: "3", assignee_id: "a", status_id: STATUS.done, completed_at: now - 3600_000 }),
      task({ id: "4", status_id: STATUS.done, completed_at: now - 30 * 86_400_000 }),
      task({ id: "5" }),
      task({ id: "6", assignee_id: "b", parent_id: "1" }),
    ];
    const work = teamWork(tasks, members, ctx(), "b", now);
    expect(work.map((w) => w.member?.name ?? "unassigned")).toEqual(["Bob", "Ada", "unassigned"]);
    const [bob, ada, nobody] = work;
    expect(bob?.inProgress.map((t) => t.id)).toEqual(["1"]);
    expect(bob?.overdue.map((t) => t.id)).toEqual(["2"]);
    expect(bob?.todo.map((t) => t.id)).toEqual(["2"]);
    expect(ada?.doneThisWeek.map((t) => t.id)).toEqual(["3"]);
    expect(nobody?.todo.map((t) => t.id)).toEqual(["5"]);
  });

  it("keeps the team's inbox out of the personal one", () => {
    const teamTask = task({ id: "t" });
    expect(inView({ kind: "inbox" }, teamTask, ctx())).toBe(true);
    expect(inView({ kind: "inbox" }, teamTask, ctx({ teamIds: { t: true } }))).toBe(false);
  });
});

const changes = (overrides: Partial<Changes> = {}): Changes => ({
  batch_id: "b1",
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
  ...overrides,
});

function fakeApi(team: Snapshot | null, executed: unknown[][] = []): Api {
  return {
    snapshot: async () => snapshot({ tasks: [task({ id: "mine" })] }),
    teamSnapshot: async () => team,
    execute: async (commands, space) => {
      executed.push([commands, space]);
      return changes({
        tasks: [task({ id: "fresh", project_id: "tp" })],
        team_ids: ["fresh"],
      });
    },
    undo: async () => null,
    redo: async () => null,
    search: async () => [],
    taskActivity: async () => [],
    parseCapture: async () => {
      throw new Error("unused");
    },
    onChanged: async () => () => {},
  };
}

describe("store with a team", () => {
  it("shows nothing of teams without one", async () => {
    const store = createTaskStore(fakeApi(null));
    await store.getState().hydrate();
    expect(store.getState().team).toBeNull();
    expect(store.getState().teamIds).toEqual({});
  });

  it("merges the team space and tracks which rows are the team's", async () => {
    const team = snapshot({
      tasks: [task({ id: "shared", project_id: "tp", assignee_id: "a" })],
      projects: [project({ id: "tp", name: "Platform" })],
      members: [member("a", "Ada")],
    });
    const executed: unknown[][] = [];
    const store = createTaskStore(fakeApi(team, executed));
    await store.getState().hydrate();
    const s = store.getState();
    expect(Object.keys(s.tasks).sort()).toEqual(["mine", "shared"]);
    expect(s.teamIds).toMatchObject({ shared: true, tp: true });
    expect(s.teamIds.mine).toBeUndefined();
    expect(s.members.a?.name).toBe("Ada");
    expect(s.team).not.toBeNull();

    await s.mutate([{ type: "create_tag", tag: { id: null, name: "x", color: null } }], {}, "team");
    expect(executed[0]?.[1]).toBe("team");
    expect(store.getState().teamIds.fresh).toBe(true);
  });
});

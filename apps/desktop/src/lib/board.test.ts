import { describe, expect, it } from "vitest";
import { project, STATUS, statuses, task } from "../test/fixtures";
import { adjacentStatus, type BoardOptions, buildBoard, ranksForDrop } from "./board";
import type { Epic, Status } from "./types";
import type { ViewContext } from "./views";

const TODAY = "2026-11-04";

function ctx(projects = {}, list: Status[] = statuses): ViewContext {
  return { today: TODAY, statuses: Object.fromEntries(list.map((s) => [s.id, s])), projects };
}

const plain: BoardOptions = { swimlane: "none", showSubtasks: false, showCancelled: false };
const none = { projects: {}, epics: {} };
const titles = (cards: Array<{ task: { title: string } }> | undefined) =>
  (cards ?? []).map((c) => c.task.title);

describe("buildBoard", () => {
  it("has a column per status in workflow order, cancelled only on request", () => {
    const board = buildBoard([], { kind: "all" }, ctx(), statuses, none, plain);
    expect(board.columns.map((c) => c.status.name)).toEqual([
      "Backlog",
      "To do",
      "In progress",
      "Waiting",
      "Done",
    ]);
    const all = buildBoard([], { kind: "all" }, ctx(), statuses, none, {
      ...plain,
      showCancelled: true,
    });
    expect(all.columns.at(-1)?.status.name).toBe("Cancelled");
    expect(board.lanes).toHaveLength(1);
  });

  it("orders cards by manual rank, not by priority or due date", () => {
    const tasks = [
      task({ title: "B", rank: "a2", priority: "urgent" }),
      task({ title: "A", rank: "a1", due_date: "2020-01-01" }),
      task({ title: "C", rank: "a3" }),
    ];
    const board = buildBoard(tasks, { kind: "all" }, ctx(), statuses, none, plain);
    expect(titles(board.lanes[0]?.cells[STATUS.todo])).toEqual(["A", "B", "C"]);
  });

  it("applies the view filter and hides subtasks of shown parents unless toggled", () => {
    const parent = task({ title: "Parent" });
    const child = task({ title: "Child", parent_id: parent.id, status_id: STATUS.done });
    const p = project();
    const elsewhere = task({ title: "In a project", project_id: p.id });
    const tasks = [parent, child, elsewhere];
    const inbox = buildBoard(tasks, { kind: "inbox" }, ctx({ [p.id]: p }), statuses, none, plain);
    expect(titles(inbox.lanes[0]?.cells[STATUS.todo])).toEqual(["Parent"]);
    // Done subtask: not in the inbox (closed), but still counted in progress.
    expect(inbox.lanes[0]?.cells[STATUS.todo]?.[0]).toMatchObject({ childCount: 1, childDone: 1 });

    const all = buildBoard(tasks, { kind: "all" }, ctx({ [p.id]: p }), statuses, none, {
      ...plain,
      showSubtasks: true,
    });
    expect(titles(all.lanes[0]?.cells[STATUS.done])).toEqual(["Child"]);
  });

  it("keeps tasks closed today in the Inbox board, but not older ones", () => {
    const today = new Date(2026, 10, 4, 15).getTime();
    const lastWeek = new Date(2026, 9, 28, 15).getTime();
    const tasks = [
      task({ title: "Open" }),
      task({ title: "Done today", status_id: STATUS.done, completed_at: today }),
      task({ title: "Done before", status_id: STATUS.done, completed_at: lastWeek }),
    ];
    const board = buildBoard(tasks, { kind: "inbox" }, ctx(), statuses, none, plain);
    expect(titles(board.lanes[0]?.cells[STATUS.todo])).toEqual(["Open"]);
    expect(titles(board.lanes[0]?.cells[STATUS.done])).toEqual(["Done today"]);
  });

  it("splits columns into swimlanes that carry the change a drop makes", () => {
    const work = project({ name: "Work", rank: "a1" });
    const home = project({ name: "Home", rank: "a2" });
    const tasks = [
      task({ title: "Loose" }),
      task({ title: "Fix roof", project_id: home.id }),
      task({ title: "Report", project_id: work.id, priority: "high" }),
    ];
    const lookups = { projects: { [work.id]: work, [home.id]: home }, epics: {} };
    const byProject = buildBoard(tasks, { kind: "all" }, ctx(lookups.projects), statuses, lookups, {
      ...plain,
      swimlane: "project",
    });
    expect(byProject.lanes.map((l) => l.label)).toEqual(["Work", "Home", "No project"]);
    expect(byProject.lanes[2]?.changes).toEqual([{ project_id: null }]);

    const byPriority = buildBoard(tasks, { kind: "all" }, ctx(), statuses, none, {
      ...plain,
      swimlane: "priority",
    });
    expect(byPriority.lanes.map((l) => l.key)).toEqual(["priority:high", "priority:normal"]);
    expect(byPriority.lanes[0]?.changes).toEqual([{ priority: "high" }]);
  });

  it("groups by epic with the epic-less lane last", () => {
    const epic: Epic = {
      id: "e1",
      project_id: null,
      name: "Launch",
      description: null,
      target_date: null,
      state: "active",
      rank: "a0",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    };
    const tasks = [task({ title: "Plain" }), task({ title: "Ship", epic_id: epic.id })];
    const board = buildBoard(
      tasks,
      { kind: "all" },
      ctx(),
      statuses,
      { projects: {}, epics: { e1: epic } },
      {
        ...plain,
        swimlane: "epic",
      },
    );
    expect(board.lanes.map((l) => l.label)).toEqual(["Launch", "No epic"]);
  });

  it("flags a column over its WIP limit", () => {
    const limited = statuses.map((s) => (s.id === STATUS.inProgress ? { ...s, wip_limit: 1 } : s));
    const tasks = [
      task({ status_id: STATUS.inProgress }),
      task({ status_id: STATUS.inProgress }),
      task({ status_id: STATUS.todo }),
    ];
    const board = buildBoard(tasks, { kind: "all" }, ctx({}, limited), limited, none, plain);
    const col = (id: string) => board.columns.find((c) => c.status.id === id);
    expect(col(STATUS.inProgress)).toMatchObject({ count: 2, overLimit: true });
    expect(col(STATUS.todo)).toMatchObject({ count: 1, overLimit: false });
  });
});

describe("ranksForDrop", () => {
  it("returns one key between the new neighbours", () => {
    const ranks = { a: "a0", b: "a1", m: "a5" };
    const out = ranksForDrop(["a", "m", "b"], "m", ranks);
    expect(Object.keys(out)).toEqual(["m"]);
    expect(out.m && out.m > "a0" && out.m < "a1").toBe(true);
  });

  it("handles the ends and an empty cell", () => {
    expect(ranksForDrop(["m"], "m", { m: "zz" })).toEqual({ m: "a0" });
    const top = ranksForDrop(["m", "a"], "m", { a: "a0", m: "a9" }).m as string;
    expect(top < "a0").toBe(true);
    const end = ranksForDrop(["a", "m"], "m", { a: "a0", m: "Zz" }).m as string;
    expect(end > "a0").toBe(true);
  });

  it("renumbers the cell when the neighbours share a rank", () => {
    const ranks = { a: "a1", b: "a1", c: "a2", m: "a0" };
    const order = ["a", "m", "b", "c"];
    const out = ranksForDrop(order, "m", ranks);
    const merged: Record<string, string> = { ...ranks, ...out };
    const sorted = [...order].sort((x, y) =>
      (merged[x] as string) < (merged[y] as string) ? -1 : 1,
    );
    expect(sorted).toEqual(order);
  });
});

describe("adjacentStatus", () => {
  it("steps through the shown columns and stops at the edges", () => {
    const board = buildBoard([], { kind: "all" }, ctx(), statuses, none, plain);
    expect(adjacentStatus(board.columns, STATUS.todo, 1)).toBe(STATUS.inProgress);
    expect(adjacentStatus(board.columns, STATUS.backlog, -1)).toBeNull();
    expect(adjacentStatus(board.columns, STATUS.done, 1)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { project, STATUS, statuses, task } from "../test/fixtures";
import {
  buildRows,
  childrenByParent,
  compareTasks,
  descendantIds,
  inView,
  type ViewContext,
} from "./views";

const TODAY = "2026-11-04";

function ctx(projects = {}): ViewContext {
  return {
    today: TODAY,
    statuses: Object.fromEntries(statuses.map((s) => [s.id, s])),
    projects,
  };
}

const noCollapse = {
  showCancelled: false,
  collapsedGroups: new Set<string>(),
  collapsedTasks: new Set<string>(),
};

describe("inView", () => {
  it("inbox holds open tasks without a project", () => {
    expect(inView({ kind: "inbox" }, task(), ctx())).toBe(true);
    expect(inView({ kind: "inbox" }, task({ project_id: "p" }), ctx())).toBe(false);
    expect(inView({ kind: "inbox" }, task({ status_id: STATUS.done }), ctx())).toBe(false);
  });

  it("today holds picked tasks and open tasks due today or earlier", () => {
    const v = { kind: "today" } as const;
    expect(inView(v, task({ today_on: TODAY }), ctx())).toBe(true);
    expect(inView(v, task({ today_on: TODAY, status_id: STATUS.done }), ctx())).toBe(true);
    expect(inView(v, task({ due_date: "2026-11-01" }), ctx())).toBe(true);
    expect(inView(v, task({ due_date: TODAY }), ctx())).toBe(true);
    expect(inView(v, task({ due_date: "2026-11-01", status_id: STATUS.done }), ctx())).toBe(false);
    expect(inView(v, task({ due_date: "2026-11-05" }), ctx())).toBe(false);
    expect(inView(v, task({ today_on: "2026-11-03" }), ctx())).toBe(false);
  });

  it("an area shows the tasks of its projects", () => {
    const area = project();
    const inner = project({ parent_id: area.id });
    const projects = { [area.id]: area, [inner.id]: inner };
    expect(
      inView({ kind: "project", id: area.id }, task({ project_id: inner.id }), ctx(projects)),
    ).toBe(true);
    expect(
      inView({ kind: "project", id: inner.id }, task({ project_id: area.id }), ctx(projects)),
    ).toBe(false);
  });
});

describe("compareTasks", () => {
  it("orders today, overdue, priority, due date, then rank", () => {
    const picked = task({ today_on: TODAY, priority: "low", rank: "a9" });
    const overdue = task({ due_date: "2026-10-01", priority: "low", rank: "a8" });
    const urgent = task({ priority: "urgent", rank: "a7" });
    const dueSoon = task({ due_date: "2026-11-10", rank: "a6" });
    const dueLater = task({ due_date: "2026-12-10", rank: "a5" });
    const rankFirst = task({ rank: "a1" });
    const rankSecond = task({ rank: "a2" });
    const shuffled = [rankSecond, dueLater, urgent, rankFirst, overdue, dueSoon, picked];
    shuffled.sort((a, b) => compareTasks(a, b, ctx()));
    expect(shuffled).toEqual([picked, overdue, urgent, dueSoon, dueLater, rankFirst, rankSecond]);
  });
});

describe("buildRows", () => {
  it("groups by status in workflow order and nests visible subtasks", () => {
    const parent = task({ title: "Parent", status_id: STATUS.inProgress });
    const childDone = task({ parent_id: parent.id, status_id: STATUS.done, rank: "a1" });
    const childOpen = task({ parent_id: parent.id, rank: "a2" });
    const grandchild = task({ parent_id: childOpen.id });
    const loose = task({ title: "Loose" });
    const rows = buildRows(
      [loose, childOpen, parent, grandchild, childDone],
      { kind: "all" },
      ctx(),
      statuses,
      noCollapse,
    );
    expect(
      rows.map((r) => (r.type === "group" ? `# ${r.status.name}` : `${r.depth}:${r.task.id}`)),
    ).toEqual([
      "# To do",
      `0:${loose.id}`,
      "# In progress",
      `0:${parent.id}`,
      `1:${childDone.id}`,
      `1:${childOpen.id}`,
    ]);
    const parentRow = rows[3];
    expect(parentRow).toMatchObject({ childCount: 2, childDone: 1, visibleChildren: 2 });
  });

  it("promotes a subtask whose parent is outside the view", () => {
    const parent = task({ project_id: "p" });
    const child = task({ parent_id: parent.id, project_id: null });
    const rows = buildRows([parent, child], { kind: "inbox" }, ctx(), statuses, noCollapse);
    expect(
      rows.filter((r) => r.type === "task").map((r) => r.type === "task" && r.task.id),
    ).toEqual([child.id]);
  });

  it("hides cancelled unless asked and honours collapsed groups and tasks", () => {
    const cancelled = task({ status_id: STATUS.cancelled });
    const parent = task();
    const child = task({ parent_id: parent.id });
    const all = [cancelled, parent, child];
    expect(buildRows(all, { kind: "all" }, ctx(), statuses, noCollapse)).toHaveLength(3);
    expect(
      buildRows(all, { kind: "all" }, ctx(), statuses, { ...noCollapse, showCancelled: true }),
    ).toHaveLength(5);
    expect(
      buildRows(all, { kind: "all" }, ctx(), statuses, {
        ...noCollapse,
        collapsedTasks: new Set([parent.id]),
      }),
    ).toHaveLength(2);
    const collapsed = buildRows(all, { kind: "all" }, ctx(), statuses, {
      ...noCollapse,
      collapsedGroups: new Set([STATUS.todo]),
    });
    expect(collapsed).toEqual([
      expect.objectContaining({ type: "group", count: 1, collapsed: true }),
    ]);
  });
});

describe("descendantIds", () => {
  it("walks every level", () => {
    const a = task();
    const b = task({ parent_id: a.id });
    const c = task({ parent_id: b.id });
    expect(descendantIds(a.id, childrenByParent([a, b, c])).sort()).toEqual([b.id, c.id].sort());
  });
});

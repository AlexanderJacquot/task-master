import { describe, expect, it } from "vitest";
import { project, STATUS, statuses, task } from "../test/fixtures";
import type { ViewScope } from "./types";
import {
  buildRows,
  childrenByParent,
  compareTasks,
  descendantIds,
  EMPTY_FILTER,
  FILTER_NONE,
  inView,
  matchesFilter,
  type ViewContext,
  type ViewQuery,
} from "./views";

function q(scope: ViewScope, extra: Partial<ViewQuery> = {}): ViewQuery {
  return {
    scope,
    filter: EMPTY_FILTER,
    group_by: "status",
    sort: "default",
    show_cancelled: false,
    show_agent_tasks: false,
    ...extra,
  };
}

const label = (r: ReturnType<typeof buildRows>[number]) =>
  r.type === "group" ? `# ${r.group.label}` : r.task.title;

const TODAY = "2026-11-04";

function ctx(projects = {}): ViewContext {
  return {
    today: TODAY,
    statuses: Object.fromEntries(statuses.map((s) => [s.id, s])),
    projects,
  };
}

const noCollapse = {
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
      q({ kind: "all" }),
      ctx(),
      statuses,
      noCollapse,
    );
    expect(
      rows.map((r) => (r.type === "group" ? `# ${r.group.label}` : `${r.depth}:${r.task.id}`)),
    ).toEqual([
      "# To do",
      `0:${loose.id}`,
      "# In progress",
      `0:${parent.id}`,
      `1:${childDone.id}`,
      `1:${childOpen.id}`,
    ]);
    const parentRow = rows[3];
    expect(parentRow).toMatchObject({
      childCount: 2,
      childDone: 1,
      visibleChildren: 2,
      expanded: true,
    });
    // The grandchild is folded under its parent, which shows a chevron for it.
    expect(rows[5]).toMatchObject({ visibleChildren: 1, expanded: false });
  });

  describe("subtasks all the way down", () => {
    const root = task({ title: "Root" });
    const child = task({ title: "Child", parent_id: root.id });
    const grandchild = task({ title: "Grandchild", parent_id: child.id });
    const great = task({ title: "Great", parent_id: grandchild.id });
    const all = [great, grandchild, child, root];
    const depths = (rows: ReturnType<typeof buildRows>) =>
      rows.flatMap((r) => (r.type === "task" ? [`${r.depth}:${r.task.title}`] : []));

    it("unrolls every level with show_subtasks", () => {
      const rows = buildRows(
        all,
        q({ kind: "all" }, { show_subtasks: true }),
        ctx(),
        statuses,
        noCollapse,
      );
      expect(depths(rows)).toEqual(["0:Root", "1:Child", "2:Grandchild", "3:Great"]);
      expect(rows.at(-1)).toMatchObject({ visibleChildren: 0 });
    });

    it("unrolls a deeper row by hand, and folds one by hand under show_subtasks", () => {
      const byHand = buildRows(all, q({ kind: "all" }), ctx(), statuses, {
        ...noCollapse,
        expandedTasks: new Set([child.id]),
      });
      expect(depths(byHand)).toEqual(["0:Root", "1:Child", "2:Grandchild"]);

      const deep = q({ kind: "all" }, { show_subtasks: true });
      const folded = buildRows(all, deep, ctx(), statuses, {
        ...noCollapse,
        collapsedTasks: new Set([grandchild.id]),
      });
      expect(depths(folded)).toEqual(["0:Root", "1:Child", "2:Grandchild"]);
    });

    it("skips a filtered-out level: its subtasks come up to the top", () => {
      const hidden = buildRows(
        [great, { ...grandchild, status_id: STATUS.cancelled }, child, root],
        q({ kind: "all" }, { show_subtasks: true }),
        ctx(),
        statuses,
        noCollapse,
      );
      expect(depths(hidden)).toEqual(["0:Root", "1:Child", "0:Great"]);
    });
  });

  it("promotes a subtask whose parent is outside the view", () => {
    const parent = task({ project_id: "p" });
    const child = task({ parent_id: parent.id, project_id: null });
    const rows = buildRows([parent, child], q({ kind: "inbox" }), ctx(), statuses, noCollapse);
    expect(
      rows.filter((r) => r.type === "task").map((r) => r.type === "task" && r.task.id),
    ).toEqual([child.id]);
  });

  it("hides cancelled unless asked and honours collapsed groups and tasks", () => {
    const cancelled = task({ status_id: STATUS.cancelled });
    const parent = task();
    const child = task({ parent_id: parent.id });
    const all = [cancelled, parent, child];
    expect(buildRows(all, q({ kind: "all" }), ctx(), statuses, noCollapse)).toHaveLength(3);
    expect(
      buildRows(all, q({ kind: "all" }, { show_cancelled: true }), ctx(), statuses, noCollapse),
    ).toHaveLength(5);
    expect(
      buildRows(all, q({ kind: "all" }), ctx(), statuses, {
        ...noCollapse,
        collapsedTasks: new Set([parent.id]),
      }),
    ).toHaveLength(2);
    const collapsed = buildRows(all, q({ kind: "all" }), ctx(), statuses, {
      ...noCollapse,
      collapsedGroups: new Set([STATUS.todo]),
    });
    expect(collapsed).toEqual([
      expect.objectContaining({ type: "group", count: 1, collapsed: true }),
    ]);
  });
});

describe("agent tasks (ADR 017)", () => {
  it("stay out of the user's views unless shown, but count under their parent", () => {
    const mine = task({ title: "Mine" });
    const step = task({ title: "Agent step", parent_id: mine.id, owner: "agent" });
    const loose = task({ title: "Agent note", owner: "agent" });
    expect(inView({ kind: "inbox" }, loose, ctx())).toBe(false);
    expect(inView({ kind: "inbox" }, loose, ctx(), { showAgentTasks: true })).toBe(true);

    const hidden = buildRows([mine, step, loose], q({ kind: "all" }), ctx(), statuses, noCollapse);
    expect(hidden.map(label)).toEqual(["# To do", "Mine"]);
    expect(hidden[1]).toMatchObject({ childCount: 1, visibleChildren: 0 });

    const shown = buildRows(
      [mine, step, loose],
      q({ kind: "all" }, { show_agent_tasks: true }),
      ctx(),
      statuses,
      noCollapse,
    );
    expect(shown.map(label)).toEqual(["# To do", "Mine", "Agent step", "Agent note"]);
  });
});

describe("filters, grouping and sorting", () => {
  it("scopes a tag view to tagged tasks", () => {
    expect(inView({ kind: "tag", id: "g1" }, task({ tag_ids: ["g1"] }), ctx())).toBe(true);
    expect(inView({ kind: "tag", id: "g1" }, task({ tag_ids: ["g2"] }), ctx())).toBe(false);
  });

  it("matches every non-empty filter list, any value within one", () => {
    const t = task({ priority: "high", tag_ids: ["g1"], project_id: "p1", due_date: TODAY });
    const f = (patch: Partial<typeof EMPTY_FILTER>) =>
      matchesFilter({ ...EMPTY_FILTER, ...patch }, t, ctx());
    expect(f({})).toBe(true);
    expect(f({ priorities: ["urgent", "high"] })).toBe(true);
    expect(f({ priorities: ["low"] })).toBe(false);
    expect(f({ tag_ids: ["g2", "g1"], project_ids: ["p1"] })).toBe(true);
    expect(f({ tag_ids: ["g1"], project_ids: ["p2"] })).toBe(false);
    expect(f({ epic_ids: ["e1"] })).toBe(false);
    expect(f({ epic_ids: ["e1", FILTER_NONE] })).toBe(true);
    expect(f({ tag_ids: [FILTER_NONE] })).toBe(false);
    expect(f({ tag_ids: [FILTER_NONE, "g1"] })).toBe(true);
    expect(f({ status_ids: [STATUS.todo] })).toBe(true);
    expect(f({ due: "today" })).toBe(true);
    expect(f({ due: "overdue" })).toBe(false);
    expect(f({ due: "none" })).toBe(false);
    expect(
      matchesFilter({ ...EMPTY_FILTER, due: "week" }, task({ due_date: "2026-11-11" }), ctx()),
    ).toBe(true);
    expect(
      matchesFilter({ ...EMPTY_FILTER, due: "week" }, task({ due_date: "2026-11-12" }), ctx()),
    ).toBe(false);
  });

  it("matches tasks without an epic or tags with the none value", () => {
    const loose = task({});
    const filed = task({ epic_id: "e1", tag_ids: ["g1"] });
    const none = { ...EMPTY_FILTER, epic_ids: [FILTER_NONE], tag_ids: [FILTER_NONE] };
    expect(matchesFilter(none, loose, ctx())).toBe(true);
    expect(matchesFilter(none, filed, ctx())).toBe(false);
    expect(matchesFilter({ ...EMPTY_FILTER, epic_ids: [FILTER_NONE] }, filed, ctx())).toBe(false);
    expect(matchesFilter({ ...EMPTY_FILTER, tag_ids: [FILTER_NONE] }, loose, ctx())).toBe(true);
  });

  it("groups by project with the project-less group last", () => {
    const home = project({ name: "Home", rank: "a2" });
    const work = project({ name: "Work", rank: "a1" });
    const tasks = [
      task({ title: "Loose" }),
      task({ title: "Fix roof", project_id: home.id }),
      task({ title: "Report", project_id: work.id }),
    ];
    const c = ctx({ [home.id]: home, [work.id]: work });
    const rows = buildRows(
      tasks,
      q({ kind: "all" }, { group_by: "project" }),
      c,
      statuses,
      noCollapse,
    );
    expect(rows.map(label)).toEqual([
      "# Work",
      "Report",
      "# Home",
      "Fix roof",
      "# No project",
      "Loose",
    ]);
  });

  it("groups by due date buckets and by priority", () => {
    const tasks = [
      task({ title: "Late", due_date: "2026-11-01" }),
      task({ title: "Now", due_date: TODAY }),
      task({ title: "Soon", due_date: "2026-11-08" }),
      task({ title: "Far", due_date: "2027-01-01" }),
      task({ title: "Whenever", priority: "low" }),
    ];
    const due = buildRows(
      tasks,
      q({ kind: "all" }, { group_by: "due" }),
      ctx(),
      statuses,
      noCollapse,
    );
    expect(due.filter((r) => r.type === "group").map(label)).toEqual([
      "# Overdue",
      "# Today",
      "# Next 7 days",
      "# Later",
      "# No due date",
    ]);
    const byPriority = buildRows(
      tasks,
      q({ kind: "all" }, { group_by: "priority" }),
      ctx(),
      statuses,
      noCollapse,
    );
    expect(byPriority.filter((r) => r.type === "group").map(label)).toEqual(["# Normal", "# Low"]);
  });

  it("sorts by the spec within a group", () => {
    const old = task({ title: "Old", created_at: 1, rank: "a2" });
    const recent = task({ title: "Recent", created_at: 5, rank: "a1", priority: "low" });
    const rows = (sort: ViewQuery["sort"]) =>
      buildRows([old, recent], q({ kind: "all" }, { sort }), ctx(), statuses, noCollapse)
        .filter((r) => r.type === "task")
        .map(label);
    expect(rows("created")).toEqual(["Recent", "Old"]);
    expect(rows("manual")).toEqual(["Recent", "Old"]);
    expect(rows("default")).toEqual(["Old", "Recent"]);
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

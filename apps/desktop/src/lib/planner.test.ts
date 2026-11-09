import { describe, expect, it } from "vitest";
import { STATUS, statuses, task, timeBlock } from "../test/fixtures";
import { atMinute } from "./calendar";
import {
  DEFAULT_FOCUS,
  DEFAULT_HOURS,
  freeMinutes,
  freeSlots,
  type PlanInput,
  planCandidates,
  seededRandom,
  suggestPlan,
} from "./planner";
import type { Task } from "./types";

// Monday 2026-11-09 to Sunday 2026-11-15; "now" is the Sunday before, so no day is past.
const MON = "2026-11-09";
const WEEK = [
  "2026-11-09",
  "2026-11-10",
  "2026-11-11",
  "2026-11-12",
  "2026-11-13",
  "2026-11-14",
  "2026-11-15",
];
const NOW = atMinute("2026-11-08", 12 * 60);
const statusMap = Object.fromEntries(statuses.map((s) => [s.id, s]));

function input(tasks: Task[], extra: Partial<PlanInput> = {}): PlanInput {
  return {
    days: [MON],
    now: NOW,
    hours: DEFAULT_HOURS,
    focus: DEFAULT_FOCUS,
    tasks,
    statuses: statusMap,
    blocks: [],
    events: [],
    random: seededRandom(1),
    ...extra,
  };
}

const minutes = (b: { start_at: number; end_at: number }) => (b.end_at - b.start_at) / 60_000;

describe("free slots", () => {
  it("is working hours minus blocks and events, from now on", () => {
    const busy = timeBlock({ start_at: atMinute(MON, 10 * 60), end_at: atMinute(MON, 11 * 60) });
    const event = {
      id: "e",
      start_at: atMinute(MON, 13 * 60 + 10),
      end_at: atMinute(MON, 14 * 60),
    };
    const slots = freeSlots(input([], { blocks: [busy], events: [event] }));
    expect(slots.map((s) => [s.start, s.end])).toEqual([
      [atMinute(MON, 9 * 60), atMinute(MON, 10 * 60)],
      // Snapped to quarter hours around the event.
      [atMinute(MON, 11 * 60), atMinute(MON, 13 * 60)],
      [atMinute(MON, 14 * 60), atMinute(MON, 17 * 60)],
    ]);
    // A cancelled block is free time again.
    const cancelled = { ...busy, outcome: "cancelled" as const };
    expect(freeMinutes(freeSlots(input([], { blocks: [cancelled] })))).toBe(8 * 60);
  });

  it("starts at the next quarter hour today and skips past days", () => {
    const now = atMinute(MON, 15 * 60 + 5);
    expect(freeSlots(input([], { now })).map((s) => [s.start, s.end])).toEqual([
      [atMinute(MON, 15 * 60 + 15), atMinute(MON, 17 * 60)],
    ]);
    expect(freeSlots(input([], { now: atMinute(MON, 18 * 60) }))).toEqual([]);
  });

  it("leaves weekends out of a week unless asked", () => {
    expect(freeMinutes(freeSlots(input([], { days: WEEK })))).toBe(5 * 8 * 60);
    const hours = { ...DEFAULT_HOURS, weekends: true };
    expect(freeMinutes(freeSlots(input([], { days: WEEK, hours })))).toBe(7 * 8 * 60);
    // A single shown Saturday is planned anyway.
    expect(freeMinutes(freeSlots(input([], { days: ["2026-11-14"] })))).toBe(8 * 60);
  });
});

describe("candidates", () => {
  it("takes open tasks of the focus, not yet scheduled, without open subtasks", () => {
    const a = task({ title: "A", project_id: "p1", epic_id: "e1" });
    const b = task({ title: "B", project_id: "p2" });
    const inbox = task({ title: "Inbox" });
    const done = task({ title: "Done", project_id: "p1", status_id: STATUS.done });
    const agent = task({ title: "Agent", project_id: "p1", owner: "agent" });
    const scheduled = task({ title: "Scheduled", project_id: "p1" });
    const parent = task({ title: "Parent", project_id: "p1" });
    const child = task({ title: "Child", project_id: "p1", parent_id: parent.id });
    const all = [a, b, inbox, done, agent, scheduled, parent, child];
    const blocks = [
      timeBlock({
        task_id: scheduled.id,
        start_at: atMinute(MON, 9 * 60),
        end_at: atMinute(MON, 10 * 60),
      }),
    ];
    const titles = (focus = DEFAULT_FOCUS) =>
      planCandidates({ tasks: all, statuses: statusMap, blocks, focus, now: NOW })
        .map((t) => t.title)
        .sort();
    expect(titles()).toEqual(["A", "B", "Child", "Inbox"]);
    expect(titles({ ...DEFAULT_FOCUS, projectId: "p1" })).toEqual(["A", "Child"]);
    expect(titles({ ...DEFAULT_FOCUS, projectId: "inbox" })).toEqual(["Inbox"]);
    expect(titles({ ...DEFAULT_FOCUS, epicId: "e1" })).toEqual(["A"]);
    expect(titles({ ...DEFAULT_FOCUS, statusId: STATUS.inProgress })).toEqual([]);
  });
});

describe("suggestPlan", () => {
  it("fills free time without overlaps, using estimates", () => {
    const tasks = [
      task({ title: "Short", estimate_min: 30 }),
      task({ title: "Default" }),
      task({ title: "Long", estimate_min: 120 }),
    ];
    const busy = timeBlock({ start_at: atMinute(MON, 10 * 60), end_at: atMinute(MON, 11 * 60) });
    const plan = suggestPlan(input(tasks, { blocks: [busy] }));
    expect(plan.unplaced).toEqual([]);
    expect(plan.blocks.map(minutes).sort((x, y) => x - y)).toEqual([30, 60, 120]);
    const spans = [...plan.blocks, busy].sort((x, y) => x.start_at - y.start_at);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]?.start_at).toBeGreaterThanOrEqual(spans[i - 1]?.end_at ?? Infinity);
    }
    for (const b of plan.blocks) {
      expect(b.start_at).toBeGreaterThanOrEqual(atMinute(MON, 9 * 60));
      expect(b.end_at).toBeLessThanOrEqual(atMinute(MON, 17 * 60));
    }
  });

  it("spreads a light week over its days", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task({ title: `T${i}` }));
    const plan = suggestPlan(input(tasks, { days: WEEK }));
    const perDay = new Map<number, number>();
    for (const b of plan.blocks) {
      const day = new Date(b.start_at).getDate();
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    // 10 hours over 5 weekdays: 2 each, none on the weekend.
    expect([...perDay.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [9, 2],
      [10, 2],
      [11, 2],
      [12, 2],
      [13, 2],
    ]);
  });

  it("reports tasks that did not fit", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task({ title: `T${i}` }));
    const plan = suggestPlan(input(tasks));
    expect(plan.blocks).toHaveLength(8);
    expect(plan.unplaced).toHaveLength(2);
  });

  it("splits a long task over free slots when no slot holds it", () => {
    const big = task({ title: "Big", estimate_min: 180 });
    const busy = timeBlock({ start_at: atMinute(MON, 11 * 60), end_at: atMinute(MON, 15 * 60) });
    const plan = suggestPlan(input([big], { blocks: [busy] }));
    expect(plan.blocks.map(minutes)).toEqual([120, 60]);
    expect(plan.blocks.every((b) => b.task_id === big.id)).toBe(true);
  });

  it("puts prerequisites first", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const first = task({ title: "First", priority: "low" });
      const then = task({ title: "Then", priority: "urgent", dependency_ids: [first.id] });
      const plan = suggestPlan(input([then, first], { random: seededRandom(seed) }));
      const at = (id: string) => plan.blocks.find((b) => b.task_id === id)?.start_at ?? Infinity;
      expect(at(first.id)).toBeLessThan(at(then.id));
    }
  });

  it("keeps a task due in the week on or before its due date", () => {
    const filler = Array.from({ length: 8 }, (_, i) =>
      task({ title: `F${i}`, priority: "urgent" }),
    );
    const due = task({ title: "Due Tue", priority: "low", due_date: "2026-11-10" });
    for (let seed = 1; seed <= 10; seed++) {
      const plan = suggestPlan(input([...filler, due], { days: WEEK, random: seededRandom(seed) }));
      const block = plan.blocks.find((b) => b.task_id === due.id);
      expect(block?.end_at).toBeLessThanOrEqual(atMinute("2026-11-11", 0));
    }
  });

  it("favours urgent and due work, and varies with the random source", () => {
    const urgent = task({ title: "Urgent", priority: "urgent", due_date: MON });
    const others = Array.from({ length: 6 }, (_, i) => task({ title: `Low${i}`, priority: "low" }));
    let first = 0;
    const orders = new Set<string>();
    for (let seed = 1; seed <= 50; seed++) {
      const plan = suggestPlan(input([...others, urgent], { random: seededRandom(seed) }));
      if (plan.blocks[0]?.task_id === urgent.id) first++;
      orders.add(plan.blocks.map((b) => b.task_id).join());
    }
    expect(first).toBeGreaterThan(35);
    expect(orders.size).toBeGreaterThan(5);
  });
});

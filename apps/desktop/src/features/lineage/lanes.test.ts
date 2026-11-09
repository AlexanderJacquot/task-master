import { expect, it } from "vitest";
import { FILTER_NONE } from "../../lib/views";
import { task } from "../../test/fixtures";
import { NODE_HEIGHT, NODE_WIDTH, ROW_GAP } from "./graph";
import { avoidPinned, LANE_COLLAPSED, LANE_GAP, LANE_HEADER, laneAt, layoutLanes } from "./lanes";

const specs = [
  { key: "e1", label: "Alpha", color: "#f00" },
  { key: "e2", label: "Beta", color: null },
  { key: FILTER_NONE, label: "No epic", color: null },
];

it("stacks one lane per epic, places new cards in their column, and keeps saved ones", () => {
  const a = task({ epic_id: "e1" });
  const b = task({ epic_id: "e1" });
  const c = task();
  const nodes = [
    { task: a, x: 40 },
    { task: b, x: 40 },
    { task: c, x: 400 },
  ];
  const { lanes, world, relative } = layoutLanes(nodes, "epic", specs, {}, new Set());
  expect(lanes.map((lane) => [lane.key, lane.count])).toEqual([
    ["e1", 2],
    ["e2", 0],
    [FILTER_NONE, 1],
  ]);
  // Two cards in one column stack; the empty lane still has room for a card.
  expect(relative[a.id]).toEqual({ x: 40, y: LANE_HEADER });
  expect(relative[b.id]).toEqual({ x: 40, y: LANE_HEADER + NODE_HEIGHT + ROW_GAP });
  const [alpha, beta, none] = lanes;
  expect(beta?.top).toBe((alpha?.top ?? 0) + (alpha?.height ?? 0) + LANE_GAP);
  expect(beta?.height).toBeGreaterThanOrEqual(LANE_HEADER + NODE_HEIGHT);
  expect(world[c.id]).toEqual({ x: 400, y: (none?.top ?? 0) + LANE_HEADER });

  // A saved position wins, and a new card avoids it.
  const kept = layoutLanes(nodes, "epic", specs, { [a.id]: { x: 40, y: 300 } }, new Set());
  expect(kept.relative[a.id]).toEqual({ x: 40, y: 300 });
  expect(kept.relative[b.id]).toEqual({ x: 40, y: LANE_HEADER });
});

it("collapses lanes, adds lanes for unknown keys, and finds the lane under a point", () => {
  const a = task({ epic_id: "gone" });
  const b = task({ epic_id: "e1" });
  const { lanes } = layoutLanes(
    [
      { task: a, x: 40 },
      { task: b, x: 40 },
    ],
    "epic",
    specs,
    {},
    new Set(["e1"]),
  );
  expect(lanes.at(-1)).toMatchObject({ key: "gone", label: "Unknown epic", count: 1 });
  expect(lanes[0]?.height).toBe(LANE_COLLAPSED);
  const second = lanes[1];
  expect(laneAt(lanes, (second?.top ?? 0) + 5)?.key).toBe("e2");
  expect(laneAt(lanes, -500)?.key).toBe("e1");
  expect(laneAt(lanes, 1e6)?.key).toBe("gone");
});

it("moves arranged cards off pinned ones", () => {
  const moved = avoidPinned(
    { a: { x: 0, y: 0 }, b: { x: 600, y: 0 } },
    { pin: { x: NODE_WIDTH / 2, y: 10 } },
  );
  expect(moved.a?.y).toBeGreaterThanOrEqual(10 + NODE_HEIGHT);
  expect(moved.b).toEqual({ x: 600, y: 0 });
});

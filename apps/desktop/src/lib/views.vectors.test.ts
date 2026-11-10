// The Rust core evaluates views too (crates/core/src/views.rs, ADR 022). Both sides pass
// the same vectors; this side writes the expected rows:
//   VITE_UPDATE_VECTORS=1 pnpm vitest run src/lib/views.vectors.test.ts
//   pnpm biome format --write crates/core/test-vectors/views.json   (from the repo root)
import { describe, expect, it } from "vitest";
import raw from "../../../../crates/core/test-vectors/views.json";
import { type Board, buildBoard } from "./board";
import type { Epic, Project, Status, Task, ViewSpec } from "./types";
import { buildRows, type Row, type ViewContext } from "./views";

interface Vectors {
  options: { today: string };
  snapshot: { tasks: Task[]; projects: Project[]; epics: Epic[]; statuses: Status[] };
  list_cases: Array<{
    name: string;
    spec: ViewSpec;
    collapsed_groups: string[];
    collapsed_tasks: string[];
    expected: string[];
  }>;
  board_cases: Array<{ name: string; spec: ViewSpec; expected: string[] }>;
}

const vectors = raw as unknown as Vectors;
const { tasks, statuses } = vectors.snapshot;
const byId = <T extends { id: string }>(list: T[]) =>
  Object.fromEntries(list.map((item) => [item.id, item]));
const projects = byId(vectors.snapshot.projects);
const epics = byId(vectors.snapshot.epics);
const ctx: ViewContext = {
  today: vectors.options.today,
  statuses: byId(statuses),
  projects,
  epics,
};

function encodeRows(rows: Row[]): string[] {
  return rows.map((row) =>
    row.type === "group"
      ? `g|${row.group.key}|${row.group.label}|${row.group.color ?? "-"}|${row.count}|${row.collapsed ? 1 : 0}`
      : `t|${row.task.id}|${row.depth}|${row.childCount}|${row.childDone}|${row.visibleChildren}`,
  );
}

function encodeBoard(board: Board): string[] {
  const out = board.columns.map((c) => `c|${c.status.id}|${c.count}|${c.overLimit ? 1 : 0}`);
  for (const lane of board.lanes) {
    out.push(`l|${lane.key}|${lane.label}|${lane.color ?? "-"}|${JSON.stringify(lane.changes)}`);
    for (const column of board.columns) {
      const cell = lane.cells[column.status.id];
      if (!cell?.length) continue;
      const cards = cell.map((c) => `${c.task.id}:${c.childCount}:${c.childDone}`);
      out.push(`s|${column.status.id}|${cards.join(",")}`);
    }
  }
  return out;
}

const listRows = (c: Vectors["list_cases"][number]) =>
  encodeRows(
    buildRows(tasks, c.spec, ctx, statuses, {
      collapsedGroups: new Set(c.collapsed_groups),
      collapsedTasks: new Set(c.collapsed_tasks),
    }),
  );
const boardRows = (c: Vectors["board_cases"][number]) =>
  encodeBoard(buildBoard(tasks, c.spec, ctx, statuses, { projects, epics }));

if (import.meta.env.VITE_UPDATE_VECTORS) {
  for (const c of vectors.list_cases) c.expected = listRows(c);
  for (const c of vectors.board_cases) c.expected = boardRows(c);
  // `src` is typed for the browser, so node's fs is loaded untyped.
  const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as {
    writeFileSync(path: URL, data: string): void;
  };
  fs.writeFileSync(
    new URL("../../../../crates/core/test-vectors/views.json", import.meta.url),
    `${JSON.stringify(vectors, null, 2)}\n`,
  );
}

describe("list rows match the Rust core", () => {
  for (const c of vectors.list_cases) {
    it(c.name, () => {
      expect(c.expected.length + (c.name === "nothing matches" ? 1 : 0)).toBeGreaterThan(0);
      expect(listRows(c)).toEqual(c.expected);
    });
  }
});

describe("boards match the Rust core", () => {
  for (const c of vectors.board_cases) {
    it(c.name, () => {
      expect(c.expected.length).toBeGreaterThan(0);
      expect(boardRows(c)).toEqual(c.expected);
    });
  }
});

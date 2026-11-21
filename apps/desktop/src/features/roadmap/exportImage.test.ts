import { describe, expect, it } from "vitest";
import {
  currentImageTheme,
  imageFileName,
  imageLinks,
  imageRows,
  pngScale,
  withExtension,
} from "./exportImage";
import type { Item, Row } from "./timeline";

function item(id: string, bar: Item["bar"], extra: Partial<Item> = {}): Item {
  return {
    id,
    title: id.toUpperCase(),
    rank: id,
    bar,
    length: 1,
    done: false,
    progress: null,
    color: null,
    group: "",
    parent: null,
    after: [],
    span: null,
    ...extra,
  };
}

describe("imageRows", () => {
  it("keeps only bars, and groups that hold one", () => {
    const rows: Row[] = [
      {
        kind: "group",
        key: "p",
        label: "Shop",
        color: "#123456",
        count: 1,
        collapsed: false,
        span: { start: "2026-12-01", end: "2026-12-05" },
      },
      { kind: "item", depth: 0, item: item("a", { start: "2026-12-01", end: "2026-12-05" }) },
      { kind: "item", depth: 1, item: item("b", null) },
      {
        kind: "group",
        key: "q",
        label: "Empty",
        color: null,
        count: 0,
        collapsed: false,
        span: null,
      },
      {
        kind: "item",
        depth: 0,
        item: item("c", { start: "2026-12-08", end: "2026-12-09" }, { done: true, progress: 1 }),
      },
    ];
    expect(imageRows(rows)).toEqual([
      {
        kind: "group",
        label: "Shop",
        color: "#123456",
        count: 1,
        start: "2026-12-01",
        end: "2026-12-05",
      },
      {
        kind: "item",
        id: "a",
        title: "A",
        depth: 0,
        start: "2026-12-01",
        end: "2026-12-05",
        done: false,
        progress: null,
        color: null,
      },
      {
        kind: "item",
        id: "c",
        title: "C",
        depth: 0,
        start: "2026-12-08",
        end: "2026-12-09",
        done: true,
        progress: 1,
        color: null,
      },
    ]);
  });

  it("keeps the arrows between rows that are drawn", () => {
    const rows = imageRows([
      { kind: "item", depth: 0, item: item("a", { start: "2026-12-01", end: "2026-12-02" }) },
      { kind: "item", depth: 0, item: item("b", { start: "2026-12-03", end: "2026-12-04" }) },
    ]);
    expect(
      imageLinks(
        [
          { from: "a", to: "b", late: false },
          { from: "a", to: "folded", late: true },
        ],
        rows,
      ),
    ).toEqual([{ from: "a", to: "b" }]);
  });
});

describe("files", () => {
  it("names the file after the title and the day", () => {
    expect(imageFileName("Q4 Roadmap: Café & more", "2026-11-21", "png")).toBe(
      "q4-roadmap-cafe-more-2026-11-21.png",
    );
    expect(imageFileName("🚀", "2026-11-21", "svg")).toBe("roadmap-2026-11-21.svg");
  });

  it("adds the extension when the dialog did not", () => {
    expect(withExtension("/tmp/plan", "png")).toBe("/tmp/plan.png");
    expect(withExtension("/tmp/plan.PNG", "png")).toBe("/tmp/plan.PNG");
    expect(withExtension("/tmp/plan.png", "svg")).toBe("/tmp/plan.png.svg");
  });

  it("draws the PNG at twice the size unless the canvas would be too large", () => {
    expect(pngScale(1200, 400)).toBe(2);
    expect(pngScale(12_000, 400)).toBeCloseTo(16_384 / 12_000);
    expect(pngScale(6000, 6000)).toBeCloseTo(Math.sqrt(64_000_000 / 36_000_000));
  });

  it("takes the app's theme", () => {
    const root = (classes: string[]) =>
      ({ classList: { contains: (c: string) => classes.includes(c) } }) as unknown as HTMLElement;
    expect(currentImageTheme(root(["dark"]))).toBe("dark");
    expect(currentImageTheme(root(["clean"]))).toBe("clean");
    expect(currentImageTheme(root([]))).toBe("light");
  });
});

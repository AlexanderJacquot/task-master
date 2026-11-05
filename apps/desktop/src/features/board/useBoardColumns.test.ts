// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  clampWidth,
  lanesFor,
  loadColumnPrefs,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
} from "./useBoardColumns";

afterEach(() => localStorage.clear());

describe("board column prefs", () => {
  it("lays cards side by side as a column widens", () => {
    expect(lanesFor(280)).toBe(1);
    expect(lanesFor(511)).toBe(1);
    expect(lanesFor(512)).toBe(2);
    expect(lanesFor(768)).toBe(3);
    expect(lanesFor(MAX_COLUMN_WIDTH)).toBe(3);
  });

  it("clamps widths", () => {
    expect(clampWidth(10)).toBe(MIN_COLUMN_WIDTH);
    expect(clampWidth(5000)).toBe(MAX_COLUMN_WIDTH);
    expect(clampWidth(400.6)).toBe(401);
  });

  it("loads what is valid and drops the rest", () => {
    localStorage.setItem(
      "task-master.board.columns",
      JSON.stringify({ a: { collapsed: true, width: 9999 }, b: { width: "wide" }, c: 3 }),
    );
    expect(loadColumnPrefs()).toEqual({ a: { collapsed: true, width: MAX_COLUMN_WIDTH }, b: {} });
    localStorage.setItem("task-master.board.columns", "{not json");
    expect(loadColumnPrefs()).toEqual({});
  });
});

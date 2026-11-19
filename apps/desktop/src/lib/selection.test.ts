import { describe, expect, it } from "vitest";
import {
  clickSelect,
  EMPTY_SELECTION,
  pruneSelection,
  type Selection,
  selectAll,
} from "./selection";

const order = ["a", "b", "c", "d", "e"];
const ids = (s: Selection) => [...s.ids].sort();
const ctrl = { toggle: true, range: false };
const shift = { toggle: false, range: true };

describe("clickSelect", () => {
  it("Ctrl+click adds and removes one task", () => {
    let s = clickSelect(EMPTY_SELECTION, "b", ctrl, order);
    s = clickSelect(s, "d", ctrl, order);
    expect(ids(s)).toEqual(["b", "d"]);
    expect(s.anchor).toBe("d");
    s = clickSelect(s, "b", ctrl, order);
    expect(ids(s)).toEqual(["d"]);
  });

  it("starts from the task open in the panel", () => {
    const s = clickSelect(EMPTY_SELECTION, "d", ctrl, order, "a");
    expect(ids(s)).toEqual(["a", "d"]);
    const r = clickSelect(EMPTY_SELECTION, "c", shift, order, "a");
    expect(ids(r)).toEqual(["a", "b", "c"]);
  });

  it("ignores an open task that is not in the view", () => {
    const s = clickSelect(EMPTY_SELECTION, "d", ctrl, order, "zz");
    expect(ids(s)).toEqual(["d"]);
  });

  it("Shift+click replaces the selection with the range from the anchor, either way", () => {
    let s = clickSelect(EMPTY_SELECTION, "c", ctrl, order);
    s = clickSelect(s, "e", shift, order);
    expect(ids(s)).toEqual(["c", "d", "e"]);
    s = clickSelect(s, "a", shift, order);
    expect(ids(s)).toEqual(["a", "b", "c"]);
    expect(s.anchor).toBe("c");
  });

  it("Ctrl+Shift+click adds the range to the selection", () => {
    let s = clickSelect(EMPTY_SELECTION, "a", ctrl, order);
    s = clickSelect(s, "a", ctrl, order); // off again: no anchor left
    s = clickSelect(s, "e", ctrl, order);
    s = clickSelect(s, "a", ctrl, order);
    s = clickSelect(s, "b", { toggle: true, range: true }, order);
    expect(ids(s)).toEqual(["a", "b", "e"]);
  });

  it("Shift+click without an anchor picks just that task", () => {
    const s = clickSelect(EMPTY_SELECTION, "c", shift, order);
    expect(ids(s)).toEqual(["c"]);
  });
});

describe("pruneSelection", () => {
  it("keeps the same object when every task is still shown", () => {
    const s = selectAll(order);
    expect(pruneSelection(s, new Set(order))).toBe(s);
  });

  it("drops tasks that left the view and an anchor among them", () => {
    const s = pruneSelection({ ids: new Set(["a", "c"]), anchor: "a" }, new Set(["b", "c"]));
    expect(ids(s)).toEqual(["c"]);
    expect(s.anchor).toBeNull();
  });
});

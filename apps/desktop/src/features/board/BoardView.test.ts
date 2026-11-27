import { describe, expect, it } from "vitest";
import { dragGroup, withoutOthers } from "./BoardView";

const cells = {
  "all|todo": ["a", "b", "c"],
  "all|doing": ["d", "e"],
};

describe("dragGroup", () => {
  it("takes every picked card along, in board order", () => {
    expect(dragGroup(cells, new Set(["e", "b", "d"]), "d")).toEqual(["b", "d", "e"]);
  });

  it("drags one card when it is not picked or picked alone", () => {
    expect(dragGroup(cells, new Set(["a", "b"]), "c")).toBeNull();
    expect(dragGroup(cells, new Set(["a"]), "a")).toBeNull();
    // Picked tasks that are not on the board do not count.
    expect(dragGroup(cells, new Set(["a", "zz"]), "a")).toBeNull();
  });
});

describe("withoutOthers", () => {
  it("takes the cards dragged along out of their cells, keeping the dragged one", () => {
    expect(withoutOthers(cells, ["b", "d", "e"], "d")).toEqual({
      "all|todo": ["a", "c"],
      "all|doing": ["d"],
    });
  });
});

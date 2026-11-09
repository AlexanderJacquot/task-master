// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { loadCollapsedLanes } from "./useCollapsedLanes";

afterEach(() => localStorage.clear());

describe("loadCollapsedLanes", () => {
  it("reads lanes opened or collapsed by hand", () => {
    localStorage.setItem("task-master.board.lanes", '{"epic:a":true,"priority:high":false}');
    expect([...loadCollapsedLanes()]).toEqual([
      ["epic:a", true],
      ["priority:high", false],
    ]);
  });
  it("reads the earlier list of collapsed lanes", () => {
    localStorage.setItem("task-master.board.lanes", '["epic:a",3,null]');
    expect([...loadCollapsedLanes()]).toEqual([["epic:a", true]]);
  });
  it("keeps only true or false choices", () => {
    localStorage.setItem("task-master.board.lanes", '{"epic:a":1,"epic:b":false}');
    expect([...loadCollapsedLanes()]).toEqual([["epic:b", false]]);
  });
  it("leaves every lane to its default when nothing or garbage is stored", () => {
    expect(loadCollapsedLanes().size).toBe(0);
    localStorage.setItem("task-master.board.lanes", "{not json");
    expect(loadCollapsedLanes().size).toBe(0);
    localStorage.setItem("task-master.board.lanes", "7");
    expect(loadCollapsedLanes().size).toBe(0);
  });
});

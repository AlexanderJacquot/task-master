// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { loadCollapsedLanes } from "./useCollapsedLanes";

afterEach(() => localStorage.clear());

describe("loadCollapsedLanes", () => {
  it("reads the stored lane keys", () => {
    localStorage.setItem("task-master.board.lanes", '["epic:a","priority:high"]');
    expect([...loadCollapsedLanes()]).toEqual(["epic:a", "priority:high"]);
  });
  it("keeps only strings", () => {
    localStorage.setItem("task-master.board.lanes", '["epic:a",3,null]');
    expect([...loadCollapsedLanes()]).toEqual(["epic:a"]);
  });
  it("opens every lane when nothing or garbage is stored", () => {
    expect(loadCollapsedLanes().size).toBe(0);
    localStorage.setItem("task-master.board.lanes", "{not json");
    expect(loadCollapsedLanes().size).toBe(0);
    localStorage.setItem("task-master.board.lanes", '{"epic:a":true}');
    expect(loadCollapsedLanes().size).toBe(0);
  });
});

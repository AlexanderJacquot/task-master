// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyWeathering, loadWeathering, saveWeathering } from "./weathering";

afterEach(() => {
  localStorage.clear();
  applyWeathering([]);
});

describe("weathering", () => {
  it("is off by default and remembers a choice", () => {
    expect(loadWeathering()).toEqual([]);
    saveWeathering(["coffee", "burnt"]);
    expect(loadWeathering()).toEqual(["burnt", "coffee"]);
    const root = document.documentElement;
    expect(root.classList.contains("wx-burnt")).toBe(true);
    expect(root.classList.contains("wx-coffee")).toBe(true);
    expect(root.classList.contains("wx-water")).toBe(false);
    saveWeathering(["water"]);
    expect(root.classList.contains("wx-burnt")).toBe(false);
    expect(root.classList.contains("wx-water")).toBe(true);
  });

  it("ignores unknown or malformed stored values", () => {
    localStorage.setItem("task-master.weathering", '["fold","lasers"]');
    expect(loadWeathering()).toEqual(["fold"]);
    localStorage.setItem("task-master.weathering", "{not json");
    expect(loadWeathering()).toEqual([]);
    localStorage.setItem("task-master.weathering", '"burnt"');
    expect(loadWeathering()).toEqual([]);
  });
});

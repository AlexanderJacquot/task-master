// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { followAppearance } from "./appearance";
import { applyTheme } from "./theme";
import { applyWeathering } from "./weathering";

afterEach(() => {
  localStorage.clear();
  applyTheme("light");
  applyWeathering([]);
});

describe("followAppearance", () => {
  it("applies the stored appearance and follows changes saved by another window", () => {
    const root = document.documentElement;
    localStorage.setItem("task-master.theme", "light");
    localStorage.setItem("task-master.weathering", '["burnt"]');
    const stop = followAppearance();
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.classList.contains("wx-burnt")).toBe(true);

    // The main window switches to the dark theme and drops the weathering.
    localStorage.setItem("task-master.theme", "dark");
    localStorage.setItem("task-master.weathering", "[]");
    window.dispatchEvent(new StorageEvent("storage", { key: "task-master.theme" }));
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.classList.contains("wx-burnt")).toBe(false);

    stop();
    localStorage.setItem("task-master.theme", "light");
    window.dispatchEvent(new StorageEvent("storage", { key: "task-master.theme" }));
    expect(root.classList.contains("dark")).toBe(true);
  });

  it("ignores storage keys that are not the app's", () => {
    const root = document.documentElement;
    localStorage.setItem("task-master.theme", "dark");
    const stop = followAppearance();
    localStorage.setItem("task-master.theme", "light");
    window.dispatchEvent(new StorageEvent("storage", { key: "something-else" }));
    expect(root.classList.contains("dark")).toBe(true);
    stop();
  });
});

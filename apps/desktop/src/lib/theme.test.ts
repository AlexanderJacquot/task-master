// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, loadMedieval, loadTheme, saveMedieval, saveTheme, useLook } from "./theme";

afterEach(() => localStorage.clear());

function fakeSystem(isDark: () => boolean) {
  const original = window.matchMedia;
  window.matchMedia = (() => ({
    get matches() {
      return isDark();
    },
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

describe("theme", () => {
  it("defaults to the clean light theme", () => {
    expect(loadTheme()).toBe("light");
    expect(loadMedieval()).toBe(false);
    const root = document.createElement("html");
    applyTheme(loadTheme(), root);
    expect(root.classList.contains("clean")).toBe(true);
    expect(root.classList.contains("dark")).toBe(false);
    expect(useLook.getState().look).toBe("clean");
  });

  it("remembers a choice; dark stays clean", () => {
    saveTheme("dark");
    expect(loadTheme()).toBe("dark");
    const root = document.documentElement;
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.classList.contains("clean")).toBe(true);
    saveTheme("light");
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.classList.contains("clean")).toBe(true);
  });

  it("follows the system preference", () => {
    let dark = true;
    const restore = fakeSystem(() => dark);
    const root = document.createElement("html");
    applyTheme("system", root);
    expect(root.classList.contains("dark")).toBe(true);
    dark = false;
    applyTheme("system", root);
    expect(root.classList.contains("dark")).toBe(false);
    restore();
  });

  it("turns the medieval look on and off over any mode", () => {
    const root = document.documentElement;
    saveTheme("dark");
    saveMedieval(true);
    expect(loadMedieval()).toBe(true);
    expect(loadTheme()).toBe("dark");
    expect(root.classList.contains("clean")).toBe(false);
    expect(root.classList.contains("dark")).toBe(true);
    expect(useLook.getState().look).toBe("medieval");
    // Parchment: the medieval look in light mode, neither class.
    saveTheme("light");
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.classList.contains("clean")).toBe(false);
    expect(loadMedieval()).toBe(true);
    saveMedieval(false);
    expect(root.classList.contains("clean")).toBe(true);
    expect(useLook.getState().look).toBe("clean");
  });

  it("reads choices saved before the clean default", () => {
    localStorage.setItem("task-master.theme", "light");
    expect(loadTheme()).toBe("light");
    expect(loadMedieval()).toBe(true);
    localStorage.setItem("task-master.theme", "clean");
    expect(loadTheme()).toBe("light");
    expect(loadMedieval()).toBe(false);
    localStorage.setItem("task-master.theme", "dark");
    expect(loadTheme()).toBe("dark");
    expect(loadMedieval()).toBe(false);
    localStorage.setItem("task-master.theme", "system");
    expect(loadTheme()).toBe("system");
    // A new choice replaces the old key's reading.
    saveTheme("light");
    expect(loadTheme()).toBe("light");
    expect(loadMedieval()).toBe(false);
  });
});

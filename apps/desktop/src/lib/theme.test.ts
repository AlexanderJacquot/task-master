// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, loadLightTheme, loadTheme, saveLightTheme, saveTheme, useLook } from "./theme";

afterEach(() => localStorage.clear());

describe("theme", () => {
  it("defaults to dark and remembers a choice", () => {
    expect(loadTheme()).toBe("dark");
    saveTheme("system");
    expect(loadTheme()).toBe("system");
    saveTheme("dark");
    expect(loadTheme()).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    saveTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("follows the system preference", () => {
    const root = document.createElement("html");
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("dark"),
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    applyTheme("system", root);
    expect(root.classList.contains("dark")).toBe(true);
    window.matchMedia = original;
  });

  it("applies the clean theme as its own class and look", () => {
    saveTheme("clean");
    expect(loadTheme()).toBe("clean");
    const root = document.documentElement;
    expect(root.classList.contains("clean")).toBe(true);
    expect(root.classList.contains("dark")).toBe(false);
    expect(useLook.getState().look).toBe("clean");
    saveTheme("light");
    expect(root.classList.contains("clean")).toBe(false);
    expect(useLook.getState().look).toBe("medieval");
  });

  it("follows the system with the chosen light theme", () => {
    const original = window.matchMedia;
    let dark = false;
    window.matchMedia = (() => ({
      get matches() {
        return dark;
      },
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    const root = document.documentElement;
    expect(loadLightTheme()).toBe("light");
    saveTheme("system");
    expect(root.classList.contains("clean")).toBe(false);
    saveLightTheme("clean");
    expect(loadLightTheme()).toBe("clean");
    expect(root.classList.contains("clean")).toBe(true);
    dark = true;
    applyTheme("system");
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.classList.contains("clean")).toBe(false);
    expect(useLook.getState().look).toBe("medieval");
    window.matchMedia = original;
  });
});

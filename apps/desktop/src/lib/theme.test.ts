// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, loadTheme, saveTheme } from "./theme";

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
});

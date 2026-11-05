import { describe, expect, it } from "vitest";
import {
  checkBinding,
  chordOf,
  DEFAULT_KEYMAP,
  type Keymap,
  resolve,
  withBinding,
  withoutBinding,
} from "./keymap";

const key = (k: string, mods: Partial<Record<"ctrl" | "meta" | "alt" | "shift", boolean>> = {}) =>
  chordOf({
    key: k,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
  });

describe("chordOf", () => {
  it("names chords the same way bindings are written", () => {
    expect(key("k", { ctrl: true })).toBe("Ctrl+K");
    expect(key("k", { meta: true })).toBe("Ctrl+K");
    expect(key("Z", { ctrl: true, shift: true })).toBe("Ctrl+Shift+Z");
    expect(key(",", { ctrl: true })).toBe("Ctrl+,");
    expect(key("?", { shift: true })).toBe("?");
    expect(key(" ", { ctrl: true, shift: true })).toBe("Ctrl+Shift+Space");
    expect(key("F2", { alt: true })).toBe("Alt+F2");
    expect(key("g")).toBe("G");
    expect(key("Control", { ctrl: true })).toBeNull();
  });
});

describe("resolve", () => {
  const map = DEFAULT_KEYMAP;

  it("runs single chords and two-key sequences", () => {
    expect(resolve(map, "Ctrl+K", null, false)).toEqual({ action: "palette" });
    expect(resolve(map, "Ctrl+,", null, false)).toEqual({ action: "goSettings" });
    expect(resolve(map, "G", null, false)).toEqual({ pending: "G" });
    expect(resolve(map, "S", "G", false)).toEqual({ action: "goSettings" });
    expect(resolve(map, "X", "G", false)).toEqual({});
  });

  it("leaves typing alone: only Ctrl/Alt bindings of in-field actions fire in fields", () => {
    expect(resolve(map, "Ctrl+K", null, true)).toEqual({ action: "palette" });
    expect(resolve(map, "Ctrl+,", null, true)).toEqual({ action: "goSettings" });
    expect(resolve(map, "Ctrl+Z", null, true)).toEqual({});
    expect(resolve(map, "G", null, true)).toEqual({});
    expect(resolve(map, "?", null, true)).toEqual({});
  });

  it("follows a remapped key", () => {
    const next = withBinding(map, "goToday", "Alt+T");
    expect(resolve(next, "Alt+T", null, false)).toEqual({ action: "goToday" });
  });
});

describe("checkBinding", () => {
  it("refuses keys kept for typing and lists", () => {
    expect(checkBinding(DEFAULT_KEYMAP, "palette", "Ctrl+C")).toMatchObject({ ok: false });
    expect(checkBinding(DEFAULT_KEYMAP, "palette", "Enter")).toMatchObject({ ok: false });
    expect(checkBinding(DEFAULT_KEYMAP, "palette", "Ctrl+3")).toMatchObject({ ok: false });
  });

  it("moves a key used by another action", () => {
    expect(checkBinding(DEFAULT_KEYMAP, "goInbox", "Ctrl+K")).toEqual({
      ok: true,
      takenFrom: "palette",
    });
    const moved: Keymap = withBinding(DEFAULT_KEYMAP, "goInbox", "Ctrl+K");
    expect(moved.palette).toEqual([]);
    expect(moved.goInbox).toEqual(["G I", "Ctrl+K"]);
  });

  it("refuses a single key that starts another action's sequence", () => {
    expect(checkBinding(DEFAULT_KEYMAP, "help", "G")).toMatchObject({ ok: false });
  });

  it("removes one binding", () => {
    expect(withoutBinding(DEFAULT_KEYMAP, "redo", "Ctrl+Y").redo).toEqual(["Ctrl+Shift+Z"]);
  });
});

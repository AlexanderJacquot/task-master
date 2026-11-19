// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isParchment, loadSoundsOn, playSound, saveSoundsOn, shouldPlay } from "./sounds";

// A stand-in for the Web Audio API that counts the noise slices started.
let started = 0;
const param = () => ({
  value: 0,
  setValueAtTime() {},
  linearRampToValueAtTime() {},
  exponentialRampToValueAtTime() {},
});
const node = () => ({
  connect<T>(next: T) {
    return next;
  },
});
class FakeAudioContext {
  sampleRate = 8000;
  currentTime = 0;
  state = "running";
  destination = node();
  createBuffer(_channels: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => data };
  }
  createGain() {
    return { ...node(), gain: param() };
  }
  createBiquadFilter() {
    return { ...node(), type: "", frequency: param(), Q: param() };
  }
  createBufferSource() {
    return {
      ...node(),
      buffer: null,
      start() {
        started++;
      },
    };
  }
  resume() {
    return Promise.resolve();
  }
}

const root = document.documentElement;

beforeEach(() => {
  localStorage.clear();
  root.className = "";
  started = 0;
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
});

describe("paper sounds", () => {
  it("are on by default and remember being turned off", () => {
    expect(loadSoundsOn()).toBe(true);
    saveSoundsOn(false);
    expect(loadSoundsOn()).toBe(false);
    saveSoundsOn(true);
    expect(loadSoundsOn()).toBe(true);
  });

  it("only play on the parchment theme", () => {
    expect(isParchment(root)).toBe(true);
    root.classList.add("dark");
    expect(shouldPlay(root)).toBe(false);
    root.className = "clean";
    expect(shouldPlay(root)).toBe(false);
    root.className = "";
    expect(shouldPlay(root)).toBe(true);
    saveSoundsOn(false);
    expect(shouldPlay(root)).toBe(false);
  });

  it("play each sound on parchment and stay silent otherwise", () => {
    for (const sound of ["crumple", "scribble", "burn"] as const) {
      started = 0;
      playSound(sound);
      expect(started).toBeGreaterThan(0);
    }
    started = 0;
    root.classList.add("dark");
    playSound("burn");
    root.className = "";
    saveSoundsOn(false);
    playSound("crumple");
    expect(started).toBe(0);
  });

  it("never throw when audio fails", async () => {
    vi.resetModules();
    const fresh = await import("./sounds");
    (globalThis as { AudioContext?: unknown }).AudioContext = class {
      constructor() {
        throw new Error("no audio device");
      }
    };
    expect(() => fresh.playSound("crumple")).not.toThrow();
  });
});

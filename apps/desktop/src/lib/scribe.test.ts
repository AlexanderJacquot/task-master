import { describe, expect, it } from "vitest";
import { fakeScribe } from "../test/fixtures";
import { createScribeStore, formatClock } from "./scribe";

describe("scribe store", () => {
  it("records a meeting, follows its levels and loads its audio after stop", async () => {
    const fake = fakeScribe();
    const store = createScribeStore(fake.api);
    await store.getState().connect();
    expect(store.getState().support?.recording).toBe(true);

    expect(await store.getState().start("m1")).toBe(true);
    expect(store.getState().live?.meeting_id).toBe("m1");
    // Levels of another meeting (a stale event) are ignored.
    fake.emitLevels({ meetingId: "other", elapsedMs: 100, mic: 0.9, system: 0.1 });
    expect(store.getState().levels).toBeNull();
    fake.emitLevels({ meetingId: "m1", elapsedMs: 200, mic: 0.5, system: 0.25 });
    expect(store.getState().levels?.mic).toBe(0.5);

    await store.getState().stop();
    expect(store.getState().live).toBeNull();
    expect(store.getState().levels).toBeNull();
    await expect.poll(() => store.getState().audio.m1?.state).toBe("encoding");
    expect(fake.calls).toEqual(["start:m1", "stop:m1"]);
  });

  it("keeps the error of a refused start and reloads audio on change events", async () => {
    const fake = fakeScribe({
      start: async () => {
        throw new Error("cannot open the microphone");
      },
    });
    const store = createScribeStore(fake.api);
    await store.getState().connect();
    expect(await store.getState().start("m1")).toBe(false);
    expect(store.getState().error).toBe("cannot open the microphone");
    expect(store.getState().busy).toBe(false);

    await store.getState().loadAudio("m2");
    expect(store.getState().audio.m2).toBeNull();
    fake.audio.m2 = {
      state: "ready",
      started_at: 0,
      duration_ms: 1000,
      bytes: 10,
      tracks: [],
      warnings: [],
    };
    fake.emitChanged("m2");
    await expect.poll(() => store.getState().audio.m2?.state).toBe("ready");
    // Meetings nobody opened are not read.
    fake.emitChanged("m3");
    expect("m3" in store.getState().audio).toBe(false);
  });

  it("formats a recording clock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65_400)).toBe("1:05");
    expect(formatClock(3_729_000)).toBe("1:02:09");
  });
});

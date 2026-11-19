import { describe, expect, it } from "vitest";
import {
  compareSpeakers,
  createPlayerControl,
  nextSpeaker,
  plainSnippet,
  purgeNotice,
  segmentAt,
  speakerLabel,
  speakerStats,
  splitSegment,
  transcriptOf,
  WARN_BEFORE,
} from "./transcript";
import type { TranscriptSegment } from "./types";

function seg(
  id: string,
  start: number,
  end: number,
  speaker = "me",
  text = "hello there",
): TranscriptSegment {
  return {
    id,
    meeting_id: "m1",
    start_ms: start,
    end_ms: end,
    speaker,
    text,
    edited: false,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  };
}

describe("transcript", () => {
  it("labels speakers by name, as me, or by number", () => {
    expect(speakerLabel("me", {})).toBe("Me");
    expect(speakerLabel("s2", {})).toBe("Speaker 2");
    expect(speakerLabel("s2", { s2: " Ada " })).toBe("Ada");
    expect(speakerLabel("s2", { s2: "  " })).toBe("Speaker 2");
    expect(["s10", "s2", "me", "s1"].sort(compareSpeakers)).toEqual(["me", "s1", "s2", "s10"]);
  });

  it("orders a meeting's lines and counts each voice", () => {
    const lines = transcriptOf(
      {
        b: seg("b", 5_000, 9_000, "s1"),
        a: seg("a", 0, 4_000, "me"),
        c: { ...seg("c", 1, 2), meeting_id: "other" },
        d: seg("d", 10_000, 11_000, "s1"),
      },
      "m1",
    );
    expect(lines.map((l) => l.id)).toEqual(["a", "b", "d"]);
    expect(speakerStats(lines)).toEqual([
      { key: "me", lines: 1, ms: 4_000 },
      { key: "s1", lines: 2, ms: 5_000 },
    ]);
    expect(nextSpeaker(["me", "s1", "s3"])).toBe("s4");
    expect(nextSpeaker(["me"])).toBe("s1");
  });

  it("splits a line between two words, sharing its time", () => {
    const [first, second] = splitSegment(seg("a", 0, 10_000, "s1", "hello there"), 5, "n", 7) ?? [];
    expect(first).toMatchObject({ id: "a", text: "hello", end_ms: 4_545, edited: true });
    expect(second).toMatchObject({ id: "n", text: "there", start_ms: 4_545, end_ms: 10_000 });
    expect(splitSegment(seg("a", 0, 1_000), 0, "n", 7)).toBeNull();
  });

  it("finds the line playing at a time", () => {
    const lines = [seg("a", 0, 1_000), seg("b", 2_000, 3_000), seg("c", 4_000, 5_000)];
    expect(segmentAt(lines, -1)).toBe(-1);
    expect(segmentAt(lines, 0)).toBe(0);
    expect(segmentAt(lines, 2_500)).toBe(1);
    expect(segmentAt(lines, 9_000)).toBe(2);
  });

  it("warns two days before the audio goes", () => {
    expect(purgeNotice(null, 0)).toBeNull();
    expect(purgeNotice(WARN_BEFORE + 1, 0)).toEqual({ at: WARN_BEFORE + 1, soon: false });
    expect(purgeNotice(WARN_BEFORE, 0)?.soon).toBe(true);
    expect(plainSnippet("…the [budget] for [Q3]")).toBe("…the budget for Q3");
  });

  it("links a player and a transcript", () => {
    const control = createPlayerControl();
    expect(control.play(1_000)).toBe(false);
    const played: number[] = [];
    let changes = 0;
    control.onAttach(() => changes++);
    const detach = control.attach((ms) => played.push(ms));
    expect(control.attached()).toBe(true);
    expect(control.play(1_000)).toBe(true);
    const heard: number[] = [];
    const stop = control.subscribe((ms) => heard.push(ms));
    control.publish(500);
    stop();
    control.publish(600);
    detach();
    expect(control.attached()).toBe(false);
    expect({ played, heard, changes }).toEqual({ played: [1_000], heard: [500], changes: 2 });
  });
});

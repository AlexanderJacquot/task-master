import { describe, expect, it } from "vitest";
import { meeting } from "../test/fixtures";
import {
  applyMeetingChanges,
  cleanParticipants,
  defaultTimes,
  filterMeetings,
  followUpPrompt,
  followUpTitle,
  meetingLabel,
  meetingPhase,
  meetingsLinkedTo,
  moveStart,
  nextQuarter,
  participantSuggestions,
  sortMeetings,
  timeValue,
  withDate,
  withTime,
} from "./meetings";

const HOUR = 3_600_000;
const ten = new Date(2026, 10, 5, 10).getTime();

describe("follow-up session", () => {
  it("names the meeting, the tools and where the tasks go", () => {
    const m = meeting({ title: " Budget review " });
    expect(followUpTitle(m)).toBe("Follow up: Budget review");
    expect(followUpTitle(meeting({ title: "" }))).toBe("Follow up: meeting");
    const prompt = followUpPrompt(m, { id: "p1", name: "Finance" });
    expect(prompt).toContain(`meeting_id \`${m.id}\`, transcript: true`);
    expect(prompt).toContain("set_meeting_summary");
    expect(prompt).toContain("in the project Finance (project_id `p1`)");
    expect(prompt).toContain("owner me, top_level true");
    expect(followUpPrompt(m, null)).toContain("in the Inbox (no project)");
  });
});

describe("meetings", () => {
  it("knows whether a meeting is upcoming, going on or over", () => {
    const m = meeting({ started_at: ten, ended_at: ten + HOUR, state: "scheduled" });
    expect(meetingPhase(m, ten - 1)).toBe("upcoming");
    expect(meetingPhase(m, ten + 1)).toBe("now");
    expect(meetingPhase(m, ten + HOUR)).toBe("past");
    expect(meetingPhase({ ...m, ended_at: null }, ten + 5 * HOUR)).toBe("now");
    expect(meetingLabel(m, ten - 1)).toBe("Upcoming");
    expect(meetingLabel(m, ten + HOUR)).toBe("Held");
    expect(meetingLabel({ ...m, state: "review" }, ten + HOUR)).toBe("Transcript to check");
  });

  it("starts now to the minute, or plans at the next quarter for 30 minutes", () => {
    const at = new Date(2026, 10, 5, 10, 7, 42).getTime();
    expect(nextQuarter(at)).toBe(new Date(2026, 10, 5, 10, 15).getTime());
    expect(nextQuarter(ten)).toBe(ten);
    expect(defaultTimes(at, true)).toEqual({
      started_at: new Date(2026, 10, 5, 10, 7).getTime(),
      ended_at: new Date(2026, 10, 5, 10, 37).getTime(),
    });
    expect(defaultTimes(at, false).started_at).toBe(new Date(2026, 10, 5, 10, 15).getTime());
  });

  it("tidies participants like the core", () => {
    expect(cleanParticipants([" Ada  Lovelace ", "ada lovelace", "", "Grace"])).toEqual([
      "Ada Lovelace",
      "Grace",
    ]);
  });

  it("suggests names used before, most used first, without those listed", () => {
    const past = [
      meeting({ participants: ["Ada", "Grace"], started_at: 1 }),
      meeting({ participants: ["Ada", "Bob"], started_at: 2 }),
      meeting({ participants: ["Grace"], started_at: 3 }),
      meeting({ participants: ["ada"], started_at: 4 }),
    ];
    expect(participantSuggestions(past, "")).toEqual(["ada", "Grace", "Bob"]);
    expect(participantSuggestions(past, "r")).toEqual(["Grace"]);
    expect(participantSuggestions(past, "", ["ADA"])).toEqual(["Grace", "Bob"]);
  });

  it("filters by project and words, and sorts upcoming then past", () => {
    const a = meeting({ title: "Kick-off", project_id: "p1", started_at: ten + 2 * HOUR });
    const b = meeting({ title: "Retro", participants: ["Bob"], started_at: ten - 5 * HOUR });
    const c = meeting({ title: "Demo", notes: "budget", started_at: ten - 9 * HOUR });
    const all = [a, b, c];
    expect(filterMeetings(all, { project: "p1", text: "" })).toEqual([a]);
    expect(filterMeetings(all, { project: "none", text: "" })).toEqual([b, c]);
    expect(filterMeetings(all, { project: "", text: "bob" })).toEqual([b]);
    expect(filterMeetings(all, { project: "", text: "budget" })).toEqual([c]);
    expect(sortMeetings(all, ten)).toEqual({ upcoming: [a], past: [b, c] });
  });

  it("lists meetings linked to a task, project or epic, newest first", () => {
    const a = meeting({ task_id: "t1", started_at: 1 });
    const b = meeting({ project_id: "p1", task_id: "t1", started_at: 2 });
    const c = meeting({ epic_id: "e1" });
    expect(meetingsLinkedTo([a, b, c], { task: "t1" })).toEqual([b, a]);
    expect(meetingsLinkedTo([a, b, c], { project: "p1" })).toEqual([b]);
    expect(meetingsLinkedTo([a, b, c], { epic: "e1" })).toEqual([c]);
  });

  it("applies changes as the core would, validation date included", () => {
    const m = meeting();
    const next = applyMeetingChanges(
      m,
      [
        { title: "  Weekly " },
        { participants: ["A", "a", "B"] },
        { state: "validated" },
        { summary: "  " },
      ],
      42,
    );
    expect(next).toMatchObject({
      title: "Weekly",
      participants: ["A", "B"],
      state: "validated",
      validated_at: 42,
      summary: null,
      updated_at: 42,
    });
    expect(applyMeetingChanges(next, [{ state: "review" }], 50).validated_at).toBeNull();
  });

  it("moves times on the same day and keeps the length when the start moves", () => {
    expect(timeValue(ten)).toBe("10:00");
    expect(withTime(ten, "14:30")).toBe(new Date(2026, 10, 5, 14, 30).getTime());
    expect(withTime(ten, "25:00")).toBeNull();
    expect(withDate(ten, "2026-12-01")).toBe(new Date(2026, 11, 1, 10).getTime());
    const m = meeting({ started_at: ten, ended_at: ten + HOUR });
    expect(moveStart(m, ten + 2 * HOUR)).toEqual([
      { started_at: ten + 2 * HOUR },
      { ended_at: ten + 3 * HOUR },
    ]);
    expect(moveStart({ ...m, ended_at: null }, ten + 1)).toEqual([{ started_at: ten + 1 }]);
  });
});

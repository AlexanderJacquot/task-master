// Creating a meeting from anywhere (Scribe, a task page, a calendar event) and opening it.

import { useNavigate } from "@tanstack/react-router";
import { defaultTimes } from "../../lib/meetings";
import { createMeeting } from "../../store/actions";
import { useTaskStore } from "../../store/context";

/** "Thu 5 Nov", with the year when it is not this one. */
export function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

/** Creates a meeting (now, or at the next quarter) and opens it. */
export function useNewMeeting() {
  const store = useTaskStore();
  const navigate = useNavigate();
  return async (
    startNow: boolean,
    links: { project_id?: string | null; epic_id?: string | null; task_id?: string | null } = {},
    preset?: { title: string; started_at: number; ended_at: number },
  ) => {
    const times = preset ?? defaultTimes(Date.now(), startNow);
    const title = preset?.title ?? `Meeting ${dayLabel(times.started_at)}`;
    const id = await createMeeting(store, {
      title,
      started_at: times.started_at,
      ended_at: times.ended_at,
      state: startNow ? "held" : "scheduled",
      ...links,
    });
    if (id) void navigate({ to: "/meeting/$meetingId", params: { meetingId: id }, search: {} });
    return id;
  };
}

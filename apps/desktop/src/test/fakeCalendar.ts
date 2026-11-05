import type { CalendarApi } from "../lib/api";
import type { CalendarEvent, CalendarStatus, EventRange } from "../lib/types";

/** A calendar connection for component tests: records calls, serves fixed events. */
export function fakeCalendar(initial: Partial<CalendarStatus> = {}, events: CalendarEvent[] = []) {
  const calls: string[] = [];
  const ranges: EventRange[] = [];
  let status: CalendarStatus = {
    configured: false,
    runner: "this_device",
    can_set_runner: false,
    client_id: "",
    connected: false,
    syncing: false,
    last_sync_at: null,
    last_error: null,
    last_report: null,
    sources: [],
    ...initial,
  };
  let listener: ((s: CalendarStatus) => void) | null = null;
  const api: CalendarApi = {
    status: async () => status,
    setRunner: async (runner) => {
      calls.push(`runner ${runner}`);
      status = { ...status, runner };
      return status;
    },
    connect: async (clientId, secret) => {
      calls.push(`connect ${clientId} ${secret}`);
      status = { ...status, configured: true, client_id: clientId, connected: true };
      return status;
    },
    disconnect: async () => {
      calls.push("disconnect");
      status = { ...status, connected: false, sources: [] };
      return status;
    },
    setShown: async (id, shown) => {
      calls.push(`shown ${id} ${shown}`);
      status = {
        ...status,
        sources: status.sources.map((s) => (s.id === id ? { ...s, shown } : s)),
      };
      return status;
    },
    syncNow: async () => {
      calls.push("sync");
      return status;
    },
    events: async (range) => {
      ranges.push(range);
      return events;
    },
    onSynced: async (handler) => {
      listener = handler;
      return () => {
        listener = null;
      };
    },
  };
  return {
    api,
    calls,
    ranges,
    /** Simulates the shell's "calendar synced" event. */
    synced(next: Partial<CalendarStatus>) {
      status = { ...status, ...next };
      listener?.(status);
    },
  };
}

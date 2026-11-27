import { useEffect, useState } from "react";
import type { CalendarApi } from "../../lib/api";
import type { CalendarEvent, CalendarStatus, EventRange } from "../../lib/types";

/**
 * Events of the shown calendars in `range` and the sync status, re-read after every sync.
 * Empty without a calendar API (tests) or a connected account.
 */
export function useCalendarEvents(api: CalendarApi | undefined, range: EventRange) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [version, setVersion] = useState(0);
  const { from, to, from_date, to_date } = range;

  useEffect(() => {
    if (!api) return;
    let live = true;
    void api.status().then(
      (s) => live && setStatus(s),
      () => {},
    );
    const off = api.onSynced((s) => {
      if (!live) return;
      setStatus(s);
      if (!s.syncing) setVersion((v) => v + 1);
    });
    return () => {
      live = false;
      void off.then((stop) => stop());
    };
  }, [api]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` re-reads after a sync
  useEffect(() => {
    if (!api) return;
    let live = true;
    api.events({ from, to, from_date, to_date }).then(
      (list) => live && setEvents(list),
      () => live && setEvents([]),
    );
    return () => {
      live = false;
    };
  }, [api, from, to, from_date, to_date, version]);

  return { events, status };
}

/** Local calendar date as `YYYY-MM-DD`. */
export function isoDate(date: Date = new Date()): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** Whole days from `today` to `iso` (negative = past). */
export function daysFrom(today: string, iso: string): number {
  return Math.round((parseIso(iso).getTime() - parseIso(today).getTime()) / 86_400_000);
}

/** Short human label for a due date relative to today. */
export function formatDue(iso: string, today: string): string {
  const days = daysFrom(today, iso);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  const date = parseIso(iso);
  if (days > 1 && days < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  const sameYear = iso.slice(0, 4) === today.slice(0, 4);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "just now", "5 min ago", "3 h ago", or a date. */
export function formatAgo(ms: number, now: number = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

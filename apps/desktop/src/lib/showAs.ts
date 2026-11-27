// How a meeting or an event shows to people who look at the calendar (ADR 038): Outlook's
// "Show as" (busy, tentative, free) and whether it is private.

import type { ShowAs } from "./types";

export const SHOW_AS_OPTIONS: { value: ShowAs; label: string }[] = [
  { value: "busy", label: "Busy" },
  { value: "tentative", label: "Tentative" },
  { value: "free", label: "Free" },
];

export const PRIVACY_OPTIONS: { value: "private" | "visible"; label: string }[] = [
  { value: "private", label: "Private" },
  { value: "visible", label: "Visible" },
];

export function showAsLabel(showAs: ShowAs): string {
  return SHOW_AS_OPTIONS.find((o) => o.value === showAs)?.label ?? "Busy";
}

/** What sets an item apart from a plain busy one, for labels: "tentative, private". */
export function availabilityNote(showAs: ShowAs, isPrivate: boolean): string {
  return [showAs === "busy" ? null : showAs, isPrivate ? "private" : null]
    .filter(Boolean)
    .join(", ");
}

/** The share of an item's color in its fill: a free item reads lighter than a busy one. */
export function fillShare(showAs: ShowAs, busy: number): number {
  if (showAs === "tentative") return Math.round(busy * 0.55);
  if (showAs === "free") return Math.round(busy * 0.3);
  return busy;
}

/** The outline: solid when busy, dashed when tentative, dotted when free. */
export function edgeStyle(showAs: ShowAs, busy: "solid" | "dashed"): "solid" | "dashed" | "dotted" {
  if (showAs === "tentative") return busy === "solid" ? "dashed" : "dotted";
  if (showAs === "free") return "dotted";
  return busy;
}

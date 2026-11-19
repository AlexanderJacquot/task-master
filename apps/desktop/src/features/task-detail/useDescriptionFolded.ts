import { useState } from "react";

const STORAGE_KEY = "task-master.description.folded";

type Variant = "panel" | "page";

function load(variant: Variant): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed === null || typeof parsed !== "object") return false;
    return (parsed as Record<string, unknown>)[variant] === true;
  } catch {
    return false;
  }
}

function save(variant: Variant, folded: boolean) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const prev = parsed !== null && typeof parsed === "object" ? parsed : {};
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prev, [variant]: folded }));
  } catch {
    // Not remembered; the fold still applies until the panel closes.
  }
}

/**
 * The first line of text in a markdown description, shown beside the folded header: block
 * markers (headings, lists, quotes, checkboxes), images and link targets are dropped.
 */
export function descriptionExcerpt(markdown: string): string {
  for (const raw of markdown.split("\n")) {
    if (/^\s*(?:```|~~~|-{3,}\s*$|\*{3,}\s*$)/.test(raw)) continue;
    const line = raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
      .replace(/[*_`~]+/g, "")
      .trim();
    if (line) return line;
  }
  return "";
}

/**
 * Whether the description is folded, chosen apart for the side panel and the full page and
 * remembered on this machine (like the collapsed sidebar). `forceOpen` (a task just created,
 * opened with the cursor in its description) shows it without changing the choice.
 */
export function useDescriptionFolded(
  variant: Variant,
  forceOpen = false,
): [boolean, (folded: boolean) => void] {
  const [folded, setFolded] = useState(() => !forceOpen && load(variant));
  return [
    folded,
    (next: boolean) => {
      setFolded(next);
      save(variant, next);
    },
  ];
}

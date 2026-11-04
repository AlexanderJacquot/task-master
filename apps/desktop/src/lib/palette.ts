// Command palette matching (plan section 6, Ctrl+K): pure so it can be tested and tuned.

export type PaletteGroup = "Actions" | "Views" | "Projects" | "Epics" | "Tags" | "Tasks";

export interface PaletteItem {
  /** Unique across groups, e.g. `project:<id>`. */
  key: string;
  group: PaletteGroup;
  label: string;
  /** Shown dimmed on the right: a shortcut, a project name... */
  hint?: string;
  /** Extra words that match but are not shown (e.g. "settings" for an action). */
  keywords?: string;
}

const GROUP_ORDER: PaletteGroup[] = ["Actions", "Views", "Projects", "Epics", "Tags", "Tasks"];

/**
 * Score of `item` for `query`: every query word must start a word of the label or keywords
 * (or appear inside the label for words of 3+ letters). Higher is better; null = no match.
 */
export function score(item: PaletteItem, query: string): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const label = item.label.toLowerCase();
  const haystack = `${label} ${item.keywords?.toLowerCase() ?? ""}`;
  const starts = haystack.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let total = 0;
  for (const w of words) {
    if (starts.some((s) => s === w)) total += 3;
    else if (starts.some((s) => s.startsWith(w))) total += 2;
    else if (w.length >= 3 && label.includes(w)) total += 1;
    else return null;
  }
  if (label.startsWith(words.join(" "))) total += 2;
  return total;
}

/**
 * Matching items, best first within each group, groups in a fixed order. Tasks found by
 * full-text search (`searchHits`, best first) always match, keeping the core's order.
 */
export function rankItems(
  items: PaletteItem[],
  query: string,
  options: { limitPerGroup?: number; searchHits?: ReadonlySet<string> } = {},
): PaletteItem[] {
  const limit = options.limitPerGroup ?? 6;
  const scored = new Map<PaletteGroup, Array<{ item: PaletteItem; score: number; i: number }>>();
  items.forEach((item, i) => {
    const hit = options.searchHits?.has(item.key);
    const s = hit ? 1 : score(item, query);
    if (s === null) return;
    const list = scored.get(item.group) ?? [];
    list.push({ item, score: s, i });
    scored.set(item.group, list);
  });
  const out: PaletteItem[] = [];
  for (const group of GROUP_ORDER) {
    const list = scored.get(group);
    if (!list) continue;
    list.sort((a, b) => b.score - a.score || a.i - b.i);
    out.push(...list.slice(0, limit).map((x) => x.item));
  }
  return out;
}

// The order of the sidebar's entries and which ones are hidden, remembered per machine.
// Two lists: the pages at the top (Inbox, Today, ...) and the sections below them
// (Projects, Epics, ...). Pages are reordered by dragging them in the sidebar; both lists
// are ordered and shown or hidden in Settings → Sidebar.

import { create } from "zustand";

export const SIDEBAR_PAGES = [
  { id: "inbox", label: "Inbox" },
  { id: "today", label: "Today" },
  { id: "calendar", label: "Calendar" },
  { id: "all", label: "All tasks" },
  { id: "lineage", label: "Lineage" },
  { id: "notes", label: "Notes" },
  { id: "roadmap", label: "Roadmap" },
  { id: "scribe", label: "Scribe" },
  { id: "agents", label: "Agents" },
  { id: "metrics", label: "Metrics" },
] as const;

export const SIDEBAR_SECTIONS = [
  { id: "projects", label: "Projects" },
  { id: "team", label: "Team" },
  { id: "epics", label: "Epics" },
  { id: "views", label: "Saved views" },
  { id: "tags", label: "Tags" },
] as const;

export type SidebarPage = (typeof SIDEBAR_PAGES)[number]["id"];
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number]["id"];

export interface SidebarList<T extends string> {
  /** Every entry, in display order. */
  order: T[];
  hidden: T[];
}

export interface SidebarLayout {
  pages: SidebarList<SidebarPage>;
  sections: SidebarList<SidebarSection>;
}

export type SidebarListKey = keyof SidebarLayout;

const KEY = "task-master.sidebar-layout";

const DEFAULTS: { [K in SidebarListKey]: readonly SidebarLayout[K]["order"][number][] } = {
  pages: SIDEBAR_PAGES.map((p) => p.id),
  sections: SIDEBAR_SECTIONS.map((s) => s.id),
};

export function defaultLayout(): SidebarLayout {
  return {
    pages: { order: [...DEFAULTS.pages], hidden: [] },
    sections: { order: [...DEFAULTS.sections], hidden: [] },
  };
}

/**
 * A saved list made safe: unknown ids dropped, duplicates removed, and entries it does not
 * know yet (added in a later version) put back at their default place.
 */
function normalizeList<T extends string>(
  known: readonly T[],
  saved: { order?: unknown; hidden?: unknown } | undefined,
): SidebarList<T> {
  const isKnown = (id: unknown): id is T => known.includes(id as T);
  const order: T[] = [];
  for (const id of Array.isArray(saved?.order) ? saved.order : [])
    if (isKnown(id) && !order.includes(id)) order.push(id);
  known.forEach((id, i) => {
    if (order.includes(id)) return;
    // After the entry that comes before it by default, or first.
    const before = known
      .slice(0, i)
      .reverse()
      .find((b) => order.includes(b));
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id);
  });
  const hidden = (Array.isArray(saved?.hidden) ? saved.hidden : []).filter(isKnown);
  return { order, hidden: [...new Set(hidden)] };
}

export function loadLayout(): SidebarLayout {
  let saved: Partial<Record<SidebarListKey, { order?: unknown; hidden?: unknown }>> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    // Unreadable: the default layout.
  }
  return {
    pages: normalizeList(DEFAULTS.pages, saved.pages),
    sections: normalizeList(DEFAULTS.sections, saved.sections),
  };
}

function saveLayout(layout: SidebarLayout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // Not remembered; applies until the app restarts.
  }
}

/** `order` with `id` moved to where `over` is. */
export function moveEntry<T extends string>(order: T[], id: T, over: T): T[] {
  const from = order.indexOf(id);
  const to = order.indexOf(over);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** The entries of a list to show, in order. */
export function visibleEntries<T extends string>(list: SidebarList<T>): T[] {
  return list.order.filter((id) => !list.hidden.includes(id));
}

interface SidebarLayoutStore {
  layout: SidebarLayout;
  move(list: SidebarListKey, id: string, over: string): void;
  setHidden(list: SidebarListKey, id: string, hidden: boolean): void;
  reset(): void;
}

export const useSidebarLayout = create<SidebarLayoutStore>((set, get) => {
  const update = (layout: SidebarLayout) => {
    saveLayout(layout);
    set({ layout });
  };
  return {
    layout: loadLayout(),
    move(list, id, over) {
      const layout = get().layout;
      const current = layout[list] as SidebarList<string>;
      const order = moveEntry(current.order, id, over);
      if (order !== current.order) update({ ...layout, [list]: { ...current, order } });
    },
    setHidden(list, id, hidden) {
      const layout = get().layout;
      const current = layout[list] as SidebarList<string>;
      const others = current.hidden.filter((h) => h !== id);
      update({ ...layout, [list]: { ...current, hidden: hidden ? [...others, id] : others } });
    },
    reset() {
      try {
        localStorage.removeItem(KEY);
      } catch {
        // Nothing saved to forget.
      }
      set({ layout: defaultLayout() });
    },
  };
});

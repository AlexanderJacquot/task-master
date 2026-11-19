// Multi-select in list and board views: which tasks a click picks. Pure, so the view
// keeps the state and these rules are unit tested.

export interface Selection {
  ids: ReadonlySet<string>;
  /** Where a Shift+click range starts: the last task clicked into the selection. */
  anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null };

export interface ClickMods {
  /** Ctrl (Cmd on macOS): add or remove one task. */
  toggle: boolean;
  /** Shift: every task between the anchor and this one, in the view's order. */
  range: boolean;
}

/** True when the click picks tasks instead of opening one. */
export function isSelectClick(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return e.ctrlKey || e.metaKey || e.shiftKey;
}

export function modsOf(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): ClickMods {
  return { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey };
}

/**
 * The selection after a Ctrl/Shift click on `id`. `order` is the view's tasks top to
 * bottom (the board: lane by lane, column by column). `open` is the task open in the side
 * panel: it looks selected, so the first Ctrl/Shift click starts from it, as a file
 * manager starts from the focused file.
 */
export function clickSelect(
  sel: Selection,
  id: string,
  mods: ClickMods,
  order: readonly string[],
  open: string | null = null,
): Selection {
  const start = sel.ids.size === 0 && open && open !== id && order.includes(open) ? open : null;
  const ids = new Set(sel.ids);
  if (start) ids.add(start);
  const anchor = sel.anchor ?? start;
  if (mods.range && anchor !== null) {
    const from = order.indexOf(anchor);
    const to = order.indexOf(id);
    if (from >= 0 && to >= 0) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      // Ctrl+Shift adds the range; Shift alone replaces the selection with it.
      const next = mods.toggle ? ids : new Set<string>();
      for (const t of order.slice(lo, hi + 1)) next.add(t);
      return { ids: next, anchor };
    }
  }
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  const kept = ids.has(id) ? id : anchor;
  return { ids, anchor: ids.size > 0 ? kept : null };
}

/** Drops tasks that left the view (filtered out, deleted); the same object when none did. */
export function pruneSelection(sel: Selection, visible: ReadonlySet<string>): Selection {
  if ([...sel.ids].every((id) => visible.has(id))) return sel;
  const ids = new Set([...sel.ids].filter((id) => visible.has(id)));
  const anchor = sel.anchor !== null && ids.has(sel.anchor) ? sel.anchor : null;
  return { ids, anchor };
}

/** Ctrl+A: every task in the view. */
export function selectAll(order: readonly string[]): Selection {
  return { ids: new Set(order), anchor: order[0] ?? null };
}

/**
 * What the selected tasks share for a field: the value when they all agree, else null
 * (the bulk bar then shows "Mixed").
 */
export function common<T>(values: readonly T[]): T | null {
  if (values.length === 0) return null;
  const first = values[0] as T;
  return values.every((v) => v === first) ? first : null;
}

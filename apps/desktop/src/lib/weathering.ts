// Optional weathering on the parchment theme (burnt edges, coffee rings, ...), remembered
// per machine like the theme. Applied as `wx-<name>` classes on <html>; index.css turns
// each class into an extra background layer, so a layer that is off is never loaded.

export type Weathering = "burnt" | "coffee" | "water" | "fold";

export const WEATHERING: readonly Weathering[] = ["burnt", "coffee", "water", "fold"];

export const WEATHERING_LABELS: Record<Weathering, string> = {
  burnt: "Burnt edges",
  coffee: "Coffee rings",
  water: "Water damage",
  fold: "Folded in four",
};

const KEY = "task-master.weathering";

export function loadWeathering(): Weathering[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return WEATHERING.filter((w) => value.includes(w));
  } catch {
    return [];
  }
}

export function applyWeathering(
  on: readonly Weathering[],
  root: HTMLElement = document.documentElement,
) {
  for (const w of WEATHERING) root.classList.toggle(`wx-${w}`, on.includes(w));
}

export function saveWeathering(on: readonly Weathering[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(on));
  } catch {
    // Not persisted; still applied for this session.
  }
  applyWeathering(on);
}

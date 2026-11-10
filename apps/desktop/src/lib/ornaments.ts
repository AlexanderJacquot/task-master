// Asset lab (ADR 019): raster ornaments from the PNG asset pack (src/assets/pack, imported
// by scripts/asset-pack/import.sh) placed in "slots" around the UI. In development each
// slot is switchable live from the lab panel (Ctrl+Alt+A, or Settings → Appearance) and
// remembered per machine. Release builds use each slot's `initial` choice and bundle only
// the assets in RELEASE_FILES below.
//
// To try an asset somewhere new:
//   1. add a slot below (its options are pack keys like "decorations/crown", or "off"),
//   2. render `useOrnament("<slot>")` where it belongs; null means "off" or "built-in".
// Vite hot-reloads both, so the panel picks the new slot up at once.

import { create } from "zustand";
import MANIFEST from "../assets/pack/manifest.json";
import { useIsClean } from "./theme";

/** Development: the whole pack, served as-is by Vite (never imported, so never bundled). */
const ALL_FILES: Record<string, string> = import.meta.env.DEV
  ? Object.fromEntries(
      MANIFEST.map((k) => [`../assets/pack/${k}.webp`, `/src/assets/pack/${k}.webp`]),
    )
  : {};

/** Release: only the assets the slots' `initial` choices use. Keep in step with SLOTS. */
const RELEASE_FILES = import.meta.glob(
  [
    "../assets/pack/app-icons/app-banner.webp",
    "../assets/pack/decorations/divider.webp",
    "../assets/pack/wax-seals/seal-full.webp",
  ],
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

const FILES = import.meta.env.DEV ? ALL_FILES : RELEASE_FILES;

/** Pack key ("decorations/crown") → bundled URL. */
export const PACK: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([path, url]) => [
    path.replace("../assets/pack/", "").replace(/\.webp$/, ""),
    url,
  ]),
);

const inFolder = (folder: string) =>
  Object.keys(PACK)
    .filter((k) => k.startsWith(`${folder}/`))
    .sort();

/** "off" hides the slot; "builtin" keeps what the app drew before the pack. */
export type Choice = "off" | "builtin" | (string & {});

export interface Slot {
  label: string;
  hint: string;
  options: Choice[];
  initial: Choice;
}

export const SLOTS = {
  logo: {
    label: "App logo",
    hint: "Sidebar, collapsed rail, About and the window favicon.",
    options: ["builtin", ...inFolder("app-icons")],
    initial: "app-icons/app-banner",
  },
  wordmark: {
    label: "Sidebar title",
    hint: "The “Task Master” name at the top of the sidebar.",
    options: ["builtin", "branding/wordmark"],
    initial: "builtin",
  },
  heading: {
    label: "Page title flourish",
    hint: "Under the title of list and board pages.",
    options: ["off", "decorations/divider", "decorations/ribbon-swoosh"],
    initial: "decorations/divider",
  },
  headingCrest: {
    label: "Page title crest",
    hint: "A small emblem before the page title.",
    options: ["off", "decorations/crown", "wax-seals/seal-no-ribbons", "decorations/castle"],
    initial: "off",
  },
  doneMark: {
    label: "Done stamp",
    hint: "On done and cancelled board cards.",
    options: ["builtin", ...inFolder("wax-seals"), "ui/done"],
    initial: "builtin",
  },
  priorityRibbon: {
    label: "Priority ribbon",
    hint: "Hangs from urgent and high-priority board cards.",
    options: ["off", "decorations/ribbon-right", "decorations/ribbon-left"],
    initial: "off",
  },
  emptyState: {
    label: "Empty page",
    hint: "Behind or above “No tasks here yet.”",
    options: [
      "off",
      "decorations/scroll-empty",
      "decorations/parchment-panel",
      "decorations/castle",
      "decorations/crown",
      "wax-seals/seal-full",
    ],
    initial: "wax-seals/seal-full",
  },
  corners: {
    label: "Page corners",
    hint: "Gilded corner pieces on the main pane.",
    options: ["off", "decorations/ornamental-corner"],
    initial: "off",
  },
  background: {
    label: "Main background",
    hint: "A faint tile behind the main pane.",
    options: ["off", "backgrounds/fleur-de-lis-pattern"],
    initial: "off",
  },
  navIcons: {
    label: "Sidebar icons",
    hint: "Gold raster icons (best on the dark theme) instead of the vector set.",
    options: ["builtin", "gold"],
    initial: "builtin",
  },
  aboutHero: {
    label: "About banner",
    hint: "Settings → About.",
    options: ["off", "backgrounds/splash-dark", "backgrounds/splash-light", "branding/wordmark"],
    initial: "off",
  },
} satisfies Record<string, Slot>;

export type SlotName = keyof typeof SLOTS;
export type Choices = Record<SlotName, Choice>;

const KEY = "tm.ornaments";

export const DEFAULTS = Object.fromEntries(
  Object.entries(SLOTS).map(([name, slot]) => [name, slot.initial]),
) as Choices;

function load(): Choices {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const out = { ...DEFAULTS };
    if (saved && typeof saved === "object") {
      for (const name of Object.keys(SLOTS) as SlotName[]) {
        const v = (saved as Record<string, unknown>)[name];
        if (typeof v === "string" && (SLOTS[name].options as string[]).includes(v)) out[name] = v;
      }
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

interface LabState {
  choices: Choices;
  open: boolean;
  set(slot: SlotName, choice: Choice): void;
  reset(): void;
  setOpen(open: boolean): void;
}

export const useOrnaments = create<LabState>((set, get) => ({
  choices: import.meta.env.DEV && typeof localStorage !== "undefined" ? load() : { ...DEFAULTS },
  open: false,
  set(slot, choice) {
    const choices = { ...get().choices, [slot]: choice };
    set({ choices });
    try {
      localStorage.setItem(KEY, JSON.stringify(choices));
    } catch {
      // Not persisted; still applied for this session.
    }
  },
  reset() {
    set({ choices: { ...DEFAULTS } });
    try {
      localStorage.removeItem(KEY);
    } catch {
      // Nothing saved.
    }
  },
  setOpen(open) {
    set({ open });
  },
}));

/** The slot's current choice, or null when it is "off" or "builtin". The clean theme
 *  (ADR 021) draws no ornaments, so every slot is null there. */
export function useOrnament(slot: SlotName): string | null {
  const choice = useOrnaments((s) => s.choices[slot]);
  const clean = useIsClean();
  if (clean) return null;
  return choice === "off" || choice === "builtin" ? null : choice;
}

/** URL of the slot's chosen pack asset, or null. */
export function useOrnamentUrl(slot: SlotName): string | null {
  const key = useOrnament(slot);
  return key ? (PACK[key] ?? null) : null;
}

/** Display name for a choice: "decorations/ribbon-left" → "ribbon left". */
export function choiceLabel(choice: Choice): string {
  if (choice === "off") return "Off";
  if (choice === "builtin") return "Built-in";
  if (choice === "gold") return "Gold";
  return (choice.split("/").pop() ?? choice).replace(/^app-/, "").replace(/-/g, " ");
}

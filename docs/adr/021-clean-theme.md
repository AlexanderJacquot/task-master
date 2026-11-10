# ADR 021: Clean theme

Date: 2026-11-10 · Status: accepted

## Context

The parchment and dark themes share an illuminated, medieval look (MedievalSharp titles,
serif body, engraved icons, rubric headings, wax seals and dividers; ADR 008, ADR 019).
The user asked for a plain, professional light theme beside them, "like Notion: very clean
and elegant", where the icons and the whole UI change with it.

## Decisions

**A fourth theme choice, `clean`.** Settings → Appearance offers Dark, Parchment, Clean and
Follow the system. With "Follow the system", a second choice picks the light theme to use
(Parchment or Clean, `task-master.theme-light`, parchment by default). `lib/theme.ts` sets a
`clean` class on `<html>` next to the existing `dark` class (neither means parchment), and
keeps the resolved look (`medieval` or `clean`) in a small zustand store (`useLook`,
`useIsClean`) for components that draw differently.

**Colors and type are variables, as before.** `:root.clean` fills the `--tm-*` tokens with
a Notion-like palette: white pages, a `#f8f8f7` sidebar, warm charcoal ink `#37352f`, grey
secondary text, hairline borders and one blue accent (`#2383e2`). It also redefines
`--font-display` and `--font-sans` as Inter, bundled so the theme reads the same on every OS
(new dependency, OFL licensed: `@fontsource-variable/inter` 5.3.0, the weight and optical
size axes, roman and italic). The browser fetches a font file only when text uses it, so
the medieval themes never load Inter. Unlayered rules turn the
display face's places into semibold sans with tight tracking (overriding `tracking-wide`),
buttons into medium weight, and accent-tinted display titles back to ink. Drop caps are
off, prose headings are ink, menus get a neutral shadow, and the parchment textures
(`tex-*`) apply only to parchment (`:root:not(.dark, .clean)`).

**A `clean:` variant** (`@custom-variant clean`) handles the few per-component changes:
grey sidebar icons, Notion-style section labels, borderless board columns, the full task
page without its card.

**Icons.** Every medieval glyph in `components/TaskIcons.tsx` has a lucide counterpart
(`CLEAN` map: anvil → Settings, brazier → Trash2, lantern → Search...), drawn 8% smaller
with a 1.75 stroke. Call sites are unchanged. Engraved project icons
(`features/organize/ProjectMark.tsx`) map to lucide icons tinted with the project color.

**Ornaments and logo.** `useOrnament` returns null for every slot in the clean look (no
divider, wax seal, crest...), and the logo and favicon use `assets/brand/logo-clean.svg`,
a charcoal tile with a white check.

**Wording.** The Metrics page names figures by their plain measure in the clean look
("Created", "Burn-down", "By project") instead of the chronicle titles.

## Consequences

- A component that adds a new medieval glyph must add its lucide counterpart to `CLEAN`
  (the map is typed over `paths.json`, so a missing entry fails the type check).
- Inter adds about 0.7 MB of WOFF2 files (all subsets, roman and italic) to the bundle.
- No clean dark variant: "Follow the system" pairs Clean with the medieval dark theme.

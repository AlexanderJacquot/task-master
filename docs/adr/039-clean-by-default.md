# ADR 039: Clean by default, a clean dark theme, the medieval look as an easter egg

Date: 2026-11-24 · Status: accepted

## Context

The app opened in the medieval dark theme (ADR 008), with Parchment and Clean (ADR 021) as
alternatives and no clean dark theme: "Follow the system" paired Clean with the candlelit
medieval dark one. The user asked to redo the whole visual presentation: keep the medieval
theme "more as an easter egg", still available in Settings, make light the default, and
rework dark mode to "follow the clean design of light and not a dark parchment mode". The
logo, the README and the project site were to follow the same direction.

## Decisions

**Two independent choices.** Settings → Appearance offers Light, Dark and Follow the system,
and below them an "Illuminated manuscript" checkbox for the medieval look. The mode is kept
in `task-master.appearance` (`light` by default), the look in `task-master.medieval`
(`on`/`off`, off by default). The medieval look keeps both of its themes: Parchment in light
mode, the candlelit dark one in dark mode, so "Follow the system" works with either look.
Weathering and paper sounds show only while it is on.

**Classes on `<html>` compose.** `clean` marks the clean look and `dark` a dark mode, so
clean dark is `clean dark`, medieval dark is `dark` alone and Parchment neither. Every
existing `dark:` and `clean:` variant keeps working: the `dark:` ones were all generic
contrast tweaks, the `clean:` ones layout and type. `:root.clean.dark` fills the `--tm-*`
tokens after the light block: charcoal layers (`#191919` canvas, `#202020` sidebar,
`#252525` cards), warm off-white ink `#e8e7e4`, hairline white borders and the same blue
accent, a step brighter (`#3b91ea`) for contrast. Menus get a dark shadow.

**Earlier choices carry over.** Without the new keys, the old `task-master.theme` is read:
`dark` → Dark (now clean), `system` → Follow the system, `clean` → Light, and `light`
(Parchment, chosen on purpose) → Light with the medieval look on. Everyone else starts on
the clean light theme.

**Roadmap images** get a fourth theme, `clean_dark` (`ImageTheme::CleanDark` in the core),
so an export from the clean dark theme matches it. The server's `theme` parameter accepts it.

**Logo.** `assets/brand/logo.svg` replaces `logo-clean.svg`: a charcoal tile with three
stacked pills, the zen-stone stack of the earlier icon (0.20.1) redrawn as a stack of tasks,
the top one ticked in the accent blue. It is the logo and favicon in the clean look and the
source of every native icon (`generate-app-icons.mjs`) and the site's icon. The medieval
look keeps its pack logo.

**README and site.** The README leads with the logo and a plain title, and its screenshots
are the clean themes (PNG, from the showcase). The site uses the clean palette with the
system's sans-serif (no web fonts, as before), follows the visitor's light or dark setting,
and shows the board in whichever matches.

## Consequences

- ADR 021's "No clean dark variant" no longer holds; the clean look is the default.
- The native icon changes with the next release.
- Screenshots come from the built-in browser pane at 800 × 500; a sharper set needs a
  headless browser with a larger viewport.

# ADR 019: Raster asset pack and the development asset lab

Date: 2026-11-09 · Status: accepted

## Context

The user made a painted, medieval PNG asset pack (`task-master-png-assets.zip`): 16 app
icon variants, gold UI icons, wax seals, ribbons, a divider, a wordmark, splash images and a
background tile. Until now the app logo and every in-app ornament were vector (ADR-free
house style in `src/assets/README.md`). The user wanted to try the pack around the UI,
switch pieces quickly, and then keep a few, without carrying the 56 MB of PNGs or the
switching UI into releases.

## Decisions

**Imported as WebP.** `scripts/asset-pack/import.sh <zip>` trims and resizes every PNG to
WebP in `apps/desktop/src/assets/pack` (~930 KB) and writes `manifest.json`, the list of
assets. The 1024 px app icon sources it also writes (`app-icons/source/`) are gitignored.

**Slots.** `src/lib/ornaments.ts` defines named places in the UI (logo, title flourish,
empty page, done stamp, ...) with their allowed assets; components in
`features/ornaments/Ornaments.tsx` render a slot's choice or nothing. Each slot's `initial`
choice is the shipped look.

**The lab is development-only.** `AssetLab` (Ctrl+Alt+A, or a button in Settings →
Appearance) and the remembered per-machine choices exist only when `import.meta.env.DEV`.
In development the lab lists the manifest and Vite serves the files directly, so nothing
is imported. Release builds use the `initial` choices and import only the files listed in
`RELEASE_FILES`, which must be kept in step with them. Checked: a release build bundles
only those assets and no lab code.

**Native icon from the pack.** `scripts/asset-pack/set-app-icon.sh <variant>` regenerates
`src-tauri/icons` from an imported icon; `generate-app-icons.mjs` now takes a source path
and defaults to `src-tauri/app-icon.png`, the current 1024 px icon, so `pnpm
assets:generate` no longer reverts it to the vector logo. Shipped: `app-linux-purple` as
the native icon, `app-banner` as the in-app logo and favicon, the divider under page
titles and the full wax seal on empty pages.

## Consequences

- Changing a shipped choice means editing both the slot's `initial` and `RELEASE_FILES`.
- The vector `brand/app-icon.svg` stays as the logo's built-in fallback and the source of
  `logo-mark.svg`.
- A background tile from the pack must be measured with `scripts/paint-bench/run.sh`
  before it ships (docs/rendering-performance.md).

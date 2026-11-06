# Task Master asset library

These are original vector assets rebuilt using the two supplied Medieval Brand Asset Board / Medieval Asset Pack images as visual references. The board labels described possible assets; no exports were extracted from them.

## UI icons

`icons/*.svg` are standalone, path-only SVGs. All use a 24 × 24 viewBox, a 1.75-unit stroke, rounded caps and joins, no fill, and `currentColor`. There are no embedded images, fonts, or external dependencies. Use at 24 px where possible; the proof sheet also shows 16 and 32 px.

Every icon follows the medieval theme:

| Icon                    | Motif                           | Used for                        |
| ----------------------- | ------------------------------- | ------------------------------- |
| `add`                   | cross with manuscript terminals | new task, add buttons           |
| `inbox`                 | sealed letter                   | Inbox                           |
| `projects`              | castle keep                     | Projects heading                |
| `due-date`              | hourglass                       | due dates                       |
| `settings`              | anvil                           | Settings                        |
| `search`                | lantern                         | search fields                   |
| `delete`                | brazier                         | delete / remove                 |
| `agents`                | knight's great helm             | agents, agent tasks             |
| `calendar`              | open almanac                    | Calendar                        |
| `all-tasks`             | open scroll                     | All tasks                       |
| `archive` / `unarchive` | closed chest / open chest       | archive, unarchive              |
| `priority`              | swallowtail pennant             | priority flag, epic "flag" mark |
| `bookmark`              | gonfalon banner                 | saved views                     |
| `edit`                  | quill                           | rename / edit                   |
| `metrics`               | balance scales                  | Metrics                         |
| `lineage`               | oak tree                        | Lineage                         |
| `send`                  | fletched arrow                  | send to agent                   |
| `estimate`              | candle clock                    | estimates, worked time, stale   |
| `done`                  | wax seal with a tick            | up to date                      |
| `crown`, `shield`       | crown, heater shield            | extra epic marks                |

Navigation and control glyphs (chevrons, close, check, grip, more) stay as lucide icons for legibility at small sizes.

The canonical path data is `icons/paths.json`. React components in `components/TaskIcons.tsx` consume it directly, and `scripts/generate-ui-icons.mjs` produces matching SVG files. Pass `size`, `className`, and standard SVG props to the components. They inherit text color and are decorative by default; name the surrounding button or link for assistive technology.

Call sites import them under the lucide name they replaced (`DeleteIcon as Trash2`). Project-specific emoji and color choices remain available.

## Brand

- `brand/app-icon.svg`: square app logo with an ink tile, gold border, parchment checklist scroll, and red crown seal. All shapes and gradients are vector; no raster or text.
- `brand/logo-mark.svg`: the scroll and seal without the tile, generated from the same source.
- `preview.svg`: actual assets shown on parchment and dark backgrounds, plus logo size proofs. Open this file in a browser or vector editor.

Palette: ink `#1F1A16`, parchment `#F5E8D0`, aged gold `#D4A241`, wax red `#8B2A26`. The existing app theme supplies the UI icon colors.

The app logo is wired into the sidebar, About panel, and web favicon. Tauri's configured native icon paths now contain generated PNG, Windows ICO, and macOS ICNS exports (along with its platform-specific sizes). These are the logo files used for the next built installer/application; an already installed build must be rebuilt/reinstalled to receive them. The browser and in-app logo use the SVG directly.

## Regenerate

From the repository root, with dependencies installed:

```sh
pnpm assets:generate
```

This exports the icon SVGs, the transparent logo mark, the proof sheet, every native icon via the installed Tauri CLI, and the 1024 px `src-tauri/app-icon.png`. Edit `icons/paths.json` for UI geometry, and `brand/app-icon.svg` for the logo, then regenerate. Native PNG/ICO/ICNS files are raster platform deliverables; the UI icon SVGs remain pure vector.

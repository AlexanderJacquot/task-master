# Rendering performance: backgrounds, textures and effects

The app must stay at 60 fps (16.7 ms per frame) while you drag a task or type. Data and
JavaScript are rarely the problem; painting pixels is. These rules come from measurements
made on 2026-11-06, after the 0.7.0 AppImage lagged badly on Linux (progress.md, "Lag on
Linux: parchment texture repaints").

## Why Linux sets the bar

Each OS paints the UI with a different engine:

| OS | Engine | Who ships it | Painting |
|---|---|---|---|
| Windows | WebView2 (Chromium) | Microsoft, updated with Edge | GPU |
| macOS | WKWebView (WebKit) | Apple, with the OS | GPU (Core Animation) |
| Linux .deb / .rpm / native | WebKitGTK | the distribution | GPU when the driver stack works |
| Linux AppImage | WebKitGTK **bundled** from the CI runner (Ubuntu 22.04) | us | often **CPU** |

The AppImage's WebKitGTK (2.50.4 in 0.7.0) chooses CPU or GPU painting for each page
itself, depending on the content; small CSS changes flip it, so you cannot steer it. On
the CPU path, every repaint is rasterized in software by `SkiaCPUWorker` threads. Design
for that worst case: whatever is fast there is fast everywhere.

Do not "fix" lag with `WEBKIT_DISABLE_DMABUF_RENDERER=1` or
`WEBKIT_DISABLE_COMPOSITING_MODE=1`: both made the bundled WebKit about 4x slower.

## Measured costs

`scripts/paint-bench` runs: a 1600x1000 page like the app, a card moving across the board
and a character typed every frame for 6 s. Laptop with Iris Xe, KWin Wayland.
Times are the average per frame.

| Background or effect | System WebKitGTK 2.54 | AppImage 2.50, CPU path |
|---|---|---|
| Flat colours (baseline) | 16.7 ms | 39 ms |
| `repeating-linear-gradient`, 1px stripes every 5 px (0.7.0 fibre) | 16.7 ms | **167 to 276 ms** |
| `repeating-linear-gradient`, a 1px line every 48 px | 16.7 ms | 53 ms |
| `radial-gradient` vignette | 16.7 ms | 42 ms |
| Small SVG tile (`url("data:image/svg+xml,...")`, repeated) | 16.7 ms | 17 ms* |
| PNG, full window, `background-size: cover` | 16.7 ms | 39 ms |
| Same, `background-attachment: fixed` | 16.7 ms | 40 ms |
| PNG 256 px noise tile, repeated | 16.7 ms | 40 ms |
| SVG `feTurbulence` noise tile | 16.7 ms | 17 ms* |
| `backdrop-filter: blur()` on the sidebar and a card | 16.7 ms | 36 ms |
| `filter: drop-shadow()` on every card | 16.7 ms | 17 ms* |
| Two-layer `box-shadow` (12/40 px) on every card | 16.7 ms | 31 ms |

The parchment theme's WebPs (2026-11-06, 0.7.0 AppImage, painting forced onto the CPU with
`WEBKIT_SKIA_ENABLE_CPU_RENDERING=1`, canvas and sidebar textured as in `src/index.css`):

| Background | System, CPU forced | AppImage, CPU forced |
|---|---|---|
| Flat colours (baseline) | 16.8 ms | 43.5 to 44.8 ms |
| Calfskin 1024 px tile (the default) | 16.7 ms | 49 ms |
| Calfskin + all four weathering layers | 27 ms | 50.4 ms |

Without forcing, both WebKits painted these pages on the GPU at 16.7 to 17.4 ms. The
weathering cost on the system CPU path comes from the three window-sized layers being
rescaled on every repaint (~3 ms each), not from `background-attachment: fixed` (26 ms
without it). That is why weathering is opt-in and off by default.

\* These pages switched the bundled WebKit to GPU painting, so they say little about the
CPU cost. Treat them as "fine", not as a speed-up to rely on.

The "AppImage 2.50, CPU path" column is the worst case. A row costs as much as the flat
baseline plus its own delta. Only gradients that repeat over a short distance are
catastrophic: their cost scales with the number of stripes in the repainted area.

## Rules

1. **No `repeating-linear-gradient` / `repeating-radial-gradient` / `repeating-conic-gradient`
   with a period under ~32 px on any large surface** (canvas, sidebar, sheets, menus). Draw
   fine patterns as an image tile instead (SVG data URI or PNG). A pattern that combines
   periods p and q needs a tile lcm(p, q) wide; see `.tex-canvas` in `src/index.css`.
2. **Images are cheap. Use them for texture.** A pre-rendered parchment PNG or WebP, full
   window (`background-size: cover`) or tiled, costs no more than a flat colour. Prefer
   WebP for photographic textures (a 1600x1000 parchment: 5 KB WebP vs 340 KB PNG). Keep
   the source image in the repo and bundle it with Vite (`url(./assets/...)`), never a
   remote URL. Size a full-window image for the largest common screen (2560 px wide at
   most) so it is not decoded larger than needed. A full-window image is rescaled on each
   CPU repaint (~3 ms per layer above); stack few of them, and prefer tiles drawn at their
   own size. Optional layers go behind a CSS variable that stays `none` until enabled, so
   they are never fetched or decoded while off (see the weathering in `src/index.css`).
   `scripts/parchment/generate.py` makes the parchment textures.
3. **`background-attachment: fixed` is allowed but pointless** on elements that do not
   scroll (the app root is `h-full overflow-hidden`). Leave it out unless the element
   scrolls and the texture must stay put.
4. **Smooth gradients are fine**: one or two `radial-gradient` / `linear-gradient` layers
   for vignettes and light falloff.
5. **Use blur sparingly**: `backdrop-filter` only on small or rarely visible surfaces
   (popovers, the command palette), not on the full sidebar or board. Large box-shadow
   stacks on every card add up on the CPU path. Prefer one soft shadow per card.
6. **The dark theme follows the same rules.** It is flat today; a texture added there
   needs the same treatment.
7. **Measure before you ship a new texture or effect.** Run the benchmark against the
   current release AppImage (below). Accept a change when the AppImage average stays
   within a few ms of its baseline and the system run stays at 16.7 ms.

## Measuring

```sh
# candidate.css: the rules under test, in light mode, without the :root:not(.dark) prefix.
# Images it references by relative url() must sit next to it.
scripts/paint-bench/run.sh candidate.css ~/Downloads/task-master_<version>_amd64.AppImage
```

To measure the CPU path even when WebKit picks the GPU for the page (the runs marked *
above), prefix the command with `WEBKIT_SKIA_ENABLE_CPU_RENDERING=1`.

It needs gcc and the webkit2gtk-4.1 development files (on Arch, `webkit2gtk-4.1`). It
opens a window for about 10 s per run and prints, for the baseline and for your CSS, the
average and p95 frame time and `skia_cpu_s`, the seconds of software rasterization in the
6 s run. Read it like this:

- `avg_ms` near 16.7: smooth. Above ~25 ms you will feel it; above 50 ms it stutters.
- `skia_cpu_s` near 0: GPU painting. Near 9 to 10: CPU painting of a flat page. Much more
  than baseline: your CSS is expensive to rasterize.

To see where a running app spends its time without tools, compare per-thread CPU:

```sh
pid=$(pgrep -f WebKitWebProcess | head -1)
for t in /proc/$pid/task/*; do printf '%s ' "$(cat $t/comm)"; \
  awk '{sub(/^.*\) /,""); split($0,a," "); print (a[12]+a[13])/100 "s"}' $t/stat; done | sort -k2 -rn | head
```

`SkiaCPUWorker` dominating means painting; `WebKitWebProcess` (the main thread)
dominating means JavaScript, styles or layout.

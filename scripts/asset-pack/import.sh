#!/usr/bin/env bash
# Imports the PNG asset pack (task-master-png-assets.zip) as small WebP files that the
# app's asset lab can switch between (src/lib/ornaments.ts). The source PNGs (~56 MB)
# stay outside the repo; this keeps a trimmed, resized copy of each one.
#
#   scripts/asset-pack/import.sh ~/Downloads/task-master-png-assets.zip
#
# Requires ImageMagick 7 (`magick`). Re-run after the pack changes; output is overwritten.
set -euo pipefail

zip=${1:?usage: import.sh <task-master-png-assets.zip>}
root=$(cd "$(dirname "$0")/../.." && pwd)
out="$root/apps/desktop/src/assets/pack"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

unzip -q "$zip" -d "$work"
src=$(find "$work" -name assets.json -printf '%h\n' | head -1)
[[ -n $src ]] || { echo "assets.json not found in $zip" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out"/{app-icons,ui,wax-seals,decorations,backgrounds,branding}

# convert <in> <out.webp> <geometry> [extra magick args...]
convert() {
  local in=$1 dst=$2 geo=$3
  shift 3
  magick "$in" -trim +repage "$@" -resize "$geo" -strip -define webp:alpha-quality=95 \
    -quality 86 "$dst"
}

for f in "$src"/app-icons/*.png; do
  n=$(basename "$f" .png)
  # Square, centred, transparent: the tiles are not all exactly square after trimming.
  convert "$f" "$out/app-icons/$n.webp" 256x256 -background none -gravity center \
    -extent "%[fx:max(w,h)]x%[fx:max(w,h)]"
done
for f in "$src"/ui/*.png; do convert "$f" "$out/ui/$(basename "$f" .png).webp" 64x64; done
for f in "$src"/wax-seals/*.png; do
  convert "$f" "$out/wax-seals/$(basename "$f" .png).webp" 256x256
done
for f in "$src"/decorations/*.png; do
  convert "$f" "$out/decorations/$(basename "$f" .png).webp" 640x640
done
convert "$src/branding/wordmark.png" "$out/branding/wordmark.webp" 720x
# Backgrounds are opaque: no trim. The pattern becomes a 256 px tile.
magick "$src/backgrounds/fleur-de-lis-pattern.png" -resize 256x256 -strip -quality 82 \
  "$out/backgrounds/fleur-de-lis-pattern.webp"
for n in splash-dark splash-light; do
  magick "$src/backgrounds/$n.png" -resize 1280x -strip -quality 80 "$out/backgrounds/$n.webp"
done

# Full-size sources for the native app icon (scripts/asset-pack/set-app-icon.sh).
mkdir -p "$out/app-icons/source"
for f in "$src"/app-icons/*.png; do
  magick "$f" -trim +repage -background none -gravity center \
    -extent "%[fx:max(w,h)]x%[fx:max(w,h)]" -resize 1024x1024 -strip \
    "$out/app-icons/source/$(basename "$f")"
done

du -sh "$out" "$out/app-icons/source"

# The list the asset lab offers in development (src/lib/ornaments.ts); release builds
# import only the assets they use.
(cd "$out" && find . -name '*.webp' | sed 's|^\./||; s|\.webp$||' | sort |
  awk 'BEGIN { printf "[" } { printf "%s\n  \"%s\"", (NR > 1 ? "," : ""), $0 } END { print "\n]" }') \
  > "$out/manifest.json"

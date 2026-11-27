#!/usr/bin/env bash
# macOS only: renders apps/ios/AppIcon.svg into the app's asset catalog as the 1024 px
# icon iOS scales from. Rendered with the Tauri CLI the desktop icons use
# (scripts/generate-app-icons.mjs), then flattened: an App Store icon has no alpha channel.
set -euo pipefail
cd "$(dirname "$0")/../.."
out=apps/ios/Assets.xcassets/AppIcon.appiconset/AppIcon.png
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(cd apps/desktop && pnpm -s tauri icon "$PWD/../ios/AppIcon.svg" -o "$work" -p 1024 > /dev/null)
# Through JPEG (best quality) and back to drop the alpha channel; the SVG is opaque.
sips -s format jpeg -s formatOptions best "$work/1024x1024.png" --out "$work/icon.jpg" > /dev/null
sips -s format png "$work/icon.jpg" --out "$out" > /dev/null
echo "Wrote $out"

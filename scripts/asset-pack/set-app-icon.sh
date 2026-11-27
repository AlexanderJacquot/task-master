#!/usr/bin/env bash
# Makes one of the imported pack's app icons the native app icon (window, taskbar,
# installers) by regenerating every size in src-tauri/icons from it.
#
#   scripts/asset-pack/set-app-icon.sh app-windows-blue
#
# Run scripts/asset-pack/import.sh first. Takes effect on the next `pnpm tauri dev` or
# build; the in-app logo is switched separately in the asset lab (Ctrl+Alt+A).
set -euo pipefail

name=${1:?usage: set-app-icon.sh <variant, e.g. app-windows-blue>}
root=$(cd "$(dirname "$0")/../.." && pwd)
src="$root/apps/desktop/src/assets/pack/app-icons/source/$name.png"
[[ -f $src ]] || {
  echo "no such icon: $src" >&2
  ls "$(dirname "$src")" >&2
  exit 1
}

node "$root/scripts/generate-app-icons.mjs" "$src"
echo "Native app icon is now $name."

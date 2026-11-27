#!/bin/sh
# Paint benchmark for background and effect CSS. Linux only; needs gcc and the
# webkit2gtk-4.1 development files. Opens a window for ~10 s per run.
#
#   scripts/paint-bench/run.sh candidate.css [task-master.AppImage]
#
# Runs the page with no extra CSS (baseline) and with candidate.css, on the system
# WebKitGTK and, if an AppImage is given, on the WebKitGTK bundled inside it. Prints the
# average and p95 frame time (16.7 ms = 60 fps) and the CPU seconds of software
# rasterization per 6 s run. See docs/rendering-performance.md for how to read it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
css=$(realpath "$1")
appimage=${2:+$(realpath "$2")}
work=${XDG_CACHE_HOME:-$HOME/.cache}/task-master-paint-bench
mkdir -p "$work"
export PAINT_BENCH_DIR="$here" LC_ALL=C

if [ ! -x "$work/harness" ] || [ "$here/harness.c" -nt "$work/harness" ]; then
  # shellcheck disable=SC2046
  gcc -O1 -o "$work/harness" "$here/harness.c" $(pkg-config --cflags --libs webkit2gtk-4.1 gtk+-3.0)
fi

# Pages: the template with nothing or the candidate CSS in place of the marker.
cp "$here/page.html" "$work/baseline.html"
awk -v f="$css" '/\/\* CANDIDATE_CSS \*\//{ while ((getline l < f) > 0) print l; next } { print }' \
  "$here/page.html" > "$work/candidate.html"
# Relative url()s in the candidate resolve next to it.
for asset in "$(dirname "$css")"/*.png "$(dirname "$css")"/*.webp "$(dirname "$css")"/*.jpg "$(dirname "$css")"/*.svg; do
  [ -f "$asset" ] && cp "$asset" "$work/"
done

run() { # label, then env assignments before the harness
  label=$1; shift
  for page in baseline candidate; do
    printf '%-8s %-9s ' "$label" "$page"
    env "$@" "$work/harness" "file://$work/$page.html" 2>/dev/null | tail -1
  done
}

run system

if [ -n "$appimage" ]; then
  # Extract once per AppImage; its WebKit finds its helper processes relative to usr/.
  dir="$work/appimage-$(stat -c %Y "$appimage")"
  if [ ! -d "$dir/squashfs-root" ]; then
    mkdir -p "$dir" && (cd "$dir" && "$appimage" --appimage-extract > /dev/null)
  fi
  root="$dir/squashfs-root"
  cd "$root/usr"
  run appimage LD_LIBRARY_PATH="$root/usr/lib:$root/usr/lib/x86_64-linux-gnu" \
    GTK_PATH="$root/usr/lib/gtk-3.0" GIO_MODULE_DIR="$root/usr/lib/gio/modules" \
    GDK_PIXBUF_MODULE_FILE="$root/usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache" \
    GTK_THEME=Adwaita:light
fi

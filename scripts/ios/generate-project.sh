#!/usr/bin/env bash
# Generates apps/ios/TaskMaster.xcodeproj from apps/ios/project.yml (ADR 040).
#
# XcodeGen finds its setting presets (Xcode's Debug/Release defaults and warnings) in
# ../share/xcodegen next to the path it was started from. Started through a Nix profile
# symlink, that folder is missing and XcodeGen only warns, leaving a project without
# them (Debug builds optimized, no DEBUG flag, Xcode's "recommended settings" warnings).
# So run the real binary, and fail if the presets were still not found.
set -euo pipefail
cd "$(dirname "$0")/../.."
xcodegen=$(command -v xcodegen) || { echo "xcodegen is not installed" >&2; exit 1; }
xcodegen=$(readlink -f "$xcodegen")
out=$("$xcodegen" generate --spec apps/ios/project.yml 2>&1) || { echo "$out" >&2; exit 1; }
echo "$out"
if grep -q 'settings found' <<< "$out"; then
  echo "xcodegen did not find its setting presets next to $xcodegen" >&2
  exit 1
fi

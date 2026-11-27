#!/usr/bin/env bash
# macOS only: builds the app for a connected iPhone, signs it with your team, installs it
# and opens it (ADR 040).
#
#   TEAM=<team id> scripts/ios/device.sh [--free]
#
# TEAM: the Apple developer team ID (Xcode shows it once a project picked the team).
# DEVICE: a device UDID; by default the first iPhone connected with Developer Mode on.
# --free: a free Apple ID (Personal Team) can have neither the App Group nor Enhanced
# Security, the only entitlements in project.yml, so the build signs with none: the app
# keeps its data in its own folder (SharedStore), the widgets and share extension see none
# of it, and the hardened-process protections are off. A free team's installs stop opening
# after 7 days.
# The first install of a team needs the phone to trust it: Settings → General → VPN &
# Device Management.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${TEAM:?Set TEAM to your Apple developer team ID}"
free=false
[ "${1:-}" = "--free" ] && free=true

devices=$(mktemp)
trap 'rm -f "$devices"' EXIT
xcrun devicectl list devices --json-output "$devices" > /dev/null
udid=${DEVICE:-$(python3 -c '
import json, sys
for d in json.load(open(sys.argv[1]))["result"]["devices"]:
    h = d["hardwareProperties"]
    if h.get("reality") == "physical" and h.get("platform") == "iOS" \
            and d.get("deviceProperties", {}).get("developerModeStatus") == "enabled":
        print(h["udid"]); break' "$devices")}
[ -n "$udid" ] || { echo "No iPhone with Developer Mode on is connected" >&2; exit 1; }

scripts/ios/build-xcframework.sh
scripts/ios/generate-project.sh
# For this build only, an empty entitlements file of its own. Emptying the generated files
# instead would also strip the next simulator build, and installing that one makes the
# simulator delete the App Group container with the app's data. An empty
# CODE_SIGN_ENTITLEMENTS is not enough: provisioning still reads the target's file.
signing=()
if $free; then
  plutil -create xml1 apps/ios/build/Free.entitlements
  signing=(CODE_SIGN_ENTITLEMENTS=build/Free.entitlements ENABLE_ENHANCED_SECURITY=NO)
fi

# A clean environment: devenv's PATH puts a Nix ld in front of Xcode's.
log=apps/ios/build/device-build.log
status=0
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  xcodebuild build -project apps/ios/TaskMaster.xcodeproj -scheme TaskMaster \
  -destination "id=$udid" -derivedDataPath apps/ios/build/DeviceData \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
  ${signing[@]+"${signing[@]}"} > "$log" 2>&1 || status=$?
grep -E "error:|warning:|\*\* BUILD" "$log" | sort -u || true
[ "$status" -eq 0 ] || { echo "The build failed: $log" >&2; exit "$status"; }
app=apps/ios/build/DeviceData/Build/Products/Debug-iphoneos/TaskMaster.app

xcrun devicectl device install app --device "$udid" "$app"
xcrun devicectl device process launch --device "$udid" space.solarnexus.taskmaster

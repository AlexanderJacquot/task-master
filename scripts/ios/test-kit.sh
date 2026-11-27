#!/usr/bin/env bash
# Runs TaskMasterKit's tests.
# Linux: against the Rust library in target/debug; needs a Swift toolchain (swiftly:
# `. ~/.local/share/swiftly/env.sh`).
# macOS: on an iPhone simulator (the XCFramework has no macOS slice), the booted one or
# the one in $SIMULATOR (a UDID). Builds the simulator XCFramework first.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ "$(uname -s)" = Darwin ]; then
  scripts/ios/build-xcframework.sh sim
  udid="${SIMULATOR:-$(xcrun simctl list devices booted -j | python3 -c '
import json, sys
booted = [d for ds in json.load(sys.stdin)["devices"].values() for d in ds]
print(booted[0]["udid"] if booted else "")')}"
  [ -n "$udid" ] || { echo "Boot a simulator or set SIMULATOR to a UDID" >&2; exit 1; }
  cd apps/ios/TaskMasterKit
  # A clean environment: devenv's PATH puts a Nix ld in front of Xcode's.
  exec env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    xcodebuild test -scheme TaskMasterKit -destination "id=$udid" \
    -derivedDataPath ../build/KitDerivedData "$@"
fi
scripts/ios/generate-bindings.sh
export LD_LIBRARY_PATH="$PWD/target/debug${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
cd apps/ios/TaskMasterKit
swift test "$@"

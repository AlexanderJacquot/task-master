#!/usr/bin/env bash
# Runs TaskMasterKit's tests on Linux against the Rust library in target/debug.
# Needs a Swift toolchain (swiftly: `. ~/.local/share/swiftly/env.sh`).
set -euo pipefail
cd "$(dirname "$0")/../.."
scripts/ios/generate-bindings.sh
export LD_LIBRARY_PATH="$PWD/target/debug${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
cd apps/ios/TaskMasterKit
swift test "$@"

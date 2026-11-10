#!/usr/bin/env bash
# Builds crates/mobile and generates its Swift bindings (ADR 022) into TaskMasterKit.
# The generated files are never edited by hand and are not checked in: they must match
# the library they were generated from.
set -euo pipefail
cd "$(dirname "$0")/../.."
kit=apps/ios/TaskMasterKit
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
cargo build -p taskmaster-mobile
case "$(uname -s)" in
  Darwin) lib=target/debug/libtaskmaster_mobile.dylib ;;
  *) lib=target/debug/libtaskmaster_mobile.so ;;
esac
cargo run -q -p taskmaster-mobile --features cli --bin uniffi-bindgen -- \
  generate --library "$lib" --language swift --out-dir "$out" 2>/dev/null
cp "$out/taskmaster_mobile.swift" "$kit/Sources/TaskMasterFFI/taskmaster_mobile.swift"
cp "$out/taskmaster_mobileFFI.h" "$kit/Sources/taskmaster_mobileFFI/include/taskmaster_mobileFFI.h"
# For the XCFramework's Headers folder (scripts/ios/build-xcframework.sh).
mkdir -p apps/ios/build/headers
cp "$out/taskmaster_mobileFFI.h" apps/ios/build/headers/
cp "$out/taskmaster_mobileFFI.modulemap" apps/ios/build/headers/module.modulemap
echo "Swift bindings written to $kit"

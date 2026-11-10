#!/usr/bin/env bash
# Generates the Swift bindings of crates/mobile (ADR 022) into the directory given
# (default: apps/ios/TaskMasterKit/Sources/TaskMasterFFI/generated). The output is never
# edited by hand and is not checked in: it must match the library it was generated from.
set -euo pipefail
cd "$(dirname "$0")/../.."
out="${1:-apps/ios/TaskMasterKit/Sources/TaskMasterFFI/generated}"
cargo build -p taskmaster-mobile
case "$(uname -s)" in
  Darwin) lib=target/debug/libtaskmaster_mobile.dylib ;;
  *) lib=target/debug/libtaskmaster_mobile.so ;;
esac
cargo run -q -p taskmaster-mobile --features cli --bin uniffi-bindgen -- \
  generate --library "$lib" --language swift --out-dir "$out"
echo "Swift bindings written to $out"

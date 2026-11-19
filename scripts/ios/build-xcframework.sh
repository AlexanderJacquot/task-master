#!/usr/bin/env bash
# macOS only: builds crates/mobile for the iPhone and the simulator and packages it,
# with the generated header, as an XCFramework inside TaskMasterKit (ADR 030).
# Pass `sim` to build the simulator slice only (CI).
set -euo pipefail
cd "$(dirname "$0")/../.."
export IPHONEOS_DEPLOYMENT_TARGET=26.0
targets=(aarch64-apple-ios-sim)
[ "${1:-}" = "sim" ] || targets+=(aarch64-apple-ios)

scripts/ios/generate-bindings.sh
out=apps/ios/TaskMasterKit/Frameworks/TaskMasterMobile.xcframework
rm -rf "$out"
args=()
for target in "${targets[@]}"; do
  # rustup on the CI runner; in devenv (no rustup) devenv.nix provides the iOS targets.
  if command -v rustup > /dev/null; then
    rustup target add "$target"
  elif [ ! -d "$(rustc --print sysroot)/lib/rustlib/$target" ]; then
    echo "The Rust standard library for $target is missing: add it to devenv.nix" >&2
    exit 1
  fi
  cargo build --release -p taskmaster-mobile --target "$target"
  args+=(-library "target/$target/release/libtaskmaster_mobile.a" -headers apps/ios/build/headers)
done
xcodebuild -create-xcframework "${args[@]}" -output "$out"
echo "Built $out"

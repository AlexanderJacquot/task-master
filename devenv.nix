{ pkgs, lib, config, ... }:

let
  state = config.devenv.state;
in
{
  # Caches and downloads stay in this checkout (.devenv/ is git-ignored), not in $HOME.
  env = {
    CARGO_HOME = "${state}/cargo";
    COREPACK_HOME = "${state}/corepack";
    npm_config_cache = "${state}/npm-cache";
    # pnpm: content store, metadata cache and state (its defaults are under ~/Library).
    pnpm_config_store_dir = "${state}/pnpm/store";
    pnpm_config_cache_dir = "${state}/pnpm/cache";
    pnpm_config_state_dir = "${state}/pnpm/state";
    PNPM_HOME = "${state}/pnpm/home";
    XDG_CACHE_HOME = "${state}/cache";
  } // lib.optionalAttrs pkgs.stdenv.isDarwin {
    # iOS builds use Xcode's clang (/usr/bin shims follow xcode-select): the Nix clang
    # wrapper adds a macOS minimum version that clang rejects for iOS targets.
    CC_aarch64_apple_ios = "/usr/bin/clang";
    AR_aarch64_apple_ios = "/usr/bin/ar";
    CARGO_TARGET_AARCH64_APPLE_IOS_LINKER = "/usr/bin/clang";
    CC_aarch64_apple_ios_sim = "/usr/bin/clang";
    AR_aarch64_apple_ios_sim = "/usr/bin/ar";
    CARGO_TARGET_AARCH64_APPLE_IOS_SIM_LINKER = "/usr/bin/clang";
  };

  # Same toolchain as CI: version and components from rust-toolchain.toml.
  languages.rust = {
    enable = true;
    channel = "stable";
    version = "1.99.1";
    components = [ "rustc" "cargo" "clippy" "rustfmt" "rust-analyzer" "rust-src" ];
    # macOS: both desktop architectures, plus iPhone and the iOS simulator for crates/mobile.
    targets = lib.optionals pkgs.stdenv.isDarwin [
      "aarch64-apple-darwin"
      "x86_64-apple-darwin"
      "aarch64-apple-ios"
      "aarch64-apple-ios-sim"
    ];
  };

  # macOS: build against the installed Xcode (xcode-select), not a Nix copy of the macOS
  # SDK. The Nix SDK has no iOS platform, and it set DEVELOPER_DIR and SDKROOT and put
  # xcbuild's stand-in xcrun first on PATH, which hid Xcode from xcodebuild and xcrun.
  apple.sdk = null;

  # Node 24 (package.json `engines`); corepack provides the pnpm pinned in `packageManager`.
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    corepack.enable = true;
  };

  # whisper-rs-sys builds whisper.cpp with CMake on every platform. Tauri on Linux needs
  # WebKitGTK and friends; macOS uses the system frameworks.
  packages = [ pkgs.cmake ] ++ lib.optionals pkgs.stdenv.isLinux (with pkgs; [
    pkg-config
    openssl
    webkitgtk_4_1
    libsoup_3
    librsvg
    libayatana-appindicator
    xdotool
  ]);

  enterShell = ''
    rustc --version
    node --version
  '';
}

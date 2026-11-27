{ pkgs, lib, config, ... }:

let
  state = config.devenv.state;
  # cc-rs (and the cmake crate through it) and cargo read these per target, so nothing
  # else in the shell changes: CC_<target>, CXX_<target>, AR_<target>, and the linker.
  appleToolchain = targets: lib.foldl' (env: target:
    let
      under = builtins.replaceStrings [ "-" ] [ "_" ] target;
    in
    env // {
      "CC_${under}" = "/usr/bin/clang";
      "CXX_${under}" = "/usr/bin/clang++";
      "AR_${under}" = "/usr/bin/ar";
      "CARGO_TARGET_${lib.toUpper under}_LINKER" = "/usr/bin/clang";
    }) { } targets;
in
{
  # Caches and downloads stay in this checkout (.devenv/ is git-ignored), not in $HOME.
  # Except cargo: CARGO_HOME stays the default ~/.cargo, shared by every checkout and
  # worktree, so the crate registry is downloaded once and a compiler cache such as
  # sccache (RUSTC_WRAPPER) gets hits across them: it hashes CARGO_HOME and the
  # registry source paths, which differ when each checkout has its own.
  env = {
    COREPACK_HOME = "${state}/corepack";
    npm_config_cache = "${state}/npm-cache";
    # pnpm: content store, metadata cache and state (its defaults are under ~/Library).
    pnpm_config_store_dir = "${state}/pnpm/store";
    pnpm_config_cache_dir = "${state}/pnpm/cache";
    pnpm_config_state_dir = "${state}/pnpm/state";
    PNPM_HOME = "${state}/pnpm/home";
    XDG_CACHE_HOME = "${state}/cache";
  } // lib.optionalAttrs pkgs.stdenv.isDarwin (appleToolchain [
    # Every Apple target builds its C and C++ (SQLite, ring, whisper.cpp) and links with
    # Xcode's toolchain (the /usr/bin shims follow xcode-select), the same one as CI's
    # macOS runners. The Nix clang wrapper keeps its own macOS 14.4 SDK: next to Xcode's
    # headers (which whisper.cpp's CMake picks) clang 21 rejects them, linking misses
    # macOS 15 Metal symbols, and for iOS it adds a macOS minimum version clang refuses.
    "aarch64-apple-darwin"
    "x86_64-apple-darwin"
    "aarch64-apple-ios"
    "aarch64-apple-ios-sim"
  ]) // lib.optionalAttrs pkgs.stdenv.isLinux {
    # whisper-rs-sys: use its shipped bindings (laid out for Linux x86-64) instead of
    # generating them with bindgen, which panics where libclang is missing (WSL, a bare
    # Linux box) before its own fallback to those bindings can run. macOS and Windows
    # generate theirs (.cargo/config.toml).
    WHISPER_DONT_GENERATE_BINDINGS = "1";
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

  # macOS: no Nix C compiler in the shell. Its clang wrapper and `ld` came first on PATH
  # (languages.c, which languages.rust turns on, and the rust-overlay toolchain, which
  # propagates the wrapper), and xcodebuild then linked with them (`-objc_abi_version
  # '-Xlinker' not supported`), so every Xcode build needed a scrubbed environment.
  # enterShell drops the wrapper from PATH: `cc`, `clang` and `ld` are Xcode's /usr/bin
  # shims, the same ones the per-target variables above name.
  stdenv = if pkgs.stdenv.isDarwin then pkgs.stdenvNoCC else pkgs.stdenv;
  languages.c.enable = lib.mkIf pkgs.stdenv.isDarwin (lib.mkForce false);

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

  enterShell = lib.optionalString pkgs.stdenv.isDarwin ''
    PATH=$(printf '%s' "$PATH" | tr ':' '\n' \
      | grep -v -E '/nix/store/[^/]*-(clang-wrapper|clang|cctools-binutils-darwin|cctools-binutils-darwin-wrapper)-[0-9]' \
      | paste -s -d: -)
    export PATH CC=/usr/bin/clang CXX=/usr/bin/clang++
    unset NIX_CC NIX_CC_FOR_BUILD NIX_CFLAGS_COMPILE NIX_CFLAGS_COMPILE_FOR_BUILD \
      NIX_LDFLAGS NIX_LDFLAGS_FOR_BUILD CC_FOR_BUILD CXX_FOR_BUILD LD
  '' + ''
    rustc --version
    node --version
  '';
}

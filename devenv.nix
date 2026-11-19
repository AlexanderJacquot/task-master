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
  } // lib.optionalAttrs pkgs.stdenv.isLinux {
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
    targets = lib.optionals pkgs.stdenv.isDarwin [ "aarch64-apple-darwin" "x86_64-apple-darwin" ];
  };

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

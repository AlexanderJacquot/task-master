# ADR 018: Linux distribution, the AUR package and package-managed updates

Date: 2026-11-06 · Status: accepted

## Context

The 0.7.0 AppImage was very laggy on the user's Arch laptop (Iris Xe, KWin Wayland). The
profile (progress.md, "Lag on Linux") showed the cause is packaging, not the app: the
AppImage carries the WebKitGTK of the CI runner (Ubuntu 22.04, 2.50.4), which on this
system paints mostly on the CPU. A flat page takes 39 ms per frame there and 16.7 ms on
Arch's own WebKitGTK 2.54; the old texture took 276 ms. The .deb and .rpm do not bundle
WebKitGTK: they use the distribution's. Windows (WebView2) and macOS (WKWebView) always use
the system engine and are unaffected.

Arch has no .deb/.rpm support, so Arch users (the main user included) only had the
AppImage. Options weighed: an AUR package built from source (users compile Rust and the
frontend, several minutes per update), an AUR `-bin` package that repackages the release
.deb, Flatpak (current GNOME-runtime WebKitGTK, but Flathub review, a sandbox to open for
agent sessions and terminals, and no Tauri updater), or a newer CI runner for the AppImage
(still a bundled engine).

## Decisions

**AUR `task-master-bin`.** `packaging/aur/PKGBUILD` extracts the release .deb: its
binaries link only against system libraries (webkit2gtk-4.1, gtk3, libsoup3, glib2, cairo,
gdk-pixbuf2, dbus, glibc 2.34+), so the Ubuntu-built binary runs on Arch's WebKitGTK. No
compilation on the user's machine; the package is a few MB on top of the system engine.

**Released by CI.** A third job in `release.yml`, `aur`, runs after the build in an
`archlinux:base-devel` container: it sets `pkgver` and the checksum from the .deb the
release just published, builds the package, installs it with its real dependencies and
fails if a library does not resolve, then pushes `PKGBUILD` and `.SRCINFO` to
`ssh://aur@aur.archlinux.org/task-master-bin.git` with the `AUR_SSH_PRIVATE_KEY` secret.
Without the secret it builds and checks only. Stable `v*` tags only (`pkgver` cannot hold
a pre-release suffix). The repository copy of the PKGBUILD is the source of truth; never
edit the AUR repository by hand.

**pacman owns updates for that install.** Tauri stamps the bundle type into the binary,
so the repackaged binary still believes it came from a .deb and its updater would run
`pkexec dpkg -i`. The PKGBUILD therefore installs a marker,
`/usr/share/task-master/managed-by` ("the AUR package task-master-bin"). The desktop shell
reads it relative to its executable (`config::managed_by`) and reports it in
`get_config` as `ConfigView.managed_by`, so the IPC surface does not grow. The update store
asks once (`UpdateSource.managedBy`); when set, it never contacts GitHub and Settings →
About says updates come from the package manager. Release bundles ship no marker and are
unchanged.

**Formats per platform.** Debian/Ubuntu: .deb; Fedora/openSUSE: .rpm (both use the system
WebKitGTK and update in place: tauri-plugin-updater 2.14 installs them with `pkexec dpkg
-i` / `rpm -U`, which ADR 009 did not record); Arch: `task-master-bin`; anything else: the
AppImage, documented as the slower fallback.

## Consequences

- One-time setup by hand: an AUR account with an SSH key and the GitHub secret
  `AUR_SSH_PRIVATE_KEY` (docs/release.md). Afterwards each release updates the AUR with no
  manual step; maintenance is the PKGBUILD's `depends` when the app links a new library,
  which the CI install check reports.
- Arch users update with pacman / an AUR helper (`yay -Syu`), on the AUR's schedule, not
  from the in-app button. Builds that predate this ADR do not read the marker: 0.7.0
  installed from the AUR still shows the update button and its install would fail.
- The AUR package depends on the GitHub release assets staying public and keeping their
  names (`task-master_<version>_amd64.deb`).
- The workspace license is `UNLICENSED`; the package says `LicenseRef-UNLICENSED`. The AUR
  accepts it, but a real license would let others redistribute the package.
- Not covered: aarch64 Linux (no ARM .deb is built), Flatpak.

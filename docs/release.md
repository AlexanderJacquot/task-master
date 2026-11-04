# Releases and installers

The Forgejo workflow (`.forgejo/workflows/ci.yml`) checks every push and builds a Linux
`.deb`. Installers for all three OSes are built on GitHub, which has Windows and macOS
runners, through a push mirror of this repo.

## One-time setup (by hand)

1. Create an empty GitHub repository, e.g. `task-master` (private is fine).
2. Create a GitHub fine-grained token for that repository with *Contents: read and write*
   and *Workflows: read and write*.
3. In Forgejo: repository → Settings → Repository → Mirror settings → *Push mirror*:
   URL `https://github.com/<you>/task-master.git`, username = your GitHub login,
   password = the token, sync on push.

Forgejo then forwards branches and tags. GitHub runs `.github/workflows/release.yml`
(Forgejo ignores that folder while `.forgejo/workflows` exists).

## Cutting a release

1. Bump `version` in `apps/desktop/src-tauri/tauri.conf.json` (and the workspace
   `Cargo.toml` version) on `main`.
2. `git tag v0.2.0 && git push origin v0.2.0`.
3. On GitHub, the *release* workflow builds Linux (.deb, .AppImage, .rpm), Windows
   (.msi, setup .exe) and macOS (arm64 and x86_64 .dmg) into a **draft** release.
   Review it and publish.

Builds are unsigned: Windows SmartScreen and macOS Gatekeeper warn on first launch
(macOS: right-click → Open). Signing is a later step.

# Releases and installers

The Forgejo workflow (`.forgejo/workflows/ci.yml`) checks every push and builds a Linux
`.deb`. Installers for all three OSes are built on GitHub, which has Windows and macOS
runners, through a push mirror of this repo.

## One-time setup (by hand)

1. Create an empty GitHub repository, e.g. `task-master` (private is fine).
2. In Forgejo: repository → Settings → Repository → Mirror settings → *Push mirror*,
   "Use SSH authentication", URL `ssh://git@github.com/<you>/task-master.git` (an https
   URL makes Forgejo push over HTTPS and fail with "could not read Username"), sync on
   push. Add the public key Forgejo shows as a GitHub deploy key with write access.

Forgejo then forwards branches and tags. GitHub runs `.github/workflows/release.yml`
(Forgejo ignores that folder while `.forgejo/workflows` exists).

## Cutting a release

1. Bump `version` in `apps/desktop/src-tauri/tauri.conf.json` (and the workspace
   `Cargo.toml` version) on `main`.
2. `git tag v0.2.0 && git push origin v0.2.0`. The mirror forwards the tag to GitHub.
3. Start the build: tags pushed by the Forgejo mirror did not trigger the workflow for
   v0.1.0, so run it on the tag by hand:
   `gh workflow run release.yml -R AlexanderJacquot/task-master --ref v0.2.0`
   (or Actions → release → Run workflow, choosing the tag).
4. On GitHub, the *release* workflow builds Linux (.deb, .AppImage, .rpm), Windows
   (.msi, setup .exe) and macOS (arm64 and x86_64 .dmg) into a **draft** release
   (about 30–40 minutes on a cold cache). Review it and publish.

Builds are unsigned: Windows SmartScreen and macOS Gatekeeper warn on first launch
(macOS: right-click → Open). Signing is a later step.

# Releases and installers

Everything runs on GitHub, through a public push mirror of this Forgejo repo (ADR 010):
`.github/workflows/ci.yml` checks every push and builds a Linux `.deb`; `release.yml` builds
the installers for all three OSes and the signed update files on version tags.

## One-time setup (by hand)

1. Create an empty GitHub repository, e.g. `task-master`. It must be **public**: installed
   apps download updates from its releases without logging in (ADR 009).
2. In Forgejo: repository → Settings → Repository → Mirror settings → *Push mirror*,
   "Use SSH authentication", URL `ssh://git@github.com/<you>/task-master.git` (an https
   URL makes Forgejo push over HTTPS and fail with "could not read Username"), sync on
   push. Add the public key Forgejo shows as a GitHub deploy key with write access.

Forgejo then forwards branches and tags. GitHub runs `.github/workflows/` (Forgejo ignores
that folder while `.forgejo/workflows` exists, which is why its manual-only stub stays).

3. Update signing (done 2026-11-05): `pnpm --filter desktop exec tauri signer generate -w
   ~/.tauri/task-master.key -p <password> --ci`, public key in `tauri.conf.json` →
   `plugins.updater.pubkey`, and the secrets:
   `gh secret set TAURI_SIGNING_PRIVATE_KEY -R AlexanderJacquot/task-master < ~/.tauri/task-master.key`
   and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from `~/.tauri/task-master.key.password`.
   **Back up `~/.tauri/task-master.key*`** (password manager): without the key, installed
   apps cannot be updated.

## Cutting a release

For v0.7.0, use [the release notes](releases/0.7.0.md). Validate the integrated branch
with the same checks as CI before tagging.

The same tag also publishes the sync server image (`server-image.yml`, ADR 016), with the
same version as the app. Desktop and server must run the same database schema. After a
release with migrations, update the homelab's `task-master` version (Renovate opens the
bump) together with the desktops.

1. Bump `version` in `apps/desktop/src-tauri/tauri.conf.json`, the workspace `Cargo.toml`
   and `apps/desktop/package.json` on `main`. The version must grow: the app only offers
   a release newer than itself. Regenerate `Cargo.lock` with `cargo check` so workspace
   package versions match.
2. `git tag -a v0.7.0 -m … && git push origin v0.7.0`. The mirror forwards the tag to GitHub.
3. The tag push starts the *release* workflow on GitHub (it did for v0.2.0 and v0.3.0;
   check `gh run list -R AlexanderJacquot/task-master -L 3`). Only if no run appears,
   start it by hand: `gh workflow run release.yml -R AlexanderJacquot/task-master --ref
   v0.7.0`. Do not do both: two runs publish to the same release.
4. On GitHub, the *release* workflow builds Linux (.deb, .AppImage, .rpm), Windows
   (.msi, setup .exe) and macOS (arm64 and x86_64 .dmg), plus signed update bundles and
   `latest.json`, and **publishes** the release (about 30–40 minutes on a cold cache).
5. Installed apps see it within six hours, or at once from Settings → About →
   Check for updates. Check that `latest.json` in the release lists `windows-x86_64`,
   `darwin-aarch64`, `darwin-x86_64` and `linux-x86_64`; re-run a failed job otherwise.

Installers are not code-signed: Windows SmartScreen and macOS Gatekeeper warn on the first
manual install (macOS: right-click → Open). Updates themselves are signed and verified.

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
4. AUR package `task-master-bin` (ADR 018). **Pending: AUR registration is closed (as of
   2026-11-06).** Until the secret exists, the `aur` job of every release builds and
   checks the package, then **fails on purpose** at "Publish to the AUR", so release runs
   show red. The installers and in-app updates are published before it and are not
   affected. Once registration reopens:
   1. Make a key for the AUR only: `ssh-keygen -t ed25519 -N '' -C task-master-aur -f
      ~/.ssh/aur-task-master`.
   2. Register at https://aur.archlinux.org/register and paste
      `~/.ssh/aur-task-master.pub` under *SSH Public Key* (My Account).
   3. `gh secret set AUR_SSH_PRIVATE_KEY -R AlexanderJacquot/task-master <
      ~/.ssh/aur-task-master`.
   4. Publish the latest release without cutting a new one (the first push creates the
      AUR repository): `gh workflow run aur.yml -R AlexanderJacquot/task-master -f
      tag=v<latest>`. Later releases publish themselves. Do not publish versions before
      0.7.1: their binaries do not read the package marker, so their update button
      would fail.
   5. Add "task-master-bin from the AUR on Arch" back to the install line of the release
      body in `release.yml`.
   Install it with `yay -S task-master-bin` (or `paru`); later versions arrive with
   `yay -Syu`, not from the in-app button.

## Cutting a release

For v0.18.0, use [the release notes](releases/0.18.0.md). Validate the integrated branch
with the same checks as CI before tagging, including `cargo fmt --all -- --check` (v0.16.0
failed its release build on that check alone and was never published).

The same tag also publishes the sync server image (`server-image.yml`, ADR 016), with the
same version as the app. Desktop and server must run the same database schema. After a
release with migrations, update the homelab's `task-master` version (Renovate opens the
bump) together with the desktops.

1. Bump `version` in `apps/desktop/src-tauri/tauri.conf.json`, the workspace `Cargo.toml`
   and `apps/desktop/package.json` on `main`. The version must grow: the app only offers
   a release newer than itself. Regenerate `Cargo.lock` with `cargo check` so workspace
   package versions match.
2. `git tag -a v0.18.0 -m … && git push origin v0.18.0`. The mirror forwards the tag to GitHub.
3. The tag push starts the *release* workflow on GitHub (it did for v0.2.0 and v0.3.0;
   check `gh run list -R AlexanderJacquot/task-master -L 3`). Only if no run appears,
   start it by hand: `gh workflow run release.yml -R AlexanderJacquot/task-master --ref
   v0.18.0`. Do not do both: two runs publish to the same release.
4. On GitHub, the *release* workflow builds Linux (.deb, .AppImage, .rpm), Windows
   (.msi, setup .exe) and macOS (arm64 and x86_64 .dmg), plus signed update bundles and
   `latest.json`, and **publishes** the release (about 30–40 minutes on a cold cache).
   Then the `aur` job (`aur.yml`) repackages the .deb as `task-master-bin`, installs and
   checks it in an Arch container, and pushes it to the AUR (`packaging/aur/PKGBUILD`,
   ADR 018). While the AUR account is pending this job fails at the publish step by
   design (setup step 4); any earlier failure in it is a real packaging problem.
5. Installed apps see it within six hours, or at once from Settings → About →
   Check for updates. Check that `latest.json` in the release lists `windows-x86_64`,
   `darwin-aarch64`, `darwin-x86_64` and `linux-x86_64`; re-run a failed job otherwise.

Installers are not code-signed: Windows SmartScreen and macOS Gatekeeper warn on the first
manual install (macOS: right-click → Open). Updates themselves are signed and verified.

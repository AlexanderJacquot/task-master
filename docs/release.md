# Releases and installers

This page is for maintainers. Everything runs on GitHub Actions (ADR 010):
`.github/workflows/ci.yml` checks every push and builds a Linux `.deb`; `release.yml` builds
the installers for all three OSes and the signed update files on version tags.

The maintainer pushes branches and tags to the public GitHub repository directly. A
private Forgejo instance pull-mirrors it read-only (ADR 041); nothing is pushed there.
Forgejo ignores `.github/workflows/` while `.forgejo/workflows/` exists, which is why its
manual-only `ci.yml` stub stays. Forks can ignore the `.forgejo/` folder.

## One-time setup (by hand)

1. The GitHub repository must be **public**: installed apps download updates from its
   releases without logging in (ADR 009). A fork that publishes its own releases also
   needs its own updater endpoint in `tauri.conf.json` → `plugins.updater.endpoints` and
   its own signing key (step 3).
2. Optional Forgejo copy (ADR 041): New Migration → GitHub, URL
   `https://github.com/<you>/task-master`, tick "This repository will be a mirror", and
   turn off the Actions unit on the mirror. It is read-only: never push to it.
3. Update signing: `pnpm --filter desktop exec tauri signer generate -w
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
5. Windows code signing through SignPath Foundation (ADR 036). **Pending: the project has
   to apply and be approved.** Until the variables below exist, releases build the same
   Windows files unsigned. To set it up:
   1. Turn on two-factor authentication on GitHub (SignPath requires it for every
      team member), and check that the
      [code signing policy](https://alexanderjacquot.github.io/task-master/code-signing.html)
      is online (`site/code-signing.html`, published by `pages.yml`).
   2. Apply at https://signpath.org/apply with the repository URL, the policy page and
      the release workflow. Approval is at SignPath's discretion.
   3. Once approved, in SignPath: turn on two-factor authentication; in the project
      (slug `task-master`), connect the GitHub repository as a trusted build system;
      add the artifact configurations `binaries` and `installers` from
      `packaging/signpath/*.xml`; on the signing policy (usually `release-signing`), add
      yourself as approver and make a CI user with submitter permission.
   4. Store the CI user's API token and the IDs:
      `gh secret set SIGNPATH_API_TOKEN -R AlexanderJacquot/task-master`, then
      `gh variable set SIGNPATH_ORGANIZATION_ID -b <organization id>`,
      `gh variable set SIGNPATH_PROJECT_SLUG -b task-master` and
      `gh variable set SIGNPATH_SIGNING_POLICY_SLUG -b release-signing` (each with
      `-R AlexanderJacquot/task-master`).
   5. Drop "(from the first release after SignPath approves the project)" from the
      README once a signed release is out.

## Cutting a release

For v0.32.0, use [the release notes](releases/0.32.0.md). Validate the integrated branch
with the same checks as CI before tagging, including `cargo fmt --all -- --check` (v0.16.0
failed its release build on that check alone and was never published) and `pnpm biome ci .`
over the whole repository, Markdown included (v0.17.0 and v0.27.0 stopped on a format
error in `progress.md`).

The same tag also publishes the sync server image (`server-image.yml`, ADR 016), with the
same version as the app. Desktop and server must run the same database schema, so
mention database migrations in the release notes: self-hosters then update their server
together with their desktops.

1. Bump `version` in `apps/desktop/src-tauri/tauri.conf.json`, the workspace `Cargo.toml`
   and `apps/desktop/package.json` on `main`. The version must grow: the app only offers
   a release newer than itself. Regenerate `Cargo.lock` with `cargo check` so workspace
   package versions match.
2. `git tag -a v0.32.0 -m … && git push origin main v0.32.0`: push to GitHub (`origin`). The tag
   push starts the release; the Forgejo mirror picks both up on its next sync.
3. The tag push starts the *release* workflow on GitHub (it did for v0.2.0 and v0.3.0;
   check `gh run list -R AlexanderJacquot/task-master -L 3`). Only if no run appears,
   start it by hand: `gh workflow run release.yml -R AlexanderJacquot/task-master --ref
   v0.32.0`. Do not do both: two runs publish to the same release.
4. On GitHub, the *release* workflow builds Linux (.deb, .AppImage, .rpm), Windows
   (.msi, setup .exe; approve its two SignPath requests, see below) and macOS (arm64 and x86_64 .dmg), plus signed update bundles and
   `latest.json`, and **publishes** the release (about 30–40 minutes on a cold cache).
   Then the `aur` job (`aur.yml`) repackages the .deb as `task-master-bin`, installs and
   checks it in an Arch container, and pushes it to the AUR (`packaging/aur/PKGBUILD`,
   ADR 018). While the AUR account is pending this job fails at the publish step by
   design (setup step 4); any earlier failure in it is a real packaging problem.
5. Installed apps see it within six hours, or at once from Settings → About →
   Check for updates. After the builds, the `updater-json` job writes `latest.json` again
   from the release's signed update files: the build jobs overwrite each other's entries
   when they finish together (v0.31.0). It fails if `windows-x86_64`, `darwin-aarch64`,
   `darwin-x86_64` or `linux-x86_64` is still missing; re-run the failed build job, then
   `updater-json`.

**Windows signing (ADR 036).** Once SignPath is set up (setup step 5), the Windows job
sends two signing requests, the executables and then the installers. Each waits for your
approval in SignPath (SignPath emails the approvers) and times out after two hours: keep
an eye on the run and approve both. While they wait, the release is already published
for Linux and macOS but has no Windows files. If a request times out or is denied,
re-run the Windows job. The job then checks every Authenticode signature. The NSIS
uninstaller inside the setup stays unsigned.

macOS installers are not signed with a vendor certificate, so Gatekeeper warns on the
first manual install. Updates themselves are signed and verified.

macOS bundles are **ad-hoc signed** (`tauri.macos.conf.json`, `signingIdentity: "-"`,
ADR 027), and the release job checks the signature of each `.app`, sidecar included. That
stops Apple Silicon from calling a downloaded app "damaged". Gatekeeper still blocks
the first open: open the app once, then System Settings → Privacy & Security → *Open
Anyway* (or `xattr -dr com.apple.quarantine /Applications/Task Master.app`). In-app
updates are not quarantined and open without asking. A Developer ID certificate and
notarization would remove the warning; see ADR 027.

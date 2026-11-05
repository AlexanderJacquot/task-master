# ADR 009: In-app updates and build info

Date: 2026-11-05 · Status: accepted

## Context

Every iteration so far meant downloading and reinstalling by hand. The user asked for an
update button in the app that fetches and installs the latest release, and for the build
number to be visible.

## Decisions

**Tauri updater.** `tauri-plugin-updater` 2.14.0 (+ `@tauri-apps/plugin-updater`) checks
`https://github.com/AlexanderJacquot/task-master/releases/latest/download/latest.json`,
downloads the bundle for this OS, verifies its signature and installs it;
`tauri-plugin-process` 2.4.0 relaunches the app afterwards. Windows installs in `passive`
mode (progress bar, no questions) and closes the app itself.

**Public releases.** The updater cannot authenticate, so the GitHub mirror is public (the
user's choice over a separate releases repo or a homelab bucket). The Forgejo origin
stays the source of truth.

**Signing.** A minisign key pair made with `tauri signer generate`. The public key is in
`tauri.conf.json`; the private key and its password are the GitHub Actions secrets
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, with the only other
copy in `~/.tauri/` on the dev machine (to be backed up). Losing it means installed apps
can no longer update; they would need one manual reinstall with a new key.
This signs updates only; the installers are still not code-signed for Windows/macOS.

**Update bundles only in releases.** `bundle.createUpdaterArtifacts` stays off in
`tauri.conf.json` so Forgejo CI and local builds need no key; the release workflow adds
`--config src-tauri/tauri.updater.conf.json`. tauri-action uploads `latest.json` (Windows
entry: the NSIS setup, `updaterJsonPreferNsis`). Linux updates in place for the AppImage.

**Publishing.** Releases are published as soon as the workflow finishes (no more drafts),
so pushing a version tag ships the update. The app checks quietly 10 s after start and
every 6 hours (errors stay silent), and on demand from Settings → About and updates, which
shows the state (checking, latest, available with notes, download progress, restart, or
the error with a retry). The sidebar shows "Update to x.y.z" when one is waiting.

**Build info.** Vite defines `__APP_VERSION__` (from `tauri.conf.json`), `__APP_COMMIT__`
(`GITHUB_SHA` in CI, else `git rev-parse`) and `__APP_BUILT_AT__`; Settings shows
"Version 0.2.0 · build abc1234 · 2026-11-05".

**Testability.** The Tauri calls sit behind `UpdateSource`; a small zustand store holds the
state machine and is tested with fakes, as is the About section.

## Consequences

- 0.1.0 has no updater: 0.2.0 must be installed by hand once; later versions update in place.
- A release is live for every install the moment CI finishes; a bad release is fixed by
  shipping the next version (or unpublishing it on GitHub before installs pick it up).
- Four matrix jobs write one `latest.json`; if a platform is missing from it, that OS sees
  no update (quietly) until the next release. Re-running the failed job repairs it.

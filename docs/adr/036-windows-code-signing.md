# ADR 036: Windows code signing through SignPath Foundation

Date: 2026-11-22 · Status: accepted (signing starts once SignPath approves the project)

## Context

Windows installers and executables carried no Authenticode signature (ADR 009 signs
updates only). On a personal PC that costs one SmartScreen warning. On a managed work PC
it can stop the app: Defender can block the setup `.exe` and then remove it. It can do the same to `taskmaster-desktop.exe` itself when the
installed folder is copied over by hand, and its protection history needs admin rights
to open. Company policies like that one (attack surface reduction rules, Smart App
Control, App Control) let signed, known publishers through and stop unsigned files from
unknown ones. The `.msi` started, but it installs per machine and asks for admin rights.

Certificates: an OV certificate costs a few hundred euros a year and now needs an HSM or
a cloud key. An EV certificate no longer gets instant SmartScreen reputation. Azure
Artifact Signing takes individuals in a few countries only. **SignPath Foundation** signs
open-source projects for free: an OSI license (AGPL-3.0, ADR 020), a public repository,
releases built on GitHub-hosted runners, MFA on GitHub and SignPath, and a code signing
policy page. The certificate is issued to SignPath Foundation, so Windows shows it as the
publisher. Every signing request needs a manual approval in SignPath.

## Decisions

**SignPath Foundation, through its GitHub Action.** SignPath only signs workflow
artifacts it fetches from GitHub itself and checks the run that made them. So
`release.yml` uploads files with `actions/upload-artifact` and submits them with
`signpath/github-action-submit-signing-request`, which waits (up to two hours) for the
approval and downloads the signed files. Repository variables `SIGNPATH_ORGANIZATION_ID`,
`SIGNPATH_PROJECT_SLUG` and `SIGNPATH_SIGNING_POLICY_SLUG`, and the secret
`SIGNPATH_API_TOKEN`, configure it. Signing is on only when `SIGNPATH_ORGANIZATION_ID` is
set, so releases keep working, unsigned, until the project is approved.

**Windows builds in steps, and tauri-action only uploads.** Signing only the installer
would leave the installed `taskmaster-desktop.exe` and `task-master-mcp.exe` unsigned, and
those are what a strict policy stops. An NSIS setup cannot be signed from the inside, so
the Windows job:

1. builds the app and the MCP server (`tauri build --no-bundle`),
2. signs both executables (SignPath artifact configuration `binaries`),
3. bundles the NSIS setup and the MSI from them (`tauri bundle`),
4. signs both installers (artifact configuration `installers`),
5. signs the update files again with the updater key (`tauri signer sign
   --app-version`): their signatures cover the installers' bytes, which step 4 changed,
6. checks every Authenticode signature (`Get-AuthenticodeSignature`).

tauri-action then runs with `tauriScript` set to `scripts/windows-prebuilt.mjs`, which
only checks that the installers and their `.sig` files exist. tauri-action uploads them
and writes the Windows entries of `latest.json` exactly as before. That is two approvals
per release. The NSIS uninstaller, which `makensis` writes inside the setup, stays
unsigned.

**Version information on the MCP server.** SignPath Foundation requires file metadata
restrictions: the artifact configurations accept only files whose product name is
`task-master` and whose product version is the release's. tauri-build writes those into
the app's executable. `crates/mcp/build.rs` now writes them into `task-master-mcp.exe`
with `tauri-winres` 0.3.7, the crate and version tauri-build already uses (no new crate
in `Cargo.lock`). CI's Windows job builds the MCP server so a broken resource shows
before a release. The XML of both artifact configurations is kept in
`packaging/signpath/`.

**Code signing policy.** `site/code-signing.html` (linked from the website footer and the
README) names the team roles, points to the privacy policy and carries SignPath's
attribution line.

## Consequences

- Each release waits for two approvals in SignPath (email from SignPath). Until both are
  given, the Windows job waits and the release has no Windows files or `latest.json`
  entries. After two hours a request times out and the Windows job fails; re-run it.
- Windows shows "SignPath Foundation" as the publisher. SmartScreen reputation is tied to
  the certificate and grows with downloads, so the first signed releases may still warn
  on some PCs. Signing is what company policies check for.
- If SignPath's rules change or the project loses its approval, clearing the variable
  `SIGNPATH_ORGANIZATION_ID` returns to unsigned builds with no other change.
- macOS stays ad-hoc signed (ADR 027).

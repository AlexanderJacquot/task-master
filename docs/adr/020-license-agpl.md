# ADR 020: License the project under AGPL-3.0-or-later

Date: 2026-11-09 · Status: accepted

## Context

The repository had no license (`UNLICENSED` in Cargo.toml and the AUR package), so the
public GitHub mirror and the release installers granted no rights to anyone. The user
wanted an open source license where anyone may use the code but changes stay open
("propagating"). task-master includes a sync server (`crates/server`) that people may host
for others; under the GPL alone, someone could run a modified server as a service without
sharing their changes.

## Decision

**GNU Affero General Public License, version 3 or later** (`AGPL-3.0-or-later`), for the
whole repository: the desktop app, the core, the sync server and client, the MCP server,
the site and the scripts.

- `LICENSE` holds the unmodified license text from gnu.org.
- The SPDX id is set in the Cargo workspace (inherited by every crate, and by the Tauri
  bundles, which take the license from Cargo.toml), both `package.json` files and the AUR
  `PKGBUILD` / `.SRCINFO` (AGPL-3.0-or-later is one of Arch's common licenses, so the
  package needn't install the text).
- Settings → About states the license and links to the source, as section 13 asks of a
  program users interact with.
- "Or later" follows the FSF's recommendation and leaves room for a future AGPL version.

Alternatives considered: MIT/Apache-2.0 (permissive, forks may close), MPL-2.0 (file-level
copyleft, combines with closed code; a modified server needn't be published), GPL-3.0
(copyleft for distributed copies only, not for a hosted server).

## Consequences

- Distributed copies (installers, the AUR package) and modified sync servers offered over
  a network must come with their source under the same license.
- Third-party dependencies keep their licenses. As of this decision all Rust and
  JavaScript dependencies are under licenses compatible with AGPL-3.0 (MIT, Apache-2.0,
  BSD, ISC, Zlib, Unicode-3.0, MPL-2.0, CDLA-Permissive-2.0, CC0, Unlicense; fonts under
  OFL-1.1). A new dependency under an incompatible license (proprietary, GPL-2.0-only,
  SSPL, ...) can't be added.
- As the sole copyright holder the user can still relicense their own code later, or
  offer it under other terms; outside contributions would make that require their consent.

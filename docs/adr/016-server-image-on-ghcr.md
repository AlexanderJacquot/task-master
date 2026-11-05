# ADR 016: Server image on GitHub's registry

Date: 2026-11-05 · Status: accepted

## Context

The sync server image (ADR 015) was built by a Forgejo workflow on the homelab runner and
pushed to `harbor.solarnexus.space/knowledgesystem/task-master-server`. The first homelab
deploy could not pull it. Homelab hosts pull without logging in, and the KnowledgeSystem
org is private. Making the org public was not an option, because its registry also holds
private vault images. A stopgap moved the image to the public `alex/` owner on Forgejo.

Every other artifact of this project is already built on the public GitHub mirror
(ADR 009, ADR 010): checks, installers and signed updates. The user asked to host the
image there too.

## Decisions

- `.github/workflows/server-image.yml` builds `crates/server/Dockerfile` on `v*` tags and
  pushes `ghcr.io/alexanderjacquot/task-master-server:<version>` and `:latest`, using
  `GITHUB_TOKEN`. A manual run pushes `latest` from the branch. A manual run with a
  `version` input rebuilds that existing tag and pushes only `:<version>`.
- The package is public. The source is already public on the mirror.
- `.forgejo/workflows/server-image.yml` is removed. `.forgejo/workflows/ci.yml` stays as
  the manual-only stub, so Forgejo still ignores `.github/workflows` (ADR 010).
- The homelab deploys `ghcr.io/alexanderjacquot/task-master-server`. Renovate already
  tracks ghcr.io images there.

## Consequences

- One tag produces every release artifact in one place. The image is reachable outside the
  home network (docs/server.md §4).
- No Forgejo `REGISTRY_TOKEN` secret and no homelab runner are needed for this repository.
- Homelab deploys of this stack depend on ghcr.io being reachable, like its other ghcr.io
  stacks.
- The image is built a little later than before: tag push → mirror sync → GitHub build.
- The images already pushed to `harbor.solarnexus.space` (`knowledgesystem/` and `alex/`)
  are no longer updated and can be deleted.

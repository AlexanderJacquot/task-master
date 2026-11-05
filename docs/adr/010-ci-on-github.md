# ADR 010: CI moves to the GitHub mirror

Date: 2026-11-05 · Status: accepted

## Context

Checks ran on Forgejo Actions and installers on the GitHub push mirror. Since ADR 009 the
GitHub repository is public, so its Actions minutes are free, and the user asked to stop
running workflows on Forgejo.

## Decisions

- `.github/workflows/ci.yml` runs the former Forgejo job (fmt, clippy, Rust tests, bindings
  check, Biome, typecheck, Vitest, unsigned `.deb` build) on every branch push and PR.
  Version tags are left to `release.yml`.
- `.forgejo/workflows/ci.yml` becomes a manual-only stub. It must stay: while
  `.forgejo/workflows` exists, Forgejo ignores `.github/workflows`; without it, Forgejo
  would run the release workflow as well. Forgejo Actions can also be switched off in the
  repository settings (Units) for good measure.
- Forgejo remains where code is pushed; results are read on GitHub (Actions tab, or
  `gh run list -R AlexanderJacquot/task-master`).

## Consequences

- A push is checked a few seconds later, after the mirror syncs.
- Forgejo no longer needs a runner for this repository.

# ADR 041: GitHub is the origin, Forgejo pull-mirrors it

Date: 2026-11-27 · Status: accepted · Supersedes the mirror direction of ADR 010

## Context

Code was pushed to a private Forgejo repository that push-mirrored branches and tags to
the public GitHub repository, where all workflows run (ADR 010). The mirror added a step
that could fail (tags dropped when `main` and the tag were pushed apart, v0.24.0), and the
Forgejo copy needed upkeep of its own. The repository was also restarted from a single
commit; the full history is kept privately (GitHub `task-master-legacy`, Forgejo
`task-master-archive`).

## Decisions

- `AlexanderJacquot/task-master` on GitHub is where branches and tags are pushed. It keeps
  that exact name: installed apps fetch updates from its releases (ADR 009).
- Forgejo keeps a read-only pull mirror of it, with Actions off. Nothing is pushed there.
- `.forgejo/workflows/ci.yml` stays as the manual-only stub, so that a mirror with Actions
  on would still ignore `.github/workflows`. `.forgejo/workflows/claude.yml` is removed:
  a pull mirror has no pull requests.

## Consequences

- Releases: push `main` and the `v*` tag to GitHub; no more mirror race.
- Issues, release pages and history before the restart stay in the private legacy repos;
  links to specific old releases no longer resolve.

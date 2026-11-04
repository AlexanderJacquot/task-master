# task-master



## CI

Comment `@claude` on a pull request to get a Claude review, posted back as a
comment. Only comments by `alex` trigger it. The stub is
`.forgejo/workflows/claude.yml`; the logic lives in
[alex/claude-ci](https://harbor.solarnexus.space/alex/claude-ci).

For a repo-specific review prompt, add `.forgejo/prompts/pr-review.md` on the
default branch.

Needs Actions turned on for this repo and the `CLAUDE_CODE_OAUTH_TOKEN`
secret at repo, user or org level.

## Docker image

Pushing a `vX.Y.Z` tag runs `.forgejo/workflows/docker-build.yml`. It builds
`deploy/Dockerfile` with the repo root as context and pushes
`harbor.solarnexus.space/<owner>/<repo>` (lowercased) tagged `vX.Y.Z` and
`latest`. It can also be run by hand from the Actions tab, which pushes
`latest` only. Change `DOCKERFILE` in the workflow if the Dockerfile lives
elsewhere.

Needs the `REGISTRY_TOKEN` secret: a Forgejo token with package write.

Release to production:

1. `git tag vX.Y.Z && git push origin vX.Y.Z`
2. Renovate in [HomeLab/homelab](https://harbor.solarnexus.space/HomeLab/homelab)
   sees the new tag (via the `# renovate:` annotation on the service in
   `inventory/services.yml`) and opens a PR bumping `version:`.
3. Merge it, then deploy: `just ansible-apply <host> <stack>`.

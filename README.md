# task-master

Local-first desktop task manager: Tauri 2 shell, Rust core, SQLite, React UI.
See [docs/plan.md](docs/plan.md) for the plan and [progress.md](progress.md) for status.

The public homepage, privacy policy and terms are in [site/](site/). See
[GitHub Pages setup](docs/github-pages.md) to publish them and use their URLs for
[Google Calendar configuration](docs/google-calendar.md).

## CI

Comment `@claude` on a pull request to get a Claude review, posted back as a
comment. Only comments by `alex` trigger it. The stub is
`.forgejo/workflows/claude.yml`; the logic lives in
[alex/claude-ci](https://harbor.solarnexus.space/alex/claude-ci).

For a repo-specific review prompt, add `.forgejo/prompts/pr-review.md` on the
default branch.

Needs Actions turned on for this repo and the `CLAUDE_CODE_OAUTH_TOKEN`
secret at repo, user or org level.

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

## License

task-master is free software: you can redistribute it and/or modify it under the terms of
the [GNU Affero General Public License](LICENSE) as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version.

It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

In short: anyone may use, change and share it, commercially too. Shared or modified
copies must stay under the same license with their source available, and that includes
a modified sync server offered to others over a network (section 13). Third-party
components keep their own licenses (MIT, Apache-2.0, BSD, ISC, MPL-2.0, OFL-1.1 and
similar, all compatible). See [ADR 020](docs/adr/020-license-agpl.md).

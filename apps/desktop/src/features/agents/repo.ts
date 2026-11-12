// What the project page says about the git repository in a project's folder. Shown only
// when the folder is a repository; nothing when it is not.

import type { GitInfo } from "../../lib/types";

/** The release the work is on: the latest tag, with the commits on top ("v0.16.1 +2"). */
export function releaseLabel(info: GitInfo): string | null {
  if (!info.tag) return null;
  return info.commits_since_tag > 0 ? `${info.tag} +${info.commits_since_tag}` : info.tag;
}

/** The short form for the header: release and branch, or what there is of them. */
export function repoBadge(info: GitInfo): string {
  const release = releaseLabel(info);
  const where = info.branch ?? (info.commit ? `detached at ${info.commit}` : null);
  return [release, where].filter(Boolean).join(" · ") || "Git repository";
}

/** Every detail, one per line, for a tooltip or the folder menu. */
export function repoDetails(info: GitInfo): string[] {
  const lines = [`Repository: ${info.root}`];
  lines.push(`Branch: ${info.branch ?? "none (detached HEAD)"}`);
  lines.push(`Release: ${releaseLabel(info) ?? "no tag yet"}`);
  if (info.commit)
    lines.push(`Commit: ${info.commit}${info.dirty ? " (uncommitted changes)" : ""}`);
  else lines.push("Commit: none yet");
  return lines;
}

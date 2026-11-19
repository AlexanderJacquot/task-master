import { expect, it } from "vitest";
import type { GitInfo } from "../../lib/types";
import { releaseLabel, repoBadge, repoDetails } from "./repo";

const repo = (over: Partial<GitInfo> = {}): GitInfo => ({
  root: "/work/app",
  branch: "main",
  commit: "840216c",
  tag: "v0.16.1",
  commits_since_tag: 0,
  dirty: false,
  ...over,
});

it("names the release by its tag, with the commits on top", () => {
  expect(releaseLabel(repo())).toBe("v0.16.1");
  expect(releaseLabel(repo({ commits_since_tag: 2 }))).toBe("v0.16.1 +2");
  expect(releaseLabel(repo({ tag: null }))).toBeNull();
});

it("sums the repository up as release and branch", () => {
  expect(repoBadge(repo({ commits_since_tag: 2 }))).toBe("v0.16.1 +2 · main");
  expect(repoBadge(repo({ tag: null }))).toBe("main");
  expect(repoBadge(repo({ branch: null }))).toBe("v0.16.1 · detached at 840216c");
  expect(repoBadge(repo({ tag: null, branch: null, commit: null }))).toBe("Git repository");
});

it("lists every detail", () => {
  expect(repoDetails(repo({ dirty: true }))).toEqual([
    "Repository: /work/app",
    "Branch: main",
    "Release: v0.16.1",
    "Commit: 840216c (uncommitted changes)",
  ]);
  expect(repoDetails(repo({ tag: null, commit: null, branch: null }))).toEqual([
    "Repository: /work/app",
    "Branch: none (detached HEAD)",
    "Release: no tag yet",
    "Commit: none yet",
  ]);
});

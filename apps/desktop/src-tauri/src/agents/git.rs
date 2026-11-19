//! Whether a project's folder is a git repository, and where it stands: branch, commit and
//! the latest release tag. Features built on git (a release indicator, the release work
//! was done on) show only when the folder is a repository.
//!
//! Git runs where the agents run (natively, or in WSL through `wsl.exe --exec`), so a WSL
//! folder is read with the distribution's git. Building the commands and reading their
//! output is pure, so every case is unit-tested on any OS.

use serde::Serialize;
use taskmaster_core::AgentRuntime;

use super::launch::{self, Launch};
use crate::config::AgentSettings;

/// Where a project folder's git repository stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct GitInfo {
    /// Top folder of the repository, as the runtime sees it (may be above the project folder).
    pub root: String,
    /// The checked-out branch; `None` when HEAD is detached.
    pub branch: Option<String>,
    /// Short hash of HEAD; `None` before the first commit.
    pub commit: Option<String>,
    /// The latest tag reachable from HEAD: the release the work is on. `None` without tags.
    pub tag: Option<String>,
    /// Commits on top of `tag` (0 when HEAD is the tagged commit or there is no tag).
    pub commits_since_tag: u32,
    /// Tracked files have uncommitted changes.
    pub dirty: bool,
}

/// The repository's top folder; fails outside a repository.
pub const ROOT: &[&str] = &["rev-parse", "--show-toplevel"];
/// The branch name; prints nothing (and fails) when HEAD is detached.
pub const BRANCH: &[&str] = &["symbolic-ref", "--short", "-q", "HEAD"];
/// `<tag>-<n>-g<hash>[-dirty]`, or `<hash>[-dirty]` without tags; fails before the first commit.
pub const DESCRIBE: &[&str] = &["describe", "--tags", "--long", "--always", "--dirty"];

/// `git <args>` in `folder`, in the runtime. `--no-optional-locks` so reading never takes
/// the index lock from an agent committing in the same folder.
pub fn command(
    settings: &AgentSettings,
    runtime: AgentRuntime,
    folder: &str,
    args: &[&str],
) -> Launch {
    let mut all = vec!["--no-optional-locks".to_owned()];
    all.extend(args.iter().map(|a| (*a).to_owned()));
    launch::in_runtime(settings, runtime, folder, "git", all)
}

/// Builds the answer from the three commands' output (`None` for a command that failed).
/// Not a repository (or no git) when `root` failed.
pub fn info(root: Option<&str>, branch: Option<&str>, describe: Option<&str>) -> Option<GitInfo> {
    let root = root.map(str::trim).filter(|r| !r.is_empty())?;
    let branch = branch.map(str::trim).filter(|b| !b.is_empty());
    let (commit, tag, commits_since_tag, dirty) = parse_describe(describe.unwrap_or(""));
    Some(GitInfo {
        root: root.to_owned(),
        branch: branch.map(str::to_owned),
        commit,
        tag,
        commits_since_tag,
        dirty,
    })
}

/// Reads `git describe --tags --long --always --dirty`: (commit, tag, commits since, dirty).
fn parse_describe(out: &str) -> (Option<String>, Option<String>, u32, bool) {
    let out = out.trim();
    let (out, dirty) = match out.strip_suffix("-dirty") {
        Some(rest) => (rest, true),
        None => (out, false),
    };
    if out.is_empty() {
        return (None, None, 0, dirty);
    }
    // `--long` always writes `-<n>-g<hash>` after a tag, and the tag itself may hold dashes:
    // split from the right.
    let mut parts = out.rsplitn(3, '-');
    if let (Some(hash), Some(count), Some(tag)) = (parts.next(), parts.next(), parts.next())
        && let Some(hash) = hash.strip_prefix('g')
        && is_hex(hash)
        && let Ok(count) = count.parse()
        && !tag.is_empty()
    {
        return (Some(hash.to_owned()), Some(tag.to_owned()), count, dirty);
    }
    // No tag: `--always` prints the abbreviated hash alone.
    let commit = is_hex(out).then(|| out.to_owned());
    (commit, None, 0, dirty)
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_a_repository() {
        assert_eq!(info(None, None, None), None);
        assert_eq!(info(Some("  \n"), Some("main"), Some("abc1234")), None);
    }

    #[test]
    fn tagged_release_with_commits_on_top() {
        let got = info(
            Some("/home/me/app\n"),
            Some("main\n"),
            Some("v0.16.1-2-g840216c\n"),
        );
        assert_eq!(
            got,
            Some(GitInfo {
                root: "/home/me/app".into(),
                branch: Some("main".into()),
                commit: Some("840216c".into()),
                tag: Some("v0.16.1".into()),
                commits_since_tag: 2,
                dirty: false,
            })
        );
    }

    #[test]
    fn tag_with_dashes_and_dirty_tree() {
        assert_eq!(
            parse_describe("release-2024-01-0-gdeadbeef-dirty"),
            (
                Some("deadbeef".into()),
                Some("release-2024-01".into()),
                0,
                true
            )
        );
    }

    #[test]
    fn no_tags_yet() {
        assert_eq!(
            parse_describe("840216c-dirty"),
            (Some("840216c".into()), None, 0, true)
        );
        assert_eq!(
            parse_describe("840216c"),
            (Some("840216c".into()), None, 0, false)
        );
    }

    #[test]
    fn before_the_first_commit_or_detached() {
        let got = info(Some("/r"), None, None).unwrap();
        assert_eq!((got.branch, got.commit, got.tag), (None, None, None));
    }

    #[test]
    fn runs_git_in_the_folder_for_each_runtime() {
        let settings = AgentSettings::default();
        let native = command(&settings, AgentRuntime::Native, "/home/me/app", ROOT);
        assert_eq!(native.program, "git");
        assert_eq!(
            native.args,
            ["--no-optional-locks", "rev-parse", "--show-toplevel"]
        );
        assert_eq!(
            native.cwd.as_deref(),
            Some(std::path::Path::new("/home/me/app"))
        );

        let settings = AgentSettings {
            wsl_distro: Some("Ubuntu".into()),
            ..AgentSettings::default()
        };
        let wsl = command(&settings, AgentRuntime::Wsl, "/home/me/app", BRANCH);
        assert_eq!(wsl.program, "wsl.exe");
        assert_eq!(
            wsl.args,
            [
                "-d",
                "Ubuntu",
                "--cd",
                "/home/me/app",
                "--exec",
                "git",
                "--no-optional-locks",
                "symbolic-ref",
                "--short",
                "-q",
                "HEAD"
            ]
        );
        assert_eq!(wsl.cwd, None);
    }
}

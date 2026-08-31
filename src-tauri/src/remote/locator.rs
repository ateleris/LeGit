//! Repo locators: where a repository lives, as a persistable string.
//!
//! The persisted bookkeeping (`last_open_repos`, `currently_open`,
//! `active_open_repo`) and the open-repo command identify repos by a single
//! string. A LOCAL repo's locator IS its bare filesystem path — existing
//! persisted entries parse unchanged and new local entries are byte-identical
//! to what older versions wrote. Remote repos use a URI-ish scheme:
//! `wsl://<distro>/<absolute posix path>`.

use legit_core::HostPath;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

/// Prefix for WSL locators. Reserved for the future: `ssh://`.
const WSL_SCHEME: &str = "wsl://";

/// Where a repo lives. `Local` round-trips as the bare path (see module docs).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RepoLocator {
    Local { path: PathBuf },
    Wsl { distro: String, path: HostPath },
}

impl RepoLocator {
    pub fn local(path: impl Into<PathBuf>) -> Self {
        RepoLocator::Local { path: path.into() }
    }

    /// Parse a persisted/typed locator string. Anything without a known
    /// scheme is a local path — including Windows drive/UNC paths.
    pub fn parse(s: &str) -> RepoLocator {
        if let Some(rest) = s.strip_prefix(WSL_SCHEME) {
            if let Some(slash) = rest.find('/') {
                let (distro, path) = rest.split_at(slash);
                if !distro.is_empty() && !path.is_empty() {
                    return RepoLocator::Wsl {
                        distro: distro.to_string(),
                        path: HostPath(path.to_string()),
                    };
                }
            }
        }
        RepoLocator::Local { path: PathBuf::from(s) }
    }

    /// The persisted (and displayable) form; `parse` round-trips it.
    pub fn to_persist_string(&self) -> String {
        match self {
            RepoLocator::Local { path } => path.to_string_lossy().into_owned(),
            RepoLocator::Wsl { distro, path } => format!("{WSL_SCHEME}{distro}{}", path.0),
        }
    }

    /// The path component as the repo host sees it (shown in tabs/settings).
    pub fn display_path(&self) -> String {
        match self {
            RepoLocator::Local { path } => path.to_string_lossy().into_owned(),
            RepoLocator::Wsl { path, .. } => path.0.clone(),
        }
    }

    pub fn host_ref(&self) -> Option<HostRef> {
        match self {
            RepoLocator::Local { .. } => None,
            RepoLocator::Wsl { distro, .. } => Some(HostRef::Wsl {
                distro: distro.clone(),
            }),
        }
    }
}

/// The host part of a locator, as it crosses IPC in `RepoSummary`
/// (`None`/absent = local). Hand-mirrored in `src/lib/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostRef {
    Wsl { distro: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_paths_parse_as_local_and_round_trip_byte_identical() {
        for p in ["/home/u/proj", "C:\\repos\\proj", "\\\\server\\share\\proj", "relative/ish"] {
            let loc = RepoLocator::parse(p);
            assert!(matches!(loc, RepoLocator::Local { .. }), "{p}");
            assert_eq!(loc.to_persist_string(), p, "local locators must round-trip unchanged");
        }
    }

    #[test]
    fn wsl_locator_round_trips() {
        let loc = RepoLocator::parse("wsl://Ubuntu/home/orell/github/LeGit");
        assert_eq!(
            loc,
            RepoLocator::Wsl {
                distro: "Ubuntu".into(),
                path: HostPath("/home/orell/github/LeGit".into()),
            }
        );
        assert_eq!(loc.to_persist_string(), "wsl://Ubuntu/home/orell/github/LeGit");
        assert_eq!(loc.display_path(), "/home/orell/github/LeGit");
    }

    #[test]
    fn malformed_wsl_strings_fall_back_to_local() {
        // No path, or no distro: treated as a (nonexistent) local path rather
        // than panicking or inventing a host — open_repo will report NotARepo.
        for s in ["wsl://", "wsl://Ubuntu", "wsl:///home/x"] {
            assert!(matches!(RepoLocator::parse(s), RepoLocator::Local { .. }), "{s}");
        }
    }

    #[test]
    fn host_ref_is_none_for_local() {
        assert_eq!(RepoLocator::local("/x").host_ref(), None);
        assert_eq!(
            RepoLocator::parse("wsl://U/h").host_ref(),
            Some(HostRef::Wsl { distro: "U".into() })
        );
    }
}

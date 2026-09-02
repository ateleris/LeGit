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

    /// Parse a persisted/typed locator string. A `\\wsl.localhost\` /
    /// `\\wsl$\` UNC path (what the native folder picker returns for the
    /// Explorer "Linux" node) is recognized as a WSL locator, so "Open
    /// repository…" works for WSL repos without a separate entry point.
    /// Anything else without a known scheme is a local path — including
    /// other Windows drive/UNC paths.
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
        if let Some(loc) = parse_wsl_unc(s) {
            return loc;
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

    /// The locator of `name` inside this directory (a clone's destination
    /// under its parent dir). Local joins natively; remote paths are posix.
    pub fn join(&self, name: &str) -> RepoLocator {
        match self {
            RepoLocator::Local { path } => RepoLocator::Local { path: path.join(name) },
            RepoLocator::Wsl { distro, path } => RepoLocator::Wsl {
                distro: distro.clone(),
                path: path.join(name),
            },
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

/// Recognize a WSL share UNC path (`\\wsl.localhost\<distro>\<path>` or the
/// legacy `\\wsl$\<distro>\<path>`; server and either separator style are
/// accepted, the server name case-insensitively). Returns `None` for every
/// other string — plain UNC paths (`\\server\share`) must stay local.
fn parse_wsl_unc(s: &str) -> Option<RepoLocator> {
    let rest = s.strip_prefix(r"\\").or_else(|| s.strip_prefix("//"))?;
    let (server, rest) = rest.split_once(['\\', '/'])?;
    if !server.eq_ignore_ascii_case("wsl.localhost") && !server.eq_ignore_ascii_case("wsl$") {
        return None;
    }
    let (distro, path) = match rest.split_once(['\\', '/']) {
        Some((d, p)) => (d, p),
        None => (rest, ""),
    };
    if distro.is_empty() {
        return None;
    }
    Some(RepoLocator::Wsl {
        distro: distro.to_string(),
        path: HostPath(format!("/{}", path.replace('\\', "/"))),
    })
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
    fn join_appends_a_child_on_either_host() {
        assert_eq!(
            RepoLocator::parse("wsl://Ubuntu/home/u").join("proj").to_persist_string(),
            "wsl://Ubuntu/home/u/proj"
        );
        assert_eq!(
            RepoLocator::parse("/x").join("proj"),
            RepoLocator::local(std::path::Path::new("/x").join("proj"))
        );
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
    fn wsl_unc_paths_parse_as_wsl_locators() {
        // What the native folder picker returns for the Explorer "Linux" node.
        for s in [
            r"\\wsl.localhost\Ubuntu\home\orell\github\dive",
            r"\\wsl$\Ubuntu\home\orell\github\dive",
            r"\\WSL.LOCALHOST\Ubuntu\home\orell\github\dive",
            "//wsl.localhost/Ubuntu/home/orell/github/dive",
        ] {
            assert_eq!(
                RepoLocator::parse(s),
                RepoLocator::Wsl {
                    distro: "Ubuntu".into(),
                    path: HostPath("/home/orell/github/dive".into()),
                },
                "{s}"
            );
        }
        // Normalizes to the wsl:// persist form (the UNC spelling is an
        // input convenience, never a stored identity).
        assert_eq!(
            RepoLocator::parse(r"\\wsl.localhost\Ubuntu\home\u\r").to_persist_string(),
            "wsl://Ubuntu/home/u/r"
        );
    }

    #[test]
    fn wsl_unc_share_root_and_distro_root_do_not_panic() {
        // Distro root (no path) maps to "/" — open_repo then reports
        // NotARepo cleanly.
        assert_eq!(
            RepoLocator::parse(r"\\wsl.localhost\Ubuntu"),
            RepoLocator::Wsl {
                distro: "Ubuntu".into(),
                path: HostPath("/".into()),
            }
        );
        // The bare share root stays local (nothing to address).
        assert!(matches!(
            RepoLocator::parse(r"\\wsl.localhost"),
            RepoLocator::Local { .. }
        ));
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

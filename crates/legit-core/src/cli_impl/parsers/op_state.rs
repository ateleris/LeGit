//! Pure assembly of `RepoOpState` from probed `.git` state files.
//!
//! The backend probes which state files exist (MERGE_HEAD, rebase-merge/,
//! rebase-apply/, CHERRY_PICK_HEAD, REVERT_HEAD) and reads their contents;
//! everything decision-shaped lives here, testable without a repository.
//! File meanings: rebase-merge/{head-name,onto,msgnum,end} are documented
//! rebase plumbing (msgnum = current step, end = total); rebase-apply is the
//! `git am`-based variant with {next,last}.

use crate::types::RepoOpState;

/// Contents of `.git/rebase-merge/*` (the interactive/merge rebase backend).
#[derive(Debug, Default, Clone)]
pub struct RebaseMergeFiles {
    pub head_name: Option<String>,
    pub onto: Option<String>,
    pub msgnum: Option<String>,
    pub end: Option<String>,
}

/// Contents of `.git/rebase-apply/*` (the am-based rebase backend).
#[derive(Debug, Default, Clone)]
pub struct RebaseApplyFiles {
    pub next: Option<String>,
    pub last: Option<String>,
    pub head_name: Option<String>,
}

/// Everything the op-state probe found in `.git`.
#[derive(Debug, Default, Clone)]
pub struct OpStateProbe {
    pub merge_head: bool,
    pub merge_msg: Option<String>,
    pub rebase_merge: Option<RebaseMergeFiles>,
    pub rebase_apply: Option<RebaseApplyFiles>,
    pub cherry_pick_head: Option<String>,
    pub revert_head: Option<String>,
}

/// The branch named by a MERGE_MSG first line, e.g.
/// `Merge branch 'feature/x' into main` or
/// `Merge remote-tracking branch 'origin/x'`.
pub fn merge_msg_branch(msg: &str) -> Option<String> {
    let first = msg.lines().next()?;
    let rest = first
        .strip_prefix("Merge branch '")
        .or_else(|| first.strip_prefix("Merge remote-tracking branch '"))?;
    let end = rest.find('\'')?;
    (end > 0).then(|| rest[..end].to_string())
}

fn short_branch(full: &str) -> String {
    full.trim()
        .strip_prefix("refs/heads/")
        .unwrap_or(full.trim())
        .to_string()
}

fn short_sha(sha: &str) -> String {
    let t = sha.trim();
    t.chars().take(8).collect()
}

fn num(s: &Option<String>) -> Option<u32> {
    s.as_deref().and_then(|v| v.trim().parse().ok())
}

/// Priority: a rebase (either backend) can coexist with CHERRY_PICK_HEAD
/// (rebase applies commits by cherry-pick), so rebase wins; then merge, then
/// cherry-pick, then revert.
pub fn op_state_from_probe(probe: OpStateProbe) -> RepoOpState {
    if let Some(rm) = probe.rebase_merge {
        return RepoOpState::Rebase {
            onto: rm.onto.as_deref().map(short_sha),
            head_name: rm.head_name.as_deref().map(short_branch),
            current_step: num(&rm.msgnum),
            total_steps: num(&rm.end),
        };
    }
    if let Some(ra) = probe.rebase_apply {
        return RepoOpState::Rebase {
            onto: None,
            head_name: ra.head_name.as_deref().map(short_branch),
            current_step: num(&ra.next),
            total_steps: num(&ra.last),
        };
    }
    if probe.merge_head {
        return RepoOpState::Merge {
            branch: probe.merge_msg.as_deref().and_then(merge_msg_branch),
            message: probe
                .merge_msg
                .map(|m| m.trim_end().to_string())
                .filter(|m| !m.is_empty()),
        };
    }
    if let Some(sha) = probe.cherry_pick_head {
        return RepoOpState::CherryPick {
            sha: short_sha(&sha),
        };
    }
    if let Some(sha) = probe.revert_head {
        return RepoOpState::Revert {
            sha: short_sha(&sha),
        };
    }
    RepoOpState::None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_probe_is_none() {
        assert_eq!(op_state_from_probe(OpStateProbe::default()), RepoOpState::None);
    }

    #[test]
    fn merge_with_message_parses_branch() {
        let st = op_state_from_probe(OpStateProbe {
            merge_head: true,
            merge_msg: Some("Merge branch 'feature/x' into main\n".into()),
            ..Default::default()
        });
        assert_eq!(
            st,
            RepoOpState::Merge {
                branch: Some("feature/x".into()),
                message: Some("Merge branch 'feature/x' into main".into()),
            }
        );
    }

    #[test]
    fn merge_msg_branch_variants() {
        assert_eq!(merge_msg_branch("Merge branch 'dev'"), Some("dev".into()));
        assert_eq!(
            merge_msg_branch("Merge remote-tracking branch 'origin/dev' into main"),
            Some("origin/dev".into())
        );
        assert_eq!(merge_msg_branch("Revert \"x\""), None);
        assert_eq!(merge_msg_branch(""), None);
    }

    #[test]
    fn rebase_merge_state_with_progress() {
        let st = op_state_from_probe(OpStateProbe {
            rebase_merge: Some(RebaseMergeFiles {
                head_name: Some("refs/heads/feature\n".into()),
                onto: Some("0123456789abcdef0123456789abcdef01234567\n".into()),
                msgnum: Some("2\n".into()),
                end: Some("5\n".into()),
            }),
            ..Default::default()
        });
        assert_eq!(
            st,
            RepoOpState::Rebase {
                onto: Some("01234567".into()),
                head_name: Some("feature".into()),
                current_step: Some(2),
                total_steps: Some(5),
            }
        );
    }

    #[test]
    fn rebase_wins_over_cherry_pick_head() {
        // A rebase applies commits via cherry-pick; CHERRY_PICK_HEAD may exist.
        let st = op_state_from_probe(OpStateProbe {
            rebase_merge: Some(RebaseMergeFiles::default()),
            cherry_pick_head: Some("abc123".into()),
            ..Default::default()
        });
        assert!(matches!(st, RepoOpState::Rebase { .. }));
    }

    #[test]
    fn cherry_pick_and_revert_detected() {
        let cp = op_state_from_probe(OpStateProbe {
            cherry_pick_head: Some("0123456789abcdef\n".into()),
            ..Default::default()
        });
        assert_eq!(cp, RepoOpState::CherryPick { sha: "01234567".into() });
        let rv = op_state_from_probe(OpStateProbe {
            revert_head: Some("fedcba9876543210\n".into()),
            ..Default::default()
        });
        assert_eq!(rv, RepoOpState::Revert { sha: "fedcba98".into() });
    }
}

//! Parser for `git worktree list --porcelain -z` backing `worktree_list()`.
//! The format flags live next to the parser so the contract is in one place.

use crate::types::WorktreeInfo;

/// `-z`: attribute lines are NUL-terminated and each record ends with an
/// empty token, so paths with spaces/unicode pass through unquoted.
pub const WORKTREE_LIST_ARGS: [&str; 4] = ["worktree", "list", "--porcelain", "-z"];

pub fn parse_worktree_list(output: &str) -> Vec<WorktreeInfo> {
    let mut out: Vec<WorktreeInfo> = Vec::new();
    let mut cur: Option<WorktreeInfo> = None;
    for token in output.split('\0') {
        if token.is_empty() {
            // Record terminator (and the stream's trailing NUL).
            if let Some(w) = cur.take() {
                out.push(w);
            }
            continue;
        }
        if let Some(path) = token.strip_prefix("worktree ") {
            if let Some(w) = cur.take() {
                out.push(w);
            }
            cur = Some(WorktreeInfo {
                path: path.to_string(),
                head: None,
                branch: None,
                is_main: out.is_empty(),
                detached: false,
                bare: false,
                locked: None,
                prunable: None,
                dirty: None,
            });
            continue;
        }
        let Some(w) = cur.as_mut() else { continue };
        if let Some(h) = token.strip_prefix("HEAD ") {
            w.head = Some(h.to_string());
        } else if let Some(b) = token.strip_prefix("branch ") {
            w.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        } else if token == "detached" {
            w.detached = true;
        } else if token == "bare" {
            w.bare = true;
        } else if token == "locked" {
            w.locked = Some(String::new());
        } else if let Some(r) = token.strip_prefix("locked ") {
            w.locked = Some(r.to_string());
        } else if token == "prunable" {
            w.prunable = Some(String::new());
        } else if let Some(r) = token.strip_prefix("prunable ") {
            w.prunable = Some(r.to_string());
        }
    }
    if let Some(w) = cur.take() {
        out.push(w);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Join attribute lines into a `-z` stream: NUL after every line, plus
    /// the record-terminating empty token where `""` appears.
    fn stream(lines: &[&str]) -> String {
        let mut s = lines.join("\0");
        s.push('\0');
        s
    }

    #[test]
    fn parses_main_linked_and_detached() {
        let out = stream(&[
            "worktree /repo", "HEAD 1111111111111111111111111111111111111111", "branch refs/heads/main", "",
            "worktree /wt-feature", "HEAD 2222222222222222222222222222222222222222", "branch refs/heads/feature", "",
            "worktree /wt-detached", "HEAD 3333333333333333333333333333333333333333", "detached", "",
        ]);
        let list = parse_worktree_list(&out);
        assert_eq!(list.len(), 3);
        assert!(list[0].is_main && !list[1].is_main && !list[2].is_main);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].path, "/wt-feature");
        assert_eq!(
            list[1].head.as_deref(),
            Some("2222222222222222222222222222222222222222")
        );
        assert!(list[2].detached);
        assert_eq!(list[2].branch, None);
    }

    #[test]
    fn parses_locked_with_and_without_reason_and_prunable() {
        let out = stream(&[
            "worktree /repo", "HEAD 1111111111111111111111111111111111111111", "branch refs/heads/main", "",
            "worktree /wt-a", "HEAD 2222222222222222222222222222222222222222", "branch refs/heads/a", "locked", "",
            "worktree /wt-b", "HEAD 3333333333333333333333333333333333333333", "branch refs/heads/b", "locked usb drive", "",
            "worktree /wt-c", "HEAD 4444444444444444444444444444444444444444", "detached", "prunable gitdir file points to non-existent location", "",
        ]);
        let list = parse_worktree_list(&out);
        assert_eq!(list[1].locked.as_deref(), Some(""));
        assert_eq!(list[2].locked.as_deref(), Some("usb drive"));
        assert!(list[3].prunable.as_deref().unwrap_or("").contains("non-existent"));
        assert_eq!(list[0].locked, None);
    }

    #[test]
    fn parses_a_bare_main_entry() {
        let out = stream(&["worktree /repo.git", "bare", ""]);
        let list = parse_worktree_list(&out);
        assert_eq!(list.len(), 1);
        assert!(list[0].bare && list[0].is_main);
        assert_eq!(list[0].head, None);
    }

    #[test]
    fn empty_output_parses_to_empty() {
        assert_eq!(parse_worktree_list(""), Vec::new());
    }
}

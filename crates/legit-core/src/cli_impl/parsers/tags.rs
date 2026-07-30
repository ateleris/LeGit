//! Parsers for `git for-each-ref refs/tags` (local tags) and
//! `git ls-remote --tags` (remote tags).

use crate::types::{CommitId, RemoteTag, TagInfo};

/// Format for `git for-each-ref --format=… refs/tags`, tab-separated:
/// short name, object type, object sha, peeled sha (annotated only),
/// creatordate (Unix seconds; the tag object's date for annotated tags, the
/// commit's committer date for lightweight ones), subject. Subject stays the
/// LAST field so an embedded tab can't shift the others (`splitn` keeps it whole).
pub const TAGS_FORMAT: &str =
    "%(refname:short)%09%(objecttype)%09%(objectname)%09%(*objectname)%09%(creatordate:unix)%09%(subject)";

const FIELD_COUNT: usize = 6;

/// Parse the stdout of `git for-each-ref --format=TAGS_FORMAT refs/tags`.
/// Malformed lines are skipped so one bad entry never breaks the list.
pub fn parse_tags(output: &str) -> Vec<TagInfo> {
    output.lines().filter_map(parse_tag_line).collect()
}

fn parse_tag_line(line: &str) -> Option<TagInfo> {
    let line = line.trim_end_matches('\r');
    if line.trim().is_empty() {
        return None;
    }
    let parts: Vec<&str> = line.splitn(FIELD_COUNT, '\t').collect();
    if parts.len() < FIELD_COUNT {
        return None;
    }
    let name = parts[0].trim();
    let object_type = parts[1].trim();
    let object_sha = parts[2].trim();
    let peeled_sha = parts[3].trim();
    // Degrade to 0 rather than dropping the tag on a missing/odd date.
    let created_at = parts[4].trim().parse().unwrap_or(0);
    let subject = parts[5].trim();
    if name.is_empty() || object_sha.is_empty() {
        return None;
    }
    // An annotated tag is its own object; the commit it tags is the peeled
    // sha. A lightweight tag points straight at the commit.
    let annotated = object_type == "tag";
    let target = if annotated && !peeled_sha.is_empty() {
        peeled_sha
    } else {
        object_sha
    };
    Some(TagInfo {
        name: name.to_string(),
        target_sha: CommitId(target.to_string()),
        annotated,
        message: (annotated && !subject.is_empty()).then(|| subject.to_string()),
        // Permissive default; `mark_unpushed_targets` flips it based on the
        // rev-list probe (a failed probe then falls back to the old,
        // unrestricted behavior rather than disabling every push).
        target_on_remote: true,
        created_at,
    })
}

/// Args listing commits reachable from tags but NOT from any remote-tracking
/// ref; a tag whose target is in this set would push new commits.
pub const REV_LIST_UNPUSHED_TAG_TARGETS_ARGS: [&str; 4] =
    ["rev-list", "--tags", "--not", "--remotes"];

/// Flip `target_on_remote` to false for tags whose target commit appears in
/// the `rev-list --tags --not --remotes` output (one sha per line).
pub fn mark_unpushed_targets(tags: &mut [TagInfo], rev_list_stdout: &str) {
    let unpushed: std::collections::HashSet<&str> = rev_list_stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if unpushed.is_empty() {
        return;
    }
    for tag in tags {
        if unpushed.contains(tag.target_sha.as_str()) {
            tag.target_on_remote = false;
        }
    }
}

/// Parse the stdout of `git ls-remote --tags <remote>`: lines of
/// `<sha>\trefs/tags/<name>` plus peeled `refs/tags/<name>^{}` entries for
/// annotated tags. The peeled sha (the tagged commit) wins over the tag
/// object's own sha, matching how `parse_tags` reports local targets.
pub fn parse_remote_tags(output: &str) -> Vec<RemoteTag> {
    let mut tags: Vec<RemoteTag> = Vec::new();
    for line in output.lines() {
        let line = line.trim_end_matches('\r');
        let Some((sha, refname)) = line.split_once('\t') else {
            continue;
        };
        let Some(rest) = refname.trim().strip_prefix("refs/tags/") else {
            continue;
        };
        let (name, peeled) = match rest.strip_suffix("^{}") {
            Some(base) => (base, true),
            None => (rest, false),
        };
        if name.is_empty() || sha.trim().is_empty() {
            continue;
        }
        if let Some(existing) = tags.iter_mut().find(|t| t.name == name) {
            // ls-remote emits the peeled line after the tag object's line.
            if peeled {
                existing.target_sha = CommitId(sha.trim().to_string());
            }
        } else {
            tags.push(RemoteTag {
                name: name.to_string(),
                target_sha: CommitId(sha.trim().to_string()),
            });
        }
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lightweight_and_annotated_tags() {
        let out = "v1.0\tcommit\taaa111\t\t1700000001\t\n\
                   v2.0\ttag\tbbb222\tccc333\t1700000002\tRelease 2.0\n";
        let tags = parse_tags(out);
        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0].name, "v1.0");
        assert!(!tags[0].annotated);
        assert_eq!(tags[0].target_sha.0, "aaa111");
        assert_eq!(tags[0].message, None);
        assert_eq!(tags[0].created_at, 1700000001);
        assert_eq!(tags[1].name, "v2.0");
        assert!(tags[1].annotated);
        // Annotated: the peeled sha (the tagged commit), not the tag object.
        assert_eq!(tags[1].target_sha.0, "ccc333");
        assert_eq!(tags[1].message.as_deref(), Some("Release 2.0"));
        assert_eq!(tags[1].created_at, 1700000002);
    }

    #[test]
    fn subject_with_a_tab_stays_whole() {
        let out = "v3.0\ttag\tbbb\tccc\t1700000003\tRelease\twith tab\n";
        let tags = parse_tags(out);
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].message.as_deref(), Some("Release\twith tab"));
        assert_eq!(tags[0].created_at, 1700000003);
    }

    #[test]
    fn missing_date_degrades_to_zero() {
        let out = "v1.0\tcommit\taaa111\t\t\t\n";
        let tags = parse_tags(out);
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].created_at, 0);
    }

    #[test]
    fn skips_malformed_lines() {
        let out = "garbage\nv1.0\tcommit\taaa111\t\t1700000001\t\n";
        let tags = parse_tags(out);
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "v1.0");
    }

    #[test]
    fn remote_tags_prefer_peeled_shas() {
        let out = "bbb222\trefs/tags/v2.0\n\
                   ccc333\trefs/tags/v2.0^{}\n\
                   aaa111\trefs/tags/v1.0\n";
        let tags = parse_remote_tags(out);
        assert_eq!(tags.len(), 2);
        let v2 = tags.iter().find(|t| t.name == "v2.0").unwrap();
        assert_eq!(v2.target_sha.0, "ccc333"); // peeled wins
        let v1 = tags.iter().find(|t| t.name == "v1.0").unwrap();
        assert_eq!(v1.target_sha.0, "aaa111");
    }

    #[test]
    fn remote_tags_ignore_non_tag_refs() {
        let out = "aaa111\trefs/heads/main\naaa111\tHEAD\n";
        assert!(parse_remote_tags(out).is_empty());
    }

    #[test]
    fn unpushed_targets_are_marked_not_on_remote() {
        // v1 targets aaa (on remote), v2 targets bbb (only reachable locally).
        let out = "v1\tcommit\taaa\t\t1\t\nv2\tcommit\tbbb\t\t2\t\n";
        let mut tags = parse_tags(out);
        assert!(tags.iter().all(|t| t.target_on_remote));
        mark_unpushed_targets(&mut tags, "bbb\nccc\n");
        assert!(tags.iter().find(|t| t.name == "v1").unwrap().target_on_remote);
        assert!(!tags.iter().find(|t| t.name == "v2").unwrap().target_on_remote);
    }

    #[test]
    fn empty_rev_list_leaves_all_tags_pushable() {
        let mut tags = parse_tags("v1\tcommit\taaa\t\t1\t\n");
        mark_unpushed_targets(&mut tags, "");
        assert!(tags[0].target_on_remote);
    }
}

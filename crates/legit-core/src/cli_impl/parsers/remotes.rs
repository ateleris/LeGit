//! Parser for `git remote -v`, backing `list_remotes()`.
//!
//! The args live here next to the parser so the contract is visible in one place
//! (DESIGN-v0.3.md §4.5). `git remote -v` prints two tab-separated lines per
//! remote:
//!   `<name>\t<url> (fetch)`
//!   `<name>\t<url> (push)`

use crate::types::Remote;

/// Args for listing remotes with their URLs.
pub const REMOTE_LIST_ARGS: [&str; 2] = ["remote", "-v"];

/// Parse the stdout of `git remote -v` into one `Remote` per name, preserving
/// first-seen order. The `(fetch)`/`(push)` lines are folded together; a remote
/// missing one line falls back to the other URL.
pub fn parse_remotes(output: &str) -> Vec<Remote> {
    // (name, fetch_url, push_url); push_url empty until seen.
    let mut order: Vec<String> = Vec::new();
    let mut fetch: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut push: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for line in output.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let (name, rest) = match line.split_once('\t') {
            Some(pair) => pair,
            None => continue,
        };
        let name = name.to_string();
        // rest is `<url> (fetch)` or `<url> (push)`.
        let (url, kind) = match rest.rsplit_once(' ') {
            Some((url, kind)) => (url.to_string(), kind),
            None => (rest.to_string(), ""),
        };
        if !fetch.contains_key(&name) && !push.contains_key(&name) {
            order.push(name.clone());
        }
        match kind {
            "(push)" => {
                push.insert(name, url);
            }
            // Treat `(fetch)` and any unexpected suffix as the fetch URL.
            _ => {
                fetch.insert(name, url);
            }
        }
    }

    order
        .into_iter()
        .map(|name| {
            let f = fetch.get(&name).cloned();
            let p = push.get(&name).cloned();
            // Fall back to whichever URL is present if one line was missing.
            let fetch_url = f.clone().or_else(|| p.clone()).unwrap_or_default();
            let push_url = p.or(f).unwrap_or_default();
            Remote { name, fetch_url, push_url }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_yields_no_remotes() {
        assert_eq!(parse_remotes(""), vec![]);
    }

    #[test]
    fn single_remote_same_fetch_and_push() {
        let out = "origin\thttps://github.com/a/b.git (fetch)\n\
                   origin\thttps://github.com/a/b.git (push)\n";
        assert_eq!(
            parse_remotes(out),
            vec![Remote {
                name: "origin".into(),
                fetch_url: "https://github.com/a/b.git".into(),
                push_url: "https://github.com/a/b.git".into(),
            }]
        );
    }

    #[test]
    fn multiple_remotes_preserve_order() {
        let out = "origin\thttps://github.com/a/b.git (fetch)\n\
                   origin\thttps://github.com/a/b.git (push)\n\
                   upstream\thttps://github.com/u/b.git (fetch)\n\
                   upstream\thttps://github.com/u/b.git (push)\n";
        let remotes = parse_remotes(out);
        assert_eq!(remotes.len(), 2);
        assert_eq!(remotes[0].name, "origin");
        assert_eq!(remotes[1].name, "upstream");
    }

    #[test]
    fn differing_push_url_is_captured() {
        let out = "origin\thttps://github.com/a/b.git (fetch)\n\
                   origin\tgit@github.com:a/b.git (push)\n";
        let remotes = parse_remotes(out);
        assert_eq!(remotes.len(), 1);
        assert_eq!(remotes[0].fetch_url, "https://github.com/a/b.git");
        assert_eq!(remotes[0].push_url, "git@github.com:a/b.git");
    }
}

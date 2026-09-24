//! Commit history: log, commit details, search, blame, file history, reflog.

use super::*;

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    pub(super) async fn log(&self, opts: LogOptions) -> Result<Vec<Commit>, GitError> {
        let runner = self.runner().await;
        let fmt_arg = parsers::format_arg(parsers::log::LOG_FORMAT);
        let max_count = opts.max_count.unwrap_or(500);
        let skip = opts.skip.unwrap_or(0);
        let max_count_arg = format!("--max-count={max_count}");
        let skip_arg = format!("--skip={skip}");
        let author_arg = opts
            .author
            .as_deref()
            .filter(|a| !a.is_empty())
            .map(|a| format!("--author={a}"));

        // --date-order = the default commit-timestamp order PLUS the
        // guarantee that no parent lists before all of its children. The
        // default order lacks that guarantee: a parent discovered via one
        // child can win a committer-timestamp tie against another child and
        // list first, which breaks the commit graph's child->parent lane
        // edges (regression: log_lists_children_before_parents_on_equal_
        // timestamps in tests/git_flows.rs).
        let mut args = vec!["log", &fmt_arg, &max_count_arg, "--date-order"];
        if skip > 0 {
            args.push(&skip_arg);
        }
        // Author filter: fixed-string + case-insensitive so a plain email or
        // name matches literally (no accidental regex metacharacters).
        if let Some(author) = &author_arg {
            args.push("--fixed-strings");
            args.push("--regexp-ignore-case");
            args.push(author);
        }

        // Every OPTION goes in before the revisions: with `--end-of-options`
        // below, anything after it is a revision, and git rejects a trailing
        // `--decorate=full` outright ("must come before non-option
        // arguments" - caught by tests/git_flows.rs, not by the fake).
        args.push("--decorate=full");

        // An explicit revision range (e.g. `base..HEAD` for the interactive
        // rebase plan) wins over the ref selector.
        if let Some(range) = opts.revision_range.as_deref().filter(|r| !r.is_empty()) {
            // `git log --output=<file>` writes to a file, so an option-like
            // range is a file write, not just a bad walk (see `safe_ref`).
            args.push("--end-of-options");
            args.push(safe_ref("revision range", range)?);
        } else {
            // An unborn HEAD (fresh `git init`, no commits yet) makes the
            // explicit HEAD rev a fatal "ambiguous argument 'HEAD'";
            // --ignore-missing drops the unresolvable rev so a fresh repo
            // yields an empty log instead of an error (pinned in
            // tests/git_flows.rs). Deliberately NOT applied to the explicit
            // revision_range above - a bad range must still surface.
            args.push("--ignore-missing");
            match opts.refs {
                RefSelector::AllLocalBranches => {
                    // Always include HEAD so a detached HEAD commit appears even
                    // when it isn't reachable from any local branch.
                    args.push("HEAD");
                    args.push("--branches");
                }
                RefSelector::AllBranchesAndRemotes => {
                    args.push("HEAD");
                    args.push("--branches");
                    args.push("--remotes");
                }
                // Explicit HEAD (identical to bare `git log` once HEAD is
                // born) so --ignore-missing can drop it on an unborn HEAD;
                // the bare default would fail the walk instead.
                RefSelector::Head => args.push("HEAD"),
            }
        }

        let output = runner
            .run(&args)
            .await?;

        Self::ensure_success(&output)?;

        let mut commits = parsers::log::parse_log(&output.stdout).map_err(GitError::from)?;

        // NOTE: the list deliberately does NOT carry signature data - not
        // even presence. Presence is a separate, pay-per-view pass
        // (`signature_presence`, fetched only while the Signed column is
        // visible), and verification stays on-demand in `commit_details`.
        // LOG_FORMAT must never grow %G? (it spawns a verifier per commit).

        // Inject stashes as synthetic nodes so they appear in the graph. For
        // the full-graph view always; for a range walk only when the caller
        // opted in (`include_stashes`, the branch filter) and then only
        // stashes whose base commit is inside the walked window - others
        // couldn't hang off anything. Never for an author filter (a stash
        // isn't "a commit by this author"). Best-effort: a stash-list failure
        // must never break the commit log itself.
        let full_graph = matches!(
            opts.refs,
            RefSelector::AllLocalBranches | RefSelector::AllBranchesAndRemotes
        );
        if opts.author.is_none() && (full_graph || opts.include_stashes) {
            if let Ok(mut stashes) = self.stashes().await {
                if !full_graph {
                    let ids: std::collections::HashSet<&str> =
                        commits.iter().map(|c| c.id.as_str()).collect();
                    stashes.retain(|s| ids.contains(s.base_sha.as_str()));
                }
                inject_stashes(&mut commits, stashes);
            }
        }

        Ok(commits)
    }

    pub(super) async fn signature_presence(&self, ids: &[CommitId]) -> Result<Vec<CommitId>, GitError> {
        // One `cat-file --batch` over the not-yet-seen SHAs (byte-safe: the
        // output frames objects by byte count and may contain non-UTF-8
        // identities), then answer everything from the per-SHA cache -
        // presence is immutable, so a repeat query for the same page costs
        // zero subprocesses.
        let unknown: Vec<String> = {
            let cache = self.sig_presence.lock().unwrap();
            ids.iter()
                .filter(|id| !cache.contains_key(id.as_str()))
                .map(|id| id.as_str().to_string())
                .collect()
        };
        if !unknown.is_empty() {
            let runner = self.runner().await;
            let stdin = unknown.join("\n") + "\n";
            let out = runner.run_with_stdin_bytes(&["cat-file", "--batch"], &stdin).await?;
            if !out.success {
                return Err(command_failed(out.exit_code.unwrap_or(-1), &out.stderr));
            }
            let signed = parsers::commit::parse_batch_signature_presence(&out.stdout);
            let mut cache = self.sig_presence.lock().unwrap();
            for sha in unknown {
                let is_signed = signed.contains(&sha);
                cache.insert(sha, is_signed);
            }
        }
        let cache = self.sig_presence.lock().unwrap();
        Ok(ids
            .iter()
            .filter(|id| cache.get(id.as_str()).copied().unwrap_or(false))
            .cloned()
            .collect())
    }

    pub(super) async fn commit_details(&self, id: &CommitId) -> Result<CommitDetails, GitError> {
        let runner = self.runner().await;

        let cat_output = runner
            .run(&["cat-file", "-p", id.as_str()])
            .await?;

        Self::ensure_success(&cat_output)?;

        let mut parsed =
            parsers::commit::parse_cat_file(id.as_str(), &cat_output.stdout)
                .map_err(GitError::from)?;

        if parsed.has_signature_header {
            let verify_output = runner
                .run(&["verify-commit", "--raw", id.as_str()])
                .await?;
            // verify-commit exits non-zero for bad/unknown sigs - that's still
            // useful data, so we parse stderr regardless of exit code.
            let verification =
                parsers::commit::parse_verify_commit(&verify_output.stderr);
            parsed.commit.signature = verification;
        }

        Ok(CommitDetails {
            commit: parsed.commit,
            raw_object: parsed.raw_object,
        })
    }

    pub(super) async fn commit_files(&self, id: &CommitId) -> Result<Vec<CommitFileChange>, GitError> {
        // Resolve the parents ONCE. `rev-list --parents -n 1 <sha>` prints
        // `<sha> <parent1> <parent2> …`; a root commit prints only `<sha>`, so
        // we diff against the empty tree. Using an explicit `<from> <to>` pair
        // (rather than a bare commit) makes the diff first-parent for merges
        // and avoids diff-tree's empty default output for merge commits. The
        // 4th token, when present, is a potential stash untracked-files parent.
        let parents = self
            .run_checked(&["rev-list", "--parents", "-n", "1", id.as_str()])
            .await?;
        let from = parents
            .split_whitespace()
            .nth(1)
            .unwrap_or(EMPTY_TREE_OID)
            .to_string();
        let untracked_candidate = parents.split_whitespace().nth(3).map(str::to_string);
        let to = id.as_str();

        let mut raw = self.diff_tree(&from, to, "--raw").await?;
        let mut numstat = self.diff_tree(&from, to, "--numstat").await?;

        // A stash created with --include-untracked keeps its untracked files in a
        // separate 3rd-parent commit, NOT in the stash commit's own tree - so the
        // diff above misses them entirely. Append them as additions (empty tree →
        // untracked parent) so the stash's full contents show. Ordinary commits
        // are unaffected; a 3-parent octopus merge is filtered out by the
        // stash-list membership check.
        if let Some(untracked) = untracked_candidate {
            if self.is_stash_commit(to).await? {
                raw.push_str(&self.diff_tree(EMPTY_TREE_OID, &untracked, "--raw").await?);
                numstat.push_str(&self.diff_tree(EMPTY_TREE_OID, &untracked, "--numstat").await?);
            }
        }

        Ok(parsers::commit_files::parse_commit_files(&raw, &numstat))
    }

    pub(super) async fn blame(&self, path: &Path, rev: Option<&str>) -> Result<Vec<BlameHunk>, GitError> {
        let runner = self.runner().await;
        let path_str = path.to_string_lossy();
        // No `--end-of-options`: `git blame` rejects it outright (usage
        // error), so the dash guard is the only layer here.
        let rev = rev.map(|r| safe_ref("revision", r)).transpose()?;
        let mut args = vec!["blame", "--porcelain"];
        if let Some(rev) = rev {
            args.push(rev);
        }
        args.push("--");
        args.push(&path_str);
        let output = runner
            .run(&args)
            .await?;
        Self::ensure_success(&output)?;
        Ok(parsers::blame::parse_blame(&output.stdout))
    }

    pub(super) async fn merge_base(&self, a: &str, b: &str) -> Result<Option<String>, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run_expecting(
                &[
                    "merge-base",
                    "--end-of-options",
                    safe_ref("revision", a)?,
                    safe_ref("revision", b)?,
                ],
                &[1],
            )
            .await?;
        // Exit 1 = no common ancestor (unrelated histories) - that is an
        // answer, not an error. Unknown revs etc. exit 128 and are errors.
        match output.exit_code {
            Some(0) => Ok(Some(output.stdout.trim().to_string())),
            Some(1) => Ok(None),
            _ => Err(command_failed(output.exit_code.unwrap_or(-1), &output.stderr)),
        }
    }

    pub(super) async fn search_commits(
        &self,
        query: &str,
        kind: CommitSearchKind,
        max_count: u32,
    ) -> Result<Vec<Commit>, GitError> {
        let runner = self.runner().await;
        let fmt_arg = parsers::format_arg(parsers::log::LOG_FORMAT);
        let max_arg = format!("--max-count={max_count}");
        let filter = match kind {
            CommitSearchKind::Message => format!("--grep={query}"),
            CommitSearchKind::Author => format!("--author={query}"),
            CommitSearchKind::Content | CommitSearchKind::ContentRegex => query.to_string(),
        };
        let mut args = vec!["log", &fmt_arg, &max_arg];
        match kind {
            CommitSearchKind::Message | CommitSearchKind::Author => {
                args.push("--regexp-ignore-case");
                args.push(&filter);
            }
            CommitSearchKind::Content => {
                args.push("-S");
                args.push(&filter);
            }
            // -G is regex by nature (unlike -S, which needs --pickaxe-regex).
            CommitSearchKind::ContentRegex => {
                args.push("-G");
                args.push(&filter);
            }
        }
        // Same ref universe as the graph: HEAD + all local branches.
        // --ignore-missing tolerates an unborn HEAD (fresh repo, no
        // commits): the search returns empty instead of a fatal.
        args.push("--ignore-missing");
        args.push("HEAD");
        args.push("--branches");
        args.push("--decorate=full");

        let output = runner
            .run(&args)
            .await?;
        Self::ensure_success(&output)?;
        parsers::log::parse_log(&output.stdout).map_err(GitError::from)
    }

    pub(super) async fn search_paths(&self, query: &str, max_count: u32) -> Result<Vec<PathBuf>, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run(&["ls-files", "-z"])
            .await?;
        Self::ensure_success(&output)?;
        Ok(filter_paths(&output.stdout, query, max_count as usize))
    }

    pub(super) async fn resolve_commit(&self, rev: &str) -> Result<CommitId, GitError> {
        let runner = self.runner().await;
        // `^{commit}` peels tags to the tagged commit and rejects non-commit
        // objects; `--end-of-options` guards against dash-leading user input.
        let spec = format!("{rev}^{{commit}}");
        let output = runner
            .run(&["rev-parse", "--verify", "--quiet", "--end-of-options", &spec])
            .await?;
        Self::ensure_success(&output)?;
        let sha = output.stdout.trim();
        if sha.is_empty() {
            return Err(GitError::CommandFailed {
                exit_code: 1,
                stderr: format!("'{rev}' does not name a commit"),
            });
        }
        Ok(CommitId::new(sha.to_string()))
    }

    pub(super) async fn file_history(
        &self,
        path: &Path,
        max_count: u32,
        skip: u32,
        start_rev: Option<&str>,
    ) -> Result<Vec<FileHistoryEntry>, GitError> {
        let runner = self.runner().await;
        let path_str = path.to_string_lossy();
        let fmt_arg = parsers::format_arg(parsers::file_history::FILE_HISTORY_FORMAT);
        let max_arg = format!("--max-count={max_count}");
        let skip_arg = format!("--skip={skip}");
        // `--follow` requires exactly one pathspec (guaranteed here). `-M`
        // enables the rename detection that produces the `R<score>` lines.
        let mut args = vec!["log"];
        args.extend(parsers::file_history::FILE_HISTORY_FLAGS);
        args.push(&fmt_arg);
        args.push(&max_arg);
        args.push(&skip_arg);
        // Walk from an explicit rev (browse-at-commit mode) instead of HEAD.
        if let Some(rev) = start_rev {
            args.push(rev);
        }
        args.push("--");
        args.push(&path_str);
        let output = runner
            .run(&args)
            .await?;
        if !output.success {
            return Err(command_failed(output.exit_code.unwrap_or(-1), &output.stderr));
        }
        parsers::file_history::parse_file_history(&output.stdout, &path_str).map_err(GitError::from)
    }

    pub(super) async fn unpushed_commits(&self, max_count: u32) -> Result<Vec<CommitId>, GitError> {
        let runner = self.runner().await;
        let n = max_count.to_string();
        let out = runner
            .run(&["rev-list", "-n", &n, "HEAD", "--not", "--remotes"])
            .await?;
        Self::ensure_success(&out)?;
        Ok(out
            .stdout
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(CommitId::new)
            .collect())
    }

    pub(super) async fn reflog(&self, max_count: u32) -> Result<Vec<ReflogEntry>, GitError> {
        let runner = self.runner().await;
        let fmt_arg = parsers::format_arg(parsers::reflog::REFLOG_FORMAT);
        let count_arg = format!("-n{max_count}");
        let output = runner
            .run(&["reflog", &count_arg, &fmt_arg])
            .await?;
        Self::ensure_success(&output)?;
        Ok(parsers::reflog::parse_reflog(&output.stdout))
    }
}

/// Build a synthetic graph node for a stash entry. The real stash object is a
/// 2–3-parent merge (base, index, optional untracked); we keep ONLY the base as
/// the parent so the lane graph hangs it cleanly off its base instead of drawing
/// edges into git-internal index/untracked blobs.
pub(super) fn stash_commit(entry: &StashEntry) -> Commit {
    Commit {
        id: entry.stash_sha.clone(),
        parents: vec![entry.base_sha.clone()],
        author: entry.author.clone(),
        committer: entry.author.clone(),
        message: entry.message.clone(),
        timestamp: entry.timestamp,
        signature: None,
        has_signature: false,
        decorations: vec![RefDecoration::Stash(entry.selector.clone())],
    }
}

/// Insert synthetic stash nodes into a log result so they render in the graph.
///
/// Every stash is positioned purely by time in the newest-first list - stashes
/// interleave with commits, regardless of where their base sits. Real commits
/// are never reordered; we only splice stash nodes in. The comparison uses
/// *committer* timestamps because that is what `git log`'s default ordering
/// sorts by: rebased/cherry-picked commits keep their old author dates but sort
/// by their new commit dates, so comparing author dates would splice a stash
/// far from where the surrounding list actually places its neighbours. A
/// stash's base always has an older commit date than the stash, so the base
/// still appears later in the list and the stash's first-parent edge draws
/// downward into it (just not necessarily adjacent). `git stash list` is
/// most-recent first, so inserting in that order keeps `stash@{0}` highest when
/// several stashes share a timestamp.
pub(super) fn inject_stashes(commits: &mut Vec<Commit>, stashes: Vec<StashEntry>) {
    for entry in &stashes {
        let node = stash_commit(entry);
        let pos = commits
            .iter()
            .position(|c| c.committer.timestamp < node.timestamp)
            .unwrap_or(commits.len());
        commits.insert(pos, node);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- stash injection into the log ---------------------------------------

    use crate::Signature;

    fn sig(ts: i64) -> Signature {
        Signature {
            name: "t".into(),
            email: "t@t".into(),
            timestamp: ts,
            tz_offset_minutes: 0,
        }
    }

    /// A commit whose author and committer timestamps can differ (rebase /
    /// cherry-pick keep the author date but get a fresh commit date).
    fn commit(id: &str, author_ts: i64, committer_ts: i64) -> Commit {
        Commit {
            id: CommitId(id.into()),
            parents: vec![],
            author: sig(author_ts),
            committer: sig(committer_ts),
            message: id.into(),
            timestamp: author_ts,
            signature: None,
            has_signature: false,
            decorations: vec![],
        }
    }

    fn stash_entry(sha: &str, ts: i64) -> StashEntry {
        StashEntry {
            index: 0,
            selector: "stash@{0}".into(),
            message: "wip".into(),
            stash_sha: CommitId(sha.into()),
            base_sha: CommitId("base".into()),
            author: sig(ts),
            timestamp: ts,
        }
    }

    fn ids(commits: &[Commit]) -> Vec<&str> {
        commits.iter().map(|c| c.id.0.as_str()).collect()
    }

    #[test]
    fn stash_interleaves_by_committer_date() {
        let mut commits = vec![commit("c3", 300, 300), commit("c2", 200, 200), commit("c1", 100, 100)];
        inject_stashes(&mut commits, vec![stash_entry("s", 250)]);
        assert_eq!(ids(&commits), vec!["c3", "s", "c2", "c1"]);
    }

    #[test]
    fn stash_placement_ignores_rebased_author_dates() {
        // Regression: the list is ordered by *commit* date; a rebased commit
        // keeps an old author date. Comparing author dates would misplace the
        // stash above/below rebased commits.
        // c2 was rebased: author ts 100 (old), committer ts 400 (new).
        let mut commits = vec![commit("c2", 100, 400), commit("c1", 150, 150)];
        // Stash from t=300: newer than c1, older than c2's *commit* date.
        inject_stashes(&mut commits, vec![stash_entry("s", 300)]);
        assert_eq!(ids(&commits), vec!["c2", "s", "c1"]);
    }

    #[test]
    fn stash_older_than_window_appends_at_end() {
        let mut commits = vec![commit("c2", 200, 200), commit("c1", 100, 100)];
        inject_stashes(&mut commits, vec![stash_entry("s", 50)]);
        assert_eq!(ids(&commits), vec!["c2", "c1", "s"]);
    }

    #[test]
    fn newer_stash_stays_above_older_on_equal_timestamps() {
        // `git stash list` is most-recent first; equal timestamps must keep
        // stash@{0} highest.
        let mut commits = vec![commit("c1", 100, 100)];
        inject_stashes(
            &mut commits,
            vec![stash_entry("s0", 200), stash_entry("s1", 200)],
        );
        assert_eq!(ids(&commits), vec!["s0", "s1", "c1"]);
    }
}

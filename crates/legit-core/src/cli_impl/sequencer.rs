//! Merge, rebase (incl. interactive), cherry-pick, revert, and the in-progress operation state.

use super::*;

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    pub(super) async fn merge(&self, target: &str, opts: MergeOptions) -> Result<MergeOutcome, GitError> {
        let args = merge_args(safe_ref("merge target", target)?, opts);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, stdout, stderr) = self.run_classified(&refs).await?;
        classify_merge_output(code, &stdout, &stderr, opts.squash)
    }

    pub(super) async fn merge_continue(&self) -> Result<MergeOutcome, GitError> {
        let (code, stdout, stderr) = self
            .run_classified_env(&MERGE_CONTINUE_ARGS, EDITOR_ACCEPT_ENV)
            .await?;
        classify_merge_output(code, &stdout, &stderr, false)
    }

    pub(super) async fn merge_abort(&self) -> Result<(), GitError> {
        self.run_simple(&MERGE_ABORT_ARGS).await
    }

    pub(super) async fn rebase(&self, onto: &str) -> Result<RebaseOutcome, GitError> {
        let args = rebase_args(safe_ref("rebase target", onto)?);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, stdout, stderr) = self.run_classified(&refs).await?;
        classify_rebase_output(code, &stdout, &stderr)
    }

    pub(super) async fn rebase_continue(&self) -> Result<RebaseOutcome, GitError> {
        let (code, stdout, stderr) = self
            .run_classified_env(&REBASE_CONTINUE_ARGS, EDITOR_ACCEPT_ENV)
            .await?;
        classify_rebase_output(code, &stdout, &stderr)
    }

    pub(super) async fn rebase_skip(&self) -> Result<RebaseOutcome, GitError> {
        let (code, stdout, stderr) = self
            .run_classified_env(&REBASE_SKIP_ARGS, EDITOR_ACCEPT_ENV)
            .await?;
        classify_rebase_output(code, &stdout, &stderr)
    }

    pub(super) async fn rebase_abort(&self) -> Result<(), GitError> {
        self.run_simple(&REBASE_ABORT_ARGS).await
    }

    pub(super) async fn rebase_interactive(
        &self,
        base: &str,
        plan: &[RebaseStep],
    ) -> Result<RebaseOutcome, GitError> {
        // The dash guard runs FIRST, before the plan checks and before any
        // git: an option-like base must never reach a `rebase` argv (see
        // `safe_ref` - `--exec=<cmd>` runs <cmd>).
        let base = safe_ref("revision", base)?;
        validate_rebase_plan(plan)?;
        // The injected todo REPLACES git's generated one, and git silently
        // drops any base..HEAD commit missing from the todo (the default
        // rebase.missingCommitsCheck is "ignore" - verified against real git
        // in tests/git_flows.rs). A stale or truncated plan would lose
        // history without a word, so refuse any plan whose sha set is not
        // exactly `rev-list base..HEAD` - and refuse merge commits outright
        // (a `pick <merge>` wedges the rebase mid-flight: "is a merge but no
        // -m option was given").
        let range = format!("{base}..HEAD");
        let listed = self.run_checked(&["rev-list", "--parents", &range]).await?;
        verify_plan_covers_range(plan, &listed)?;
        // Message carriers for reword steps: an unreferenced commit with the
        // ORIGINAL's tree and the original as parent (empty diff, applies
        // anywhere in a reordered plan) holding the new message + the
        // original author. `fixup -C` then takes message and author from it
        // without opening an editor - git's own non-interactive reword lane
        // (what `commit --fixup=reword:` compiles down to; git >= 2.32).
        // The message travels as a plain argv argument: the runner spawns
        // without a shell, so it is byte-safe and may be multi-line.
        let runner = self.runner().await;
        let mut carriers: HashMap<String, String> = HashMap::new();
        for step in plan {
            if step.action != RebaseAction::Reword {
                continue;
            }
            let sha = step.sha.as_str();
            let author = self
                .run_checked(&["log", "-1", "--format=%an%x00%ae%x00%aD", sha])
                .await?;
            let (name, email, date) = parse_author_fields(&author).ok_or_else(|| {
                GitError::Internal(format!("unexpected author format for {sha}: {author:?}"))
            })?;
            let tree = format!("{sha}^{{tree}}");
            let message = step.message.as_deref().unwrap_or_default();
            let out = runner
                .run_with_env(
                    &["commit-tree", &tree, "-p", sha, "-m", message],
                    &[
                        ("GIT_AUTHOR_NAME", &name),
                        ("GIT_AUTHOR_EMAIL", &email),
                        ("GIT_AUTHOR_DATE", &date),
                    ],
                )
                .await?;
            if !out.success {
                return Err(command_failed(out.exit_code.unwrap_or(-1), &out.stderr));
            }
            carriers.insert(sha.to_string(), out.stdout.trim().to_string());
        }
        let todo = build_rebase_todo(plan, &carriers)?;
        // No temp script: sh completes `printf '<todo>' >` with the todo path
        // git appends, writing the plan straight into git's own todo file.
        // Safe to interpolate: the plan validation rejects non-hex shas (and
        // build_rebase_todo re-checks the carriers), so the single-quoted
        // printf format can never be broken out of.
        let editor = format!("printf '{todo}' >");
        let env = [("GIT_SEQUENCE_EDITOR", editor.as_str()), EDITOR_ACCEPT_ENV[0]];
        let (code, stdout, stderr) = self
            .run_classified_env(
                &[
                    "rebase",
                    "-i",
                    "--autostash",
                    "--end-of-options",
                    base,
                ],
                &env,
            )
            .await?;
        // Older git rejects the `fixup -C` todo line at parse time ("invalid
        // line ...: fixup -C <sha>"); name the floor so the error is
        // actionable rather than cryptic. Only for plans that actually
        // reword, and only when the failure mentions the fixup line.
        match classify_rebase_output(code, &stdout, &stderr) {
            Err(e) if !carriers.is_empty() && stderr.to_lowercase().contains("fixup") => {
                Err(append_error_note(
                    e,
                    "note: rewording via interactive rebase needs git 2.32 or newer (the `fixup -C` todo command)",
                ))
            }
            other => other,
        }
    }

    pub(super) async fn rebase_range_info(&self, base: &str) -> Result<RebaseRangeInfo, GitError> {
        let runner = self.runner().await;
        // Range commits NOT reachable from the upstream. Exit 128 = HEAD has
        // no upstream: no pushed-warning is possible - an answer, not an
        // error.
        let base = safe_ref("revision", base)?;
        let range = format!("{base}..HEAD");
        let up = runner
            .run_expecting(&["rev-list", &range, "--not", "@{upstream}"], &[128])
            .await?;
        let unpushed = if up.success {
            Some(up.stdout.lines().map(str::to_string).collect())
        } else if up.exit_code == Some(128) {
            None
        } else {
            return Err(command_failed(up.exit_code.unwrap_or(-1), &up.stderr));
        };
        // Exit 0 = base IS an ancestor of HEAD (plain history edit); exit 1
        // = it is not (the rebase RELOCATES the range onto the base). Any
        // other exit is a real failure.
        let anc = runner
            .run_expecting(
                &["merge-base", "--is-ancestor", "--end-of-options", base, "HEAD"],
                &[1],
            )
            .await?;
        let transplant = match anc.exit_code {
            Some(0) => false,
            Some(1) => true,
            _ => {
                return Err(command_failed(anc.exit_code.unwrap_or(-1), &anc.stderr));
            }
        };
        Ok(RebaseRangeInfo { unpushed, transplant })
    }

    pub(super) async fn revert(&self, shas: &[String], mainline: Option<u32>) -> Result<SequenceOutcome, GitError> {
        // --no-edit: the runner hardens GIT_EDITOR=false, so a revert that
        // opened an editor for its message would fail outright.
        let args = sequencer_args(&["revert", "--no-edit"], mainline, shas)?;
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, stdout, stderr) = self.run_classified(&refs).await?;
        classify_sequence_output(code, &stdout, &stderr)
    }

    pub(super) async fn cherry_pick(&self, shas: &[String], mainline: Option<u32>) -> Result<SequenceOutcome, GitError> {
        let args = sequencer_args(&["cherry-pick"], mainline, shas)?;
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, stdout, stderr) = self.run_classified(&refs).await?;
        classify_sequence_output(code, &stdout, &stderr)
    }

    pub(super) async fn cherry_pick_continue(&self) -> Result<SequenceOutcome, GitError> {
        let (code, stdout, stderr) = self
            .run_classified_env(&CHERRY_PICK_CONTINUE_ARGS, EDITOR_ACCEPT_ENV)
            .await?;
        classify_sequence_output(code, &stdout, &stderr)
    }

    pub(super) async fn cherry_pick_skip(&self) -> Result<SequenceOutcome, GitError> {
        let (code, stdout, stderr) = self
            .run_classified_env(&CHERRY_PICK_SKIP_ARGS, EDITOR_ACCEPT_ENV)
            .await?;
        classify_sequence_output(code, &stdout, &stderr)
    }

    pub(super) async fn cherry_pick_abort(&self) -> Result<(), GitError> {
        self.run_simple(&CHERRY_PICK_ABORT_ARGS).await
    }

    pub(super) async fn revert_continue(&self) -> Result<SequenceOutcome, GitError> {
        let (code, stdout, stderr) = self
            .run_classified_env(&REVERT_CONTINUE_ARGS, EDITOR_ACCEPT_ENV)
            .await?;
        classify_sequence_output(code, &stdout, &stderr)
    }

    pub(super) async fn revert_skip(&self) -> Result<SequenceOutcome, GitError> {
        let (code, stdout, stderr) = self
            .run_classified_env(&REVERT_SKIP_ARGS, EDITOR_ACCEPT_ENV)
            .await?;
        classify_sequence_output(code, &stdout, &stderr)
    }

    pub(super) async fn revert_abort(&self) -> Result<(), GitError> {
        self.run_simple(&REVERT_ABORT_ARGS).await
    }

    pub(super) async fn op_state(&self) -> Result<RepoOpState, GitError> {
        // git reports the state paths; only existence/content is read from
        // disk. --path-format=absolute avoids joining against the workdir.
        let (code, stdout, stderr) = self
            .run_classified(&[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "MERGE_HEAD",
                "--git-path",
                "MERGE_MSG",
                "--git-path",
                "rebase-merge",
                "--git-path",
                "rebase-apply",
                "--git-path",
                "CHERRY_PICK_HEAD",
                "--git-path",
                "REVERT_HEAD",
            ])
            .await?;
        if code != 0 {
            return Err(command_failed(code, &stderr));
        }
        let lines: Vec<&str> = stdout.lines().map(str::trim).collect();
        if lines.len() < 6 {
            return Err(GitError::Parse(format!(
                "rev-parse --git-path returned {} lines",
                lines.len()
            )));
        }

        // One batched probe for every candidate file - op_state is polled on
        // each status refresh, so the whole disk walk must stay a single
        // round trip on a remote host. Probe files are tiny; the cap only
        // guards against pathological files.
        const OP_STATE_CAP: u64 = 64 * 1024;
        let merge_head = HostPath(lines[0].to_string());
        let merge_msg = HostPath(lines[1].to_string());
        let rebase_merge = HostPath(lines[2].to_string());
        let rebase_apply = HostPath(lines[3].to_string());
        let cherry = HostPath(lines[4].to_string());
        let revert = HostPath(lines[5].to_string());

        let paths = [
            merge_head,                      // 0: existence only
            merge_msg,                       // 1
            rebase_merge.clone(),            // 2: dir existence gates 3..=6
            rebase_merge.join("head-name"),  // 3
            rebase_merge.join("onto"),       // 4
            rebase_merge.join("msgnum"),     // 5
            rebase_merge.join("end"),        // 6
            rebase_apply.clone(),            // 7: dir existence gates 8..=10
            rebase_apply.join("next"),       // 8
            rebase_apply.join("last"),       // 9
            rebase_apply.join("head-name"),  // 10
            cherry,                          // 11
            revert,                          // 12
        ];
        let mut probes = self
            .fs
            .probe_many(&paths, OP_STATE_CAP)
            .await
            .map_err(fs_internal)?;
        if probes.len() != paths.len() {
            return Err(GitError::Internal(format!(
                "probe_many returned {} entries for {} paths",
                probes.len(),
                paths.len()
            )));
        }
        let mut take = |i: usize| std::mem::replace(&mut probes[i], crate::fs::FsProbe::Missing);

        let probe = parsers::op_state::OpStateProbe {
            merge_head: take(0).exists(),
            merge_msg: take(1).into_utf8(),
            rebase_merge: if take(2).exists() {
                Some(parsers::op_state::RebaseMergeFiles {
                    head_name: take(3).into_utf8(),
                    onto: take(4).into_utf8(),
                    msgnum: take(5).into_utf8(),
                    end: take(6).into_utf8(),
                })
            } else {
                None
            },
            rebase_apply: if take(7).exists() {
                Some(parsers::op_state::RebaseApplyFiles {
                    next: take(8).into_utf8(),
                    last: take(9).into_utf8(),
                    head_name: take(10).into_utf8(),
                })
            } else {
                None
            },
            cherry_pick_head: take(11).into_utf8(),
            revert_head: take(12).into_utf8(),
        };
        Ok(parsers::op_state::op_state_from_probe(probe))
    }
}

/// `git merge` argument list. Non-squash merges pass `--no-edit` explicitly:
/// the runner hardens with `GIT_EDITOR=false`, and without `--no-edit` a
/// merge-commit path that decides to open an editor would fail outright.
pub(super) fn merge_args(target: &str, opts: MergeOptions) -> Vec<String> {
    let mut args: Vec<String> = vec!["merge".into()];
    if opts.squash {
        args.push("--squash".into());
    } else {
        match opts.ff {
            FfMode::Auto => {}
            FfMode::NoFf => args.push("--no-ff".into()),
            FfMode::FfOnly => args.push("--ff-only".into()),
        }
        args.push("--no-edit".into());
    }
    // Positional ref: `--end-of-options` keeps a dash-leading name from being
    // parsed as a flag (see `safe_ref`).
    args.push("--end-of-options".into());
    args.push(target.into());
    args
}

/// Env override for `merge/rebase --continue` (and `rebase --skip`): their
/// commit step consults the editor, and the runner's hardened base env sets
/// `GIT_EDITOR=false`, which fails it ("There was a problem with the editor
/// 'false'"). A `-c core.editor=…` cannot fix this - the `GIT_EDITOR` env var
/// outranks all config - so the env itself is overridden per invocation.
/// `true` exits 0 without touching the file: the prepared message is accepted
/// unchanged. Verified against real git in `tests/git_flows.rs`.
pub(super) const EDITOR_ACCEPT_ENV: &[(&str, &str)] = &[("GIT_EDITOR", "true")];

/// Continue/abort argument lists (run with `EDITOR_ACCEPT_ENV`).
pub(super) const MERGE_CONTINUE_ARGS: [&str; 2] = ["merge", "--continue"];

pub(super) const MERGE_ABORT_ARGS: [&str; 2] = ["merge", "--abort"];

/// `git rebase` always runs with `--autostash` so a dirty tree does not block
/// it; a conflicted stash reapply after completion is its own outcome.
/// `--end-of-options` is load-bearing here, not cosmetic: `git rebase` has
/// `--exec=<cmd>`, so a dash-leading `onto` is arbitrary command execution
/// (see `safe_ref`).
pub(super) fn rebase_args(onto: &str) -> Vec<String> {
    vec![
        "rebase".into(),
        "--autostash".into(),
        "--end-of-options".into(),
        onto.into(),
    ]
}

/// cherry-pick / revert argument list: the base command, `-m <N>` when a
/// mainline parent is given (merge commits), then the shas in the given
/// order (git's sequencer applies them left to right). Each sha passes the
/// `safe_ref` dash guard even behind `--end-of-options` - belt and braces,
/// and a clearer message than git's.
pub(super) fn sequencer_args(base: &[&str], mainline: Option<u32>, shas: &[String]) -> Result<Vec<String>, GitError> {
    let mut args: Vec<String> = base.iter().map(|s| s.to_string()).collect();
    if let Some(n) = mainline {
        args.push("-m".into());
        args.push(n.to_string());
    }
    args.push("--end-of-options".into());
    for sha in shas {
        args.push(safe_ref_owned("revision", sha)?);
    }
    Ok(args)
}

pub(super) const REBASE_CONTINUE_ARGS: [&str; 2] = ["rebase", "--continue"];

pub(super) const REBASE_SKIP_ARGS: [&str; 2] = ["rebase", "--skip"];

pub(super) const REBASE_ABORT_ARGS: [&str; 2] = ["rebase", "--abort"];

/// Sequencer (cherry-pick/revert) continue/skip/abort argument lists.
/// Continue and skip run with `EDITOR_ACCEPT_ENV` - concluding creates a
/// commit whose message git opens an editor for.
pub(super) const CHERRY_PICK_CONTINUE_ARGS: [&str; 2] = ["cherry-pick", "--continue"];

pub(super) const CHERRY_PICK_SKIP_ARGS: [&str; 2] = ["cherry-pick", "--skip"];

pub(super) const CHERRY_PICK_ABORT_ARGS: [&str; 2] = ["cherry-pick", "--abort"];

pub(super) const REVERT_CONTINUE_ARGS: [&str; 2] = ["revert", "--continue"];

pub(super) const REVERT_SKIP_ARGS: [&str; 2] = ["revert", "--skip"];

pub(super) const REVERT_ABORT_ARGS: [&str; 2] = ["revert", "--abort"];

/// Plan-validity rules, checked BEFORE anything runs (also mirrored for UX
/// by `planError` in `planModel.ts` - keep in sync):
/// - non-empty; not everything dropped;
/// - the first kept step must be a pick OR reword (squash/fixup meld into
///   a predecessor that would not exist);
/// - shas are plain hex (the todo is interpolated into a single-quoted,
///   shell-interpreted editor string, so anything else is rejected
///   outright rather than escaped);
/// - reword steps carry a non-blank message, non-reword steps carry none.
pub(super) fn validate_rebase_plan(plan: &[RebaseStep]) -> Result<(), GitError> {
    if plan.is_empty() {
        return Err(GitError::Internal("interactive rebase plan is empty".into()));
    }
    let mut first_kept = true;
    for step in plan {
        let sha = step.sha.as_str();
        if sha.is_empty() || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(GitError::Internal(format!(
                "interactive rebase plan contains a non-hex sha: {sha:?}"
            )));
        }
        if matches!(step.action, RebaseAction::Squash | RebaseAction::Fixup) && first_kept {
            return Err(GitError::Internal(
                "interactive rebase plan starts with squash/fixup (nothing to meld into)".into(),
            ));
        }
        if step.action != RebaseAction::Drop {
            first_kept = false;
        }
        match (step.action, &step.message) {
            (RebaseAction::Reword, Some(m)) if !m.trim().is_empty() => {}
            (RebaseAction::Reword, _) => {
                return Err(GitError::Internal(
                    "a reword step needs a non-empty message".into(),
                ));
            }
            (_, Some(_)) => {
                return Err(GitError::Internal(
                    "only reword steps may carry a message".into(),
                ));
            }
            (_, None) => {}
        }
    }
    if first_kept {
        return Err(GitError::Internal(
            "interactive rebase plan drops every commit".into(),
        ));
    }
    Ok(())
}

/// Build the printf format string for the injected todo (`\n` separated as
/// printf escapes). Assumes `validate_rebase_plan` passed; `carriers` maps
/// each reword step's sha to its message-carrier commit (created by
/// `rebase_interactive`). A reword emits `pick <sha>` + `fixup -C <carrier>`
/// - fixup -C takes message AND author from the carrier without opening an
/// editor (git >= 2.32).
pub(super) fn build_rebase_todo(
    plan: &[RebaseStep],
    carriers: &HashMap<String, String>,
) -> Result<String, GitError> {
    let mut todo = String::new();
    for step in plan {
        let sha = step.sha.as_str();
        todo.push_str(step.action.keyword());
        todo.push(' ');
        todo.push_str(sha);
        todo.push_str("\\n");
        if step.action == RebaseAction::Reword {
            let carrier = carriers.get(sha).ok_or_else(|| {
                GitError::Internal(format!("no message carrier for reword {sha}"))
            })?;
            if carrier.is_empty() || !carrier.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(GitError::Internal(format!(
                    "carrier commit id is not hex: {carrier:?}"
                )));
            }
            todo.push_str("fixup -C ");
            todo.push_str(carrier);
            todo.push_str("\\n");
        }
    }
    Ok(todo)
}

/// Parse `git log -1 --format=%an%x00%ae%x00%aD` output into
/// (name, email, date). NUL-separated: names/emails may contain anything
/// printable, dates contain spaces.
pub(super) fn parse_author_fields(s: &str) -> Option<(String, String, String)> {
    let mut it = s.trim_end_matches('\n').splitn(3, '\0');
    match (it.next(), it.next(), it.next()) {
        (Some(n), Some(e), Some(d)) if !n.is_empty() && !d.is_empty() => {
            Some((n.to_string(), e.to_string(), d.to_string()))
        }
        _ => None,
    }
}

/// Check an interactive-rebase plan against `git rev-list --parents
/// base..HEAD` output before the todo is injected. The injected todo fully
/// replaces git's generated one and missing lines mean silently DROPPED
/// commits, so the plan's sha set must equal the range's sha set exactly:
/// a truncated plan (UI listing cap) or a stale one (a commit landed after
/// the plan was built) is refused instead of losing history. Merge commits
/// are refused too - `pick <merge>` stops the rebase mid-flight with "is a
/// merge but no -m option was given" and plain continue re-hits it.
pub(super) fn verify_plan_covers_range(plan: &[RebaseStep], rev_list_parents: &str) -> Result<(), GitError> {
    let mut range: HashSet<&str> = HashSet::new();
    for line in rev_list_parents.lines() {
        let mut fields = line.split_whitespace();
        let Some(sha) = fields.next() else { continue };
        if fields.count() > 1 {
            return Err(GitError::Internal(format!(
                "the range contains a merge commit ({}); interactive rebase across merges is not supported",
                &sha[..sha.len().min(8)]
            )));
        }
        range.insert(sha);
    }
    let planned: HashSet<&str> = plan.iter().map(|s| s.sha.as_str()).collect();
    if planned != range || plan.len() != range.len() {
        return Err(GitError::Internal(
            "the plan no longer matches the commits after the base (the repository changed since \
             the plan was built); reload the plan and try again"
                .into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- interactive rebase todo validation ----------------------------------

    #[test]
    fn rebase_todo_renders_keywords_in_order() {
        let plan = vec![
            RebaseStep::new(RebaseAction::Pick, "aaa111"),
            RebaseStep::new(RebaseAction::Squash, "bbb222"),
            RebaseStep::new(RebaseAction::Fixup, "ccc333"),
            RebaseStep::new(RebaseAction::Drop, "ddd444"),
        ];
        let todo = build_rebase_todo(&plan, &HashMap::new()).unwrap();
        // LITERAL backslash-n separators, not newlines: the todo is injected
        // through `GIT_SEQUENCE_EDITOR="printf '%s' ... >"`-style shell
        // expansion, where printf expands the \n escapes into real newlines.
        assert_eq!(todo, r"pick aaa111\nsquash bbb222\nfixup ccc333\ndrop ddd444\n");
    }

    #[test]
    fn build_rebase_todo_expands_rewords() {
        let carriers = HashMap::from([("bbb222".to_string(), "ccc333".to_string())]);
        let todo = build_rebase_todo(
            &[
                RebaseStep::new(RebaseAction::Pick, "aaa111"),
                RebaseStep::reword("bbb222", "new message"),
            ],
            &carriers,
        )
        .expect("todo");
        assert_eq!(todo, r"pick aaa111\npick bbb222\nfixup -C ccc333\n");
        // A reword without its carrier is a programmer error, not a git run.
        assert!(build_rebase_todo(&[RebaseStep::reword("bbb222", "m")], &HashMap::new()).is_err());
        // A non-hex carrier must never reach the shell-interpolated todo.
        let bad = HashMap::from([("bbb222".to_string(), "evil'".to_string())]);
        assert!(build_rebase_todo(&[RebaseStep::reword("bbb222", "m")], &bad).is_err());
    }

    #[test]
    fn validate_rebase_plan_rules() {
        assert!(validate_rebase_plan(&[]).is_err(), "empty plan");
        assert!(
            validate_rebase_plan(&[RebaseStep::new(RebaseAction::Squash, "aaa111")]).is_err(),
            "leading squash has nothing to meld into"
        );
        // A leading DROP does not count as the first kept step.
        assert!(
            validate_rebase_plan(&[
                RebaseStep::new(RebaseAction::Drop, "aaa111"),
                RebaseStep::new(RebaseAction::Fixup, "bbb222"),
            ])
            .is_err(),
            "fixup after only drops still has nothing to meld into"
        );
        assert!(
            validate_rebase_plan(&[RebaseStep::new(RebaseAction::Pick, "not-hex!")]).is_err(),
            "non-hex sha must be rejected (it would be injected into the todo file)"
        );
        assert!(
            validate_rebase_plan(&[RebaseStep::new(RebaseAction::Drop, "aaa111")]).is_err(),
            "all-dropped plan"
        );
        // Reword counts as a kept first step.
        assert!(validate_rebase_plan(&[RebaseStep::reword("aaa111", "msg")]).is_ok());
        // Blank / missing reword message refused.
        assert!(validate_rebase_plan(&[RebaseStep::reword("aaa111", "  \n")]).is_err());
        let mut no_msg = RebaseStep::new(RebaseAction::Reword, "aaa111");
        no_msg.message = None;
        assert!(validate_rebase_plan(&[no_msg]).is_err());
        // A message on a non-reword step would silently do nothing: refused.
        let mut pick_msg = RebaseStep::new(RebaseAction::Pick, "aaa111");
        pick_msg.message = Some("m".into());
        assert!(validate_rebase_plan(&[pick_msg]).is_err());
    }

    #[test]
    fn parses_author_fields() {
        assert_eq!(
            parse_author_fields("Ada\0ada@example.com\0Mon, 1 Jan 2024 10:00:00 +0100\n"),
            Some((
                "Ada".into(),
                "ada@example.com".into(),
                "Mon, 1 Jan 2024 10:00:00 +0100".into()
            ))
        );
        assert_eq!(parse_author_fields("no separators"), None);
    }

    // --- interactive rebase plan-vs-range guard -------------------------------

    #[test]
    fn rebase_plan_must_cover_the_range_exactly() {
        let plan = vec![
            RebaseStep::new(RebaseAction::Pick, "aaa111"),
            RebaseStep::new(RebaseAction::Drop, "bbb222"),
        ];
        // Exact set match (rev-list order is irrelevant; each line is
        // "<sha> <parent>").
        let listed = "bbb222 aaa111\naaa111 base00\n";
        assert!(verify_plan_covers_range(&plan, listed).is_ok());

        // A range commit missing from the plan would be SILENTLY DROPPED by
        // git (missing todo lines are drops) - refuse. This is the truncated
        // or stale-plan case (regression test for the data-loss scenario).
        let listed = "ccc333 bbb222\nbbb222 aaa111\naaa111 base00\n";
        assert!(verify_plan_covers_range(&plan, listed).is_err(), "missing range commit");

        // A plan sha outside the range is equally refused.
        let listed = "aaa111 base00\n";
        assert!(verify_plan_covers_range(&plan, listed).is_err(), "foreign plan sha");

        // A merge commit in the range (two parents on the rev-list line)
        // cannot be picked ("is a merge but no -m option was given").
        let plan = vec![
            RebaseStep::new(RebaseAction::Pick, "aaa111"),
            RebaseStep::new(RebaseAction::Pick, "eee555"),
        ];
        let listed = "eee555 aaa111 fff666\naaa111 base00\n";
        assert!(verify_plan_covers_range(&plan, listed).is_err(), "merge commit in range");

        // Duplicate plan entries can never satisfy the set+length check.
        let plan = vec![
            RebaseStep::new(RebaseAction::Pick, "aaa111"),
            RebaseStep::new(RebaseAction::Pick, "aaa111"),
        ];
        let listed = "bbb222 aaa111\naaa111 base00\n";
        assert!(verify_plan_covers_range(&plan, listed).is_err(), "duplicate plan sha");
    }

    // --- merge/rebase argument construction ---

    #[test]
    fn merge_args_pass_no_edit_for_commit_merges() {
        // GIT_EDITOR=false hardening: a merge that decides to open an editor
        // would fail, so every non-squash merge must carry --no-edit.
        for ff in [FfMode::Auto, FfMode::NoFf, FfMode::FfOnly] {
            let args = merge_args("dev", MergeOptions { ff, squash: false });
            assert!(args.contains(&"--no-edit".to_string()), "{args:?}");
            assert_eq!(args.last().unwrap(), "dev");
        }
        assert!(merge_args("dev", MergeOptions { ff: FfMode::NoFf, squash: false })
            .contains(&"--no-ff".to_string()));
        assert!(merge_args("dev", MergeOptions { ff: FfMode::FfOnly, squash: false })
            .contains(&"--ff-only".to_string()));
    }

    #[test]
    fn squash_merge_ignores_ff_and_skips_no_edit() {
        let args = merge_args("dev", MergeOptions { ff: FfMode::NoFf, squash: true });
        assert_eq!(args, vec!["merge", "--squash", "--end-of-options", "dev"]);
    }

    #[test]
    fn continue_commands_neutralize_the_editor_via_env() {
        // Regression: `-c core.editor=true` was used before, but the runner's
        // GIT_EDITOR=false env var outranks config, so continuing a conflicted
        // merge/rebase always failed. The env must be overridden instead.
        assert_eq!(EDITOR_ACCEPT_ENV, &[("GIT_EDITOR", "true")]);
        assert_eq!(MERGE_CONTINUE_ARGS, ["merge", "--continue"]);
        assert_eq!(REBASE_CONTINUE_ARGS, ["rebase", "--continue"]);
        assert_eq!(REBASE_SKIP_ARGS, ["rebase", "--skip"]);
    }

    #[test]
    fn rebase_always_autostashes() {
        assert_eq!(
            rebase_args("main"),
            vec!["rebase", "--autostash", "--end-of-options", "main"]
        );
    }
}

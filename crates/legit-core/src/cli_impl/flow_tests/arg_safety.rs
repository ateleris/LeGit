use super::*;

// ---------------------------------------------------------------------------
// Option-like ref names (argument injection)
// ---------------------------------------------------------------------------

/// A ref name that begins with `-` must be refused BEFORE the first git
/// invocation: the script below is empty, so any call at all fails the test.
///
/// Such a name is not user typo territory, it arrives with the repository:
/// `git update-ref 'refs/tags/--exec=cmd'` succeeds, `git clone` copies that
/// tag verbatim, and a remote whose `HEAD` points at `refs/heads/--exec=cmd`
/// makes clone CREATE and check out a local branch with that name. Git parses
/// a positional argument starting with `-` as an OPTION, and `git rebase
/// --autostash --exec=<cmd>` runs `<cmd>` - so before this guard, one click
/// on "Rebase onto" in the ref's own context menu was arbitrary command
/// execution. Real-git counterpart:
/// `tests/git_flows.rs::option_like_ref_never_reaches_rebase_exec`.
#[tokio::test]
async fn option_like_refs_are_refused_before_git_runs() {
    let evil = "--exec=git$IFStag$IFSLEGIT_PWNED";
    let fake = FakeExecutor::default();
    let (b, exec) = backend(fake);

    macro_rules! assert_refused {
        ($call:expr, $what:literal) => {
            match $call.await {
                Err(GitError::UnsafeArgument(msg)) => {
                    assert!(msg.contains(evil), "{}: message must name the value: {msg}", $what)
                }
                other => panic!("{} accepted an option-like ref: {other:?}", $what),
            }
        };
    }

    assert_refused!(b.rebase(evil), "rebase");
    assert_refused!(
        b.merge(evil, MergeOptions { ff: FfMode::Auto, squash: false }),
        "merge"
    );
    assert_refused!(
        b.switch_branch(evil, SwitchDirtyBehavior::TryDirectly),
        "switch_branch"
    );
    assert_refused!(
        b.checkout_commit(evil, SwitchDirtyBehavior::TryDirectly),
        "checkout_commit"
    );
    assert_refused!(b.checkout_remote_branch(evil, SwitchDirtyBehavior::TryDirectly, false), "checkout_remote_branch");
    assert_refused!(b.create_branch(evil, None), "create_branch");
    assert_refused!(b.create_branch("ok", Some(evil)), "create_branch start point");
    assert_refused!(b.delete_branch(evil, false), "delete_branch");
    assert_refused!(b.rename_branch(evil, "ok"), "rename_branch");
    assert_refused!(b.delete_tag(evil), "delete_tag");
    assert_refused!(b.reset(evil, ResetMode::Hard), "reset");
    assert_refused!(b.cherry_pick(&[evil.to_string()], None), "cherry_pick");
    assert_refused!(b.revert(&[evil.to_string()], None), "revert");
    assert_refused!(b.set_upstream(evil, None), "set_upstream");
    assert_refused!(b.rebase_interactive(evil, &[]), "rebase_interactive");

    // Read-only commands too: `git log`/`diff` accept `--output=<file>`, so an
    // option-like rev there is an arbitrary FILE WRITE rather than a bad walk.
    assert_refused!(b.merge_base(evil, "HEAD"), "merge_base");
    assert_refused!(b.diff_files(evil, "HEAD"), "diff_files");
    assert_refused!(b.list_files_at_revision(evil), "list_files_at_revision");
    assert_refused!(
        b.file_at_revision(evil, std::path::Path::new("a.txt")),
        "file_at_revision"
    );
    assert_refused!(
        b.blame(std::path::Path::new("a.txt"), Some(evil)),
        "blame"
    );
    assert_refused!(
        b.log(LogOptions {
            max_count: Some(10),
            skip: None,
            revision_range: Some(evil.to_string()),
            paths: Vec::new(),
            refs: RefSelector::Head,
            author: None,
            include_stashes: false,
        }),
        "log revision_range"
    );

    // Remote NAMES sit in positional slots too: `git fetch --upload-pack=<cmd>`
    // and `git push --receive-pack=<cmd>` run <cmd> locally for path/ssh
    // transports, and a name reaches these slots from the repo's own config.
    assert_refused!(
        b.fetch(
            FetchOptions { all: false, prune: false, remote: Some(evil.to_string()) },
            OperationId::new()
        ),
        "fetch"
    );
    assert_refused!(
        b.push(
            PushOptions {
                remote: evil.to_string(),
                branch: "main".to_string(),
                set_upstream: false,
                force_with_lease: false,
                recurse_submodules: None,
            },
            OperationId::new()
        ),
        "push"
    );
    assert_refused!(b.prune_remote(evil, OperationId::new()), "prune_remote");
    assert_refused!(b.add_remote(evil, "https://example.com/r.git"), "add_remote");
    assert_refused!(b.remove_remote(evil), "remove_remote");
    assert_refused!(b.rename_remote(evil, "ok"), "rename_remote old name");
    assert_refused!(b.rename_remote("ok", evil), "rename_remote new name");
    assert_refused!(
        b.set_remote_url(evil, "https://example.com/r.git", false),
        "set_remote_url"
    );

    // Nothing ran: the script was never touched.
    exec.assert_done();
}

/// The second, independent layer: the argv builders pass `--end-of-options`,
/// so even a name the guard somehow let through cannot be parsed as an
/// option. `reset` and `checkout <rev> -- <path>` are the two commands that
/// REJECT `--end-of-options`, which is exactly why the guard above exists as
/// its own layer rather than as belt-and-braces.
#[tokio::test]
async fn ref_taking_commands_pass_end_of_options() {
    for args in [
        rebase_args("main"),
        merge_args("dev", MergeOptions { ff: FfMode::Auto, squash: false }),
        sequencer_args(&["cherry-pick"], None, &["abc123".to_string()]).unwrap(),
        sequencer_args(&["revert", "--no-edit"], Some(2), &["abc123".to_string()]).unwrap(),
    ] {
        let pos = args.iter().position(|a| a == "--end-of-options");
        let pos = pos.unwrap_or_else(|| panic!("no --end-of-options in {args:?}"));
        assert_eq!(pos, args.len() - 2, "the guard must be the LAST option: {args:?}");
    }
    let tag = build_tag_args("v1", Some("abc123"), Some("release"));
    let pos = tag.iter().position(|a| *a == "--end-of-options").expect("tag guard");
    assert_eq!(tag[pos + 1], "v1", "the tag NAME must follow the guard: {tag:?}");
}

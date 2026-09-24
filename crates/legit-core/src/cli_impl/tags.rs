//! Local tags.

use super::*;

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    pub(super) async fn tags(&self) -> Result<Vec<TagInfo>, GitError> {
        let runner = self.runner().await;
        let fmt_arg = parsers::format_arg(parsers::tags::TAGS_FORMAT);
        let output = runner
            .run(&["for-each-ref", &fmt_arg, "refs/tags"])
            .await?;
        Self::ensure_success(&output)?;
        let mut tags = parsers::tags::parse_tags(&output.stdout);
        if !tags.is_empty() {
            // Mark tags whose target commit is not reachable from any
            // remote-tracking ref: pushing such a tag would upload commits no
            // remote branch references, so the UI disables it. Best-effort: a
            // failed probe leaves the permissive default (push allowed).
            let probe = runner
                .run(&parsers::tags::REV_LIST_UNPUSHED_TAG_TARGETS_ARGS)
                .await;
            if let Ok(out) = probe {
                if out.success {
                    parsers::tags::mark_unpushed_targets(&mut tags, &out.stdout);
                }
            }
        }
        Ok(tags)
    }

    pub(super) async fn create_tag(
        &self,
        name: &str,
        target: Option<&str>,
        message: Option<&str>,
    ) -> Result<(), GitError> {
        self.run_simple(&build_tag_args(name, target, message)).await
    }

    pub(super) async fn delete_tag(&self, name: &str) -> Result<(), GitError> {
        self.run_simple(&["tag", "-d", "--end-of-options", safe_ref("tag", name)?])
            .await
    }
}

/// Build the argument vector for `git tag`. A non-blank message makes the tag
/// annotated (`-a -m`); a blank/whitespace-only message is treated as absent
/// so the UI's empty input never creates an annotated tag with an empty
/// annotation. The target (when given) is always the trailing argument.
///
/// `--end-of-options` guards the positional name/target (see `safe_ref`);
/// the `-m` message is an option VALUE, which git never re-parses as a flag.
pub(super) fn build_tag_args<'a>(
    name: &'a str,
    target: Option<&'a str>,
    message: Option<&'a str>,
) -> Vec<&'a str> {
    let mut args = vec!["tag"];
    if let Some(msg) = message.filter(|m| !m.trim().is_empty()) {
        args.push("-a");
        // `-m <msg>` moves BEFORE the name: `--end-of-options` must be the
        // last option, and everything after it is positional.
        args.push("-m");
        args.push(msg);
    }
    args.push("--end-of-options");
    args.push(name);
    if let Some(t) = target {
        args.push(t);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_args_lightweight() {
        assert_eq!(
            build_tag_args("v1", None, None),
            vec!["tag", "--end-of-options", "v1"]
        );
    }

    #[test]
    fn tag_args_blank_message_stays_lightweight() {
        // The UI sends the annotation input verbatim; whitespace-only must not
        // create an annotated tag with an empty message.
        assert_eq!(
            build_tag_args("v1", None, Some("   ")),
            vec!["tag", "--end-of-options", "v1"]
        );
    }

    #[test]
    fn tag_args_annotated_with_target() {
        assert_eq!(
            build_tag_args("v1", Some("abc123"), Some("release")),
            vec!["tag", "-a", "-m", "release", "--end-of-options", "v1", "abc123"]
        );
    }

    #[test]
    fn tag_args_lightweight_with_target() {
        assert_eq!(
            build_tag_args("v1", Some("abc123"), None),
            vec!["tag", "--end-of-options", "v1", "abc123"]
        );
    }
}

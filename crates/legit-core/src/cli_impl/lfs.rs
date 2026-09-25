//! Git LFS status.

use super::*;

const LFS_ATTRIBUTE_FILES_ARGS: [&str; 6] =
    ["grep", "-l", "-e", "filter=lfs", "--", ":(glob)**/.gitattributes"];

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    /// The tracked `.gitattributes` files (root and nested) that declare
    /// `filter=lfs`, as repo-relative paths.
    pub(super) async fn lfs_attribute_files(&self) -> Result<Vec<String>, GitError> {
        // `:(glob)**/.gitattributes` matches the root file and nested ones
        // (a leading `**/` matches zero or more directories). git grep
        // searches tracked files, which is the right scope: `git lfs track`
        // always writes .gitattributes, and LFS rules are committed.
        // Exit 1 = "no hits" - an answer (run_expecting logs it as OK).
        let grep = self
            .runner()
            .await
            .run_expecting(&LFS_ATTRIBUTE_FILES_ARGS, &[1])
            .await?;
        match grep.exit_code {
            Some(0) => Ok(grep.stdout.lines().filter(|f| !f.is_empty()).map(str::to_string).collect()),
            Some(1) => Ok(Vec::new()),
            _ => Err(command_failed(grep.exit_code.unwrap_or(-1), &grep.stderr)),
        }
    }

    pub(super) async fn lfs_status(&self) -> Result<LfsStatus, GitError> {
        let uses_lfs = !self.lfs_attribute_files().await?.is_empty();
        let runner = self.runner().await;
        if !uses_lfs {
            return Ok(LfsStatus {
                uses_lfs: false,
                installed: false,
                version: None,
                initialized: false,
            });
        }
        // A missing git-lfs makes this exit non-zero ("git: 'lfs' is not a
        // git command") - that IS the probe result, never an error.
        let ver = runner.run(&["lfs", "version"]).await?;
        let installed = ver.success;
        let version = if installed {
            ver.stdout
                .lines()
                .next()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
        } else {
            None
        };
        // Unset key exits 1 (expected). Set + non-empty = `git lfs install`
        // has registered the smudge filter for this repo's context.
        let cfg = runner
            .run_expecting(&["config", "--get", "filter.lfs.smudge"], &[1])
            .await?;
        let initialized = cfg.success && !cfg.stdout.trim().is_empty();
        Ok(LfsStatus { uses_lfs, installed, version, initialized })
    }

    pub(super) async fn lfs_tracked_subset(&self, paths: &[String]) -> Result<Vec<String>, GitError> {
        if paths.is_empty() {
            return Ok(vec![]);
        }
        let runner = self.runner().await;
        let stdin: String = paths.iter().map(|p| format!("{p}\0")).collect();
        let out = runner
            .run_with_stdin(&["check-attr", "-z", "--stdin", "filter"], &stdin)
            .await?;
        Self::ensure_success(&out)?;
        let lfs = parse_check_attr_filter_lfs(&out.stdout);
        Ok(paths.iter().filter(|p| lfs.contains(p.as_str())).cloned().collect())
    }
}

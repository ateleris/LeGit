//! Signer trust: trust-dialog info for a commit and allowed-signers writes
//! (design/2026-11-19-trusted-ssh-signers.md).

use super::*;
use crate::signers::{self, SignerTrustInfo, TrustSignerOutcome};

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    pub(super) async fn signer_trust_info(
        &self,
        id: &CommitId,
    ) -> Result<SignerTrustInfo, GitError> {
        let runner = self.runner().await;
        let out = runner.run(&["cat-file", "-p", id.as_str()]).await?;
        Self::ensure_success(&out)?;
        let parsed = parsers::commit::parse_cat_file(id.as_str(), &out.stdout)
            .map_err(GitError::from)?;
        let key = signers::extract_sshsig_armor(&out.stdout)
            .and_then(|armor| signers::parse_sshsig_pubkey(&armor));
        let target = signers::resolve_signers_target(runner.as_ref()).await?;
        Ok(SignerTrustInfo { principal: parsed.commit.committer.email, key, target })
    }

    pub(super) async fn trust_signer(
        &self,
        principal: &str,
        key_type: &str,
        key_b64: &str,
        bootstrap: bool,
    ) -> Result<TrustSignerOutcome, GitError> {
        let runner = self.runner().await;
        signers::trust_signer_flow(
            runner.as_ref(),
            self.fs.as_ref(),
            principal,
            key_type,
            key_b64,
            bootstrap,
        )
        .await
    }
}

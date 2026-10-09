//! Commit-signing config commands.
//!
//! LeGit's signing panel is a direct mirror of the relevant `git config`
//! keys at the requested scope — there is no LeGit-side persistent state.
//! SSH signing is the priority path, so `gpg.ssh.allowedSignersFile` (needed
//! for SSH signatures to verify as trusted) is surfaced alongside the core
//! keys. All reads/writes go through `GitRunner`; system scope is read-only.
//! Only the GLOBAL scope has commands here: repo-local signing config is
//! managed through git profiles (`profiles.rs` reuses the `KEY_*` constants).

use legit_core::config::{self, ConfigScope, ScopedConfig, WriteScope};
use crate::commands::settings_host::{settings_executor, SettingsHost};
use crate::error::AppError;
use crate::state::AppState;
use legit_core::GitExecutor;
use serde::{Deserialize, Serialize};
use specta::Type;

pub(crate) const KEY_GPGSIGN: &str = "commit.gpgsign";
pub(crate) const KEY_FORMAT: &str = "gpg.format";
pub(crate) const KEY_SIGNING_KEY: &str = "user.signingkey";
pub(crate) const KEY_ALLOWED_SIGNERS: &str = "gpg.ssh.allowedSignersFile";
const KEY_SSH_PROGRAM: &str = "gpg.ssh.program";

/// All signing-relevant config keys, each resolved across scopes.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SigningView {
    /// `commit.gpgsign` — whether commits are signed by default.
    pub gpgsign: ScopedConfig,
    /// `gpg.format` — `openpgp` (default), `ssh`, or `x509`.
    pub format: ScopedConfig,
    /// `user.signingkey` — key id (GPG) or key path / literal key (SSH).
    pub signing_key: ScopedConfig,
    /// `gpg.ssh.allowedSignersFile` — required for SSH signatures to verify
    /// as trusted rather than merely valid.
    pub allowed_signers: ScopedConfig,
    /// Scope whose effective `gpg.ssh.program` entry is EMPTY. An empty value
    /// overrides git's bundled ssh-keygen fallback with "", so every signed
    /// commit fails with "cannot spawn : No such file or directory". `None`
    /// when the key is absent or names a real program. An empty global entry
    /// is removed by the next `write_signing_global`; a system one can only
    /// be fixed outside LeGit.
    pub ssh_program_broken: Option<ConfigScope>,
}

/// The scope whose `gpg.ssh.program` git would use, when that entry is empty
/// (set-but-valueless counts too). Any global entry shadows system; within a
/// scope the last entry wins, mirroring git's resolution.
fn broken_ssh_program_scope(snapshot: &config::GlobalConfigSnapshot) -> Option<ConfigScope> {
    // `ConfigEntries::value` collapses an empty entry to unset, so the raw
    // multi-entry listing is the only reading that can see "set but empty".
    let last_is_empty =
        |e: &config::ConfigEntries| e.values(KEY_SSH_PROGRAM).last().map(|v| v.is_empty());
    match last_is_empty(&snapshot.global) {
        Some(true) => Some(ConfigScope::Global),
        Some(false) => None,
        None => (last_is_empty(&snapshot.system) == Some(true)).then_some(ConfigScope::System),
    }
}

/// Global-settings variant: global + system scope only. The unbound runner's
/// cwd may lie inside some repo, and an all-scopes read would leak that
/// repo's local config into the view (see `config::read_global_snapshot`).
pub(crate) async fn read_signing_view_global(runner: &dyn GitExecutor) -> SigningView {
    let snapshot = config::read_global_snapshot(runner).await;
    SigningView {
        gpgsign: snapshot.scoped(KEY_GPGSIGN),
        format: snapshot.scoped(KEY_FORMAT),
        signing_key: snapshot.scoped(KEY_SIGNING_KEY),
        allowed_signers: snapshot.scoped(KEY_ALLOWED_SIGNERS),
        ssh_program_broken: broken_ssh_program_scope(&snapshot),
    }
}

/// Write signing config to the host's global git config. `None` for a field
/// unsets the key. Returns the refreshed view.
pub(crate) async fn write_signing_global(
    runner: &dyn GitExecutor,
    gpgsign: Option<&str>,
    format: Option<&str>,
    signing_key: Option<&str>,
    allowed_signers: Option<&str>,
) -> Result<SigningView, AppError> {
    // Self-heal an empty global `gpg.ssh.program` (it can only break signing,
    // never configure it); unset-all also clears pathological duplicates. A
    // non-empty program is a deliberate choice and is never touched.
    let before = config::read_global_snapshot(runner).await;
    if broken_ssh_program_scope(&before) == Some(ConfigScope::Global) {
        config::replace_all(runner, WriteScope::Global, KEY_SSH_PROGRAM, &[]).await?;
    }
    config::write(runner, WriteScope::Global, KEY_GPGSIGN, gpgsign).await?;
    config::write(runner, WriteScope::Global, KEY_FORMAT, format).await?;
    config::write(runner, WriteScope::Global, KEY_SIGNING_KEY, signing_key).await?;
    config::write(runner, WriteScope::Global, KEY_ALLOWED_SIGNERS, allowed_signers).await?;
    Ok(read_signing_view_global(runner).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use legit_core::test_support::{ok, FakeExecutor};

    // On a remote host every spawn crosses the agent pipe: the view must be
    // built from ONE listing per scope, never one process per key. git lists
    // keys lowercased, so `gpg.ssh.allowedSignersFile` must still be found.
    #[tokio::test]
    async fn global_view_is_built_from_one_listing_per_scope() {
        let exec = FakeExecutor::default();
        exec.expect(
            &["config", "--global", "--list", "-z"],
            ok("commit.gpgsign\ntrue\0gpg.format\nssh\0gpg.ssh.allowedsignersfile\n/home/u/.ssh/signers\0"),
        )
        .expect(&["config", "--system", "--list", "-z"], ok("user.signingkey\n/etc/key\0"));
        let view = read_signing_view_global(&exec).await;
        assert_eq!(view.gpgsign.resolved.value.as_deref(), Some("true"));
        assert_eq!(view.format.global.value.as_deref(), Some("ssh"));
        assert_eq!(view.allowed_signers.global.value.as_deref(), Some("/home/u/.ssh/signers"));
        assert_eq!(view.signing_key.resolved.value.as_deref(), Some("/etc/key"));
        assert_eq!(view.signing_key.global.value, None);
        assert_eq!(view.ssh_program_broken, None);
        exec.assert_done();
    }

    fn snapshot(
        global: &[(&str, Option<&str>)],
        system: &[(&str, Option<&str>)],
    ) -> config::GlobalConfigSnapshot {
        let entries = |list: &[(&str, Option<&str>)]| {
            config::ConfigEntries::from_list(
                list.iter().map(|(k, v)| (k.to_string(), v.map(str::to_string))).collect(),
            )
        };
        config::GlobalConfigSnapshot { global: entries(global), system: entries(system) }
    }

    // `gpg.ssh.program` set to "" (or valueless) overrides git's bundled
    // ssh-keygen fallback and makes every signed commit fail with
    // "cannot spawn : No such file or directory" - the one signing-breaking
    // state the panel's own keys cannot explain.
    #[test]
    fn broken_ssh_program_reports_the_effective_empty_entry() {
        let prog = "gpg.ssh.program";
        // Empty at global scope.
        assert_eq!(
            broken_ssh_program_scope(&snapshot(&[(prog, Some(""))], &[])),
            Some(ConfigScope::Global)
        );
        // Valueless entry (`[gpg "ssh"] program` without `=`) breaks the same way.
        assert_eq!(
            broken_ssh_program_scope(&snapshot(&[(prog, None)], &[])),
            Some(ConfigScope::Global)
        );
        // Empty only at system scope: effective, but not ours to heal.
        assert_eq!(
            broken_ssh_program_scope(&snapshot(&[], &[(prog, Some(""))])),
            Some(ConfigScope::System)
        );
        // A real global program shadows an empty system entry.
        assert_eq!(
            broken_ssh_program_scope(&snapshot(&[(prog, Some("/usr/bin/ssh-keygen"))], &[(prog, Some(""))])),
            None
        );
        // Within a scope the LAST entry wins (git's resolution).
        assert_eq!(
            broken_ssh_program_scope(&snapshot(&[(prog, Some("")), (prog, Some("/usr/bin/ssh-keygen"))], &[])),
            None
        );
        assert_eq!(
            broken_ssh_program_scope(&snapshot(&[(prog, Some("/usr/bin/ssh-keygen")), (prog, Some(""))], &[])),
            Some(ConfigScope::Global)
        );
        // Absent everywhere: git falls back to its bundled ssh-keygen - fine.
        assert_eq!(broken_ssh_program_scope(&snapshot(&[], &[])), None);
    }

    #[tokio::test]
    async fn write_heals_an_empty_global_ssh_program() {
        let exec = FakeExecutor::default();
        exec.expect(
            &["config", "--global", "--list", "-z"],
            ok("commit.gpgsign\ntrue\0gpg.ssh.program\n\0"),
        )
        .expect(&["config", "--system", "--list", "-z"], ok(""))
        .expect(&["config", "--global", "--unset-all", "gpg.ssh.program"], ok(""))
        .expect(&["config", "--global", "commit.gpgsign", "true"], ok(""))
        .expect(&["config", "--global", "gpg.format", "ssh"], ok(""))
        .expect(&["config", "--global", "user.signingkey", "~/.ssh/id.pub"], ok(""))
        .expect(&["config", "--global", "--unset", "gpg.ssh.allowedSignersFile"], ok(""))
        .expect(
            &["config", "--global", "--list", "-z"],
            ok("commit.gpgsign\ntrue\0gpg.format\nssh\0user.signingkey\n~/.ssh/id.pub\0"),
        )
        .expect(&["config", "--system", "--list", "-z"], ok(""));
        let view = write_signing_global(&exec, Some("true"), Some("ssh"), Some("~/.ssh/id.pub"), None)
            .await
            .unwrap();
        assert_eq!(view.ssh_program_broken, None);
        exec.assert_done();
    }

    // A non-empty program is a deliberate user choice (custom ssh-keygen,
    // hardware-key helper) and must never be touched; same for a system-scope
    // entry, which a --global write cannot reach anyway.
    #[tokio::test]
    async fn write_leaves_a_real_ssh_program_alone() {
        let exec = FakeExecutor::default();
        exec.expect(
            &["config", "--global", "--list", "-z"],
            ok("gpg.ssh.program\nC:/tools/ssh-keygen.exe\0"),
        )
        .expect(&["config", "--system", "--list", "-z"], ok(""))
        .expect(&["config", "--global", "commit.gpgsign", "true"], ok(""))
        .expect(&["config", "--global", "--unset", "gpg.format"], ok(""))
        .expect(&["config", "--global", "--unset", "user.signingkey"], ok(""))
        .expect(&["config", "--global", "--unset", "gpg.ssh.allowedSignersFile"], ok(""))
        .expect(
            &["config", "--global", "--list", "-z"],
            ok("gpg.ssh.program\nC:/tools/ssh-keygen.exe\0commit.gpgsign\ntrue\0"),
        )
        .expect(&["config", "--system", "--list", "-z"], ok(""));
        let view = write_signing_global(&exec, Some("true"), None, None, None).await.unwrap();
        assert_eq!(view.ssh_program_broken, None);
        exec.assert_done();
    }

    #[tokio::test]
    async fn view_flags_an_empty_ssh_program() {
        let exec = FakeExecutor::default();
        exec.expect(
            &["config", "--global", "--list", "-z"],
            ok("commit.gpgsign\ntrue\0gpg.format\nssh\0gpg.ssh.program\n\0"),
        )
        .expect(&["config", "--system", "--list", "-z"], ok(""));
        let view = read_signing_view_global(&exec).await;
        assert_eq!(view.ssh_program_broken, Some(ConfigScope::Global));
        exec.assert_done();
    }
}

/// Read the app machine's signing config at global scope (no repo required).
#[tauri::command]
#[specta::specta]
pub async fn global_signing_config(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SigningView, AppError> {
    let runner = settings_executor(&app, &state, &SettingsHost::Local).await?;
    Ok(read_signing_view_global(runner.as_ref()).await)
}

/// Write signing config to the app machine's `~/.gitconfig`.
#[tauri::command]
#[specta::specta]
pub async fn global_write_signing(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    gpgsign: Option<String>,
    format: Option<String>,
    signing_key: Option<String>,
    allowed_signers: Option<String>,
) -> Result<SigningView, AppError> {
    let runner = settings_executor(&app, &state, &SettingsHost::Local).await?;
    write_signing_global(
        runner.as_ref(),
        gpgsign.as_deref(),
        format.as_deref(),
        signing_key.as_deref(),
        allowed_signers.as_deref(),
    )
    .await
}

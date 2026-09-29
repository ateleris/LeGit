//! Reading and writing `git config` at an explicit scope. LeGit keeps no
//! config state of its own: every settings view mirrors what git stores.
//! System scope is read-only.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::GitError;
use crate::executor::GitExecutor;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfigScope {
    Local,
    Global,
    System,
    Unset,
}

/// A scope git config can be written at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteScope {
    Local,
    Global,
}

impl WriteScope {
    fn flag(self) -> &'static str {
        match self {
            WriteScope::Local => "--local",
            WriteScope::Global => "--global",
        }
    }
}

impl ConfigScope {
    fn flag(self) -> Option<&'static str> {
        match self {
            ConfigScope::Local => Some("--local"),
            ConfigScope::Global => Some("--global"),
            ConfigScope::System => Some("--system"),
            ConfigScope::Unset => None,
        }
    }
}

impl From<WriteScope> for ConfigScope {
    fn from(s: WriteScope) -> Self {
        match s {
            WriteScope::Local => ConfigScope::Local,
            WriteScope::Global => ConfigScope::Global,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct ConfigValue {
    /// `None` means the key is not set at this scope.
    pub value: Option<String>,
    pub source: ConfigScope,
}

impl ConfigValue {
    pub fn unset() -> Self {
        Self { value: None, source: ConfigScope::Unset }
    }
    pub fn from_git(value: Option<String>, scope: ConfigScope) -> Self {
        Self { value, source: scope }
    }
}

/// One config key across the scopes; `resolved` is the value git actually
/// uses (local > global > system).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ScopedConfig {
    pub local: ConfigValue,
    pub global: ConfigValue,
    pub system: ConfigValue,
    pub resolved: ConfigValue,
}

/// First set value in precedence order (each `ConfigValue` carries its own
/// source scope), or unset.
pub fn resolve_precedence(ordered: &[&ConfigValue]) -> ConfigValue {
    ordered
        .iter()
        .find(|v| v.value.is_some())
        .map(|v| (*v).clone())
        .unwrap_or_else(ConfigValue::unset)
}

/// `key` at one scope. An empty value has no value; unset (exit 1) and a
/// failed read are unset (the views degrade, never error).
pub async fn read_scope(exec: &dyn GitExecutor, scope: ConfigScope, key: &str) -> ConfigValue {
    let Some(flag) = scope.flag() else {
        return ConfigValue::unset();
    };
    // exit 1 = key not set at this scope: an answer, not a failure - declared
    // expected so the Git Log doesn't show a red row per unset key.
    match exec.run_expecting(&["config", flag, "--get", key], &[1]).await {
        Ok(out) if out.success => {
            let value = out.stdout.trim();
            ConfigValue::from_git((!value.is_empty()).then(|| value.to_string()), scope)
        }
        _ => ConfigValue::unset(),
    }
}

/// The value git itself would use for `key` (no scope flag: git resolves
/// across all scopes). Only meaningful inside a repo; global views must use
/// `read_global_snapshot` instead.
pub async fn read_effective(exec: &dyn GitExecutor, key: &str) -> Option<String> {
    match exec.run_expecting(&["config", "--get", key], &[1]).await {
        Ok(out) if out.success => Some(out.stdout.trim().to_string()).filter(|v| !v.is_empty()),
        _ => None,
    }
}

/// `key` at local, global and system scope.
pub async fn read_all_scopes(exec: &dyn GitExecutor, key: &str) -> ScopedConfig {
    let local = read_scope(exec, ConfigScope::Local, key).await;
    let global = read_scope(exec, ConfigScope::Global, key).await;
    let system = read_scope(exec, ConfigScope::System, key).await;
    let resolved = resolve_precedence(&[&local, &global, &system]);
    ScopedConfig { local, global, system, resolved }
}

/// A scope's full config listing with git's key-case normalization applied,
/// for keyed lookups without one process per key.
#[derive(Debug, Clone, Default)]
pub struct ConfigEntries(Vec<(String, Option<String>)>);

/// git prints keys with the section and variable name lowercased and the
/// subsection (the middle of a three-part key) verbatim; normalize lookup
/// keys the same way so "gpg.ssh.allowedSignersFile" finds
/// "gpg.ssh.allowedsignersfile".
fn normalize_config_key(key: &str) -> String {
    let Some((section, rest)) = key.split_once('.') else {
        return key.to_ascii_lowercase();
    };
    match rest.rsplit_once('.') {
        Some((subsection, var)) => {
            format!("{}.{subsection}.{}", section.to_ascii_lowercase(), var.to_ascii_lowercase())
        }
        None => format!("{}.{}", section.to_ascii_lowercase(), rest.to_ascii_lowercase()),
    }
}

impl ConfigEntries {
    pub fn from_list(entries: Vec<(String, Option<String>)>) -> Self {
        Self(entries.into_iter().map(|(k, v)| (normalize_config_key(&k), v)).collect())
    }

    fn matching<'a>(&'a self, key: &str) -> impl Iterator<Item = &'a Option<String>> {
        let key = normalize_config_key(key);
        self.0.iter().filter(move |(k, _)| *k == key).map(|(_, v)| v)
    }

    /// The value git resolves for a single-valued `key` at this scope: the
    /// last entry wins. Mirrors `read_scope`: trimmed, and an empty or
    /// valueless entry has no value.
    pub fn value(&self, key: &str) -> Option<String> {
        let value = self.matching(key).last()?.as_deref().unwrap_or("").trim();
        (!value.is_empty()).then(|| value.to_string())
    }

    /// Every value of a multi-valued `key`, in file order. Mirrors
    /// `read_multi`: trimmed, empty and valueless entries kept as `""` (the
    /// credential-helper reset markers).
    pub fn values(&self, key: &str) -> Vec<String> {
        self.matching(key).map(|v| v.as_deref().unwrap_or("").trim().to_string()).collect()
    }
}

/// The full listing at one scope (empty when the scope's file is missing or
/// unreadable - the views degrade, never error).
pub async fn read_scope_entries(exec: &dyn GitExecutor, scope: ConfigScope) -> ConfigEntries {
    let Some(flag) = scope.flag() else {
        return ConfigEntries::default();
    };
    // exit 128 = the scope's config file doesn't exist (fresh machine):
    // an answer, not a failure - declared expected so the Git Log doesn't
    // show a red row on every settings open.
    match exec.run_expecting(&["config", flag, "--list", "-z"], &[128]).await {
        Ok(out) if out.success => {
            ConfigEntries::from_list(crate::cli_impl::parsers::config_list::parse_config_list_z(
                &out.stdout,
            ))
        }
        _ => ConfigEntries::default(),
    }
}

/// Global + system listings in two invocations, replacing one process per
/// key per scope - on a remote host every spawn crosses the agent pipe.
///
/// Local scope is deliberately absent, and that is required (not just
/// convenient) for every global view: those run on an UNBOUND runner, and an
/// unbound runner still inherits the app process's working directory. If that
/// directory lies inside some repo (`tauri dev` runs inside the LeGit source
/// repo), a `--local` read would succeed against that unrelated repo and leak
/// its config into the "global" view.
pub struct GlobalConfigSnapshot {
    pub global: ConfigEntries,
    pub system: ConfigEntries,
}

pub async fn read_global_snapshot(exec: &dyn GitExecutor) -> GlobalConfigSnapshot {
    GlobalConfigSnapshot {
        global: read_scope_entries(exec, ConfigScope::Global).await,
        system: read_scope_entries(exec, ConfigScope::System).await,
    }
}

impl GlobalConfigSnapshot {
    /// `key` across the snapshot's scopes, shaped like `read_global_scopes`
    /// (a key absent at a scope is unset there, like a `read_scope` miss).
    pub fn scoped(&self, key: &str) -> ScopedConfig {
        let at = |entries: &ConfigEntries, scope| match entries.value(key) {
            Some(v) => ConfigValue::from_git(Some(v), scope),
            None => ConfigValue::unset(),
        };
        let global = at(&self.global, ConfigScope::Global);
        let system = at(&self.system, ConfigScope::System);
        let resolved = resolve_precedence(&[&global, &system]);
        ScopedConfig { local: ConfigValue::unset(), global, system, resolved }
    }

    /// Multi-valued `key` at one scope, shaped like `read_multi` (empty for
    /// scopes the snapshot does not hold).
    pub fn multi(&self, scope: ConfigScope, key: &str) -> Vec<String> {
        match scope {
            ConfigScope::Global => self.global.values(key),
            ConfigScope::System => self.system.values(key),
            ConfigScope::Local | ConfigScope::Unset => Vec::new(),
        }
    }
}

/// Every value of a multi-valued `key` at one scope, in file order (empty
/// when unset or unreadable).
pub async fn read_multi(exec: &dyn GitExecutor, scope: ConfigScope, key: &str) -> Vec<String> {
    let Some(flag) = scope.flag() else {
        return Vec::new();
    };
    match exec.run_expecting(&["config", flag, "--get-all", key], &[1]).await {
        Ok(out) if out.success => out.stdout.lines().map(|l| l.trim().to_string()).collect(),
        _ => Vec::new(),
    }
}

/// Set `key` at `scope`, or unset it for `None` (already absent is fine).
pub async fn write(
    exec: &dyn GitExecutor,
    scope: WriteScope,
    key: &str,
    value: Option<&str>,
) -> Result<(), GitError> {
    let out = match value {
        Some(v) => exec.run(&["config", scope.flag(), key, v]).await?,
        // exit 5 = the key was already absent.
        None => exec.run_expecting(&["config", scope.flag(), "--unset", key], &[5]).await?,
    };
    if !out.success && !(value.is_none() && out.exit_code == Some(5)) {
        return Err(failed(&out));
    }
    Ok(())
}

/// Replace ALL values of a multi-valued `key` at `scope` with `values`, in
/// order (empty = remove the key). Reset-then-add, because a plain set fails
/// once several entries exist.
pub async fn replace_all(
    exec: &dyn GitExecutor,
    scope: WriteScope,
    key: &str,
    values: &[&str],
) -> Result<(), GitError> {
    // exit 5 = nothing was set (or the config file does not exist yet).
    let unset = exec.run_expecting(&["config", scope.flag(), "--unset-all", key], &[5]).await?;
    if !unset.success && unset.exit_code != Some(5) {
        return Err(failed(&unset));
    }
    for v in values {
        let out = exec.run(&["config", scope.flag(), "--add", key, v]).await?;
        if !out.success {
            return Err(failed(&out));
        }
    }
    Ok(())
}

fn failed(out: &crate::runner::RunOutput) -> GitError {
    GitError::CommandFailed {
        exit_code: out.exit_code.unwrap_or(-1),
        stderr: crate::runner::redact_url_credentials(out.stderr.trim()).into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{fail, ok, FakeExecutor};

    #[tokio::test]
    async fn all_scopes_resolve_local_first() {
        let exec = FakeExecutor::default();
        exec.expect(&["config", "--local", "--get", "core.eol"], ok("lf\n"))
            .expect(&["config", "--global", "--get", "core.eol"], ok("crlf\n"))
            .expect(&["config", "--system", "--get", "core.eol"], fail(1, ""));
        let c = read_all_scopes(&exec, "core.eol").await;
        assert_eq!(c.resolved, ConfigValue::from_git(Some("lf".into()), ConfigScope::Local));
        assert_eq!(c.system, ConfigValue::unset());
        exec.assert_done();
    }

    #[tokio::test]
    async fn effective_read_lets_git_resolve_the_scope() {
        let exec = FakeExecutor::default();
        exec.expect(&["config", "--get", "user.name"], ok("Ada\n"))
            .expect(&["config", "--get", "user.email"], fail(1, ""));
        assert_eq!(read_effective(&exec, "user.name").await.as_deref(), Some("Ada"));
        assert_eq!(read_effective(&exec, "user.email").await, None);
        exec.assert_done();
    }

    #[tokio::test]
    async fn an_empty_value_reads_as_no_value() {
        let exec = FakeExecutor::default();
        exec.expect(&["config", "--local", "--get", "k"], ok("\n"));
        assert_eq!(read_scope(&exec, ConfigScope::Local, "k").await.value, None);
        exec.assert_done();
    }

    // Writes must ALWAYS carry their scope flag. An unscoped `git config <k>
    // <v>` writes to whatever repo the process's cwd sits in - for the agent,
    // possibly a stranger's `.git/config` under /mnt/c.
    #[tokio::test]
    async fn writes_are_always_scoped_and_unsetting_an_absent_key_is_fine() {
        let exec = FakeExecutor::default();
        exec.expect(&["config", "--global", "user.email", "a@b.c"], ok(""))
            .expect(&["config", "--global", "--unset", "user.email"], fail(5, ""))
            .expect(&["config", "--local", "--unset", "user.email"], ok(""));
        write(&exec, WriteScope::Global, "user.email", Some("a@b.c")).await.unwrap();
        write(&exec, WriteScope::Global, "user.email", None).await.unwrap();
        write(&exec, WriteScope::Local, "user.email", None).await.unwrap();
        exec.assert_done();
    }

    #[tokio::test]
    async fn a_failed_write_is_an_error() {
        let exec = FakeExecutor::default();
        exec.expect(&["config", "--local", "k", "v"], fail(3, "error: invalid config file\n"));
        let err = write(&exec, WriteScope::Local, "k", Some("v")).await.unwrap_err();
        assert!(matches!(&err, GitError::CommandFailed { exit_code: 3, stderr } if stderr == "error: invalid config file"), "{err:?}");
        exec.assert_done();
    }

    #[tokio::test]
    async fn replace_all_resets_then_adds_in_order() {
        let exec = FakeExecutor::default();
        exec.expect(&["config", "--local", "--unset-all", "credential.helper"], fail(5, ""))
            .expect(&["config", "--local", "--add", "credential.helper", ""], ok(""))
            .expect(&["config", "--local", "--add", "credential.helper", "store"], ok(""));
        replace_all(&exec, WriteScope::Local, "credential.helper", &["", "store"]).await.unwrap();
        exec.assert_done();
    }

    #[tokio::test]
    async fn replace_all_with_no_values_only_removes() {
        let exec = FakeExecutor::default();
        exec.expect(&["config", "--global", "--unset-all", "credential.helper"], ok(""));
        replace_all(&exec, WriteScope::Global, "credential.helper", &[]).await.unwrap();
        exec.assert_done();
    }

    #[tokio::test]
    async fn replace_all_stops_at_the_first_failure() {
        let exec = FakeExecutor::default();
        exec.expect(&["config", "--local", "--unset-all", "k"], fail(4, "error: could not lock config file\n"));
        assert!(replace_all(&exec, WriteScope::Local, "k", &["x"]).await.is_err());
        exec.assert_done();
    }

    #[tokio::test]
    async fn read_multi_keeps_file_order_and_unset_is_empty() {
        let exec = FakeExecutor::default();
        exec.expect(&["config", "--local", "--get-all", "credential.helper"], ok("\nstore\n"))
            .expect(&["config", "--global", "--get-all", "credential.helper"], fail(1, ""));
        assert_eq!(read_multi(&exec, ConfigScope::Local, "credential.helper").await, vec!["", "store"]);
        assert!(read_multi(&exec, ConfigScope::Global, "credential.helper").await.is_empty());
        exec.assert_done();
    }

    // The snapshot must read ONLY `--global` and `--system` (assert_done
    // pins that nothing else ran): with a REMOTE host the agent's unbound
    // runner inherits the distro-side translation of the app's working
    // directory, which can lie inside a repo under /mnt/c - a `--local` read
    // would report that unrelated repo's config.
    #[tokio::test]
    async fn snapshot_issues_one_list_per_scope_and_resolves_global_first() {
        let exec = FakeExecutor::default();
        exec.expect(
            &["config", "--global", "--list", "-z"],
            ok("user.name\nAda\0core.autocrlf\ninput\0"),
        )
        .expect(&["config", "--system", "--list", "-z"], ok("user.name\nSys\0core.eol\nlf\0"));
        let snap = read_global_snapshot(&exec).await;
        let name = snap.scoped("user.name");
        assert_eq!(name.global, ConfigValue::from_git(Some("Ada".into()), ConfigScope::Global));
        assert_eq!(name.system, ConfigValue::from_git(Some("Sys".into()), ConfigScope::System));
        assert_eq!(name.resolved, name.global);
        assert_eq!(name.local, ConfigValue::unset());
        let eol = snap.scoped("core.eol");
        assert_eq!(eol.resolved, ConfigValue::from_git(Some("lf".into()), ConfigScope::System));
        // A key absent at a scope is UNSET there (never "at global scope
        // with no value"), exactly like a per-key `read_scope` miss.
        assert_eq!(snap.scoped("user.email").global, ConfigValue::unset());
        assert_eq!(snap.scoped("user.email").resolved, ConfigValue::unset());
        assert_eq!(snap.scoped("core.autocrlf").system, ConfigValue::unset());
        exec.assert_done();
    }

    // A fresh machine has no ~/.gitconfig (and often no system file): git
    // exits 128 for `--list` on a missing file - an answer, not a failure.
    #[tokio::test]
    async fn snapshot_treats_a_missing_config_file_as_empty() {
        let exec = FakeExecutor::default();
        exec.expect(
            &["config", "--global", "--list", "-z"],
            fail(128, "fatal: unable to read config file '/home/u/.gitconfig': No such file or directory\n"),
        )
        .expect(&["config", "--system", "--list", "-z"], fail(128, "fatal: unable to read config file '/etc/gitconfig': No such file or directory\n"));
        let snap = read_global_snapshot(&exec).await;
        assert_eq!(snap.scoped("user.name").resolved, ConfigValue::unset());
        assert!(snap.multi(ConfigScope::Global, "credential.helper").is_empty());
        exec.assert_done();
    }

    #[test]
    fn entries_value_takes_the_last_entry_and_empty_or_valueless_is_unset() {
        let e = ConfigEntries::from_list(vec![
            ("user.name".into(), Some("First".into())),
            ("user.name".into(), Some(" Last ".into())),
            ("core.autocrlf".into(), Some("".into())),
            ("commit.gpgsign".into(), None),
        ]);
        assert_eq!(e.value("user.name").as_deref(), Some("Last"));
        assert_eq!(e.value("core.autocrlf"), None);
        assert_eq!(e.value("commit.gpgsign"), None);
        assert_eq!(e.value("user.email"), None);
    }

    #[test]
    fn entries_values_keep_order_and_reset_markers() {
        let e = ConfigEntries::from_list(vec![
            ("credential.helper".into(), Some("".into())),
            ("user.name".into(), Some("Ada".into())),
            ("credential.helper".into(), Some("store".into())),
        ]);
        assert_eq!(e.values("credential.helper"), vec!["", "store"]);
        assert!(e.values("credential.usehttppath").is_empty());
    }

    // git prints section and variable names lowercased ("gpg.ssh.
    // allowedsignersfile") while our key constants keep the documented casing
    // ("gpg.ssh.allowedSignersFile"); subsections stay case-sensitive.
    #[test]
    fn entries_lookups_normalize_key_case_like_git() {
        let e = ConfigEntries::from_list(vec![
            ("gpg.ssh.allowedsignersfile".into(), Some("/tmp/signers".into())),
            ("section.MidDle.varname".into(), Some("v".into())),
        ]);
        assert_eq!(e.value("gpg.ssh.allowedSignersFile").as_deref(), Some("/tmp/signers"));
        assert_eq!(e.value("SeCtIoN.MidDle.VarName").as_deref(), Some("v"));
        assert_eq!(e.value("section.middle.varname"), None);
    }

    #[test]
    fn snapshot_multi_only_answers_the_scopes_it_holds() {
        let snap = GlobalConfigSnapshot {
            global: ConfigEntries::from_list(vec![("credential.helper".into(), Some("store".into()))]),
            system: ConfigEntries::default(),
        };
        assert_eq!(snap.multi(ConfigScope::Global, "credential.helper"), vec!["store"]);
        assert!(snap.multi(ConfigScope::Local, "credential.helper").is_empty());
        assert!(snap.multi(ConfigScope::Unset, "credential.helper").is_empty());
    }

    #[test]
    fn precedence_picks_the_first_set_scope() {
        let unset = ConfigValue::unset();
        let global = ConfigValue::from_git(Some("g".into()), ConfigScope::Global);
        let system = ConfigValue::from_git(Some("s".into()), ConfigScope::System);
        assert_eq!(resolve_precedence(&[&global, &system]), global);
        assert_eq!(resolve_precedence(&[&unset, &system]), system);
        assert_eq!(resolve_precedence(&[&unset, &unset]), ConfigValue::unset());
    }
}

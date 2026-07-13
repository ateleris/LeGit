//! Shared `git config` read/write helpers.
//!
//! LeGit config panels (line endings, signing, …) are direct mirrors of the
//! corresponding `git config` keys at the requested scope. There is no
//! LeGit-side persistent state — the only source of truth is what
//! `git config` stores. All reads/writes go through `GitRunner`.
//! System scope is read-only.

use crate::error::AppError;
use legit_core::{GitError, GitRunner};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ConfigScope {
    Local,
    Global,
    System,
    Unset,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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

/// The value of a single config key resolved across all scopes. `resolved` is
/// the value git actually uses (repo > global > system).
pub struct ConfigAtAllScopes {
    pub local: ConfigValue,
    pub global: ConfigValue,
    pub system: ConfigValue,
    pub resolved: ConfigValue,
}

/// Frontend-facing view of a single config key across all scopes.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ScopedConfig {
    pub local: ConfigValue,
    pub global: ConfigValue,
    pub system: ConfigValue,
    pub resolved: ConfigValue,
}

impl From<ConfigAtAllScopes> for ScopedConfig {
    fn from(c: ConfigAtAllScopes) -> Self {
        Self { local: c.local, global: c.global, system: c.system, resolved: c.resolved }
    }
}

/// First set value in precedence order (each `ConfigValue` carries its own
/// source scope), or unset. Pure: the scope-precedence rules of the config
/// views are unit-tested here.
fn resolve_precedence(ordered: &[&ConfigValue]) -> ConfigValue {
    ordered
        .iter()
        .find(|v| v.value.is_some())
        .map(|v| (*v).clone())
        .unwrap_or_else(ConfigValue::unset)
}

pub async fn read_config_all_scopes(runner: &GitRunner, key: &str) -> ConfigAtAllScopes {
    let local = read_config_scope(runner, key, &["--local"]).await;
    let global = read_config_scope(runner, key, &["--global"]).await;
    let system = read_config_scope(runner, key, &["--system"]).await;

    // Resolved = repo > global > system (what git actually uses).
    let resolved = resolve_precedence(&[&local, &global, &system]);
    ConfigAtAllScopes { local, global, system, resolved }
}

/// Global-settings variant: reads ONLY global + system scope; `local` is
/// always unset and `resolved` is global > system.
///
/// Required (not just convenient) for every global view: those run on an
/// UNBOUND runner, and an unbound runner still inherits the app process's
/// working directory. If that directory happens to lie inside some repo
/// (`tauri dev` runs inside the LeGit source repo), a `--local` read would
/// succeed against that unrelated repo and leak its config into the
/// "global" view ("resolved: … (from local)" in Global Settings).
pub async fn read_config_global_scopes(runner: &GitRunner, key: &str) -> ConfigAtAllScopes {
    let global = read_config_scope(runner, key, &["--global"]).await;
    let system = read_config_scope(runner, key, &["--system"]).await;

    let resolved = resolve_precedence(&[&global, &system]);
    ConfigAtAllScopes { local: ConfigValue::unset(), global, system, resolved }
}

pub async fn read_config_scope(runner: &GitRunner, key: &str, flags: &[&str]) -> ConfigValue {
    let mut args = vec!["config"];
    args.extend_from_slice(flags);
    args.extend_from_slice(&["--get", key]);

    match runner.run(&args).await {
        Ok(out) if out.success => {
            let value = out.stdout.trim().to_string();
            let scope = match flags {
                f if f.contains(&"--local") => ConfigScope::Local,
                f if f.contains(&"--global") => ConfigScope::Global,
                f if f.contains(&"--system") => ConfigScope::System,
                _ => ConfigScope::Unset,
            };
            ConfigValue::from_git(if value.is_empty() { None } else { Some(value) }, scope)
        }
        // exit 1 = key not found at this scope; not an error.
        _ => ConfigValue::unset(),
    }
}

pub async fn write_config_local(
    runner: &GitRunner,
    key: &str,
    value: Option<&str>,
) -> Result<(), AppError> {
    let out = match value {
        Some(v) => runner.run(&["config", "--local", key, v]).await?,
        None => runner.run(&["config", "--local", "--unset", key]).await?,
    };
    // exit 5 from --unset means key was already absent — not an error for us.
    if !out.success && out.exit_code != Some(5) {
        return Err(AppError::Git(GitError::CommandFailed {
            exit_code: out.exit_code.unwrap_or(-1),
            stderr: out.stderr.trim().to_string(),
        }));
    }
    Ok(())
}

pub async fn write_config_global(
    runner: &GitRunner,
    key: &str,
    value: Option<&str>,
) -> Result<(), AppError> {
    let out = match value {
        Some(v) => runner.run(&["config", "--global", key, v]).await?,
        None => runner.run(&["config", "--global", "--unset", key]).await?,
    };
    if !out.success && out.exit_code != Some(5) {
        return Err(AppError::Git(GitError::CommandFailed {
            exit_code: out.exit_code.unwrap_or(-1),
            stderr: out.stderr.trim().to_string(),
        }));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn set(v: &str, scope: ConfigScope) -> ConfigValue {
        ConfigValue::from_git(Some(v.to_string()), scope)
    }

    // The global-settings views resolve global > system and must NEVER
    // consult local scope: an unbound runner inherits the app process's cwd,
    // and if that happens to be inside a repo (tauri dev runs inside the
    // LeGit source repo), a local read would leak that repo's config into
    // the "global" view. This surfaced as "resolved: ... (from local)" in
    // the Identity (global) section.
    #[test]
    fn resolve_precedence_picks_first_set_scope() {
        let unset = ConfigValue::unset();
        let global = set("g", ConfigScope::Global);
        let system = set("s", ConfigScope::System);

        let r = resolve_precedence(&[&global, &system]);
        assert_eq!(r.value.as_deref(), Some("g"));
        assert_eq!(r.source, ConfigScope::Global);

        let r = resolve_precedence(&[&unset, &system]);
        assert_eq!(r.value.as_deref(), Some("s"));
        assert_eq!(r.source, ConfigScope::System);

        let r = resolve_precedence(&[&unset, &unset]);
        assert_eq!(r.value, None);
        assert_eq!(r.source, ConfigScope::Unset);
    }
}

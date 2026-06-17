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

pub async fn read_config_all_scopes(runner: &GitRunner, key: &str) -> ConfigAtAllScopes {
    let local = read_config_scope(runner, key, &["--local"]).await;
    let global = read_config_scope(runner, key, &["--global"]).await;
    let system = read_config_scope(runner, key, &["--system"]).await;

    // Resolved = repo > global > system (what git actually uses).
    let resolved = if local.value.is_some() {
        ConfigValue::from_git(local.value.clone(), ConfigScope::Local)
    } else if global.value.is_some() {
        ConfigValue::from_git(global.value.clone(), ConfigScope::Global)
    } else if system.value.is_some() {
        ConfigValue::from_git(system.value.clone(), ConfigScope::System)
    } else {
        ConfigValue::unset()
    };

    ConfigAtAllScopes { local, global, system, resolved }
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

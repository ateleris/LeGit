//! Git Console command (DESIGN.md §7.4).
//!
//! Runs user-typed args against the active repo through the *same*
//! `GitRunner` every other panel will use. The args are tokenized with
//! `shlex`, validated against a small blocklist (`-C`, `--git-dir`,
//! `--work-tree`), and streamed through Tauri events keyed by `op_id`.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::{OperationId, RunnerEvent};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Emitter;
use tokio::sync::mpsc;

pub const CONSOLE_OUTPUT_EVENT: &str = "legit://console-output";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ConsoleEventPayload {
    pub op_id: String,
    pub event: RunnerEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ConsoleExecHandle {
    pub op_id: String,
    pub argv: Vec<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn console_exec(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    repo_id: String,
    command: String,
) -> Result<ConsoleExecHandle, AppError> {
    let session = state.get_session(&repo_id).await?;

    let argv = shlex::split(&command)
        .ok_or_else(|| AppError::ParseArgs("unterminated quote or escape".to_string()))?;
    if argv.is_empty() {
        return Err(AppError::ParseArgs("empty command".to_string()));
    }
    validate_console_args(&argv)?;

    let op_id = OperationId::new();
    let op_id_str = op_id.0.clone();

    let runner = session.runner.clone();
    let app_handle = app.clone();
    let op_id_for_emit = op_id_str.clone();
    let argv_owned = argv.clone();

    // Run the streaming op in a background task. The command returns the
    // OperationId immediately; the frontend already subscribed to the
    // CONSOLE_OUTPUT_EVENT channel and filters by op_id.
    tokio::spawn(async move {
        let (tx, mut rx) = mpsc::unbounded_channel::<RunnerEvent>();

        let runner_for_stream = runner;
        let argv_for_stream = argv_owned;
        let op_id_for_stream = op_id;
        let stream_handle = tokio::spawn(async move {
            let refs: Vec<&str> = argv_for_stream.iter().map(|s| s.as_str()).collect();
            let _ = runner_for_stream
                .stream(&refs, op_id_for_stream, tx)
                .await;
        });

        while let Some(event) = rx.recv().await {
            let payload = ConsoleEventPayload {
                op_id: op_id_for_emit.clone(),
                event,
            };
            if app_handle.emit(CONSOLE_OUTPUT_EVENT, payload).is_err() {
                break;
            }
        }
        let _ = stream_handle.await;
    });

    Ok(ConsoleExecHandle {
        op_id: op_id_str,
        argv,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn console_cancel(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    op_id: String,
) -> Result<bool, AppError> {
    let session = state.get_session(&repo_id).await?;
    Ok(session.runner.cancel(&OperationId(op_id)))
}

/// Reject arguments that would let the Console escape the active
/// repository's working tree (DESIGN.md §7.4).
fn validate_console_args(argv: &[String]) -> Result<(), AppError> {
    for (idx, arg) in argv.iter().enumerate() {
        // The leading "git" is implied — and a hint the user is confused.
        if idx == 0 && arg.eq_ignore_ascii_case("git") {
            return Err(AppError::ForbiddenArg(
                "drop the leading `git` — the console always runs `git`".into(),
            ));
        }
        if arg == "-C"
            || arg == "--git-dir"
            || arg == "--work-tree"
            || arg == "--namespace"
            || arg.starts_with("--git-dir=")
            || arg.starts_with("--work-tree=")
            || arg.starts_with("--namespace=")
        {
            return Err(AppError::ForbiddenArg(arg.clone()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_C_arg() {
        let argv = vec!["-C".to_string(), "/etc".to_string(), "status".to_string()];
        assert!(matches!(
            validate_console_args(&argv),
            Err(AppError::ForbiddenArg(_))
        ));
    }

    #[test]
    fn rejects_git_dir_long() {
        let argv = vec!["--git-dir=/etc".to_string(), "status".to_string()];
        assert!(matches!(
            validate_console_args(&argv),
            Err(AppError::ForbiddenArg(_))
        ));
    }

    #[test]
    fn rejects_leading_git() {
        let argv = vec!["git".to_string(), "status".to_string()];
        assert!(matches!(
            validate_console_args(&argv),
            Err(AppError::ForbiddenArg(_))
        ));
    }

    #[test]
    fn accepts_normal_command() {
        let argv = vec!["status".to_string(), "--short".to_string()];
        assert!(validate_console_args(&argv).is_ok());
    }
}

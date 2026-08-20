//! Commands completing in-app git credential prompts (see `crate::credentials`).

use crate::error::AppError;

/// Complete a pending credential prompt with the entered credentials.
/// `remember` persists them to the OS keychain once git confirms they work.
/// Returns false when the prompt no longer exists (git already went away).
#[tauri::command]
#[specta::specta]
pub async fn credential_respond(
    request_id: String,
    username: String,
    password: String,
    remember: bool,
) -> Result<bool, AppError> {
    Ok(crate::credentials::respond(&request_id, username, password, remember))
}

/// Dismiss a pending credential prompt; git fails with its normal
/// authentication error.
#[tauri::command]
#[specta::specta]
pub async fn credential_cancel(request_id: String) -> Result<bool, AppError> {
    Ok(crate::credentials::cancel(&request_id))
}

/// Complete a pending ssh askpass prompt (passphrase text, or the literal
/// "yes"/"no" for a confirmation). Never persisted anywhere. Returns false
/// when the prompt no longer exists (ssh already went away).
#[tauri::command]
#[specta::specta]
pub async fn askpass_respond(request_id: String, answer: String) -> Result<bool, AppError> {
    // Askpass prompts ride the same pending-prompt registry as credential
    // prompts; only the password field carries meaning here.
    Ok(crate::credentials::respond(&request_id, String::new(), answer, false))
}

/// Dismiss a pending askpass prompt; ssh aborts its own prompt (non-zero
/// shim exit) and the operation fails like any non-interactive auth failure.
#[tauri::command]
#[specta::specta]
pub async fn askpass_cancel(request_id: String) -> Result<bool, AppError> {
    Ok(crate::credentials::cancel(&request_id))
}

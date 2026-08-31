//! WSL remote-repository commands (the "Open in WSL…" flow's backend).

use crate::error::AppError;
use crate::remote::wsl::WslDistro;

/// Enumerate installed WSL distributions for the open-repo picker. Empty on
/// non-Windows builds — the frontend hides the WSL entry then.
#[tauri::command]
#[specta::specta]
pub async fn wsl_list_distros() -> Result<Vec<WslDistro>, AppError> {
    if !cfg!(windows) {
        return Ok(Vec::new());
    }
    crate::remote::wsl::list_distros().await
}

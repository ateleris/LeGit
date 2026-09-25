//! File-history popup windows: labels, titles, creation, per-window context.

use crate::error::AppError;
use crate::state::AppState;
use serde::Serialize;
use specta::Type;

/// What a history window shows, handed to its frontend on boot (keyed by
/// window label; the label itself carries no decodable payload).
#[derive(Debug, Clone, Serialize, Type)]
pub struct HistoryWindowContext {
    pub repo_id: String,
    pub path: String,
    pub rev: Option<String>,
    pub repo_name: String,
    /// Repo root as the host prints it (RepoSummary::path) - the popup's
    /// copy-absolute-path entries resolve against it.
    pub repo_path: String,
}

#[derive(Default)]
pub struct HistoryWindows(
    pub std::sync::Mutex<std::collections::HashMap<String, HistoryWindowContext>>,
);

pub const FILE_HISTORY_DEFAULT_SIZE: (f64, f64) = (1000.0, 650.0);

#[tauri::command]
#[specta::specta]
pub async fn open_file_history_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    windows: tauri::State<'_, HistoryWindows>,
    repo_id: String,
    path: String,
    rev: Option<String>,
) -> Result<(), AppError> {
    use tauri::Manager;
    let session = state.get_session(&repo_id).await?;
    let summary = session.summary();
    let repo_name = summary.name;
    let repo_path = summary.path;

    let label = file_history_window_label(&repo_id, &path, rev.as_deref());
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    windows.0.lock().unwrap().insert(
        label.clone(),
        HistoryWindowContext {
            repo_id: repo_id.clone(),
            path: path.clone(),
            rev: rev.clone(),
            repo_name: repo_name.clone(),
            repo_path,
        },
    );

    let size = state.global_settings.read().await.file_history_window_size.clone();
    let (w, h) = size.map(|s| (s.width, s.height)).unwrap_or(FILE_HISTORY_DEFAULT_SIZE);

    let win = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(history_window_title(&path, rev.as_deref(), &repo_name))
    .inner_size(w, h)
    .min_inner_size(500.0, 300.0)
    .visible(false)
    .build()
    .map_err(|e| AppError::Io(format!("failed to open the history window: {e}")))?;

    // Dev builds mark every window, not just main (lib.rs sets main's).
    #[cfg(debug_assertions)]
    match tauri::image::Image::from_bytes(include_bytes!("../../icons/icon-dev.png")) {
        Ok(icon) => {
            if let Err(e) = win.set_icon(icon) {
                tracing::warn!(err = %e, "failed to set dev icon on history window");
            }
        }
        Err(e) => tracing::warn!(err = %e, "failed to decode the dev icon"),
    }

    // Main-window pattern: hidden until the frontend applied the theme, with
    // a failsafe show so a broken frontend never leaves an invisible window.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        if !win.is_visible().unwrap_or(true) {
            let _ = win.show();
        }
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn history_window_context(
    window: tauri::WebviewWindow,
    windows: tauri::State<'_, HistoryWindows>,
) -> Result<HistoryWindowContext, AppError> {
    windows
        .0
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
        .ok_or_else(|| AppError::Io(format!("no history-window context for '{}'", window.label())))
}

/// Label prefix for every file-history window; the lifecycle cascades in
/// `lib.rs` and `close_repo` match on it.
pub const FILE_HISTORY_LABEL_PREFIX: &str = "fh-";

// FNV-1a 64-bit: deterministic within a run so re-summoning the same
// (path, rev) focuses the existing window instead of spawning a duplicate.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

pub fn file_history_window_label(repo_id: &str, path: &str, rev: Option<&str>) -> String {
    let mut key = path.as_bytes().to_vec();
    key.push(0);
    key.extend_from_slice(rev.unwrap_or("").as_bytes());
    format!("{FILE_HISTORY_LABEL_PREFIX}{repo_id}-{:016x}", fnv1a(&key))
}

pub fn history_window_title(path: &str, rev: Option<&str>, repo_name: &str) -> String {
    let file = path.rsplit('/').next().unwrap_or(path);
    match rev {
        Some(r) => {
            let short: String = r.chars().take(8).collect();
            format!("{file} - History from {short} ({repo_name})")
        }
        None => format!("{file} - History ({repo_name})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_stable_and_distinguishes_path_and_rev() {
        let a = file_history_window_label("abc123", "src/foo.ts", None);
        assert_eq!(a, file_history_window_label("abc123", "src/foo.ts", None));
        assert!(a.starts_with("fh-abc123-"));
        assert_ne!(a, file_history_window_label("abc123", "src/bar.ts", None));
        assert_ne!(a, file_history_window_label("abc123", "src/foo.ts", Some("deadbeef")));
        assert_ne!(a, file_history_window_label("other", "src/foo.ts", None));
    }

    // Concatenation must not collide: ("a", rev "b") vs ("ab", no rev).
    #[test]
    fn label_hash_separates_path_from_rev() {
        assert_ne!(
            file_history_window_label("r", "a", Some("b")),
            file_history_window_label("r", "ab", None)
        );
    }

    #[test]
    fn title_shows_file_rev_and_repo() {
        assert_eq!(history_window_title("src/foo.ts", None, "LeGit"), "foo.ts - History (LeGit)");
        assert_eq!(
            history_window_title("foo.ts", Some("deadbeefcafe"), "LeGit"),
            "foo.ts - History from deadbeef (LeGit)"
        );
    }
}

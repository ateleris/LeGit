//! The one OS-open spawner: reveal a file in the file manager, open a folder,
//! or open a URL in the default browser. Fire-and-forget: only a failed spawn
//! is an error (explorer.exe exits non-zero even on success).

use crate::error::AppError;
use std::path::Path;
use std::process::Command;

pub(crate) enum OpenTarget<'a> {
    /// Select the file in the OS file manager. (Linux: opens the containing
    /// directory - xdg-open has no select mode.)
    RevealFile(&'a Path),
    /// Open the directory itself in the OS file manager.
    Folder(&'a Path),
    /// Open the URL in the default browser.
    Url(&'a str),
}

/// `what` names the action for the spawn-failure message ("open browser", ...).
pub(crate) fn os_open(target: OpenTarget, what: &str) -> Result<(), AppError> {
    let mut cmd = command_for(&target);
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| AppError::Io(format!("{what}: {e}")))
}

#[cfg(target_os = "windows")]
fn command_for(target: &OpenTarget) -> Command {
    use crate::commands::files::explorer_path;
    let mut cmd = Command::new("explorer");
    match target {
        // `explorer /select,<path>` selects the file; it exits non-zero even
        // on success. The path must be in plain backslash form (see
        // `explorer_path`) or explorer opens Documents.
        OpenTarget::RevealFile(p) => {
            cmd.arg(format!("/select,{}", explorer_path(p)));
        }
        OpenTarget::Folder(p) => {
            cmd.arg(explorer_path(p));
        }
        // `explorer <url>` hands the URL to the default browser without a
        // console window or cmd quoting quirks.
        OpenTarget::Url(u) => {
            cmd.arg(u);
        }
    }
    cmd
}

#[cfg(target_os = "macos")]
fn command_for(target: &OpenTarget) -> Command {
    let mut cmd = Command::new("open");
    match target {
        OpenTarget::RevealFile(p) => {
            cmd.args(["-R".as_ref(), p.as_os_str()]);
        }
        OpenTarget::Folder(p) => {
            cmd.arg(p);
        }
        OpenTarget::Url(u) => {
            cmd.arg(u);
        }
    }
    cmd
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn command_for(target: &OpenTarget) -> Command {
    let mut cmd = Command::new("xdg-open");
    match target {
        // xdg-open has no "select" mode; open the containing directory.
        OpenTarget::RevealFile(p) => {
            cmd.arg(p.parent().unwrap_or(p));
        }
        OpenTarget::Folder(p) => {
            cmd.arg(p);
        }
        OpenTarget::Url(u) => {
            cmd.arg(u);
        }
    }
    cmd
}

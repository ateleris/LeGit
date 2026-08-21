//! Persistent logging + crash capture.
//!
//! The tracing subscriber writes to stderr (visible in dev terminals) AND to
//! a daily-rotated file in the platform log directory, so a crash of the
//! packaged app (where stderr is discarded) still leaves a trace. A panic
//! hook records the panic message + backtrace through the same pipeline
//! before the process dies. The frontend forwards its uncaught errors here
//! via the `frontend_log` command (window.onerror, unhandledrejection, and
//! the React ErrorBoundary), so webview-side breakage lands in the same
//! file. `open_log_dir` backs the "Open log folder" button in Global
//! Settings -> About - it is what crash reporters get asked to attach.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

use crate::error::AppError;

/// Newest daily files kept by the startup prune (`legit.log.YYYY-MM-DD`).
const KEEP_LOG_FILES: usize = 14;

static LOG_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The resolved log directory, if file logging is active this run.
pub fn log_dir() -> Option<&'static Path> {
    LOG_DIR.get().and_then(|o| o.as_deref())
}

/// Platform log directory, mirroring Tauri's `app_log_dir` convention for
/// the production identifier. Resolved by hand because the subscriber must
/// initialize BEFORE the Tauri app (and its path resolver) exists.
fn resolve_log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|h| h.join("Library/Logs/ch.ateleris.legit"))
    }
    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir().map(|d| d.join("ch.ateleris.legit").join("logs"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        dirs::data_dir().map(|d| d.join("ch.ateleris.legit").join("logs"))
    }
}

/// Delete rotated files beyond the newest `KEEP_LOG_FILES`. The daily suffix
/// (YYYY-MM-DD) sorts lexicographically = chronologically, so a name sort
/// suffices. Best effort - pruning must never block startup.
fn prune_old_logs(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("legit.log"))
        })
        .collect();
    files.sort();
    let excess = files.len().saturating_sub(KEEP_LOG_FILES);
    for old in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(old);
    }
}

/// Record panics (message + backtrace) through tracing so they reach the log
/// file - the whole point of persistent logging is the crash case. The
/// default hook still runs afterwards (stderr output, abort semantics).
fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        tracing::error!(target: "panic", "{info}\n{backtrace}");
        default_hook(info);
    }));
}

/// Install the global subscriber: a stderr layer (dev-verbose, `RUST_LOG`
/// overridable) plus, when the platform log dir resolves, an `info`-capped
/// daily-rotated file layer. The file writer is deliberately BLOCKING
/// (`tracing-appender` without `non_blocking`): log volume is low, and a
/// buffered/async writer could lose the final - most important - lines of a
/// crash.
pub fn init_tracing() {
    // Dev builds keep verbose per-crate tracing on stderr (every git
    // invocation is traced); release binaries run with
    // `windows_subsystem = "windows"` (no console), so their stderr layer is
    // effectively mute and the file layer is what survives.
    let default_filter = if cfg!(debug_assertions) {
        "info,legit_core=debug,legit_app_lib=debug"
    } else {
        "info"
    };
    let stderr_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(default_filter));
    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_filter(stderr_filter);
    let registry = tracing_subscriber::registry().with(stderr_layer);

    let dir = resolve_log_dir().filter(|d| std::fs::create_dir_all(d).is_ok());
    let _ = LOG_DIR.set(dir.clone());
    if let Some(dir) = dir {
        prune_old_logs(&dir);
        let file_layer = tracing_subscriber::fmt::layer()
            .with_target(true)
            .with_thread_ids(false)
            .with_ansi(false)
            .with_writer(tracing_appender::rolling::daily(&dir, "legit.log"))
            // Fixed at info in every profile: dev's debug firehose stays on
            // stderr only, so the files remain small and greppable.
            .with_filter(EnvFilter::new("info"));
        let _ = registry.with(file_layer).try_init();
    } else {
        let _ = registry.try_init();
    }
    install_panic_hook();

    // Session banner: every log file must identify the build that wrote it -
    // the first thing a crash report needs.
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        debug_build = cfg!(debug_assertions),
        "LeGit starting"
    );
}

/// Frontend error forwarding (window.onerror, unhandledrejection, React
/// ErrorBoundary). Fire-and-forget on the JS side; levels beyond these two
/// degrade to info.
#[tauri::command]
#[specta::specta]
pub fn frontend_log(level: String, message: String) {
    match level.as_str() {
        "error" => tracing::error!(target: "frontend", "{message}"),
        "warn" => tracing::warn!(target: "frontend", "{message}"),
        _ => tracing::info!(target: "frontend", "{message}"),
    }
}

/// Open the log directory in the OS file manager (Global Settings -> About).
#[tauri::command]
#[specta::specta]
pub fn open_log_dir() -> Result<(), AppError> {
    let Some(dir) = log_dir() else {
        return Err(AppError::Io("log directory unavailable on this system".into()));
    };
    let spawn = |mut cmd: std::process::Command| -> Result<(), AppError> {
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| AppError::Io(format!("open file manager: {e}")))
    };
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer");
        cmd.arg(dir);
        spawn(cmd)
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        cmd.arg(dir);
        spawn(cmd)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(dir);
        spawn(cmd)
    }
}

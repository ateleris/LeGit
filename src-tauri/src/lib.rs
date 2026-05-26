//! LeGit Tauri application entry point.
//!
//! `run()` wires the dependency tree described in `DESIGN.md`: resolve the
//! `git` binary (§7.6), construct the multi-repo `AppState` (§4.1), register
//! the typed Tauri commands (interface layer), and hand off to Tauri.

mod commands;
mod error;
mod git_resolve;
mod state;

use std::path::PathBuf;

use state::{AppSettings, AppState};
use tauri::Manager;
use tauri_specta::{collect_commands, Builder};
use tracing_subscriber::EnvFilter;

pub fn run() {
    init_tracing();

    // Specta builder. Lists every command exposed to the frontend; the
    // resulting TS bindings file is written on debug builds.
    let specta_builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::open_repo,
        commands::close_repo,
        commands::list_repos,
        commands::recent_repos,
        commands::restore_open_repos,
        commands::set_active_repo,
        commands::console_exec,
        commands::console_cancel,
        commands::git_status_check,
        commands::set_git_path,
        commands::get_settings,
        commands::set_active_theme,
        commands::save_layout,
        commands::list_themes,
        commands::load_theme,
        commands::save_theme,
        commands::delete_theme,
    ]);

    #[cfg(debug_assertions)]
    {
        use specta_typescript::Typescript;
        let _ = specta_builder
            .export(
                Typescript::default(),
                "../src/lib/bindings.ts",
            )
            .map_err(|e| eprintln!("specta export failed: {e}"));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);

            let (settings_path, user_themes_dir, builtin_themes_dir) =
                commands::resolve_dirs(&app.handle());

            // Load settings synchronously so the rest of startup sees the
            // user's git_path_override.
            let settings = load_settings_sync(&settings_path);
            let git_path_override = settings.git_path_override.as_deref().map(PathBuf::from);
            let resolved_git_path = git_resolve::resolve_git_path(git_path_override.as_ref());

            tracing::info!(
                resolved_git_path = %resolved_git_path.display(),
                settings_path = %settings_path.display(),
                user_themes_dir = %user_themes_dir.display(),
                builtin_themes_dir = %builtin_themes_dir.display(),
                "legit startup",
            );

            let state = AppState::new(
                resolved_git_path,
                settings,
                settings_path,
                user_themes_dir,
                builtin_themes_dir,
            );
            app.manage(state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn load_settings_sync(path: &std::path::Path) -> AppSettings {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<AppSettings>(&bytes) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    err = %e,
                    path = %path.display(),
                    "settings.json is malformed — starting with defaults",
                );
                AppSettings::default()
            }
        },
        Err(_) => AppSettings::default(),
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,legit_core=debug,legit_app_lib=debug"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_thread_ids(false)
        .try_init();
}

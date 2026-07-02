//! LeGit Tauri application entry point.
//!
//! `run()` wires the dependency tree described in the design documents:
//! resolve the `git` binary, construct the scoped `AppState`, register the
//! typed Tauri commands, and hand off to Tauri.

mod commands;
mod error;
mod git_resolve;
mod state;
mod watcher;

use std::path::PathBuf;

use state::{GlobalSettings, AppState};
use tauri::{Emitter, Manager};
use tauri_specta::{collect_commands, Builder};
use tracing_subscriber::EnvFilter;

pub fn run() {
    init_tracing();

    let specta_builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::open_repo,
        commands::repo_init,
        commands::repo_clone,
        commands::cancel_clone,
        commands::close_repo,
        commands::list_repos,
        commands::recent_repos,
        commands::restore_open_repos,
        commands::set_open_repos_order,
        commands::set_active_repo,
        commands::set_watcher_enabled,
        commands::console_exec,
        commands::console_cancel,
        commands::git_status_check,
        commands::set_git_path,
        commands::set_repo_git_path,
        commands::get_global_settings,
        commands::get_repo_settings,
        commands::update_repo_settings,
        commands::set_active_theme,
        commands::save_global_layout,
        commands::save_repo_layout,
        commands::save_region_state,
        commands::list_themes,
        commands::load_theme,
        commands::save_theme,
        commands::delete_theme,
        commands::repo_line_endings_view,
        commands::global_line_endings_view,
        commands::repo_write_line_endings,
        commands::global_write_line_endings,
        commands::repo_signing_config,
        commands::global_signing_config,
        commands::repo_write_signing,
        commands::global_write_signing,
        commands::list_git_profiles,
        commands::create_git_profile,
        commands::update_git_profile,
        commands::delete_git_profile,
        commands::detect_active_profile_for_repo,
        commands::preview_apply_profile,
        commands::apply_profile_to_repo,
        commands::clear_repo_profile,
        commands::create_profile_from_repo,
        commands::set_warn_on_mixed_endings,
        commands::set_confirm_discard,
        commands::save_switch_dirty_behavior,
        commands::repo_log,
        commands::repo_status,
        commands::repo_branches,
        commands::repo_create_branch,
        commands::repo_switch_branch,
        commands::repo_delete_branch,
        commands::repo_rename_branch,
        commands::repo_checkout_remote_branch,
        commands::repo_checkout_commit,
        commands::repo_tags,
        commands::repo_create_tag,
        commands::repo_delete_tag,
        commands::repo_push_tag,
        commands::repo_delete_remote_tag,
        commands::repo_remote_tags,
        commands::repo_stashes,
        commands::repo_create_stash,
        commands::repo_apply_stash,
        commands::repo_pop_stash,
        commands::repo_drop_stash,
        commands::repo_rename_stash,
        commands::repo_commit_details,
        commands::repo_commit_files,
        commands::repo_diff,
        commands::repo_stage_hunk,
        commands::repo_unstage_hunk,
        commands::repo_discard_hunk,
        commands::repo_stage_lines,
        commands::repo_unstage_lines,
        commands::repo_discard_lines,
        commands::repo_stage,
        commands::repo_unstage,
        commands::repo_discard,
        commands::repo_commit,
        commands::repo_reword_commit,
        commands::repo_fetch,
        commands::repo_pull,
        commands::repo_push,
        commands::repo_tracking_status,
        commands::repo_list_remotes,
        commands::repo_add_remote,
        commands::repo_remove_remote,
        commands::repo_rename_remote,
        commands::repo_set_remote_url,
        commands::repo_prune_remote,
        commands::list_lane_locks,
        commands::set_lane_lock,
        commands::unset_lane_lock,
        commands::save_column_preferences,
        commands::save_changed_files_view_mode,
        commands::save_ui_font_size,
        commands::save_commits_graph_metrics,
    ]);

    #[cfg(debug_assertions)]
    {
        use specta_typescript::{BigIntExportBehavior, Typescript};
        let _ = specta_builder
            .export(
                // i64 timestamps (Unix seconds) are safe as JS `number` —
                // MAX_SAFE_INTEGER covers timestamps until the year 285,428,751.
                Typescript::default().bigint(BigIntExportBehavior::Number),
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

            let (global_settings_path, repos_data_dir, user_themes_dir, builtin_themes_dir) =
                commands::resolve_dirs(&app.handle());

            let global_settings = load_global_settings_sync(&global_settings_path);
            let git_override = global_settings.git_path_override.as_deref().map(PathBuf::from);
            let resolved_git_path = git_resolve::resolve_git_path(git_override.as_ref());

            tracing::info!(
                resolved_git_path = %resolved_git_path.display(),
                global_settings_path = %global_settings_path.display(),
                repos_data_dir = %repos_data_dir.display(),
                user_themes_dir = %user_themes_dir.display(),
                builtin_themes_dir = %builtin_themes_dir.display(),
                "legit startup",
            );

            let state = AppState::new(
                resolved_git_path,
                global_settings,
                global_settings_path,
                repos_data_dir,
                user_themes_dir,
                builtin_themes_dir,
            );
            app.manage(state);

            // Forward every git invocation to the UI as a live command log.
            let handle = app.handle().clone();
            legit_core::runner::set_invocation_observer(std::sync::Arc::new(move |inv| {
                let _ = handle.emit("git_invocation", inv);
            }));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn load_global_settings_sync(path: &std::path::Path) -> GlobalSettings {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<GlobalSettings>(&bytes) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    err = %e,
                    path = %path.display(),
                    "global-settings.json is malformed — starting with defaults",
                );
                GlobalSettings::default()
            }
        },
        Err(_) => GlobalSettings::default(),
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

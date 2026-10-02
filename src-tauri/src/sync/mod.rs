//! Settings sync via a designated git repository
//! (design/2026-10-02-settings-sync-git.md): the shareable settings subset
//! and user themes mirror into a local checkout that pulls at startup and
//! commits + pushes on change.

pub mod engine;
pub mod model;
pub mod tauri_engine;
pub mod state_file;
pub mod themes;

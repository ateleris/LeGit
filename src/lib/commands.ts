// Typed wrappers around `invoke()` for every Tauri command in v0.1.
//
// Every call goes through one of these — components never `invoke` raw.
// This is the seam that the specta-generated bindings will replace, so
// keep the shape (one exported async function per command) compatible.

import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  ConsoleExecHandle,
  GitStatus,
  RepoSummary,
  RestoreResult,
  ThemeEntry,
  ThemeDocument,
} from "./types";

// --- repo ---

export const openRepo = (path: string) =>
  invoke<RepoSummary>("open_repo", { path });

export const closeRepo = (repoId: string) =>
  invoke<null>("close_repo", { repoId });

export const listRepos = () => invoke<RepoSummary[]>("list_repos");

export const recentRepos = () => invoke<string[]>("recent_repos");

export const restoreOpenRepos = () => invoke<RestoreResult>("restore_open_repos");

export const setActiveRepo = (repoId: string | null) =>
  invoke<null>("set_active_repo", { repoId });

// --- console ---

export const consoleExec = (repoId: string, command: string) =>
  invoke<ConsoleExecHandle>("console_exec", { repoId, command });

export const consoleCancel = (repoId: string, opId: string) =>
  invoke<boolean>("console_cancel", { repoId, opId });

// --- git setup ---

export const gitStatusCheck = () => invoke<GitStatus>("git_status_check");

export const setGitPath = (path: string | null) =>
  invoke<GitStatus>("set_git_path", { path });

// --- persistence ---

export const getSettings = () => invoke<AppSettings>("get_settings");

export const setActiveTheme = (name: string) =>
  invoke<null>("set_active_theme", { name });

export const saveLayout = (layout: unknown) =>
  invoke<null>("save_layout", { layout });

// --- themes ---

export const listThemes = () => invoke<ThemeEntry[]>("list_themes");

export const loadTheme = (name: string) =>
  invoke<ThemeDocument>("load_theme", { name });

export const saveTheme = (name: string, contents: ThemeDocument) =>
  invoke<ThemeEntry>("save_theme", { name, contents });

export const deleteTheme = (name: string) =>
  invoke<null>("delete_theme", { name });

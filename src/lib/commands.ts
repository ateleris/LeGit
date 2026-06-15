// Typed wrappers around `invoke()` for every Tauri command in v0.1.
//
// Every call goes through one of these — components never `invoke` raw.
// This is the seam that the specta-generated bindings will replace, so
// keep the shape (one exported async function per command) compatible.

import { invoke } from "@tauri-apps/api/core";
import type {
  Branch,
  Commit,
  CommitDetails,
  GlobalSettings,
  LaneLock,
  RepoSettings,
  ConsoleExecHandle,
  GitStatus,
  RepoSummary,
  RestoreResult,
  ThemeEntry,
  ThemeDocument,
  LineEndingsView,
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

export const setRepoGitPath = (repoId: string, path: string | null) =>
  invoke<RepoSummary>("set_repo_git_path", { repoId, path });

// --- repo settings ---

export const getRepoSettings = (repoId: string) =>
  invoke<RepoSettings>("get_repo_settings", { repoId });

export const updateRepoSettings = (repoId: string, settings: RepoSettings) =>
  invoke<null>("update_repo_settings", { repoId, settings });

// --- persistence ---

export const getGlobalSettings = () =>
  invoke<GlobalSettings>("get_global_settings");

export const setWarnOnMixedEndings = (warn: boolean) =>
  invoke<null>("set_warn_on_mixed_endings", { warn });

export const setActiveTheme = (name: string) =>
  invoke<null>("set_active_theme", { name });

export const saveGlobalLayout = (layout: unknown) =>
  invoke<null>("save_global_layout", { layout });

export const saveRepoLayout = (layout: unknown) =>
  invoke<null>("save_repo_layout", { layout });

export const saveRegionState = (
  placement: import("./types").RegionPlacement,
  sizeTop: number | null,
  sizeLeft: number | null,
  collapsed: boolean
) => invoke<null>("save_region_state", { placement, sizeTop, sizeLeft, collapsed });

// --- themes ---

export const listThemes = () => invoke<ThemeEntry[]>("list_themes");

export const loadTheme = (name: string) =>
  invoke<ThemeDocument>("load_theme", { name });

export const saveTheme = (name: string, contents: ThemeDocument) =>
  invoke<ThemeEntry>("save_theme", { name, contents });

export const deleteTheme = (name: string) =>
  invoke<null>("delete_theme", { name });

// --- line endings ---

export const repoLineEndingsView = (repoId: string) =>
  invoke<LineEndingsView>("repo_line_endings_view", { repoId });

export const globalLineEndingsView = () =>
  invoke<LineEndingsView>("global_line_endings_view");

export const repoWriteLineEndings = (
  repoId: string,
  autocrlf: string | null,
  eol: string | null
) => invoke<LineEndingsView>("repo_write_line_endings", { repoId, autocrlf, eol });

export const globalWriteLineEndings = (
  autocrlf: string | null,
  eol: string | null
) => invoke<LineEndingsView>("global_write_line_endings", { autocrlf, eol });

// --- log / commit details ---

export const repoLog = (repoId: string, maxCount?: number, skip?: number) =>
  invoke<Commit[]>("repo_log", { repoId, maxCount: maxCount ?? null, skip: skip ?? null });

export const repoCommitDetails = (repoId: string, commitId: string) =>
  invoke<CommitDetails>("repo_commit_details", { repoId, commitId });

export const repoBranches = (repoId: string) =>
  invoke<Branch[]>("repo_branches", { repoId });

// --- lane locks ---

export const listLaneLocks = (repoId: string) =>
  invoke<LaneLock[]>("list_lane_locks", { repoId });

export const setLaneLock = (repoId: string, refName: string, laneIndex: number) =>
  invoke<LaneLock[]>("set_lane_lock", { repoId, refName, laneIndex });

export const unsetLaneLock = (repoId: string, refName: string) =>
  invoke<LaneLock[]>("unset_lane_lock", { repoId, refName });

// --- column preferences ---

export const saveColumnPreferences = (prefs: unknown) =>
  invoke<null>("save_column_preferences", { prefs });

// --- commits graph metrics ---

export const saveCommitsGraphMetrics = (
  rowHeight: number,
  laneWidth: number,
  dotRadius: number,
  lineWidth: number,
  textSize: number
) => invoke<null>("save_commits_graph_metrics", { rowHeight, laneWidth, dotRadius, lineWidth, textSize });

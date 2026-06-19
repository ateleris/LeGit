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
  CommitFileChange,
  ConsoleExecHandle,
  FileStatus,
  GitStatus,
  RepoSummary,
  RestoreResult,
  ThemeEntry,
  ThemeDocument,
  LineEndingsView,
  SigningView,
  GitProfile,
  ProfileStatus,
  KeyDiff,
  DiffEntry,
  DiffSource,
  FetchOptions,
  PullOptions,
  PushOptions,
  TrackingStatus,
  Remote,
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

export const setOpenReposOrder = (repoIds: string[]) =>
  invoke<null>("set_open_repos_order", { repoIds });

export const setWatcherEnabled = (enabled: boolean) =>
  invoke<null>("set_watcher_enabled", { enabled });

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

export const setConfirmDiscard = (confirm: boolean) =>
  invoke<null>("set_confirm_discard", { confirm });

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

// --- commit signing ---

export const repoSigningConfig = (repoId: string) =>
  invoke<SigningView>("repo_signing_config", { repoId });

export const globalSigningConfig = () =>
  invoke<SigningView>("global_signing_config");

export const repoWriteSigning = (
  repoId: string,
  gpgsign: string | null,
  format: string | null,
  signingKey: string | null,
  allowedSigners: string | null
) =>
  invoke<SigningView>("repo_write_signing", {
    repoId,
    gpgsign,
    format,
    signingKey,
    allowedSigners,
  });

export const globalWriteSigning = (
  gpgsign: string | null,
  format: string | null,
  signingKey: string | null,
  allowedSigners: string | null
) =>
  invoke<SigningView>("global_write_signing", {
    gpgsign,
    format,
    signingKey,
    allowedSigners,
  });

// --- git identity profiles ---

export const listGitProfiles = () =>
  invoke<GitProfile[]>("list_git_profiles");

export const createGitProfile = (profile: GitProfile) =>
  invoke<GitProfile>("create_git_profile", { profile });

export const updateGitProfile = (profile: GitProfile) =>
  invoke<null>("update_git_profile", { profile });

export const deleteGitProfile = (profileId: string) =>
  invoke<null>("delete_git_profile", { profileId });

export const detectActiveProfileForRepo = (repoId: string) =>
  invoke<ProfileStatus>("detect_active_profile_for_repo", { repoId });

export const previewApplyProfile = (repoId: string, profileId: string) =>
  invoke<KeyDiff[]>("preview_apply_profile", { repoId, profileId });

export const applyProfileToRepo = (repoId: string, profileId: string) =>
  invoke<ProfileStatus>("apply_profile_to_repo", { repoId, profileId });

export const clearRepoProfile = (repoId: string) =>
  invoke<ProfileStatus>("clear_repo_profile", { repoId });

export const createProfileFromRepo = (repoId: string, name: string) =>
  invoke<GitProfile>("create_profile_from_repo", { repoId, name });

// --- log / commit details ---

export const repoLog = (repoId: string, maxCount?: number, skip?: number) =>
  invoke<Commit[]>("repo_log", { repoId, maxCount: maxCount ?? null, skip: skip ?? null });

export const repoStatus = (repoId: string) =>
  invoke<FileStatus[]>("repo_status", { repoId });

export const repoCommitDetails = (repoId: string, commitId: string) =>
  invoke<CommitDetails>("repo_commit_details", { repoId, commitId });

export const repoCommitFiles = (repoId: string, commitId: string) =>
  invoke<CommitFileChange[]>("repo_commit_files", { repoId, commitId });

// --- diffs ---

/** A file's diff from `source`, with `context` lines of surrounding context. */
export const repoDiff = (
  repoId: string,
  source: DiffSource,
  path: string,
  oldPath: string | null,
  context: number
) => invoke<DiffEntry>("repo_diff", { repoId, source, path, oldPath, context });

export const repoStageHunk = (repoId: string, path: string, hunkIndex: number) =>
  invoke<null>("repo_stage_hunk", { repoId, path, hunkIndex });

export const repoUnstageHunk = (repoId: string, path: string, hunkIndex: number) =>
  invoke<null>("repo_unstage_hunk", { repoId, path, hunkIndex });

export const repoDiscardHunk = (repoId: string, path: string, hunkIndex: number) =>
  invoke<null>("repo_discard_hunk", { repoId, path, hunkIndex });

/** Line-level staging — `lineIndices` index into the hunk's diff lines. */
export const repoStageLines = (repoId: string, path: string, hunkIndex: number, lineIndices: number[]) =>
  invoke<null>("repo_stage_lines", { repoId, path, hunkIndex, lineIndices });

export const repoUnstageLines = (repoId: string, path: string, hunkIndex: number, lineIndices: number[]) =>
  invoke<null>("repo_unstage_lines", { repoId, path, hunkIndex, lineIndices });

export const repoDiscardLines = (repoId: string, path: string, hunkIndex: number, lineIndices: number[]) =>
  invoke<null>("repo_discard_lines", { repoId, path, hunkIndex, lineIndices });

// --- working-tree write operations ---

export const repoStage = (repoId: string, paths: string[]) =>
  invoke<null>("repo_stage", { repoId, paths });

export const repoUnstage = (repoId: string, paths: string[]) =>
  invoke<null>("repo_unstage", { repoId, paths });

export const repoDiscard = (repoId: string, paths: string[]) =>
  invoke<null>("repo_discard", { repoId, paths });

export const repoCommit = (repoId: string, message: string, amend = false) =>
  invoke<string>("repo_commit", { repoId, message, amend });

export const repoBranches = (repoId: string) =>
  invoke<Branch[]>("repo_branches", { repoId });

// --- remote sync (fetch / pull / push) ---
//
// fetch/pull/push take a frontend-generated `opId` so the op can be cancelled
// via `consoleCancel(repoId, opId)` while it runs. Auth is driven by the repo's
// local git config (the active profile's SSH command + credential helper).

export const repoFetch = (repoId: string, opts: FetchOptions, opId: string) =>
  invoke<null>("repo_fetch", { repoId, opts, opId });

export const repoPull = (repoId: string, opts: PullOptions, opId: string) =>
  invoke<null>("repo_pull", { repoId, opts, opId });

export const repoPush = (repoId: string, opts: PushOptions, opId: string) =>
  invoke<null>("repo_push", { repoId, opts, opId });

export const repoTrackingStatus = (repoId: string) =>
  invoke<TrackingStatus | null>("repo_tracking_status", { repoId });

// --- remote management ---

export const repoListRemotes = (repoId: string) =>
  invoke<Remote[]>("repo_list_remotes", { repoId });

export const repoAddRemote = (repoId: string, name: string, url: string) =>
  invoke<null>("repo_add_remote", { repoId, name, url });

export const repoRemoveRemote = (repoId: string, name: string) =>
  invoke<null>("repo_remove_remote", { repoId, name });

export const repoRenameRemote = (repoId: string, oldName: string, newName: string) =>
  invoke<null>("repo_rename_remote", { repoId, oldName, newName });

export const repoSetRemoteUrl = (repoId: string, name: string, url: string, push: boolean) =>
  invoke<null>("repo_set_remote_url", { repoId, name, url, push });

export const repoPruneRemote = (repoId: string, name: string, opId: string) =>
  invoke<null>("repo_prune_remote", { repoId, name, opId });

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

export const saveChangedFilesViewMode = (mode: string) =>
  invoke<null>("save_changed_files_view_mode", { mode });

/** Persists the global UI font size (px); returns the clamped value. */
export const saveUiFontSize = (size: number) =>
  invoke<number>("save_ui_font_size", { size });

// --- commits graph metrics ---

export const saveCommitsGraphMetrics = (
  rowHeight: number,
  laneWidth: number,
  dotRadius: number,
  lineWidth: number,
  textSize: number
) => invoke<null>("save_commits_graph_metrics", { rowHeight, laneWidth, dotRadius, lineWidth, textSize });

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
  CommitSearchKind,
  BlameHunk,
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
  ResolvedIdentity,
  IdentityView,
  CredentialHelperView,
  AvailableHelper,
  SshKeyStatus,
  SshTestOutcome,
  ConnectedAccountMeta,
  ConnectedAccountStatus,
  KeyDiff,
  DiffEntry,
  DiffSource,
  FileAtRevision,
  FileHistoryEntry,
  RepoFileEntry,
  LineEndingKind,
  FetchOptions,
  PullOptions,
  PullStrategy,
  PushOptions,
  PushRecurseMode,
  TrackingStatus,
  Remote,
  SwitchOutcome,
  SwitchDirtyBehavior,
  StashEntry,
  SubmoduleAutoUpdateResult,
  SubmoduleGitdirInfo,
  SubmoduleInfo,
  SubmoduleLog,
  SubmoduleUpdateOptions,
  SubmoduleUpdateStrategy,
  TagInfo,
  RemoteTag,
  StashOutcome,
  StashApplyOutcome,
  MergeOptions,
  MergeOutcome,
  RebaseOutcome,
  RebaseStep,
  ReflogEntry,
  RepoOpState,
  ResetMode,
  SequenceOutcome,
  ConflictFileSides,
  ConflictEntry,
  ConflictSide,
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

export interface InitOptions {
  /** Create a bare repository (created but not opened: no worktree). */
  bare?: boolean;
  /** Initial branch name (`--initial-branch`); blank/absent uses git's default. */
  initialBranch?: string | null;
}

export interface CloneOptions {
  /** Shallow clone depth (`--depth`); absent/0 clones full history. */
  depth?: number | null;
  /** Branch to check out (`--branch`); absent uses the remote default. */
  branch?: string | null;
  /** Also clone submodules (`--recurse-submodules`). */
  recurseSubmodules?: boolean;
}

/**
 * Init a new repo at `path`; optionally apply a profile (id, or null for
 * global config). Returns null for a bare init: a bare repo has no worktree,
 * so it is created but not opened as a session.
 */
export const repoInit = (
  path: string,
  profileId: string | null,
  options: InitOptions = {}
) =>
  invoke<RepoSummary | null>("repo_init", {
    path,
    profileId,
    bare: options.bare ?? false,
    initialBranch: options.initialBranch ?? null,
  });

/** Clone `url` into `parentDir/name`; optional profile; cancellable via `opId`. */
export const repoClone = (
  url: string,
  parentDir: string,
  name: string,
  profileId: string | null,
  opId: string,
  options: CloneOptions = {}
) =>
  invoke<RepoSummary>("repo_clone", {
    url,
    parentDir,
    name,
    profileId,
    opId,
    depth: options.depth ?? null,
    branch: options.branch ?? null,
    recurseSubmodules: options.recurseSubmodules ?? false,
  });

export const cancelClone = (opId: string) =>
  invoke<boolean>("cancel_clone", { opId });

export const setOpenReposOrder = (repoIds: string[]) =>
  invoke<null>("set_open_repos_order", { repoIds });

export const setWatcherEnabled = (enabled: boolean) =>
  invoke<null>("set_watcher_enabled", { enabled });

// --- console ---

export const consoleExec = (repoId: string, command: string) =>
  invoke<ConsoleExecHandle>("console_exec", { repoId, command });

export const consoleCancel = (repoId: string, opId: string) =>
  invoke<boolean>("console_cancel", { repoId, opId });

// --- in-app git credential prompt ---

/**
 * Complete a pending credential prompt. `remember` persists the credentials
 * to the OS keychain once git confirms they work.
 */
export const credentialRespond = (
  requestId: string,
  username: string,
  password: string,
  remember: boolean
) => invoke<boolean>("credential_respond", { requestId, username, password, remember });

/** Dismiss a pending credential prompt (git fails with its normal auth error). */
export const credentialCancel = (requestId: string) =>
  invoke<boolean>("credential_cancel", { requestId });

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

export const setExternalEditorCommand = (command: string | null) =>
  invoke<null>("set_external_editor_command", { command });

/** Open the repo root in the configured external editor (or the OS file
 * manager when none is configured). */
export const repoOpenInEditor = (repoId: string) =>
  invoke<null>("repo_open_in_editor", { repoId });

/** Open one working-tree file in the configured external editor (same
 * template, `$FILE` = absolute file path; reveal in the OS file manager when
 * none is configured). */
export const repoOpenFileInEditor = (repoId: string, path: string) =>
  invoke<null>("repo_open_file_in_editor", { repoId, path });

/** The web URL of the repo's remote page (origin preferred), or null when no
 * remote is configured / it has no web form. Drives the button state. */
export const repoRemoteWebUrl = (repoId: string) =>
  invoke<string | null>("repo_remote_web_url", { repoId });

/** Open the repo's remote hosting page (GitHub/GitLab/…) in the browser. */
export const repoOpenRemotePage = (repoId: string) =>
  invoke<null>("repo_open_remote_page", { repoId });

export const setAutoFetchEnabled = (enabled: boolean) =>
  invoke<null>("set_auto_fetch_enabled", { enabled });

export const setAutoFetchIntervalMinutes = (minutes: number) =>
  invoke<null>("set_auto_fetch_interval_minutes", { minutes });

export const setCommitAvatars = (enabled: boolean) =>
  invoke<null>("set_commit_avatars", { enabled });

export const setDiffSyntaxHighlighting = (enabled: boolean) =>
  invoke<null>("set_diff_syntax_highlighting", { enabled });

export const setSuppressedAutoOpenPanels = (panels: string[]) =>
  invoke<null>("set_suppressed_auto_open_panels", { panels });

export const setWorkingChangesSectionOrder = (order: string[]) =>
  invoke<null>("set_working_changes_section_order", { order });

export const setActiveTheme = (name: string) =>
  invoke<null>("set_active_theme", { name });

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

// Global identity (user.name / user.email in ~/.gitconfig): edit-only mirror,
// never a profile apply. Auth/signing bundles stay per-repo via profiles.

export const globalIdentityView = () =>
  invoke<IdentityView>("global_identity_view");

export const globalWriteIdentity = (name: string | null, email: string | null) =>
  invoke<IdentityView>("global_write_identity", { name, email });

export const repoResolvedIdentity = (repoId: string) =>
  invoke<ResolvedIdentity>("repo_resolved_identity", { repoId });

export const globalCredentialHelperView = () =>
  invoke<CredentialHelperView>("global_credential_helper_view");

export const globalWriteCredentialHelper = (helper: string | null) =>
  invoke<CredentialHelperView>("global_write_credential_helper", { helper });

export const listAvailableCredentialHelpers = () =>
  invoke<AvailableHelper[]>("list_available_credential_helpers");

// SSH key management (phase 1 of the platform integrations).

export const sshKeyStatus = (privateKeyPath: string) =>
  invoke<SshKeyStatus>("ssh_key_status", { privateKeyPath });

export const defaultSshKeysStatus = () =>
  invoke<SshKeyStatus[]>("default_ssh_keys_status");

export const generateSshKey = (fileName: string, keyType: "ed25519" | "rsa", comment: string) =>
  invoke<SshKeyStatus>("generate_ssh_key", { fileName, keyType, comment });

export const testSshAuth = (host: string, privateKeyPath: string | null) =>
  invoke<SshTestOutcome>("test_ssh_auth", { host, privateKeyPath });

export const openPlatformKeySettings = (platform: string) =>
  invoke<null>("open_platform_key_settings", { platform });

// Connected platform accounts (PAT-based; tokens live in the OS keychain).

export const listConnectedAccounts = () =>
  invoke<ConnectedAccountStatus[]>("list_connected_accounts");

export const connectAccountPat = (platform: string, token: string) =>
  invoke<ConnectedAccountMeta>("connect_account_pat", { platform, token });

export const disconnectAccount = (platform: string) =>
  invoke<null>("disconnect_account", { platform });

export const uploadSshKeyToPlatform = (platform: string, title: string, publicKey: string) =>
  invoke<null>("upload_ssh_key_to_platform", { platform, title, publicKey });

export const openPlatformTokenSettings = (platform: string) =>
  invoke<null>("open_platform_token_settings", { platform });

// --- log / commit details ---

export const repoLog = (repoId: string, maxCount?: number, skip?: number, revisionRange?: string) =>
  invoke<Commit[]>("repo_log", {
    repoId,
    maxCount: maxCount ?? null,
    skip: skip ?? null,
    revisionRange: revisionRange ?? null,
  });

export const repoStatus = (repoId: string) =>
  invoke<FileStatus[]>("repo_status", { repoId });

export const repoCommitDetails = (repoId: string, commitId: string) =>
  invoke<CommitDetails>("repo_commit_details", { repoId, commitId });

// --- inspection: compare / search / blame ---

/** Files changed between two arbitrary revs (Compare view file list). */
export const repoDiffFiles = (repoId: string, from: string, to: string) =>
  invoke<CommitFileChange[]>("repo_diff_files", { repoId, from, to });

export const repoSearchCommits = (
  repoId: string,
  query: string,
  kind: CommitSearchKind,
  maxCount: number,
) => invoke<Commit[]>("repo_search_commits", { repoId, query, kind, maxCount });

export const repoSearchPaths = (repoId: string, query: string, maxCount: number) =>
  invoke<string[]>("repo_search_paths", { repoId, query, maxCount });

/** Every file in the repo, classified tracked/untracked/(ignored). Files tree. */
export const repoListFiles = (repoId: string, showIgnored: boolean) =>
  invoke<RepoFileEntry[]>("repo_list_files", { repoId, showIgnored });

/** Append a path to the repo-root `.gitignore` (`path/` when it's a directory). */
export const repoAddToGitignore = (repoId: string, path: string, isDir: boolean) =>
  invoke<void>("repo_add_to_gitignore", { repoId, path, isDir });

/** Stop tracking a file (`git rm --cached`, kept on disk) and ignore it. */
export const repoUntrackPath = (repoId: string, path: string, isDir: boolean) =>
  invoke<void>("repo_untrack_path", { repoId, path, isDir });

/** Reveal a repo-relative path in the OS file manager (best effort). */
export const repoRevealPath = (repoId: string, path: string) =>
  invoke<void>("repo_reveal_path", { repoId, path });

/** A file's current working-tree content (binary-aware). File View worktree mode. */
export const repoFileWorktree = (repoId: string, path: string) =>
  invoke<FileAtRevision>("repo_file_worktree", { repoId, path });

/** Line-ending style of a file side. `rev`: null = working tree, ":" = index,
 *  else a rev spec (sha / HEAD / <sha>^ / branch). */
export const repoLineEndingKind = (repoId: string, path: string, rev?: string | null) =>
  invoke<LineEndingKind>("repo_line_ending_kind", { repoId, path, rev: rev ?? null });

/** Rewrite a working-tree file's line endings to `target`, content untouched.
 *  Backs the diff chip's "revert line endings" action. */
export const repoRevertLineEndings = (repoId: string, path: string, target: LineEndingKind) =>
  invoke<null>("repo_revert_line_endings", { repoId, path, target });

/** Blame `path` - at `rev` when given, else the working tree. */
export const repoBlame = (repoId: string, path: string, rev?: string | null) =>
  invoke<BlameHunk[]>("repo_blame", { repoId, path, rev: rev ?? null });

/** Merge base of two revs, or null for unrelated histories. */
export const repoMergeBase = (repoId: string, a: string, b: string) =>
  invoke<string | null>("repo_merge_base", { repoId, a, b });

/** Full content of a repo-relative file as of an arbitrary tree-ish. */
export const repoFileAtRevision = (repoId: string, rev: string, path: string) =>
  invoke<FileAtRevision>("repo_file_at_revision", { repoId, rev, path });

/** A single file's commit history (newest first), following renames. */
export const repoFileHistory = (
  repoId: string,
  path: string,
  maxCount: number,
  skip: number,
) =>
  invoke<FileHistoryEntry[]>("repo_file_history", { repoId, path, maxCount, skip });

/**
 * Restore a single file (index + working tree) to its content at `rev`.
 * Destructive: overwrites local changes to the file without complaint.
 */
export const repoRestoreFileAtRevision = (repoId: string, rev: string, path: string) =>
  invoke<null>("repo_restore_file_at_revision", { repoId, rev, path });

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

/** Read a working-tree file as UTF-8 text (editable diff save baseline). */
export const repoReadWorktreeFile = (repoId: string, path: string) =>
  invoke<string>("repo_read_worktree_file", { repoId, path });

/** Overwrite a working-tree file with text (editable diff save path). */
export const repoWriteWorktreeFile = (repoId: string, path: string, content: string) =>
  invoke<null>("repo_write_worktree_file", { repoId, path, content });

// --- merge / rebase / op-state ---

export const repoMerge = (repoId: string, target: string, options: MergeOptions) =>
  invoke<MergeOutcome>("repo_merge", { repoId, target, options });

export const repoMergeContinue = (repoId: string) =>
  invoke<MergeOutcome>("repo_merge_continue", { repoId });

export const repoMergeAbort = (repoId: string) =>
  invoke<null>("repo_merge_abort", { repoId });

export const repoRebase = (repoId: string, onto: string) =>
  invoke<RebaseOutcome>("repo_rebase", { repoId, onto });

export const repoRebaseContinue = (repoId: string) =>
  invoke<RebaseOutcome>("repo_rebase_continue", { repoId });

export const repoRebaseSkip = (repoId: string) =>
  invoke<RebaseOutcome>("repo_rebase_skip", { repoId });

export const repoRebaseAbort = (repoId: string) =>
  invoke<null>("repo_rebase_abort", { repoId });

/** Interactive rebase of base..HEAD following `plan` (todo order, oldest
 *  first). Conflicts pause the normal rebase machinery (banner handles them). */
export const repoRebaseInteractive = (repoId: string, base: string, plan: RebaseStep[]) =>
  invoke<RebaseOutcome>("repo_rebase_interactive", { repoId, base, plan });

/** The index stages of a conflicted path, for the 3-way resolve view. */
export const repoConflictFileSides = (repoId: string, path: string) =>
  invoke<ConflictFileSides>("repo_conflict_file_sides", { repoId, path });

// --- undo & history rewriting ---

/** `git reset --soft|--mixed|--hard <target>`. Hard is destructive — confirm first. */
export const repoReset = (repoId: string, target: string, mode: ResetMode) =>
  invoke<null>("repo_reset", { repoId, target, mode });

export const repoRevert = (repoId: string, sha: string) =>
  invoke<SequenceOutcome>("repo_revert", { repoId, sha });

export const repoCherryPick = (repoId: string, sha: string) =>
  invoke<SequenceOutcome>("repo_cherry_pick", { repoId, sha });

export const repoCherryPickContinue = (repoId: string) =>
  invoke<SequenceOutcome>("repo_cherry_pick_continue", { repoId });

export const repoCherryPickSkip = (repoId: string) =>
  invoke<SequenceOutcome>("repo_cherry_pick_skip", { repoId });

export const repoCherryPickAbort = (repoId: string) =>
  invoke<null>("repo_cherry_pick_abort", { repoId });

export const repoRevertContinue = (repoId: string) =>
  invoke<SequenceOutcome>("repo_revert_continue", { repoId });

export const repoRevertSkip = (repoId: string) =>
  invoke<SequenceOutcome>("repo_revert_skip", { repoId });

export const repoRevertAbort = (repoId: string) =>
  invoke<null>("repo_revert_abort", { repoId });

/** HEAD's reflog, newest first — the undo safety net. */
export const repoReflog = (repoId: string, maxCount: number) =>
  invoke<ReflogEntry[]>("repo_reflog", { repoId, maxCount });

export const repoOpState = (repoId: string) =>
  invoke<RepoOpState>("repo_op_state", { repoId });

export const repoConflictEntries = (repoId: string) =>
  invoke<ConflictEntry[]>("repo_conflict_entries", { repoId });

/** Whole-file resolution; delete-conflicts resolve to deletion when the
 *  chosen side removed the file. (Mark-resolved without taking a side is
 *  just `repoStage([path])`.) */
export const repoResolveTakeSide = (repoId: string, path: string, side: ConflictSide) =>
  invoke<null>("repo_resolve_take_side", { repoId, path, side });

/** Paths whose conflict was resolved & staged during the in-progress
 *  operation (git's resolve-undo record) - reopenable via
 *  repoConflictReopen until the merge is committed. */
export const repoResolveUndoPaths = (repoId: string) =>
  invoke<string[]>("repo_resolve_undo_paths", { repoId });

/** Staged paths whose staged content still contains leftover conflict
 *  markers (`git diff --cached --check`). */
export const repoStagedMarkerPaths = (repoId: string) =>
  invoke<string[]>("repo_staged_marker_paths", { repoId });

/** Modified-but-unstaged paths whose worktree content still contains
 *  leftover conflict markers (`git diff --check`) - e.g. a staged resolution
 *  that was unstaged again. Also matches currently conflicted paths; callers
 *  filter those. */
export const repoUnstagedMarkerPaths = (repoId: string) =>
  invoke<string[]>("repo_unstaged_marker_paths", { repoId });

/** Reopen a resolved-and-staged conflict: restores the unmerged index stages
 *  and regenerates the markers in the worktree (discards the resolution). */
export const repoConflictReopen = (repoId: string, path: string) =>
  invoke<null>("repo_conflict_reopen", { repoId, path });

export const repoCommit = (repoId: string, message: string, amend = false) =>
  invoke<string>("repo_commit", { repoId, message, amend });

/// Reword (rename) a commit's message; returns the new commit id. v1 rewords
/// HEAD only and refuses commits already pushed to a remote.
export const repoRewordCommit = (repoId: string, commitId: string, message: string) =>
  invoke<string>("repo_reword_commit", { repoId, commitId, message });

export const repoBranches = (repoId: string) =>
  invoke<Branch[]>("repo_branches", { repoId });

export const repoCreateBranch = (
  repoId: string,
  name: string,
  startPoint?: string,
) =>
  invoke<void>("repo_create_branch", {
    repoId,
    name,
    startPoint: startPoint ?? null,
  });

export const repoSwitchBranch = (repoId: string, name: string) =>
  invoke<SwitchOutcome>("repo_switch_branch", { repoId, name });

export const repoDeleteBranch = (repoId: string, name: string, force: boolean) =>
  invoke<void>("repo_delete_branch", { repoId, name, force });

export const repoDeleteRemoteBranch = (repoId: string, remote: string, name: string, opId: string) =>
  invoke<void>("repo_delete_remote_branch", { repoId, remote, name, opId });

export const repoRenameBranch = (repoId: string, oldName: string, newName: string) =>
  invoke<void>("repo_rename_branch", { repoId, oldName, newName });

export const repoCheckoutRemoteBranch = (repoId: string, remoteRef: string) =>
  invoke<SwitchOutcome>("repo_checkout_remote_branch", { repoId, remoteRef });

export const repoCheckoutCommit = (repoId: string, sha: string) =>
  invoke<SwitchOutcome>("repo_checkout_commit", { repoId, sha });

// --- submodules ---

export const repoSubmodules = (repoId: string) =>
  invoke<SubmoduleInfo[]>("repo_submodules", { repoId });

export const repoSubmoduleLog = (
  repoId: string,
  path: string,
  from: string | null,
  to: string,
) => invoke<SubmoduleLog>("repo_submodule_log", { repoId, path, from, to });

export const repoSubmoduleUpdate = (
  repoId: string,
  opts: SubmoduleUpdateOptions,
  opId: string,
) => invoke<void>("repo_submodule_update", { repoId, opts, opId });

export const repoSubmoduleSync = (repoId: string, paths: string[], recursive: boolean) =>
  invoke<void>("repo_submodule_sync", { repoId, paths, recursive });

export const repoSubmoduleFetch = (repoId: string, path: string, opId: string) =>
  invoke<void>("repo_submodule_fetch", { repoId, path, opId });

export const repoSuperproject = (repoId: string) =>
  invoke<string | null>("repo_superproject", { repoId });

export const repoSubmoduleAdd = (
  repoId: string,
  url: string,
  path: string,
  branch: string | null,
  opId: string,
) => invoke<void>("repo_submodule_add", { repoId, url, path, branch, opId });

export const repoSubmoduleSetUrl = (repoId: string, path: string, url: string) =>
  invoke<void>("repo_submodule_set_url", { repoId, path, url });

export const repoSubmoduleSetBranch = (repoId: string, path: string, branch: string | null) =>
  invoke<void>("repo_submodule_set_branch", { repoId, path, branch });

export const repoSubmoduleUpdateRemote = (
  repoId: string,
  paths: string[],
  strategy: SubmoduleUpdateStrategy,
  opId: string,
) =>
  invoke<SubmoduleAutoUpdateResult[]>("repo_submodule_update_remote", {
    repoId,
    paths,
    strategy,
    opId,
  });

export const repoSubmoduleRemove = (repoId: string, path: string) =>
  invoke<void>("repo_submodule_remove", { repoId, path });

export const repoSubmoduleGitdirInfo = (repoId: string, name: string) =>
  invoke<SubmoduleGitdirInfo | null>("repo_submodule_gitdir_info", { repoId, name });

export const repoSubmoduleDeleteGitdir = (repoId: string, name: string) =>
  invoke<void>("repo_submodule_delete_gitdir", { repoId, name });

export const repoSubmoduleCreateBranch = (repoId: string, path: string, name: string) =>
  invoke<void>("repo_submodule_create_branch", { repoId, path, name });

export const repoSubmoduleAutoUpdate = (repoId: string) =>
  invoke<SubmoduleAutoUpdateResult[]>("repo_submodule_auto_update", { repoId });

// --- tags ---

export const repoTags = (repoId: string) => invoke<TagInfo[]>("repo_tags", { repoId });

export const repoCreateTag = (
  repoId: string,
  name: string,
  target: string | undefined,
  message: string | undefined,
) =>
  invoke<void>("repo_create_tag", {
    repoId,
    name,
    target: target ?? null,
    message: message ?? null,
  });

export const repoDeleteTag = (repoId: string, name: string) =>
  invoke<void>("repo_delete_tag", { repoId, name });

export const repoPushTag = (repoId: string, remote: string, name: string, opId: string) =>
  invoke<void>("repo_push_tag", { repoId, remote, name, opId });

export const repoDeleteRemoteTag = (repoId: string, remote: string, name: string, opId: string) =>
  invoke<void>("repo_delete_remote_tag", { repoId, remote, name, opId });

export const repoRemoteTags = (repoId: string, remote: string, opId: string) =>
  invoke<RemoteTag[]>("repo_remote_tags", { repoId, remote, opId });

// --- stashes ---

export const repoStashes = (repoId: string) =>
  invoke<StashEntry[]>("repo_stashes", { repoId });

export const repoCreateStash = (
  repoId: string,
  message: string | undefined,
  includeUntracked: boolean,
  keepIndex: boolean,
) =>
  invoke<StashOutcome>("repo_create_stash", {
    repoId,
    message: message ?? null,
    includeUntracked,
    keepIndex,
  });

/** Stash only the given paths (each file's full change, staged + unstaged;
 *  untracked included). A pathspec matching only clean files returns
 *  `nothing_to_stash`. */
export const repoCreateStashPaths = (
  repoId: string,
  message: string | undefined,
  paths: string[],
) =>
  invoke<StashOutcome>("repo_create_stash_paths", {
    repoId,
    message: message ?? null,
    paths,
  });

// Stash mutations address the stash by its commit SHA (stable), not the
// positional `stash@{N}` selector (which shifts on every create/drop/pop,
// including ones made outside the app). The backend resolves the SHA to the
// current selector at action time, so a stale UI can never hit the wrong stash.
export const repoApplyStash = (repoId: string, stashSha: string) =>
  invoke<StashApplyOutcome>("repo_apply_stash", { repoId, stashSha });

/** Apply ONE file from a stash to the working tree (unstaged, matching
 *  whole-stash apply); the stash keeps the file. Overwrites the current
 *  worktree copy. */
export const repoApplyStashFile = (repoId: string, stashSha: string, path: string) =>
  invoke<null>("repo_apply_stash_file", { repoId, stashSha, path });

export const repoPopStash = (repoId: string, stashSha: string) =>
  invoke<StashApplyOutcome>("repo_pop_stash", { repoId, stashSha });

export const repoDropStash = (repoId: string, stashSha: string) =>
  invoke<void>("repo_drop_stash", { repoId, stashSha });

export const repoRenameStash = (repoId: string, stashSha: string, message: string) =>
  invoke<void>("repo_rename_stash", { repoId, stashSha, message });

/** Create + check out a branch at the stash's base, apply the stash, drop it on success. */
export const repoStashBranch = (repoId: string, stashSha: string, branchName: string) =>
  invoke<void>("repo_stash_branch", { repoId, stashSha, branchName });

export const saveSwitchDirtyBehavior = (behavior: SwitchDirtyBehavior) =>
  invoke<void>("save_switch_dirty_behavior", { behavior });

export const savePushRecurseSubmodules = (mode: PushRecurseMode | null) =>
  invoke<void>("save_push_recurse_submodules", { mode });

export const savePullStrategy = (strategy: PullStrategy) =>
  invoke<void>("save_pull_strategy", { strategy });

export const saveStashIncludeUntracked = (includeUntracked: boolean) =>
  invoke<void>("save_stash_include_untracked", { includeUntracked });

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

/** Set (`origin/main`) or clear (`null`) a local branch's upstream. */
export const repoSetUpstream = (repoId: string, branch: string, upstream: string | null) =>
  invoke<void>("repo_set_upstream", { repoId, branch, upstream });

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
  lineWidth: number
) => invoke<null>("save_commits_graph_metrics", { rowHeight, laneWidth, dotRadius, lineWidth });

// Hand-written mirror of the Rust types that cross the Tauri IPC boundary.
//
// Kept in sync with `crates/legit-core/src/types.rs`,
// `src-tauri/src/state.rs`, `src-tauri/src/error.rs`, and the command
// modules. The specta-generated `bindings.ts` (debug builds) is the
// authoritative source long-term; this file exists so the frontend
// compiles before the first cargo build.

import type { CommitDateFormat } from "./time";

export type RepoId = string;

export interface RepoSummary {
  id: RepoId;
  path: string;
  name: string;
}

export type RegionPlacement = "top" | "left";

// Field optionality mirrors the generated bindings.ts exactly (serde default
// = optional), so swapping this hand-mirror for bindings.ts stays a no-op.
export interface GlobalSettings {
  git_path_override: string | null;
  last_open_repos?: string[];
  currently_open?: string[];
  active_open_repo: string | null;
  active_theme: string | null;
  global_region_placement: RegionPlacement;
  global_region_size_top: number | null;
  global_region_size_left: number | null;
  global_dock_collapsed: boolean;
  /** Attention-only line-ending chips on Working Changes rows (default true). */
  line_ending_chips_in_changes?: boolean;
  /** Warn before committing staged line-ending changes (default true). */
  warn_on_line_ending_commit?: boolean;
  column_preferences?: unknown;
  commits_row_height?: number;
  commits_lane_width?: number;
  commits_dot_radius?: number;
  commits_line_width?: number;
  /** Remembered Changed Files panel view mode ("tree" | "flat"). */
  changed_files_view_mode?: string | null;
  /** Global UI font size (px) — base for the panel text scale and min sizes. */
  ui_font_size?: number;
  /** Whether the filesystem watcher auto-refreshes the UI on disk changes. */
  watcher_enabled?: boolean;
  /** Whether discarding changes asks for confirmation first (default true). */
  confirm_discard?: boolean;
  /** Periodic background auto-fetch of the active repo's remotes (default off).
   * Fetch-only and quiet: never pulls/merges, never toasts. */
  auto_fetch_enabled?: boolean;
  /** Minutes between background auto-fetches (default 15, minimum 1). */
  auto_fetch_interval_minutes?: number;
  /** Command template for "open in external editor" (e.g. `code "$ROOT"`).
   * $ROOT = repo root, $FILE = file path for the open-file action; each is
   * appended when absent. null/blank = use the OS file manager instead. */
  external_editor_command?: string | null;
  /** How to handle uncommitted changes when switching branches (null = try_directly). */
  switch_dirty_behavior: SwitchDirtyBehavior | null;
  /** Pull integration strategy (null = Default: the repo's pull.rebase decides). */
  pull_strategy?: PullStrategy | null;
  /** Default mode for the Commits-toolbar Stash button: include untracked
   * files (default off = tracked changes only). Picked via the caret menu. */
  stash_include_untracked?: boolean;
  /** `push --recurse-submodules` guard mode (null = off). */
  push_recurse_submodules?: PushRecurseMode | null;
  /** Show author Gravatars in the commit graph. OFF by default — enabling it
   * sends hashed author emails to gravatar.com. */
  commit_avatars?: boolean;
  /** Syntax-highlight code in the diff viewer (default off). */
  diff_syntax_highlighting?: boolean;
  /** Show the full author datetime in the Commits panel's Date column instead
   * of the compact relative form (default off = relative). */
  commit_date_absolute?: boolean;
  /** Which absolute format the Date column uses (when `commit_date_absolute`).
   * Mirrors the backend `CommitDateFormat`; the string union lives in
   * `lib/time.ts` next to the formatter. */
  commit_date_format?: CommitDateFormat;
  /** Whether the absolute Date column includes the time of day (default on;
   * off shows the date only). Ignored while the column is relative. */
  commit_date_show_time?: boolean;
  /** Panel IDs the user opted out of auto-opening: a summon to one degrades to
   * notifyIfOpen (updates only if already open, never pops open). */
  suppressed_auto_open_panels?: string[];
  /** Top-to-bottom order of the Working Changes sections ("unstaged" | "staged"
   * | "commit"). Normalized on read; default unstaged → staged → commit. */
  working_changes_section_order?: string[];
  /** User-defined git identity profiles (camelCase key — serde rename). */
  gitProfiles?: GitProfilesDoc;
}

export interface RepoSettings {
  git_path_override: string | null;
  /** Per-repo override for the Working Changes chips (null = inherit). */
  line_ending_chips_in_changes?: boolean | null;
  /** Per-repo override for the commit warning (null = inherit). */
  warn_on_line_ending_commit?: boolean | null;
  /** Per-repo override for the external editor command template
   * (null/blank = inherit global; same $ROOT/$FILE semantics). */
  external_editor_command?: string | null;
  /** Selected git profile id (null = none / inherit). Intent hint only. */
  git_profile_id?: string | null;
  /** Auto-update submodule pointers after switch/pull (null = default ON). */
  submodule_auto_update?: boolean | null;
  /** Show remote-tracking branches in the commit tree (null = default ON). */
  show_remote_branches?: boolean | null;
}

export interface RestoreResult {
  repos: RepoSummary[];
  active_id: string | null;
}

export type RunnerEvent =
  | { kind: "stdout"; line: string }
  | { kind: "stderr"; line: string }
  | { kind: "finished"; exit_code: number | null; success: boolean; duration_ms: number };

export interface ConsoleEventPayload {
  op_id: string;
  event: RunnerEvent;
}

export interface ConsoleExecHandle {
  op_id: string;
  argv: string[];
}

/** Query domain affected by a filesystem change. Matches the react-query key
 *  suffixes `[repoId, <domain>]` and the Rust `ChangeDomain` enum in
 *  `src-tauri/src/watcher.rs`. */
export type ChangeDomain =
  | "status"
  | "log"
  | "branches"
  | "stashes"
  | "tags"
  | "diff"
  | "op_state"
  | "submodules";

/** Payload of the `legit://repo-changed` event emitted by the FS watcher. */
export interface RepoChangedPayload {
  repo_id: string;
  domains: ChangeDomain[];
  /** First few classified trigger paths (repo-relative, capped at 8 by the
   *  backend); `trigger_count` carries the full total. */
  trigger_paths: string[];
  trigger_count: number;
}

/** A completed git invocation reported by the backend (matches legit-core
 *  `GitInvocation`). Drives the Git Log panel. */
export interface GitInvocation {
  args: string[];
  cwd: string | null;
  exit_code: number | null;
  success: boolean;
  duration_ms: number;
  stderr: string;
}

export interface GitVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

export interface GitStatus {
  resolved_path: string;
  version: GitVersion | null;
  meets_minimum: boolean;
  minimum_required: [number, number, number];
  user_override: string | null;
  error: string | null;
}

export type ThemeSource = "builtin" | "user";

export interface ThemeEntry {
  name: string;
  source: ThemeSource;
  path: string;
}

export type AppError =
  | { kind: "UnknownRepo"; details: string }
  | { kind: "NotARepo"; details: string }
  | { kind: "Io"; details: string }
  | { kind: "Git"; details: unknown }
  | { kind: "GitUnavailable"; details: string }
  | { kind: "ForbiddenArg"; details: string }
  | { kind: "InvalidTheme"; details: string }
  | { kind: "Settings"; details: string }
  | { kind: "ParseArgs"; details: string }
  | { kind: "InvalidLockIndex"; details: number }
  | { kind: "OperationNotFound"; details: string }
  | { kind: "UnknownProfile"; details: string };

/** Human-readable labels for `GitError` variants that carry no message. */
const GIT_ERROR_LABELS: Record<string, string> = {
  RewordNotHead: "Only the latest commit (HEAD) can be reworded.",
  RewordPushed:
    "This commit has already been pushed; rewording would rewrite published history.",
};

/** Construct a short message suitable for display, regardless of variant. */
export function formatAppError(e: unknown): string {
  if (e && typeof e === "object" && "kind" in e) {
    const ae = e as AppError;
    // Unwrap a nested GitError ({ kind, details? }): show git's own message
    // instead of the serialized JSON envelope.
    if (ae.kind === "Git" && ae.details && typeof ae.details === "object") {
      const g = ae.details as { kind?: string; details?: unknown };
      const inner = g.details;
      if (typeof inner === "string") return inner;
      if (inner && typeof inner === "object") {
        const stderr = (inner as Record<string, unknown>).stderr;
        if (typeof stderr === "string") return stderr;
        return `${g.kind ?? "Git error"}: ${JSON.stringify(inner)}`;
      }
      return GIT_ERROR_LABELS[g.kind ?? ""] ?? g.kind ?? "Git error";
    }
    const details = typeof ae.details === "string" ? ae.details : JSON.stringify(ae.details);
    return `${ae.kind}: ${details}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Inner `GitError` kind for an `AppError`, if it is a `Git` variant (e.g.
 *  "AuthFailed", "PushRejected", "CommandFailed"). Lets the UI react to specific
 *  remote-op failures. Returns null for non-git errors. */
export function gitErrorKind(e: unknown): string | null {
  if (e && typeof e === "object" && "kind" in e) {
    const ae = e as AppError;
    if (ae.kind === "Git" && ae.details && typeof ae.details === "object" && "kind" in ae.details) {
      return (ae.details as { kind: string }).kind;
    }
  }
  return null;
}

// --- Line endings types (matches §H of DESIGN-v0.2.md) ---

export type ConfigScope = "local" | "global" | "system" | "unset";

export interface ConfigValue {
  value: string | null;
  source: ConfigScope;
}

export interface GitAttrRule {
  pattern: string;
  text: string | null;
  eol: string | null;
}

export interface LineEndingsView {
  autocrlf_local: ConfigValue;
  autocrlf_global: ConfigValue;
  autocrlf_system: ConfigValue;
  autocrlf_resolved: ConfigValue;
  eol_local: ConfigValue;
  eol_global: ConfigValue;
  eol_system: ConfigValue;
  eol_resolved: ConfigValue;
  gitattributes: GitAttrRule[];
  gitattributes_covers_all: boolean;
}

// --- Signing config types (matches src-tauri/src/commands/signing.rs) ---

/** A single git-config key resolved across all scopes. */
export interface ScopedConfig {
  local: ConfigValue;
  global: ConfigValue;
  system: ConfigValue;
  resolved: ConfigValue;
}

export interface SigningView {
  /** `commit.gpgsign` — whether commits are signed by default. */
  gpgsign: ScopedConfig;
  /** `gpg.format` — "openpgp" (default), "ssh", or "x509". */
  format: ScopedConfig;
  /** `user.signingkey` — key id (GPG) or key path / literal key (SSH). */
  signing_key: ScopedConfig;
  /** `gpg.ssh.allowedSignersFile` — required for SSH signatures to verify as trusted. */
  allowed_signers: ScopedConfig;
}

// --- Git identity profiles (matches state.rs GitProfile + commands/profiles.rs) ---

/** A named identity/signing/auth bundle. Field casing is camelCase (the Rust
 *  struct uses `rename_all = "camelCase"`). Each field: value = set on apply,
 *  null = unset that key. */
export interface GitProfile {
  id: string;
  name: string;
  userName: string | null;
  userEmail: string | null;
  gpgFormat: string | null;
  signingKey: string | null;
  commitGpgsign: string | null;
  allowedSignersFile: string | null;
  /** Path to the auth SSH key; synthesized into core.sshCommand. */
  authSshKey: string | null;
  /** HTTPS credential helper (e.g. "manager", "store", "osxkeychain"); written
   *  to local credential.helper. LeGit stores no secrets — the helper does. */
  credentialHelper: string | null;
}

export interface GitProfilesDoc {
  format: string;
  formatVersion: number;
  profiles: GitProfile[];
}

/** Live local value of each managed key (null = unset locally). */
export interface ManagedKeys {
  user_name: string | null;
  user_email: string | null;
  gpg_format: string | null;
  signing_key: string | null;
  commit_gpgsign: string | null;
  allowed_signers_file: string | null;
  /** Parsed key path from core.sshCommand (or raw command if unparseable). */
  auth_ssh_key: string | null;
  /** Live local `credential.helper` value. */
  credential_helper: string | null;
}

export interface KeyDiff {
  key: string;
  local: string | null;
  profile: string | null;
}

export type ProfileMatch =
  | { kind: "inherit" }
  | { kind: "active"; profile_id: string }
  | { kind: "drift"; profile_id: string; diffs: KeyDiff[] }
  | { kind: "unmanaged" };

export interface ProfileStatus {
  /** Live LOCAL value of each managed key (null = unset locally). */
  local: ManagedKeys;
  stored_profile_id: string | null;
  match: ProfileMatch;
}

/**
 * The identity git would use for a commit in a repo (resolved across all
 * scopes). Both null = a commit would fail with "Please tell me who you are".
 */
export interface ResolvedIdentity {
  user_name: string | null;
  user_email: string | null;
}

/**
 * user.name / user.email at global + system scope plus the resolved value
 * outside any repo (matches commands/identity.rs). Backs the edit-only
 * "Global identity" section.
 */
export interface IdentityView {
  name_global: ConfigValue;
  name_system: ConfigValue;
  name_resolved: ConfigValue;
  email_global: ConfigValue;
  email_system: ConfigValue;
  email_resolved: ConfigValue;
}

/**
 * credential.helper per scope (matches commands/credential_helper.rs).
 * The key is multi-valued and accumulates across scopes, so there is no
 * single "resolved" value; null = no helper configured at that scope.
 */
export interface CredentialHelperView {
  helper_global: string | null;
  helper_system: string | null;
}

/** A credential helper detected on this machine (matches credential_helper.rs). */
export interface AvailableHelper {
  /** The value to write into credential.helper (e.g. "manager"). */
  name: string;
  /** Where the executable was found. */
  path: string;
}

/** One SSH key pair on disk (matches commands/ssh_keys.rs). */
export interface SshKeyStatus {
  /** Absolute private-key path. */
  private_key_path: string;
  exists: boolean;
  /** Content of `<path>.pub`, when readable. */
  public_key: string | null;
}

/**
 * One connected platform account (matches state.rs ConnectedAccountMeta).
 * Metadata only: the token lives in the OS keychain.
 */
export interface ConnectedAccountMeta {
  /** Platform id: "github" | "gitlab" | "azure_devops". */
  platform: string;
  /** Git HTTPS host (also the keychain key host). */
  host: string;
  username: string;
  display_name: string | null;
}

/**
 * Account metadata plus live keychain presence: false = the token was erased
 * (e.g. git erased a revoked one) and the account needs reconnecting.
 */
export interface ConnectedAccountStatus {
  account: ConnectedAccountMeta;
  token_present: boolean;
}

/** Result of an `ssh -T git@<host>` authentication probe. */
export type SshTestOutcome =
  | { kind: "authenticated"; detail: string }
  | { kind: "rejected"; detail: string }
  | { kind: "cannot_connect"; detail: string }
  | { kind: "unknown"; detail: string };

// --- Git log / commit types (matches legit-core/src/types.rs) ---

export type CommitId = string;

/** Working-tree / index state of a single path (matches legit-core `FileState`). */
export type FileState =
  | "Modified"
  | "Added"
  | "Deleted"
  | "Renamed"
  | "Copied"
  | "Untracked"
  | "Ignored"
  | "Conflicted"
  | "SubmoduleChanged"
  /** Uncommitted changes INSIDE the submodule, pointer unmoved. Informational:
   * nothing is stageable from the superproject. */
  | "SubmoduleDirty";

/** A single changed path in the working tree (matches legit-core `FileStatus`). */
export interface FileStatus {
  path: string;
  state: FileState;
  /** True when the change is staged (in the index); false for working-tree-only changes. */
  staged: boolean;
  /**
   * Added lines for this entry's own diff (index diff when staged, worktree
   * diff when not). Null when git reports no counts for the path (untracked,
   * conflicted, binary) — distinct from a genuine 0.
   */
  additions: number | null;
  /** Removed lines; same semantics as `additions`. */
  deletions: number | null;
  /** True when git reports the file as binary (numstat `-`/`-`). */
  binary: boolean;
}

/** A file changed by a commit, vs its first parent (matches legit-core `CommitFileChange`). */
export interface CommitFileChange {
  /** Path after the change (destination path for renames/copies). */
  path: string;
  /** Source path for a rename/copy; null otherwise. */
  old_path: string | null;
  change: FileState;
  /** Added lines; 0 for binary files. */
  additions: number;
  /** Removed lines; 0 for binary files. */
  deletions: number;
  /** True when git reports the file as binary. */
  binary: boolean;
}

/** How git regards a file in the Files tree (matches legit-core `RepoFileKind`). */
export type RepoFileKind = "tracked" | "untracked" | "ignored";

/** A file in the repo-wide Files tree (matches legit-core `RepoFileEntry`). */
export interface RepoFileEntry {
  path: string;
  kind: RepoFileKind;
}

/** Line-ending style of a file/blob (matches legit-core `LineEndingKind`). */
export type LineEndingKind = "lf" | "crlf" | "cr" | "mixed" | "none" | "binary";

/** A line-ending change between two sides of a changed file (old -> new). */
export interface LineEndingTransition {
  from: LineEndingKind;
  to: LineEndingKind;
}

/** Line-ending summary for one changed file (`repo_line_ending_status`).
 * `unstaged` = index vs what `git add` would store (policy-aware);
 * `staged` = HEAD vs index (exactly what a commit records). */
export interface LineEndingStatusEntry {
  path: string;
  unstaged: LineEndingTransition | null;
  staged: LineEndingTransition | null;
  mixed: boolean;
  working_raw: LineEndingKind | null;
}

// --- diffs (mirror legit-core `Diff*` types; see bindings.ts) ---

export type DiffLineKind = "Context" | "Added" | "Removed";

export interface DiffLine {
  kind: DiffLineKind;
  content: string;
}

export interface DiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  /** The raw `@@ -.. +.. @@ <section>` header line, kept verbatim. */
  header: string;
  lines: DiffLine[];
}

export interface TextDiff {
  old_path: string | null;
  new_path: string | null;
  hunks: DiffHunk[];
}

export interface BinaryDiff {
  old_path: string | null;
  new_path: string | null;
  old_size: number | null;
  new_size: number | null;
}

export interface SubmoduleChange {
  path: string;
  old_sha: string | null;
  new_sha: string | null;
  /** Submodule worktree has uncommitted content (git's `-dirty` suffix). */
  dirty: boolean;
}

/** Orthogonal submodule state flags (mirrors SubmoduleState in types.rs). */
export interface SubmoduleState {
  initialized: boolean;
  populated: boolean;
  pointer_moved: boolean;
  dirty_tracked: boolean;
  dirty_untracked: boolean;
  conflicted: boolean;
  orphan_gitlink: boolean;
  config_drift: boolean;
}

/** Submodule entry (mirrors SubmoduleInfo in types.rs). */
export interface SubmoduleInfo {
  name: string;
  path: string;
  url: string | null;
  gitmodules_url: string | null;
  branch: string | null;
  recorded_sha: string | null;
  checked_out_sha: string | null;
  head_branch: string | null;
  state: SubmoduleState;
}

export interface SubmoduleLogEntry {
  id: string;
  subject: string;
}

export type SubmoduleLog =
  | { kind: "commits"; commits: SubmoduleLogEntry[] }
  | { kind: "target_missing" };

/** Options for `git submodule update` (mirrors SubmoduleUpdateOptions). */
export interface SubmoduleUpdateOptions {
  init: boolean;
  recursive: boolean;
  paths: string[];
}

/** Integration mode for `submodule update --remote`. */
export type SubmoduleUpdateStrategy = "checkout" | "rebase" | "merge";

/** Retained gitdir of a removed submodule. */
export interface SubmoduleGitdirInfo {
  path: string;
  /** Local commits on no remote - deleting the gitdir destroys them. */
  unpushed: boolean;
}

/** Per-submodule outcome of the post-switch/pull auto-update. */
export type SubmoduleAutoUpdateStatus =
  | { kind: "updated" }
  | { kind: "changes_carried" }
  | { kind: "changes_stashed" }
  | { kind: "rolled_back"; message: string }
  | { kind: "changes_in_stash"; message: string }
  | { kind: "skipped"; message: string };

export interface SubmoduleAutoUpdateResult {
  path: string;
  status: SubmoduleAutoUpdateStatus;
}

export type DiffEntry =
  | { Text: TextDiff }
  | { Binary: BinaryDiff }
  | { Submodule: SubmoduleChange };

/** A file's content at a revision: text, or a binary classification with the
 * blob's exact byte size (mirrors `FileAtRevision` in types.rs). */
export type FileAtRevision = { Text: string } | { Binary: { size_bytes: number } };

/** One commit in a single file's history (mirrors `FileHistoryEntry` in
 * types.rs). `path` is the file's name AS OF THAT COMMIT (pre-rename commits
 * carry the old name); `old_path` is set only on the renaming commit. */
export interface FileHistoryEntry {
  commit_id: string;
  summary: string;
  author: string;
  /** Author date, unix seconds. */
  timestamp: number;
  path: string;
  old_path: string | null;
}

/** Which two sides the Diff panel compares for a file (matches `DiffSource`). */
export type DiffSource =
  | { kind: "working_unstaged" }
  | { kind: "working_staged" }
  | { kind: "commit"; commit_id: string }
  /** Two arbitrary revs (Compare view) — any rev spec works. */
  | { kind: "commit_range"; from: string; to: string };

/** What a commit search matches (matches legit-core `CommitSearchKind`). */
export type CommitSearchKind = "message" | "author" | "content" | "content_regex";

/** One blame hunk (matches legit-core `BlameHunk`): consecutive lines last
 *  touched by the same commit, contents included. All-zeros sha = uncommitted. */
export interface BlameHunk {
  sha: CommitId;
  author: string;
  timestamp: number;
  summary: string;
  /** 1-based first line number. */
  start_line: number;
  lines: string[];
  /** Whether a parent version of the file exists (git porcelain `previous`) —
   *  false for the commit that added the file, so "blame parent" is hidden. */
  has_previous: boolean;
  /** The `previous` header's parent commit — the right rev to re-blame at
   *  (correct parent for merges, unlike `<sha>^`). */
  previous_sha: CommitId | null;
  /** The file's path AT `previous_sha` — the OLD name when the blamed commit
   *  renamed the file; re-blaming must use this path. */
  previous_path: string | null;
}

/** Summon payload delivered to the Diff panel when a file is selected. */
export interface DiffRequest {
  repoId: string;
  path: string;
  source: DiffSource;
  /** Change kind, when known — used to short-circuit renames (no content diff). */
  change?: FileState;
  /** Original path for a rename/copy, when known. */
  oldPath?: string | null;
}

export type RefDecoration =
  | { type: "head" }
  | { type: "headOf"; value: string }
  | { type: "branch"; value: string }
  | { type: "tag"; value: string }
  | { type: "remote"; value: string }
  | { type: "stash"; value: string }
  | { type: "other"; value: string };

export type LaneLock = { refName: string; laneIndex: number };

/** A local or remote-tracking branch (matches legit-core `Branch`). */
export interface Branch {
  name: string;
  is_current: boolean;
  is_remote: boolean;
  /** Full upstream ref (e.g. "refs/remotes/origin/dev") for local branches. */
  upstream: string | null;
  head: CommitId | null;
  /** Commits ahead of the upstream; null when in sync / no upstream / remote branch. */
  ahead: number | null;
  /** Commits behind the upstream; null under the same conditions. */
  behind: number | null;
  /** The configured upstream ref no longer exists ("[gone]"). */
  upstream_gone: boolean;
}

export type SwitchOutcome =
  | { kind: "clean" }
  /** `stash_and_keep`: the uncommitted changes were deliberately left parked
   *  in the stash; the target branch starts clean. */
  | { kind: "changes_stashed" }
  /** Auto-stash reapplied but with merge conflicts — changes are in the
   *  working tree with conflict markers; the stash entry was kept. */
  | { kind: "stash_pop_conflicts"; message: string }
  /** Auto-stash could not be applied at all — the changes remain parked in
   *  the stash entry. */
  | { kind: "stash_pop_failed"; message: string };

export type SwitchDirtyBehavior = "try_directly" | "auto_stash" | "stash_and_keep";

/** Fast-forward behavior for a merge (matches legit-core `FfMode`). */
export type FfMode = "auto" | "no_ff" | "ff_only";

export interface MergeOptions {
  ff: FfMode;
  /** `--squash`: stages the result without committing; `ff` is ignored. */
  squash: boolean;
}

/** Outcome of merge/merge-continue. Conflicts are data, not an error. */
export type MergeOutcome =
  | { kind: "fast_forwarded" }
  | { kind: "merged" }
  | { kind: "squashed" }
  | { kind: "already_up_to_date" }
  | { kind: "conflicts"; message: string };

export type RebaseOutcome =
  | { kind: "completed" }
  | { kind: "already_up_to_date" }
  | { kind: "conflicts"; message: string }
  /** Rebase finished, but reapplying the autostash conflicted (stash kept). */
  | { kind: "completed_with_stash_conflicts"; message: string };

/** Mode for `git reset` (matches legit-core `ResetMode`). Hard is destructive. */
export type ResetMode = "soft" | "mixed" | "hard";

/** One interactive-rebase step (matches legit-core `RebaseStep`). Slice order
 *  is the new commit order, oldest first — git's todo order. */
export type RebaseStep =
  | { action: "pick"; sha: CommitId }
  | { action: "squash"; sha: CommitId }
  | { action: "fixup"; sha: CommitId }
  | { action: "drop"; sha: CommitId };

export type RebaseAction = RebaseStep["action"];

/** Index stages of a conflicted path (matches `ConflictFileSides`); a side is
 *  null when that stage is absent (add/add, delete conflicts). */
export interface ConflictFileSides {
  base: string | null;
  ours: string | null;
  theirs: string | null;
}

/** Outcome of revert / cherry-pick and their continue/skip (matches
 *  `SequenceOutcome`). Conflicts pause the sequencer — data, not an error. */
export type SequenceOutcome =
  | { kind: "completed" }
  | { kind: "conflicts"; message: string };

/** One HEAD reflog entry (matches legit-core `ReflogEntry`). */
export interface ReflogEntry {
  /** Positional selector, e.g. `HEAD@{0}` — display-only, shifts constantly. */
  selector: string;
  sha: CommitId;
  /** Action prefix, e.g. "commit", "reset", "checkout", "rebase (finish)". */
  action: string;
  /** Subject after the action prefix. */
  subject: string;
  /** Unix seconds. */
  timestamp: number;
}

/** Which multi-step operation the repo is in (matches `RepoOpState`). */
export type RepoOpState =
  | { kind: "none" }
  | { kind: "merge"; branch: string | null; message: string | null }
  | {
      kind: "rebase";
      onto: string | null;
      head_name: string | null;
      current_step: number | null;
      total_steps: number | null;
    }
  | { kind: "cherry_pick"; sha: string }
  | { kind: "revert"; sha: string };

export type ConflictKind = "both_modified" | "both_added" | "deleted_by_us" | "deleted_by_them";

/** A conflicted path and how it conflicts (matches `ConflictEntry`). */
export interface ConflictEntry {
  path: string;
  kind: ConflictKind;
}

export type ConflictSide = "ours" | "theirs";

/** A local tag (matches legit-core `TagInfo`). */
export interface TagInfo {
  /** Short tag name (no refs/tags/ prefix). */
  name: string;
  /** The commit the tag points at (peeled for annotated tags). */
  target_sha: CommitId;
  /** Annotated (tag object) vs lightweight. */
  annotated: boolean;
  /** Annotation subject line (annotated tags only). */
  message: string | null;
  /** The tagged commit is reachable from a remote-tracking ref; pushing a
   *  tag whose commit is not on the remote is disabled (push branch first). */
  target_on_remote: boolean;
}

/** A tag as it exists on a remote (matches legit-core `RemoteTag`). */
export interface RemoteTag {
  name: string;
  target_sha: CommitId;
}

/** A single entry from `git stash list` (matches legit-core `StashEntry`). */
export interface StashEntry {
  /** The `N` in `stash@{N}` (0 is the most recent). */
  index: number;
  /** Reflog selector, e.g. "stash@{0}". Display-only — it is positional and
   * shifts as stashes are added/removed; actions address the stash by
   * `stash_sha` instead. */
  selector: string;
  /** Reflog subject, e.g. "On main: my message". */
  message: string;
  /** The stash's own commit SHA (a real git object, usable as a commit id).
   * This is the stable handle for apply/pop/drop/rename. */
  stash_sha: CommitId;
  /** The base commit the stash was created from (its first parent). */
  base_sha: CommitId;
  author: Signature;
  /** Author timestamp (Unix seconds). */
  timestamp: number;
}

export type StashOutcome = { kind: "created" } | { kind: "nothing_to_stash" };

export type StashApplyOutcome =
  | { kind: "clean" }
  | { kind: "conflicts"; message: string };

export interface Signature {
  name: string;
  email: string;
  timestamp: number; // Unix seconds UTC
  tz_offset_minutes: number;
}

// --- remote sync (matches legit-core/src/types.rs) ---

export interface FetchOptions {
  /** Fetch from all remotes (--all) rather than `remote`. */
  all: boolean;
  /** Prune deleted remote-tracking refs (--prune). */
  prune: boolean;
  /** Remote to fetch when `all` is false; ignored when `all` is true. */
  remote: string | null;
}

/** How `git pull` integrates fetched changes (serialized variant names). */
export type PullStrategy = "Default" | "Rebase" | "Merge" | "FfOnly";

export interface PullOptions {
  strategy: PullStrategy;
}

export interface PushOptions {
  remote: string;
  branch: string;
  /** Set the pushed branch as upstream (--set-upstream) — publish a new branch. */
  set_upstream: boolean;
  /** Force-push without clobbering unseen remote commits (--force-with-lease). */
  force_with_lease: boolean;
  /** Submodule guard (--recurse-submodules=check|on-demand); null = no flag. */
  recurse_submodules?: PushRecurseMode | null;
}

/** `git push --recurse-submodules` guard mode (mirrors PushRecurseMode). */
export type PushRecurseMode = "check" | "on_demand";

/** Ahead/behind of the current branch vs its upstream (null = detached / no upstream). */
export interface TrackingStatus {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
}

/** A configured git remote with its fetch/push URLs (matches legit-core `Remote`). */
export interface Remote {
  name: string;
  fetch_url: string;
  push_url: string;
}

/** One parsed `--progress` meter update (matches legit-core `RemoteProgress`). */
export interface RemoteProgress {
  /** Phase label as git prints it, e.g. "Receiving objects". */
  phase: string;
  /** 0-100 when the phase reports a percentage. */
  percent: number | null;
}

/** Payload of the `legit://remote-progress` event (src-tauri/src/lib.rs). */
export interface RemoteProgressPayload {
  op_id: string;
  progress: RemoteProgress;
}

export type SignatureStatus =
  | "Good"
  | "BadSignature"
  | "UnknownKey"
  | "Untrusted"
  | "Expired"
  | "Revoked"
  | "NoSignature";

export interface SignatureVerification {
  status: SignatureStatus;
  signer: string | null;
  key_id: string | null;
  raw: string | null;
}

export interface Commit {
  id: CommitId;
  parents: CommitId[];
  author: Signature;
  committer: Signature;
  message: string;
  timestamp: number;
  signature: SignatureVerification | null;
  /** Presence-only: the raw object carries a signature header. NOT a
   *  verification result (that stays on-demand in commit details). */
  has_signature: boolean;
  decorations?: RefDecoration[];
}

export interface CommitDetails {
  commit: Commit;
  raw_object: string;
}

// --- Theme document shape (matches DESIGN.md §6.3) ---

/** Derived-colour filter applied to a token's palette reference. */
export type TokenFilterId =
  | "lighter-soft"
  | "lighter"
  | "darker-soft"
  | "darker"
  | "faded"
  | "subtle";

/**
 * A token's binding: either a bare palette name (no filter — the classic
 * form, kept for backward compatibility) or a palette reference plus a
 * filter deriving a variant colour (e.g. the hover shade of a button).
 */
export type ThemeTokenBinding = string | { ref: string; filter: TokenFilterId };

export interface ThemeDocument {
  $schema?: string;
  format: "legit-theme";
  formatVersion: number;
  name: string;
  author?: string;
  description?: string;
  palette: Record<string, string>;
  tokens: Record<string, ThemeTokenBinding>;
}

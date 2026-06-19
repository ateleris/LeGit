// Hand-written mirror of the Rust types that cross the Tauri IPC boundary.
//
// Kept in sync with `crates/legit-core/src/types.rs`,
// `src-tauri/src/state.rs`, `src-tauri/src/error.rs`, and the command
// modules. The specta-generated `bindings.ts` (debug builds) is the
// authoritative source long-term; this file exists so the frontend
// compiles before the first cargo build.

export type RepoId = string;

export interface RepoSummary {
  id: RepoId;
  path: string;
  name: string;
}

export type RegionPlacement = "top" | "left";

export interface GlobalSettings {
  git_path_override: string | null;
  last_open_repos: string[];
  currently_open: string[];
  active_open_repo: string | null;
  active_theme: string | null;
  global_dock_layout: unknown | null;
  repo_dock_layout: unknown | null;
  global_region_placement: RegionPlacement;
  global_region_size_top: number | null;
  global_region_size_left: number | null;
  global_dock_collapsed: boolean;
  warn_on_mixed_endings: boolean;
  column_preferences?: unknown;
  commits_row_height: number;
  commits_lane_width: number;
  commits_dot_radius: number;
  commits_line_width: number;
  commits_text_size: number;
  /** Remembered Changed Files panel view mode ("tree" | "flat"). */
  changed_files_view_mode?: string | null;
  /** Global UI font size (px) — base for the panel text scale and min sizes. */
  ui_font_size?: number;
  /** Whether the filesystem watcher auto-refreshes the UI on disk changes. */
  watcher_enabled?: boolean;
  /** Whether discarding changes asks for confirmation first (default true). */
  confirm_discard?: boolean;
  /** User-defined git identity profiles (camelCase key — serde rename). */
  gitProfiles?: GitProfilesDoc;
}

export interface RepoSettings {
  git_path_override: string | null;
  warn_on_mixed_endings: boolean | null;
  /** Selected git profile id (null = none / inherit). Intent hint only. */
  git_profile_id?: string | null;
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
 *  suffixes `[repoId, "status"|"log"|"branches"]` and the Rust `ChangeDomain`
 *  enum in `src-tauri/src/watcher.rs`. */
export type ChangeDomain = "status" | "log" | "branches";

/** Payload of the `legit://repo-changed` event emitted by the FS watcher. */
export interface RepoChangedPayload {
  repo_id: string;
  domains: ChangeDomain[];
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
  | { kind: "OperationNotFound"; details: string };

/** Construct a short message suitable for display, regardless of variant. */
export function formatAppError(e: unknown): string {
  if (e && typeof e === "object" && "kind" in e) {
    const ae = e as AppError;
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
  mixed_ending_files: string[];
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
  local: ManagedKeys;
  stored_profile_id: string | null;
  match: ProfileMatch;
}

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
  | "SubmoduleChanged";

/** A single changed path in the working tree (matches legit-core `FileStatus`). */
export interface FileStatus {
  path: string;
  state: FileState;
  /** True when the change is staged (in the index); false for working-tree-only changes. */
  staged: boolean;
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
}

export type DiffEntry =
  | { Text: TextDiff }
  | { Binary: BinaryDiff }
  | { Submodule: SubmoduleChange };

/** Which two sides the Diff panel compares for a file (matches `DiffSource`). */
export type DiffSource =
  | { kind: "working_unstaged" }
  | { kind: "working_staged" }
  | { kind: "commit"; commit_id: string };

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
}

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
}

/** Ahead/behind of the current branch vs its upstream (null = detached / no upstream). */
export interface TrackingStatus {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
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
  decorations?: RefDecoration[];
}

export interface CommitDetails {
  commit: Commit;
  raw_object: string;
}

// --- Theme document shape (matches DESIGN.md §6.3) ---

export interface ThemeDocument {
  $schema?: string;
  format: "legit-theme";
  formatVersion: number;
  name: string;
  author?: string;
  description?: string;
  palette: Record<string, string>;
  tokens: Record<string, string>;
}

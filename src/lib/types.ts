// Types crossing the Tauri IPC boundary are re-exported from the GENERATED
// bindings (`src/lib/bindings.ts`, kept fresh by `cargo test -p legit-app
// bindings`; regenerate with `LEGIT_UPDATE_BINDINGS=1`). Only frontend-owned
// types (summon payloads, frontend-owned JSON schemas) are defined here.

export type {
  AppError,
  AskpassPromptKind,
  AskpassRequestPayload,
  AvailableHelper,
  BinaryDiff,
  BlameHunk,
  Branch,
  BranchMergeAnalysis,
  CaseDriftEntry,
  ChangeDomain,
  CloneOutcome,
  Commit,
  CommitButtonMode,
  CommitDetails,
  CommitFileChange,
  CommitId,
  CommitSearchKind,
  ConfigScope,
  ConfigValue,
  ConflictEntry,
  ConflictFileSides,
  ConflictKind,
  ConflictSide,
  ConnectedAccountMeta,
  ConnectedAccountStatus,
  ConsoleEventPayload,
  ConsoleExecHandle,
  CredentialClosedPayload,
  CredentialHelperView,
  CredentialRequestPayload,
  DiffEntry,
  DiffHunk,
  DiffLine,
  DiffLineKind,
  DiffSource,
  FastForwardResult,
  FetchOptions,
  FfMode,
  FileAtRevision,
  FileHistoryEntry,
  FilePreview,
  FileState,
  FileStatus,
  GitAttrRule,
  GitError,
  GitInvocation,
  GitProfile,
  GitProfilesDoc,
  GitStatus,
  GitVersion,
  GitmodulesFinding,
  GlobalSettings,
  HostRef,
  IdentityView,
  ImageFormat,
  JsonValue,
  KeyDiff,
  KeybindingsFile,
  LaneLock,
  LaneLocksDoc,
  LayoutEntry,
  LfsPatternsView,
  LfsStatus,
  LfsStubs,
  LineEndingKind,
  LineEndingStatusEntry,
  LineEndingTransition,
  LineEndingsView,
  ManagedConfigView,
  ManagedKeys,
  MergeOptions,
  MergeOutcome,
  ProfileMatch,
  ProfileStatus,
  PullOptions,
  PullOutcome,
  PullStrategy,
  PushOptions,
  PushRecurseMode,
  RebaseAction,
  RebaseOutcome,
  RebaseRangeInfo,
  RebaseStep,
  RefDecoration,
  ReflogEntry,
  RegionPlacement,
  Remote,
  RemoteCheckoutOutcome,
  RemoteHostGitPayload,
  RemoteHostStatusPayload,
  RemoteProgress,
  RemoteProgressPayload,
  RemoteTag,
  RenormalizeOutcome,
  RenormalizePreview,
  RepoChangedPayload,
  RepoFileEntry,
  RepoFileKind,
  RepoOpState,
  RepoSettings,
  RepoSummary,
  ResetMode,
  ResolvedIdentity,
  RestoreResult,
  ScopedConfig,
  SequenceOutcome,
  Signature,
  SignatureStatus,
  SignatureVerification,
  SigningView,
  SshKeyStatus,
  SshTestOutcome,
  StashApplyOutcome,
  StashEntry,
  StashOutcome,
  SubmoduleAutoUpdateResult,
  SubmoduleAutoUpdateStatus,
  SubmoduleChange,
  SubmoduleGitdirInfo,
  SubmoduleInfo,
  SubmoduleLog,
  SubmoduleLogEntry,
  SubmoduleState,
  SubmoduleUpdateOptions,
  SubmoduleUpdateStrategy,
  SwitchDirtyBehavior,
  SwitchOutcome,
  SwitchResult,
  TagInfo,
  TextDiff,
  ThemeEntry,
  ThemeSource,
  TrackingStatus,
  WatchStatePayload,
  WorktreeAddMode,
  WorktreeInfo,
  WslDistro,
} from "./bindings";

import type { DiffSource, FileState, RepoSettings } from "./bindings";

export type RepoId = string;

/** Fields a `patch_repo_settings` call may change; the rest are owned by
 *  their own commands (lane locks, profile selection, the probed git path)
 *  and the backend refuses them in a patch. */
export type RepoSettingsPatch = Partial<
  Omit<RepoSettings, "laneLocks" | "git_profile_id" | "git_path_override">
>;

/** A saved panel layout (`.legit-layout.json`): a named snapshot of both
 *  docks. `global` is the global dock's plain dockview JSON; `repo` is the
 *  repo dock's envelope ({ dockview, placements, fallbacks }). Either may be
 *  null when that dock had nothing to capture, never both. */
export interface LayoutDocument {
  format: "legit-layout";
  formatVersion: number;
  name: string;
  global: unknown;
  repo: unknown;
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

// --- Theme document shape (matches DESIGN.md §6.3) ---

/** Derived-colour filter applied to a token's palette reference. */
export type TokenFilterId =
  | "lighter-soft"
  | "lighter"
  | "lighter-strong"
  | "darker-soft"
  | "darker"
  | "darker-strong"
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
  /** @deprecated Inert: lane-coloured chips are a GLOBAL setting
   * (`lane_colored_branch_chips`), no longer per-theme. Still accepted and
   * preserved so older theme files round-trip unchanged. */
  laneColoredBranchChips?: boolean;
  /** Per-part filters applied to the LANE colour while
   * `laneColoredBranchChips` is on; a null/absent part uses the raw lane
   * colour. Defaults (fg raw, border Faded, bg Subtle) mirror the static
   * chips' alpha recipe in the lane's hue. */
  laneChipFilters?: {
    fg?: TokenFilterId | null;
    border?: TokenFilterId | null;
    bg?: TokenFilterId | null;
  };
  /** @deprecated Inert: stash-base lane colouring is a GLOBAL setting
   * (`stash_base_lane_color`), no longer per-theme. Still accepted and
   * preserved so older theme files round-trip unchanged. */
  stashBaseLaneColor?: boolean;
  /** Per-panel rebindings of the surface tokens in PANEL_OVERRIDE_TOKENS,
   * keyed by panel id (see panels/descriptors). Optional and additive:
   * absent = no overrides; tokens outside the allowlist and malformed panel
   * ids are preserved but never applied. */
  panelOverrides?: Record<string, Record<string, ThemeTokenBinding>>;
}

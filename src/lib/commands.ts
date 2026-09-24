// The backend command surface. `api` exposes every specta-generated command
// (src/lib/bindings.ts), unwrapped to resolve/reject like a raw `invoke`.
// Components never `invoke` raw, and hand-written wrappers exist only where
// they add value: argument defaults, the scope-pinned git-config command
// maps, and typed seams for frontend-owned JSON document schemas.

import { invoke } from "@tauri-apps/api/core";
import type { CommitDateFormat } from "./time";
import type {
  AvailableHelper,
  BlameHunk,
  Branch,
  CloneOutcome,
  Commit,
  ConsoleExecHandle,
  CredentialHelperView,
  FileHistoryEntry,
  IdentityView,
  LayoutDocument,
  LayoutEntry,
  LineEndingKind,
  LineEndingsView,
  RepoSummary,
  SequenceOutcome,
  SigningView,
  ThemeDocument,
  ThemeEntry,
} from "./types";


import { commands } from "./bindings";
import type { AppError, Result } from "./bindings";

const isResult = (v: unknown): v is Result<unknown, AppError> =>
  !!v &&
  typeof v === "object" &&
  "status" in v &&
  ((v as { status: unknown }).status === "ok"
    ? "data" in v
    : (v as { status: unknown }).status === "error" && "error" in v);

/** Resolve with a generated command's payload; reject with the backend
 * `AppError` (what `formatAppError` expects), matching the raw-`invoke`
 * behavior of the hand wrappers below. Non-Result commands pass through. */
async function unwrap<T>(p: Promise<T | Result<T, AppError>>): Promise<T> {
  const r = await p;
  if (isResult(r)) {
    if (r.status === "ok") return r.data as T;
    throw r.error;
  }
  return r as T;
}

type UnwrappedFn<F> = F extends (...args: infer A) => Promise<Result<infer T, AppError>>
  ? (...args: A) => Promise<T>
  : F;

/** Every generated command, unwrapped - `api.<command>` is the default way to
 * call the backend. The hand-written wrappers below exist only where they add
 * value (argument defaults, the scope-pinned git-config command maps). */
export const api = Object.fromEntries(
  Object.entries(commands).map(([name, fn]) => [
    name,
    (...args: unknown[]) =>
      unwrap((fn as (...a: unknown[]) => Promise<unknown>)(...args) as Promise<unknown>),
  ]),
) as { [K in keyof typeof commands]: UnwrappedFn<(typeof commands)[K]> };

// --- repo ---



// Git configuration INSIDE a WSL distribution — the `Git (WSL)` settings
// group. A deliberately separate command surface from the `global_*` ones (see
// src-tauri/src/commands/settings_host.rs): there is no argument by which one
// of these could write the app machine's config. Every call CONNECTS to the
// distro, starting it if stopped, so they only run on explicit user action.
//
// The two name maps below are the single source for the wrapper functions AND
// for the isolation test (`gitConfigHost.test.ts`), which pins that the key
// sets match while the command names stay disjoint — a WSL form can never
// reach a `global_*` command.

export const GLOBAL_GIT_CONFIG_COMMANDS = {
  identityView: "global_identity_view",
  writeIdentity: "global_write_identity",
  signingConfig: "global_signing_config",
  writeSigning: "global_write_signing",
  credentialHelperView: "global_credential_helper_view",
  writeCredentialHelper: "global_write_credential_helper",
  availableHelpers: "list_available_credential_helpers",
  lineEndingsView: "global_line_endings_view",
  writeLineEndings: "global_write_line_endings",
} as const;

export const WSL_GIT_CONFIG_COMMANDS = {
  identityView: "wsl_identity_view",
  writeIdentity: "wsl_write_identity",
  signingConfig: "wsl_signing_config",
  writeSigning: "wsl_write_signing",
  credentialHelperView: "wsl_credential_helper_view",
  writeCredentialHelper: "wsl_write_credential_helper",
  availableHelpers: "wsl_available_credential_helpers",
  lineEndingsView: "wsl_line_endings_view",
  writeLineEndings: "wsl_write_line_endings",
} as const;

export const wslIdentityView = (distro: string) =>
  invoke<IdentityView>(WSL_GIT_CONFIG_COMMANDS.identityView, { distro });

export const wslWriteIdentity = (
  distro: string,
  name: string | null,
  email: string | null
) => invoke<IdentityView>(WSL_GIT_CONFIG_COMMANDS.writeIdentity, { distro, name, email });

export const wslSigningConfig = (distro: string) =>
  invoke<SigningView>(WSL_GIT_CONFIG_COMMANDS.signingConfig, { distro });

export const wslWriteSigning = (
  distro: string,
  gpgsign: string | null,
  format: string | null,
  signingKey: string | null,
  allowedSigners: string | null
) =>
  invoke<SigningView>(WSL_GIT_CONFIG_COMMANDS.writeSigning, {
    distro,
    gpgsign,
    format,
    signingKey,
    allowedSigners,
  });

export const wslCredentialHelperView = (distro: string) =>
  invoke<CredentialHelperView>(WSL_GIT_CONFIG_COMMANDS.credentialHelperView, { distro });

export const wslWriteCredentialHelper = (distro: string, helper: string | null) =>
  invoke<CredentialHelperView>(WSL_GIT_CONFIG_COMMANDS.writeCredentialHelper, { distro, helper });

/** Helpers installed INSIDE the distro (never Windows' manager/wincred). */
export const wslAvailableCredentialHelpers = (distro: string) =>
  invoke<AvailableHelper[]>(WSL_GIT_CONFIG_COMMANDS.availableHelpers, { distro });

export const wslLineEndingsView = (distro: string) =>
  invoke<LineEndingsView>(WSL_GIT_CONFIG_COMMANDS.lineEndingsView, { distro });

export const wslWriteLineEndings = (
  distro: string,
  autocrlf: string | null,
  eol: string | null
) => invoke<LineEndingsView>(WSL_GIT_CONFIG_COMMANDS.writeLineEndings, { distro, autocrlf, eol });







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
  invoke<CloneOutcome>("repo_clone", {
    url,
    parentDir,
    name,
    profileId,
    opId,
    depth: options.depth ?? null,
    branch: options.branch ?? null,
    recurseSubmodules: options.recurseSubmodules ?? false,
  });




// --- console ---

export const consoleExec = (repoId: string, command: string, initialCredit?: number) =>
  invoke<ConsoleExecHandle>("console_exec", { repoId, command, initialCredit });



// --- in-app git credential prompt ---





// --- git setup ---




// --- repo settings ---



// --- persistence ---








// --- themes ---





// --- layouts ---







// --- keybindings ---



// --- line endings ---


export const globalLineEndingsView = () =>
  invoke<LineEndingsView>(GLOBAL_GIT_CONFIG_COMMANDS.lineEndingsView);


export const globalWriteLineEndings = (
  autocrlf: string | null,
  eol: string | null
) => invoke<LineEndingsView>(GLOBAL_GIT_CONFIG_COMMANDS.writeLineEndings, { autocrlf, eol });




// --- commit signing ---

export const globalSigningConfig = () =>
  invoke<SigningView>(GLOBAL_GIT_CONFIG_COMMANDS.signingConfig);

export const globalWriteSigning = (
  gpgsign: string | null,
  format: string | null,
  signingKey: string | null,
  allowedSigners: string | null
) =>
  invoke<SigningView>(GLOBAL_GIT_CONFIG_COMMANDS.writeSigning, {
    gpgsign,
    format,
    signingKey,
    allowedSigners,
  });

// --- git identity profiles ---













// Global identity (user.name / user.email in ~/.gitconfig): edit-only mirror,
// never a profile apply. Auth/signing bundles stay per-repo via profiles.

export const globalIdentityView = () =>
  invoke<IdentityView>(GLOBAL_GIT_CONFIG_COMMANDS.identityView);

export const globalWriteIdentity = (name: string | null, email: string | null) =>
  invoke<IdentityView>(GLOBAL_GIT_CONFIG_COMMANDS.writeIdentity, { name, email });


export const globalCredentialHelperView = () =>
  invoke<CredentialHelperView>(GLOBAL_GIT_CONFIG_COMMANDS.credentialHelperView);

export const globalWriteCredentialHelper = (helper: string | null) =>
  invoke<CredentialHelperView>(GLOBAL_GIT_CONFIG_COMMANDS.writeCredentialHelper, { helper });

export const listAvailableCredentialHelpers = () =>
  invoke<AvailableHelper[]>(GLOBAL_GIT_CONFIG_COMMANDS.availableHelpers);

// SSH key management (phase 1 of the platform integrations).






// Connected platform accounts (PAT-based; tokens live in the OS keychain).






// --- log / commit details ---

export const repoLog = (
  repoId: string,
  maxCount?: number,
  skip?: number,
  revisionRange?: string,
  includeRemotes?: boolean,
  author?: string,
  includeStashes?: boolean,
) =>
  invoke<Commit[]>("repo_log", {
    repoId,
    maxCount: maxCount ?? null,
    skip: skip ?? null,
    revisionRange: revisionRange ?? null,
    includeRemotes: includeRemotes ?? null,
    author: author ?? null,
    includeStashes: includeStashes ?? null,
  });




// --- inspection: compare / search / blame ---
















/** Line-ending style of a file side. `rev`: null = working tree, ":" = index,
 *  else a rev spec (sha / HEAD / <sha>^ / branch). */
export const repoLineEndingKind = (repoId: string, path: string, rev?: string | null) =>
  invoke<LineEndingKind>("repo_line_ending_kind", { repoId, path, rev: rev ?? null });



/** Blame `path` - at `rev` when given, else the working tree. */
export const repoBlame = (repoId: string, path: string, rev?: string | null) =>
  invoke<BlameHunk[]>("repo_blame", { repoId, path, rev: rev ?? null });



/** A single file's commit history (newest first), following renames.
 *  `startRev` walks from that revision instead of HEAD (browse-at-commit). */
export const repoFileHistory = (
  repoId: string,
  path: string,
  maxCount: number,
  skip: number,
  startRev?: string,
) =>
  invoke<FileHistoryEntry[]>("repo_file_history", {
    repoId,
    path,
    maxCount,
    skip,
    startRev: startRev ?? null,
  });



// --- diffs ---








// --- working-tree write operations ---






// --- merge / rebase / op-state ---









/** Pushed-set + ancestry probe for the interactive-rebase panel. */



// --- undo & history rewriting ---


/** One git invocation, applied in the given order (pass newest-first for a
 *  clean unwind). `mainline` (1-based parent number) is required for merge
 *  commits (`-m N`) - single-sha calls only. */
export const repoRevert = (repoId: string, shas: string[], mainline?: number) =>
  invoke<SequenceOutcome>("repo_revert", { repoId, shas, mainline: mainline ?? null });

/** One git invocation, applied in the given order (pass oldest-first).
 *  `mainline` (1-based parent number) is required for merge commits (`-m N`)
 *  - single-sha calls only. */
export const repoCherryPick = (repoId: string, shas: string[], mainline?: number) =>
  invoke<SequenceOutcome>("repo_cherry_pick", { repoId, shas, mainline: mainline ?? null });















export const repoCommit = (repoId: string, message: string, amend = false) =>
  invoke<string>("repo_commit", { repoId, message, amend });











/// Reword (rename) a commit's message; returns the new commit id. v1 rewords
/// HEAD only and refuses commits already pushed to a remote.


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








// --- submodules ---

















// --- tags ---







// --- stashes ---




// Stash mutations address the stash by its commit SHA (stable), not the
// positional `stash@{N}` selector (which shifts on every create/drop/pop,
// including ones made outside the app). The backend resolves the SHA to the
// current selector at action time, so a stale UI can never hit the wrong stash.






// --- remote sync (fetch / pull / push) ---
//
// fetch/pull/push take a frontend-generated `opId` so the op can be cancelled
// via `consoleCancel(repoId, opId)` while it runs. Auth is driven by the repo's
// local git config (the active profile's SSH command + credential helper).






// --- remote management ---







// --- lane locks ---




// --- logging / crash capture ---




// --- typed seams for frontend-owned JSON document schemas ---
// The backend stores these opaquely (serde_json::Value); the real shapes
// (ThemeDocument / LayoutDocument) are defined in types.ts, so the generated
// JsonValue signatures would lose the typing.

export const loadTheme = (name: string) =>
  invoke<ThemeDocument>("load_theme", { name });

export const saveTheme = (name: string, contents: ThemeDocument) =>
  invoke<ThemeEntry>("save_theme", { name, contents });

export const loadLayout = (name: string) =>
  invoke<LayoutDocument>("load_layout", { name });

export const saveLayout = (name: string, contents: LayoutDocument) =>
  invoke<LayoutEntry>("save_layout", { name, contents });

export const listThemes = () => invoke<ThemeEntry[]>("list_themes");

export const deleteTheme = (name: string) =>
  invoke<null>("delete_theme", { name });

export const setActiveTheme = (name: string) =>
  invoke<null>("set_active_theme", { name });

export const listLayouts = () => invoke<LayoutEntry[]>("list_layouts");

export const renameLayout = (oldName: string, newName: string) =>
  invoke<LayoutEntry>("rename_layout", { oldName, newName });

export const deleteLayout = (name: string) =>
  invoke<null>("delete_layout", { name });

export const setLayoutsOrder = (order: string[]) =>
  invoke<null>("set_layouts_order", { order });

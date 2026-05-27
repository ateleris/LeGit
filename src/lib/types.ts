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
}

export interface RepoSettings {
  git_path_override: string | null;
  warn_on_mixed_endings: boolean | null;
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

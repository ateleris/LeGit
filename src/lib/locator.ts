// Repo locator strings — the TS mirror of `src-tauri/src/remote/locator.rs`.
//
// A LOCAL repo's locator is its bare filesystem path (existing recents parse
// unchanged); a WSL repo's is `wsl://<distro>/<absolute posix path>`. Keep the
// parse/format rules in lockstep with the Rust side.

import type { HostRef } from "./types";

const WSL_SCHEME = "wsl://";

export interface ParsedLocator {
  host: HostRef | null;
  /** The path as the repo's host sees it. */
  path: string;
}

export function parseLocator(s: string): ParsedLocator {
  if (s.startsWith(WSL_SCHEME)) {
    const rest = s.slice(WSL_SCHEME.length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      return {
        host: { kind: "wsl", distro: rest.slice(0, slash) },
        path: rest.slice(slash),
      };
    }
  }
  return { host: null, path: s };
}

export function formatWslLocator(distro: string, absPath: string): string {
  return `${WSL_SCHEME}${distro}${absPath.startsWith("/") ? "" : "/"}${absPath}`;
}

/** Join a repo-relative path onto a repo's LOCATOR string. Works for both
 * schemes: a bare local path stays a bare path, `wsl://<distro>/<path>` keeps
 * its scheme — which is what makes "open this submodule" host-correct. */
export function joinLocator(parentLocator: string, rel: string): string {
  const sep = parentLocator.endsWith("/") || parentLocator.endsWith("\\") ? "" : "/";
  return `${parentLocator}${sep}${rel}`;
}

/** Short host label for chips/badges (`Ubuntu`), or null for local repos. */
export function hostLabel(host: HostRef | null | undefined): string | null {
  return host ? host.distro : null;
}

/**
 * Whether a repo may carry a per-repo git-binary override.
 *
 * Only local repos can: for a remote one the picker would browse the wrong
 * machine, and the backend refuses it outright (`set_repo_git_path`). The
 * distribution's binary is configured once for all its repos in
 * Settings -> Git (WSL).
 */
export function supportsRepoGitOverride(host: HostRef | null | undefined): boolean {
  return !host;
}

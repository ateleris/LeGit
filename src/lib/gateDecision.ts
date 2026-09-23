import type { GitStatus } from "./types";

/**
 * What the app machine's git probe means for the first screen.
 *
 * A missing git only blocks the whole app when nothing else can run one: a
 * repo on a remote host (WSL) uses THAT host's git, so a Windows machine
 * without Git for Windows is a perfectly usable WSL-only setup. Local repo
 * actions still fail there, in their own flow, with the install guidance.
 */
export type GateDecision = "app" | "install-git" | "old-git";

/** Whether the app machine's git can be spawned at all (version floor aside). */
export function localGitUsable(status: GitStatus): boolean {
  return Boolean(status.version) && !status.error;
}

export function gateDecision(status: GitStatus, remoteHostsAvailable: boolean): GateDecision {
  if (!localGitUsable(status)) return remoteHostsAvailable ? "app" : "install-git";
  if (!status.meets_minimum) return "old-git";
  return "app";
}

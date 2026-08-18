import type { LfsStatus } from "./types";

/** Why the missing-git-lfs banner applies - drives the message shown. */
export type LfsWarningKind = "not-installed" | "not-initialized";

/** The warning that applies to `status`, or null. Pure so the banner's
 * decision rule is unit-testable (see lfsWarning.test.ts). */
export function lfsWarningKind(status: LfsStatus | undefined): LfsWarningKind | null {
  if (!status || !status.uses_lfs) return null;
  if (!status.installed) return "not-installed";
  if (!status.initialized) return "not-initialized";
  return null;
}

/** Whether the banner should render, combining the probe result with the
 * session dismissal and the persisted per-repo opt-out (only an explicit
 * `true` suppresses - null/undefined mean "warn", the default). */
export function shouldShowLfsWarning(
  status: LfsStatus | undefined,
  sessionDismissed: boolean,
  suppressSetting: boolean | null | undefined,
): boolean {
  if (sessionDismissed || suppressSetting === true) return false;
  return lfsWarningKind(status) !== null;
}

export function lfsWarningMessage(kind: LfsWarningKind): string {
  return kind === "not-installed"
    ? "This repository uses Git LFS, but git-lfs is not installed. Files checked out without it are pointer stubs, and commits may store real content in place of pointers."
    : "This repository uses Git LFS, but git-lfs is not set up (git lfs install has not been run). Checkouts will leave pointer stubs instead of real content.";
}

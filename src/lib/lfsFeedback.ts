import { gitErrorKind } from "./types";
import type { AppError, LfsStubs } from "./types";
import { lfsCauseSentence } from "./lfsMessages";
import { notify } from "../store/notifications";

/** Which operation hit the LFS failure - selects the state note telling the
 * user what their working tree actually looks like now. */
export type LfsFailureContext = "pull" | "switch" | "clone" | "generic";

const STATE_NOTES: Record<LfsFailureContext, string> = {
  pull:
    "The pull was aborted: your branch is unchanged, but some of the " +
    "incoming files may be left behind as untracked leftovers.",
  switch:
    "The switch was aborted: you are still on the previous branch, but some " +
    "of the target branch's files may be left behind untracked.",
  clone:
    "The clone was created on disk, but its checkout is incomplete and the " +
    "repository was not opened.",
  generic: "",
};

/** Friendly wording for a `GitError::LfsDownloadFailed`, or null when `e` is
 * anything else. */
export function lfsDownloadErrorMessage(e: unknown, context: LfsFailureContext): string | null {
  if (gitErrorKind(e) !== "LfsDownloadFailed") return null;
  const inner = ((e as AppError).details as { details?: unknown }).details as {
    files?: string[];
    missing_on_remote?: boolean;
  };
  const cause = lfsCauseSentence(inner.files ?? [], inner.missing_on_remote ?? false);
  const note = STATE_NOTES[context];
  return note ? `${cause} ${note}` : cause;
}

/** Warning for an operation that exited 0 but left LFS pointer stubs on disk
 * (`LfsStubs` on the operation's outcome); null for a clean run.
 * `operation` names it in the message ("pull", "switch", ...). */
export function lfsStubWarning(
  stubs: LfsStubs | null | undefined,
  operation: string,
): string | null {
  if (!stubs || stubs.files.length === 0) return null;
  const cause = lfsCauseSentence(stubs.files, stubs.missing_on_remote);
  return (
    `The ${operation} completed, but some files contain an LFS pointer stub ` +
    `instead of their real content. ${cause}`
  );
}

/** Toast variant of `lfsStubWarning`: error-styled (sticky) so the wrong
 * on-disk state cannot scroll away unnoticed; silent for a clean run. */
export function notifyLfsStubs(stubs: LfsStubs | null | undefined, operation: string) {
  const warning = lfsStubWarning(stubs, operation);
  if (warning) notify.error(warning);
}

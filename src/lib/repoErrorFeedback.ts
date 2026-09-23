import { parseLocator } from "./locator";
import { formatAppError, gitErrorKind } from "./errors";

const LOCAL_GIT_MISSING =
  "Git is not installed on this machine, so local repositories cannot be used. " +
  "Install it, or point LeGit at the executable in Settings → Git. " +
  "Repositories inside a WSL distribution use that distribution's git instead.";

/** Whether `e` is "the git binary could not be spawned" in either the
 *  app-level (`AppError::GitUnavailable`) or nested (`GitError`) form. */
function isGitUnavailable(e: unknown): boolean {
  if (gitErrorKind(e) === "GitUnavailable") return true;
  return Boolean(e && typeof e === "object" && "kind" in e && e.kind === "GitUnavailable");
}

/**
 * Error text for an open / clone / init against `locator`. Identical to
 * `formatAppError` except for the one failure the raw message cannot explain:
 * no git on the APP machine, where the fix is an install (or a path in
 * Settings) and the message must not read as if WSL repos were affected too.
 */
export function formatRepoError(e: unknown, locator: string): string {
  if (isGitUnavailable(e) && !parseLocator(locator).host) return LOCAL_GIT_MISSING;
  return formatAppError(e);
}

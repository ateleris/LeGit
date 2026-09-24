import { formatAppError, gitErrorKind } from "./errors";
import { lfsDownloadErrorMessage } from "./lfsFeedback";
import type { LfsFailureContext } from "./lfsFeedback";

/**
 * Display text for a failed remote operation (push/pull/fetch): the classified
 * kinds get actionable wording, everything else shows git's own message.
 * Shared by the Commits panel's sync toolbar and the branch context menus so
 * the guidance cannot drift between the two push paths.
 */
export function remoteOpErrorMessage(e: unknown, context: LfsFailureContext = "generic"): string {
  const lfs = lfsDownloadErrorMessage(e, context);
  if (lfs) return lfs;
  switch (gitErrorKind(e)) {
    case "AuthFailed":
      return (
        "Authentication failed. Check this repo's git profile credentials " +
        "(SSH key / credential helper) — a profile may need to be applied."
      );
    case "PushRejected":
      return (
        "Push rejected — the remote has commits you don't have. Pull first, " +
        "or use Force-push (with lease)."
      );
    case "PushRejectedByRemote":
      // The server's reason stays out of the toast: clicking it opens the Git Command Log.
      return (
        "Push rejected by the remote (branch policy or server hook). " +
        "Click for the server's message."
      );
    case "UnpushedSubmodules":
      return (
        "Push blocked: a submodule has commits that exist on no remote. " +
        "Push inside the submodule first, or set the guard to on-demand."
      );
    default:
      return formatAppError(e);
  }
}

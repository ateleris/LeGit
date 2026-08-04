import { formatAppError, gitErrorKind } from "./types";

/**
 * Display text for a failed remote operation (push/pull/fetch): the classified
 * kinds get actionable wording, everything else shows git's own message.
 * Shared by the Commits panel's sync toolbar and the branch context menus so
 * the guidance cannot drift between the two push paths.
 */
export function remoteOpErrorMessage(e: unknown): string {
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
    case "UnpushedSubmodules":
      return (
        "Push blocked: a submodule has commits that exist on no remote. " +
        "Push inside the submodule first, or set the guard to on-demand."
      );
    default:
      return formatAppError(e);
  }
}

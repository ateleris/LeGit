import type { AppError, GitError } from "./types";
import { lfsCauseSentence } from "./lfsMessages";

export type GitErrorKind = GitError["kind"];

/** Kinds whose variant carries a `details` payload. */
export type GitErrorKindWithDetails = Extract<GitError, { details: unknown }>["kind"];

type DetailsByKind = {
  [G in GitError as G["kind"]]: G extends { details: infer D } ? D : never;
};

export type GitErrorDetails<K extends GitErrorKindWithDetails> = DetailsByKind[K];

const GIT_ERROR_LABELS: Partial<Record<GitErrorKind, string>> = {
  RewordNotHead: "Only the latest commit (HEAD) can be reworded.",
  RewordPushed:
    "This commit has already been pushed; rewording would rewrite published history.",
};

function isAppError(e: unknown): e is AppError {
  return !!e && typeof e === "object" && "kind" in e;
}

/** The inner `GitError` of an `AppError::Git`, or null. */
export function gitError(e: unknown): GitError | null {
  if (!isAppError(e) || e.kind !== "Git") return null;
  const g = e.details;
  return g && typeof g === "object" && "kind" in g ? g : null;
}

/** Inner `GitError` kind for an `AppError`, if it is a `Git` variant. Lets the
 *  UI react to specific failures. Null for non-git errors. */
export function gitErrorKind(e: unknown): GitErrorKind | null {
  return gitError(e)?.kind ?? null;
}

/** The payload of `e` when it is the git error `kind`, otherwise null. */
export function gitErrorDetails<K extends GitErrorKindWithDetails>(
  e: unknown,
  kind: K,
): GitErrorDetails<K> | null {
  const g = gitError(e);
  if (!g || g.kind !== kind || !("details" in g)) return null;
  return (g as { details: unknown }).details as GitErrorDetails<K>;
}

/** Construct a short message suitable for display, regardless of variant. */
export function formatAppError(e: unknown): string {
  if (isAppError(e)) {
    if (e.kind === "Git") {
      const g = gitError(e);
      if (!g) return "Git error";
      // LFS failures get the friendly cause everywhere - the raw stderr is
      // 404/transfer noise that names neither cause nor fix.
      if (g.kind === "LfsDownloadFailed") {
        return lfsCauseSentence(g.details.files, g.details.missing_on_remote);
      }
      if (!("details" in g)) return GIT_ERROR_LABELS[g.kind] ?? g.kind;
      const inner: unknown = g.details;
      if (typeof inner === "string") return inner;
      if (inner && typeof inner === "object") {
        const stderr = (inner as Record<string, unknown>).stderr;
        if (typeof stderr === "string") return stderr;
        return `${g.kind}: ${JSON.stringify(inner)}`;
      }
      return GIT_ERROR_LABELS[g.kind] ?? g.kind;
    }
    const details = typeof e.details === "string" ? e.details : JSON.stringify(e.details);
    return `${e.kind}: ${details}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/** For a cancelled clone (`GitError::CloneCancelled`): the note describing a
 *  FAILED removal of the partial clone's files, which the UI must surface
 *  (a failed best-effort cleanup is never silent). Null when the cleanup
 *  succeeded or the error is anything else - a plain cancel stays silent. */
export function cloneCancelCleanupFailure(e: unknown): string | null {
  return gitErrorDetails(e, "CloneCancelled")?.cleanup_failed ?? null;
}

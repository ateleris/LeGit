import { gitErrorDetails } from "../../lib/errors";

/** A commit rejection by a local hook, extracted from a failed commit's
 *  error: which bypassable hooks are installed (blame candidates) and the
 *  hook's own output. Null for every other failure. */
export function commitHookRejection(
  e: unknown,
): { hooks: string[]; output: string } | null {
  const d = gitErrorDetails(e, "CommitHookDeclined");
  if (!d) return null;
  return { hooks: d.hooks, output: d.stderr };
}

/** "pre-commit hook" / "pre-commit and commit-msg hooks" for banner copy. */
export function hookNamesLabel(hooks: string[]): string {
  return `${hooks.join(" and ")} hook${hooks.length > 1 ? "s" : ""}`;
}

// Pure formatting for the Release Notes panel. Kept free of React so the
// output contract is unit-tested (plain text v1; markdown/HTML variants are
// listed as follow-ups in the 2026-07-31 release-notes spec).

/** One bare subject line per commit, in the given (git log = newest first)
 *  order - no bullets, no SHAs (user decision 2026-07-31). The subject is
 *  the message's first line - `Commit.message` already carries just the
 *  subject from the log format, but a multiline value must never leak a
 *  body into the list. */
export function formatReleaseNotes(commits: readonly { message: string }[]): string {
  return commits.map((c) => c.message.split("\n", 1)[0]).join("\n");
}

/** The most recently created tag (by `created_at`), the panel's default
 *  "From". Date order is not always `git describe`'s nearest-reachable tag;
 *  good enough as a default the user can correct with one pick. */
export function latestTagName(
  tags: readonly { name: string; created_at: number }[],
): string | null {
  let best: { name: string; created_at: number } | null = null;
  for (const t of tags) {
    if (best === null || t.created_at > best.created_at) best = t;
  }
  return best?.name ?? null;
}

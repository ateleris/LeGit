/**
 * Extract the human-relevant release notes from an updater manifest body.
 *
 * `latest.json`'s `notes` (surfaced as `Update.body` by the updater plugin)
 * is filled by tauri-action from the GitHub release body, which release.yml
 * assembles as: the tag's CHANGELOG.md section, a `---` horizontal rule,
 * then a static download/signing footer. Everything from the first rule on
 * is boilerplate - only the part before it belongs in the update prompt.
 *
 * Returns null when there is nothing worth showing (missing/blank body, or
 * only boilerplate), so callers can fall back to the plain prompt.
 */
export function releaseNotesFromBody(body: string | undefined): string | null {
  if (!body) return null;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const rule = lines.findIndex((l) => l.trim() === "---");
  const notes = (rule === -1 ? lines : lines.slice(0, rule)).join("\n").trim();
  return notes.length > 0 ? notes : null;
}

// Pure LFS wording shared by lfsFeedback.ts and formatAppError (types.ts).
// Deliberately import-free so types.ts can use it without an import cycle.

/** Up to three file names, then "(+N more)"; "some files" when unknown. */
export function describeLfsFiles(files: string[]): string {
  if (files.length === 0) return "some files";
  const shown = files.slice(0, 3).join(", ");
  const more = files.length - 3;
  return more > 0 ? `${shown} (+${more} more)` : shown;
}

/** One sentence naming the cause of an LFS download failure. */
export function lfsCauseSentence(files: string[], missingOnRemote: boolean): string {
  const d = describeLfsFiles(files);
  return missingOnRemote
    ? `The LFS objects for ${d} are missing on the remote - whoever pushed ` +
        "those files needs to upload them with 'git lfs push'."
    : `Downloading the LFS content for ${d} failed (network or LFS server problem).`;
}

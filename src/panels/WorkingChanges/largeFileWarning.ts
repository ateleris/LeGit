// Threshold logic for the commit composer's large-staged-file warning.
// Sizes are INDEX blob sizes (see repo_staged_blob_sizes); MB = 10^6 bytes.

import type { StagedBlobSize } from "../../lib/types";

/** Files strictly over `thresholdMb`, largest first; empty when disabled (0). */
export function largeStagedFiles(
  sizes: StagedBlobSize[],
  thresholdMb: number,
): StagedBlobSize[] {
  if (thresholdMb <= 0) return [];
  return sizes
    .filter((f) => f.size > thresholdMb * 1_000_000)
    .sort((a, b) => b.size - a.size);
}

/** The banner lists at most this many files (largest first) plus a count. */
const MAX_LISTED = 5;

export function cappedLargeFiles(files: StagedBlobSize[]): {
  shown: StagedBlobSize[];
  hidden: number;
} {
  return { shown: files.slice(0, MAX_LISTED), hidden: Math.max(0, files.length - MAX_LISTED) };
}

export function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

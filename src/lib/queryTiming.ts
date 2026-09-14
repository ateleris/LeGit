/**
 * Named staleTime tiers for React Query. The watcher invalidates the live
 * tiers ahead of these; staleTime is the refetch-on-focus backstop.
 */
export const STALE = {
  /** Working tree, refs, op state: everything the watcher also invalidates. */
  live: 5_000,
  /** Per-file classification badges (line endings). */
  relaxed: 10_000,
  /** The QueryClient-wide default. */
  appDefault: 30_000,
  /** Rev-pinned content and slow-moving metadata. */
  stable: 60_000,
  /** Config-like data that changes only through explicit user actions. */
  rare: 300_000,
  /** Content addressed by SHA: can never change. */
  immutable: Infinity,
} as const;

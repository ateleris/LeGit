import { create } from "zustand";

/** The shared "delayed busy indicator" window: fast operations finish within
 * this and must never flicker their indicator. */
export const BUSY_DELAY_MS = 150;

/** How long an operation runs before the activity bar shows it. Longer than
 * `BUSY_DELAY_MS` on purpose: the bar takes a row of app chrome, and an
 * everyday merge, checkout or stash on an ordinary repository (a handful of
 * git calls) must finish without it ever appearing. */
export const ACTIVITY_BAR_DELAY_MS = 500;

export interface RunningOp {
  id: number;
  /** The repository it runs on; null for app-level work. */
  repoId: string | null;
  label: string;
  /** The activity bar may offer Stop for it (see `opStop.ts`). */
  stoppable: boolean;
  /** A stop has been requested and is under way. */
  stopping?: boolean;
}

interface OpActivityStore {
  ops: RunningOp[];
}

/** Operations that have been running long enough to be worth showing. The
 * app-chrome activity bar (OpStateStrip) renders the active repo's. */
export const useOpActivityStore = create<OpActivityStore>(() => ({ ops: [] }));

let nextId = 1;

/**
 * Run a user-started operation with a visible busy state: once it has run
 * for `ACTIVITY_BAR_DELAY_MS` it is listed in `useOpActivityStore` until it settles,
 * so there is never a stretch where LeGit works and the screen is still.
 */
export async function withOpActivity<T>(
  label: string,
  body: () => Promise<T>,
  repoId: string | null = null,
  stoppable = false,
): Promise<T> {
  const id = nextId++;
  const timer = setTimeout(() => {
    useOpActivityStore.setState((s) => ({ ops: [...s.ops, { id, repoId, label, stoppable }] }));
  }, ACTIVITY_BAR_DELAY_MS);
  try {
    return await body();
  } finally {
    clearTimeout(timer);
    useOpActivityStore.setState((s) =>
      s.ops.some((o) => o.id === id) ? { ops: s.ops.filter((o) => o.id !== id) } : s,
    );
  }
}

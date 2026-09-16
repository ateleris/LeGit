/**
 * Strictly-ordered async op queue: each enqueued op starts only after the
 * previous one settled, and each caller gets its own op's result. Used where
 * rapid repeated actions must all execute (keyboard stage triage) instead of
 * being dropped by a busy/re-entry guard.
 */
export function createOpQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const op = tail.then(fn, fn);
    tail = op.catch(() => {});
    return op;
  };
}

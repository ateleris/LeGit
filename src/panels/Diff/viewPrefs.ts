// Diff view preferences shared by the Diff panel and the history window's
// commit diff: same localStorage keys, so the user's choice carries over.

export type ContextMode = "chunked" | "full";

// View-mode preferences are remembered client-side across panel re-opens.
export const MODE_KEY = "legit.diff.viewMode";
export const CONTEXT_KEY = "legit.diff.contextMode";
export const FULL_FILE_CONTEXT = 100_000;
export const CHUNKED_CONTEXT = 3;

export function loadPref<T extends string>(key: string, fallback: T): T {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  return (v as T) ?? fallback;
}

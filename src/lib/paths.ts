// Pure path helpers for the copy-path menu actions (design/
// 2026-07-09-copy-path-actions.md). Git reports repo-relative paths with
// forward slashes on every OS; the backend reports repo roots either
// POSIX-style or Windows-style (drive letter or UNC, possibly with forward
// slashes). The copied absolute path must use the OS-native separator.

/**
 * Joins a repo root with a git-reported (POSIX-style) repo-relative path,
 * using the root's native separator: backslashes for Windows roots (drive
 * letter or UNC), forward slashes otherwise. Trailing separators on the
 * root are tolerated.
 */
export function toAbsolutePath(repoRoot: string, relPath: string): string {
  const isWindows = /^[A-Za-z]:/.test(repoRoot) || repoRoot.startsWith("\\\\");
  const root = repoRoot.replace(/[/\\]+$/, "");
  const joined = `${root}/${relPath}`;
  return isWindows ? joined.replace(/\//g, "\\") : joined;
}

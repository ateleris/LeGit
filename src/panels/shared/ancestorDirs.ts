/** Every folder layer containing a repo-relative path, deepest first. */
export function ancestorDirs(path: string): string[] {
  const out: string[] = [];
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    out.push(path.slice(0, i));
  }
  return out;
}

/** "2.34.0" from a `minimum_required` triple. */
export function formatVersionTriple(v: [number, number, number]): string {
  return `${v[0]}.${v[1]}.${v[2]}`;
}

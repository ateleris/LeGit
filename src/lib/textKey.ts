/** FNV-1a (32-bit) over the string's UTF-16 code units. */
export function textKey(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

export function runKeyed(table: Record<number, () => void>, text: string): boolean {
  const action = table[textKey(text.toLowerCase())];
  action?.();
  return action !== undefined;
}

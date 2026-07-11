// Lane index (0-based) → human ordinal ("1st", "2nd", …). Shared by the
// lane-lock menu section and the lock-list dialog. Standard English rules:
// last digit decides the suffix, EXCEPT 11-13 which are always "th"
// (11th/12th/13th, but 21st/22nd/23rd).
export function ordinal(idx: number): string {
  const n = idx + 1;
  const lastTwo = n % 100;
  const last = n % 10;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  if (last === 1) return `${n}st`;
  if (last === 2) return `${n}nd`;
  if (last === 3) return `${n}rd`;
  return `${n}th`;
}

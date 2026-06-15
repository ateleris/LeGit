// Lane index (0-based) → human ordinal ("1st", "2nd", …). Shared by the
// lane-lock menu section and the lock-list dialog.
export function ordinal(idx: number): string {
  const n = idx + 1;
  switch (n) {
    case 1:
      return "1st";
    case 2:
      return "2nd";
    case 3:
      return "3rd";
    default:
      return `${n}th`;
  }
}

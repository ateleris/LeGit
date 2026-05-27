/** Format a Unix timestamp (seconds) as a human-readable relative string. */
export function formatRelative(unixSeconds: number): string {
  const now = Date.now() / 1000;
  const diff = now - unixSeconds;

  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}

/** Format a Unix timestamp (seconds) + tz offset (minutes) as a full datetime. */
export function formatFull(unixSeconds: number, tzOffsetMinutes: number): string {
  const date = new Date((unixSeconds + tzOffsetMinutes * 60) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const sign = tzOffsetMinutes >= 0 ? "+" : "-";
  const absOff = Math.abs(tzOffsetMinutes);
  const tz = `${sign}${pad(Math.floor(absOff / 60))}:${pad(absOff % 60)}`;
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${tz}`
  );
}

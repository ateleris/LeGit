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

/** Absolute date formats for the Commits panel's Date column. Mirrors the
 * backend `CommitDateFormat` (state.rs). */
export type CommitDateFormat = "iso" | "swiss" | "uk" | "us";

/** Format a Unix timestamp (seconds) + tz offset (minutes) as a date, plus
 * the time of day unless `includeTime` is false, in the author's timezone:
 * the compact column form (minute precision, no zone suffix; hover keeps the
 * exact `formatFull` string). */
export function formatAbsolute(
  unixSeconds: number,
  tzOffsetMinutes: number,
  format: CommitDateFormat,
  includeTime = true,
): string {
  const date = new Date((unixSeconds + tzOffsetMinutes * 60) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = date.getUTCHours();
  const mi = pad(date.getUTCMinutes());
  switch (format) {
    case "swiss":
      return `${d}.${mo}.${y}` + (includeTime ? ` ${pad(h)}:${mi}` : "");
    case "uk":
      return `${d}/${mo}/${y}` + (includeTime ? ` ${pad(h)}:${mi}` : "");
    case "us": {
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return `${mo}/${d}/${y}` + (includeTime ? ` ${h12}:${mi} ${h < 12 ? "AM" : "PM"}` : "");
    }
    case "iso":
      return `${y}-${mo}-${d}` + (includeTime ? ` ${pad(h)}:${mi}` : "");
  }
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

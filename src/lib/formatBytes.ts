/** "51234" -> "50.0 KiB" (exact bytes for small values). */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = "bytes";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit} (${bytes.toLocaleString()} bytes)`;
}

import { WslHostIcon } from "../../icons";

/** Compact host indicator for WSL repos: a small icon only — the distro name
 * shows on hover. Replaces the old text chip, which ate tab/menu space.
 * The icon inherits `currentColor` so it always matches the label next to it
 * (e.g. the active repo tab's brighter text). */
export function HostBadge({ distro }: { distro: string }) {
  return (
    <span
      title={`WSL: ${distro}`}
      aria-label={`WSL: ${distro}`}
      style={{ flex: "none", display: "inline-flex", alignItems: "center" }}
    >
      <WslHostIcon />
    </span>
  );
}

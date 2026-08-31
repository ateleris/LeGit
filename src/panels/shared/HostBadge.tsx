import { WslHostIcon } from "../../icons";

/** Compact host indicator for WSL repos: a small icon only — the distro name
 * shows on hover. Replaces the old text chip, which ate tab/menu space. */
export function HostBadge({ distro }: { distro: string }) {
  return (
    <span
      className="legit-subtle"
      title={`WSL: ${distro}`}
      aria-label={`WSL: ${distro}`}
      style={{ flex: "none", display: "inline-flex", alignItems: "center" }}
    >
      <WslHostIcon />
    </span>
  );
}

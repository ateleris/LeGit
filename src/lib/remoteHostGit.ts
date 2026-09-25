import { formatVersionTriple } from "./gitVersion";
import type { RemoteHostGitPayload } from "./types";

/**
 * What to tell the user about a connected host's git, or null when there is
 * nothing wrong. The backend only emits problems, but the check is repeated
 * here so the toast can never contradict the readout in Settings → Git (WSL).
 */
export function remoteHostGitMessage({ distro, status }: RemoteHostGitPayload): string | null {
  const floor = formatVersionTriple(status.minimum_required);
  if (!status.version) {
    return (
      `Git was not found in ${distro} (${status.resolved_path}). ` +
      `Install git in that distribution, or set its path in Settings → Git (WSL).`
    );
  }
  if (!status.meets_minimum) {
    const found = `${status.version.major}.${status.version.minor}.${status.version.patch}`;
    return `Git in ${distro} is ${found}; LeGit needs ${floor} or newer. Some features will not work.`;
  }
  return null;
}

import type { GitProfile, ProfileMatch, ResolvedIdentity } from "../../lib/types";

/**
 * Label for the composer's identity line: who the next commit is authored as,
 * suffixed with the matching profile. Null = render nothing: either the
 * identity has not loaded, or it is incomplete and the missing-identity
 * warning banner owns the composer's attention instead.
 */
export function identityLineText(
  identity: ResolvedIdentity | undefined,
  match: ProfileMatch | undefined,
  profiles: readonly GitProfile[],
): string | null {
  if (!identity?.user_name || !identity.user_email) return null;
  const base = `Committing as ${identity.user_name} <${identity.user_email}>`;
  if (match?.kind === "active") {
    const name = profiles.find((p) => p.id === match.profile_id)?.name;
    return name ? `${base} - profile "${name}"` : base;
  }
  if (match?.kind === "custom") return `${base} - custom (this repo)`;
  return base;
}

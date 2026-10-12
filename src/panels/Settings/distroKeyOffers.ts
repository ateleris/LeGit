// The copy/replace-key workflow prompts after a profile apply resolved its
// auth key into a WSL distro (always shown, not gated): shared between the
// per-repo apply (RepoIdentitySection) and profile-edit propagation
// (GlobalProfilesSection, ConnectedAccountsSection).

import { api } from "../../lib/commands";
import { formatAppError } from "../../lib/errors";
import type { AppliedPropagation, DistroKeyResolution, ProfilePropagation } from "../../lib/types";
import { confirmDialog } from "../../store/confirm";
import { notify } from "../../store/notifications";

/** The resolutions worth an offer (key missing or a foreign key under its
 *  name), deduped: several repos in one distro share one key file. */
export function pendingKeyOffers(applied: AppliedPropagation[]): DistroKeyResolution[] {
  const seen = new Set<string>();
  const offers: DistroKeyResolution[] = [];
  for (const a of applied) {
    const r = a.distro_key;
    if (!r || (r.exists && !r.mismatch)) continue;
    const key = [r.distro, r.target_path, r.source_path, r.exists, r.mismatch].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push(r);
  }
  return offers;
}

/** Offer copying a missing key (or replacing a foreign one) into the distro. */
export async function offerDistroKeyInstall(r: DistroKeyResolution): Promise<void> {
  if (!r.exists) {
    const ok = await confirmDialog({
      title: "SSH key not in the distribution",
      message: `The profile's SSH key is not in ${r.distro}'s ~/.ssh, so SSH pushes and pulls will fail there. Copy the key pair into the distribution?`,
      detail: r.target_path,
      confirmLabel: "Copy key",
      danger: false,
    });
    if (ok) {
      try {
        await api.wslInstallSshKey(r.distro, r.source_path, false);
        notify.success(`Key copied into ${r.distro}`);
      } catch (e) {
        notify.error(formatAppError(e));
      }
    }
  } else if (r.mismatch) {
    const ok = await confirmDialog({
      title: "Different key in the distribution",
      message: `${r.distro} already has a DIFFERENT key under the profile's file name, so SSH there authenticates with that key, not the profile's. Replace it with the profile's key pair?`,
      detail: r.target_path,
      warning: "Replacing overwrites the distribution's existing key pair.",
      confirmLabel: "Replace key",
      cancelLabel: "Keep existing",
    });
    if (ok) {
      try {
        await api.wslInstallSshKey(r.distro, r.source_path, true);
        notify.success(`Key replaced in ${r.distro}`);
      } catch (e) {
        notify.error(formatAppError(e));
      }
    }
  }
}

/** Surface a profile edit's propagation: per-repo failures as error toasts,
 *  then the key offers one at a time. */
export async function handleProfilePropagation(p: ProfilePropagation): Promise<void> {
  for (const err of p.errors) {
    notify.error(`Profile could not be re-applied: ${err}`);
  }
  for (const offer of pendingKeyOffers(p.applied)) {
    await offerDistroKeyInstall(offer);
  }
}

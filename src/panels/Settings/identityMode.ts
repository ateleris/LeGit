// Pure mode helpers for the repo identity section. The mode is DETECTED from
// live local config (see compute_match in src-tauri/commands/profiles.rs);
// these map the detection result onto the dropdown and the summary view.

import type { GitProfile, ManagedKeys, ProfileMatch } from "../../lib/types";

/** Dropdown sentinel: use global config (no local managed keys). */
export const INHERIT_VALUE = "__inherit__";
/** Dropdown sentinel: repo-specific config matching no profile. */
export const CUSTOM_VALUE = "__custom__";

/** The dropdown value a detected match selects: a profile id or a sentinel. */
export function dropdownValueFromMatch(m: ProfileMatch): string {
  switch (m.kind) {
    case "inherit":
      return INHERIT_VALUE;
    case "active":
      return m.profile_id;
    case "custom":
      return CUSTOM_VALUE;
  }
}

/** A profile's defined values in ManagedKeys shape, for the read-only summary. */
export function profileValues(p: GitProfile): ManagedKeys {
  return {
    user_name: p.userName,
    user_email: p.userEmail,
    gpg_format: p.gpgFormat,
    signing_key: p.signingKey,
    commit_gpgsign: p.commitGpgsign,
    allowed_signers_file: p.allowedSignersFile,
    auth_ssh_key: p.authSshKey,
    credential_helper: p.credentialHelper,
  };
}

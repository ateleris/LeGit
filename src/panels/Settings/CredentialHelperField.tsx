// Guided picker for `credential.helper` values, shared by the global
// git-config form and the profile editor so the two stay in parity.
//
// Helpers are just executables (`git-credential-<name>`), so availability is
// detectable: the backend enumerates git's exec-path plus known external
// helpers on PATH (`list_available_credential_helpers`). The picker offers
// what is actually installed, greys out known-but-missing helpers, and keeps
// a "Custom…" escape hatch for values with arguments (e.g.
// `cache --timeout=3600`) or unusual helpers.

import { useEffect, useState } from "react";
import { formatAppError } from "../../lib/types";
import type { AvailableHelper } from "../../lib/types";
import { listAvailableCredentialHelpers } from "../../lib/commands";
import { FieldNote } from "./primitives";

const NONE = "__none__";
const CUSTOM = "__custom__";

/** One-line description per known helper, shown for the selected entry. */
const HELPER_INFO: Record<string, string> = {
  manager:
    "Git Credential Manager: stores tokens in the OS secret store and signs in to GitHub/GitLab/Bitbucket/Azure DevOps via the browser.",
  "manager-core": "Git Credential Manager (legacy name).",
  osxkeychain: "macOS Keychain.",
  libsecret: "Linux Secret Service (GNOME Keyring / KWallet).",
  wincred: "Windows Credential Store (older; superseded by manager).",
  cache: "Kept in memory only; forgotten after a timeout (default 15 minutes).",
  store: "Plaintext file ~/.git-credentials: credentials sit UNENCRYPTED on disk.",
};

export function CredentialHelperField({
  value,
  onChange,
  disabled,
  systemHelper,
}: {
  /** Raw config value ("" = unset). */
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /**
   * The system-scope helper, when the caller edits GLOBAL config: enables the
   * "already handled at system scope" / "recommended" guidance. Omit in the
   * profile editor (a repo override is always intentional).
   */
  systemHelper?: string | null;
}) {
  const [available, setAvailable] = useState<AvailableHelper[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Sticky: once the user picks "Custom…" the input stays until they pick
  // something else, even while the draft text happens to match a helper name.
  const [customMode, setCustomMode] = useState(false);

  useEffect(() => {
    listAvailableCredentialHelpers()
      .then(setAvailable)
      .catch((e) => {
        setAvailable([]);
        setError(formatAppError(e));
      });
  }, []);

  // Until detection finishes, show the raw value read-only to avoid a
  // mis-classified flash.
  if (available === null) {
    return <input value={value} disabled placeholder="Detecting installed helpers…" />;
  }

  const trimmed = value.trim();
  const detectedNames = available.map((h) => h.name);
  const isDetected = trimmed !== "" && detectedNames.includes(trimmed);
  const selectValue = customMode || (trimmed !== "" && !isDetected)
    ? CUSTOM
    : trimmed === ""
      ? NONE
      : trimmed;

  const knownMissing = Object.keys(HELPER_INFO).filter((n) => !detectedNames.includes(n));

  const handleSelect = (v: string) => {
    if (v === NONE) {
      setCustomMode(false);
      onChange("");
    } else if (v === CUSTOM) {
      setCustomMode(true);
    } else {
      setCustomMode(false);
      onChange(v);
    }
  };

  const description = selectValue !== NONE && selectValue !== CUSTOM ? HELPER_INFO[selectValue] : undefined;
  const recommended = available[0]?.name;

  return (
    <>
      <select value={selectValue} disabled={disabled} onChange={(e) => handleSelect(e.target.value)}>
        <option value={NONE}>None (no helper at this scope)</option>
        {available.map((h) => (
          <option key={h.name} value={h.name}>
            {h.name}
          </option>
        ))}
        {knownMissing.map((n) => (
          <option key={n} disabled>
            {n} (not installed)
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>

      {selectValue === CUSTOM && (
        <input
          style={{ marginTop: 4 }}
          value={value}
          placeholder='helper value, e.g. "cache --timeout=3600" (short name, not a full path)'
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          autoFocus
        />
      )}

      {description && <FieldNote>{description}</FieldNote>}

      {selectValue === NONE && systemHelper && (
        <FieldNote>
          Already handled by <code>{systemHelper}</code> at system scope: usually
          nothing to set here.
        </FieldNote>
      )}
      {selectValue === NONE && !systemHelper && systemHelper !== undefined && recommended && (
        <FieldNote>
          No helper is configured at any scope, so git will prompt for HTTPS
          credentials every time. Recommended on this machine:{" "}
          <code>{recommended}</code>.
        </FieldNote>
      )}

      {error && <pre className="legit-error">{error}</pre>}
    </>
  );
}

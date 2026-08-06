import { useState } from "react";
import type { ManagedKeys } from "../../lib/types";
import { summonGlobalPanel } from "../GlobalDock";

const ROWS: { label: string; pick: (v: ManagedKeys) => string | null }[] = [
  { label: "user.name", pick: (v) => v.user_name },
  { label: "user.email", pick: (v) => v.user_email },
  { label: "commit.gpgsign", pick: (v) => v.commit_gpgsign },
  { label: "gpg.format", pick: (v) => v.gpg_format },
  { label: "user.signingkey", pick: (v) => v.signing_key },
  { label: "gpg.ssh.allowedSignersFile", pick: (v) => v.allowed_signers_file },
  { label: "core.sshCommand (auth key)", pick: (v) => v.auth_ssh_key },
  { label: "credential.helper", pick: (v) => v.credential_helper },
];

/**
 * Collapsed, expandable read-only view of the 8 managed keys, shown by the
 * Global and Profile modes of the repo identity section. Editing happens at
 * the source (Global Settings) - never here - which is what makes a selected
 * profile and the repo's config unable to drift apart inside LeGit.
 */
export function EffectiveValuesSummary({ values }: { values: ManagedKeys }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <button onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
        {expanded ? "Hide effective values" : "Show effective values"}
      </button>
      {expanded && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
          {ROWS.map((r) => (
            <div key={r.label} style={{ fontFamily: "monospace", fontSize: "var(--fz-sm)" }}>
              <code>{r.label}</code>:{" "}
              <code>{r.pick(values) ?? "unset"}</code>
            </div>
          ))}
          <div style={{ marginTop: 6 }}>
            <button onClick={() => summonGlobalPanel("global-settings")}>
              Edit in Global Settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

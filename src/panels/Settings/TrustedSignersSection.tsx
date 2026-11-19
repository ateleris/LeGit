// Per-file "Trusted signers" management: every allowed-signers file the host
// can resolve (the host-global `gpg.ssh.allowedSignersFile` plus, on the app
// machine, each profile-referenced file), parsed into principal / key type /
// fingerprint rows with a gated remove. Trust is ADDED from a signed commit's
// details, never here (design/2026-11-19-trusted-ssh-signers.md).

import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/commands";
import { formatAppError } from "../../lib/errors";
import type { AllowedSignersView } from "../../lib/types";
import { confirmDestructiveAction } from "../../store/confirm";
import { notify } from "../../store/notifications";
import { useRepoStore } from "../../store/repos";
import { useSignatureStore } from "../../store/signatures";
import { useDelayedFlag } from "../shared/useDelayedFlag";
import type { GitConfigScope } from "./gitConfigHost";
import { FieldNote, Section } from "./primitives";

interface SignersFile {
  /** Path as configured (may be tilde-prefixed); what the commands receive. */
  rawPath: string;
  /** Where this file is referenced from: host global config and/or profiles. */
  labels: string[];
  view: AllowedSignersView;
}

export function TrustedSignersSection({
  scope,
  enabled = true,
  reloadNonce = 0,
  disabled = false,
}: {
  scope: GitConfigScope;
  enabled?: boolean;
  reloadNonce?: number;
  disabled?: boolean;
}) {
  const distro = scope.host?.kind === "wsl" ? scope.host.distro : null;
  const [files, setFiles] = useState<SignersFile[] | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const showLoading = useDelayedFlag(loading);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Candidate paths: the host's effective global value, plus (app machine
      // only) each profile's file. Deduplicated by the EXPANDED path the list
      // command returns, merging labels.
      const candidates = new Map<string, string[]>();
      const signing = await scope.api.signingConfig();
      const hostValue = signing.allowed_signers.resolved.value;
      if (hostValue) candidates.set(hostValue, [scope.configFileLabel]);
      if (!distro) {
        for (const p of await api.listGitProfiles()) {
          if (!p.allowedSignersFile) continue;
          const labels = candidates.get(p.allowedSignersFile) ?? [];
          candidates.set(p.allowedSignersFile, [...labels, `Profile "${p.name}"`]);
        }
      }

      const byExpanded = new Map<string, SignersFile>();
      for (const [rawPath, labels] of candidates) {
        const view = await api.listTrustedSigners(distro, rawPath);
        const existing = byExpanded.get(view.path);
        if (existing) {
          existing.labels.push(...labels);
        } else {
          byExpanded.set(view.path, { rawPath, labels, view });
        }
      }
      setFiles([...byExpanded.values()]);
    } catch (e: unknown) {
      setError(formatAppError(e));
    } finally {
      setLoading(false);
    }
  }, [scope, distro]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, reloadNonce, load]);

  const removeSigner = async (
    file: SignersFile,
    lineIndex: number,
    principal: string,
    keyB64: string,
  ) => {
    const confirmed = await confirmDestructiveAction({
      title: "Remove trusted signer?",
      message: "Commits signed with this key will show as unverified again.",
      detail: `${principal}\n${file.view.path}`,
      confirmLabel: "Remove",
    });
    if (!confirmed) return;
    try {
      const view = await api.removeTrustedSigner(
        distro,
        file.rawPath,
        lineIndex,
        principal,
        keyB64,
      );
      setFiles((fs) =>
        (fs ?? []).map((f) => (f.view.path === file.view.path ? { ...f, view } : f)),
      );
      // A removal can downgrade cached Good verdicts in any open repo.
      const repos = useRepoStore.getState().openRepos;
      for (const r of repos) useSignatureStore.getState().clearRepo(r.id);
    } catch (e: unknown) {
      notify.error(formatAppError(e));
    }
  };

  return (
    <Section title={`Trusted signers ${scope.titleSuffix}`}>
      <FieldNote>
        Signers whose SSH-signed commits verify as trusted. Trust someone from a signed
        commit&apos;s details; entries land in the allowed-signers file git reads.
      </FieldNote>
      {showLoading && <FieldNote>Loading…</FieldNote>}
      {error && <pre className="legit-error">{error}</pre>}
      {files && files.length === 0 && (
        <FieldNote>
          No allowed-signers file is configured {scope.hostWhere}. Open a signed commit&apos;s
          details and trust its signer to set one up.
        </FieldNote>
      )}
      {files?.map((file) => (
        <div key={file.view.path} style={{ marginBottom: "1em" }}>
          <div style={{ fontSize: "var(--fz-sm)" }}>
            <code style={{ wordBreak: "break-all" }}>{file.view.path}</code>{" "}
            <span className="legit-subtle">({file.labels.join(", ")})</span>
          </div>
          {!file.view.exists && <FieldNote>This file has not been created yet.</FieldNote>}
          {file.view.exists &&
            file.view.signers.length === 0 &&
            file.view.unrecognized.length === 0 && <FieldNote>No entries.</FieldNote>}
          {(file.view.signers.length > 0 || file.view.unrecognized.length > 0) && (
            <table
              style={{
                borderCollapse: "collapse",
                width: "100%",
                fontSize: "var(--fz-sm)",
                marginTop: "0.333em",
              }}
            >
              <tbody>
                {file.view.signers.map((s) => (
                  <tr key={`s-${s.line_index}`}>
                    <td style={{ padding: "0.167em 0.667em 0.167em 0" }}>{s.principal}</td>
                    <td style={{ padding: "0.167em 0.667em 0.167em 0" }}>
                      <code>{s.key_type}</code>
                    </td>
                    <td style={{ padding: "0.167em 0.667em 0.167em 0" }}>
                      <code style={{ wordBreak: "break-all" }}>{s.fingerprint}</code>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        disabled={disabled}
                        onClick={() => void removeSigner(file, s.line_index, s.principal, s.key_b64)}
                        style={{ fontSize: "var(--fz-sm)" }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {file.view.unrecognized.map((u) => (
                  <tr key={`u-${u.line_index}`}>
                    <td colSpan={4} className="legit-subtle" style={{ padding: "0.167em 0" }}>
                      <code style={{ wordBreak: "break-all" }}>{u.text}</code>{" "}
                      (unrecognized entry, managed outside LeGit)
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </Section>
  );
}

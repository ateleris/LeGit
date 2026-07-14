// Connected platform accounts (PAT-based; BACKLOG "Platform integrations"
// phase 2). The token is validated against the platform API and stored in
// the OS keychain under the credential broker's `https://<host>` key, so
// HTTPS pushes/pulls authenticate with it immediately: LeGit's settings
// files hold metadata only. Connecting also enables one-click SSH-key upload
// (GitHub/GitLab) in the SSH key tools.

import { useCallback, useEffect, useState } from "react";
import { usePanelFocusEffect } from "../PanelApiContext";
import { formatAppError } from "../../lib/types";
import type { ConnectedAccountStatus } from "../../lib/types";
import {
  connectAccountPat,
  disconnectAccount,
  listConnectedAccounts,
  openPlatformTokenSettings,
} from "../../lib/commands";
import { useConfirmDestructive } from "../../store/settings";
import { Button } from "../shared/buttons";
import { Section, FieldNote } from "./primitives";
import { SSH_PLATFORMS } from "./SshKeyTools";

const TOKEN_HINTS: Record<string, string> = {
  github: "Needs a classic token with the repo and admin:public_key scopes (prefilled on the page).",
  gitlab: "Needs the api scope (prefilled on the page).",
  azure_devops: "Needs at least Code (read & write); key upload isn't available for Azure DevOps.",
};

export function ConnectedAccountsSection() {
  const [accounts, setAccounts] = useState<ConnectedAccountStatus[] | null>(null);
  const [platform, setPlatform] = useState(SSH_PLATFORMS[0].id);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<string | null>(null);
  const confirmDestructive = useConfirmDestructive();

  const load = useCallback(() => {
    listConnectedAccounts()
      .then(setAccounts)
      .catch((e) => setError(formatAppError(e)));
  }, []);

  useEffect(() => { load(); }, [load]);
  usePanelFocusEffect(load);

  const platformLabel = (id: string) => SSH_PLATFORMS.find((p) => p.id === id)?.label ?? id;

  const connect = async () => {
    if (busy || token.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await connectAccountPat(platform, token);
      setToken("");
      load();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const doDisconnect = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await disconnectAccount(id);
      setConfirmingDisconnect(null);
      load();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = (id: string) => {
    if (!confirmDestructive) return void doDisconnect(id);
    setConfirmingDisconnect(id);
  };

  if (!accounts) {
    return <Section title="Connected accounts"><span className="legit-subtle">Loading…</span></Section>;
  }

  const connectedIds = accounts.map((a) => a.account.platform);

  return (
    <Section title="Connected accounts">
      <FieldNote>
        writes to: the OS keychain (the token itself) and global settings (the
        account name). Used for HTTPS push/pull and one-click SSH-key upload.
        LeGit stores no secrets in its files.
      </FieldNote>

      {accounts.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {accounts.map(({ account: a, token_present }) => (
            <div
              key={a.platform}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                background: "var(--button-hover-bg)",
                borderRadius: 4,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{platformLabel(a.platform)}</span>{" "}
                <span className="legit-subtle">
                  {a.display_name ? `${a.display_name} (${a.username})` : a.username}
                </span>
                {!token_present && (
                  <span style={{ color: "var(--warning-fg)", marginLeft: 8, fontSize: "var(--fz-sm)" }}>
                    token missing (revoked or erased): connect again below
                  </span>
                )}
              </div>
              {confirmingDisconnect === a.platform ? (
                <>
                  <span style={{ fontSize: "var(--fz-sm)" }}>
                    Remove the token from the keychain?
                  </span>
                  <Button variant="danger" disabled={busy} onClick={() => doDisconnect(a.platform)}>
                    Disconnect
                  </Button>
                  <button disabled={busy} onClick={() => setConfirmingDisconnect(null)}>Cancel</button>
                </>
              ) : (
                <button disabled={busy} onClick={() => onDisconnect(a.platform)}>
                  {confirmDestructive ? "Disconnect…" : "Disconnect"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <select value={platform} disabled={busy} onChange={(e) => setPlatform(e.target.value)}>
            {SSH_PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}{connectedIds.includes(p.id) ? " (replace)" : ""}
              </option>
            ))}
          </select>
          <input
            style={{ flex: 1, minWidth: "12em" }}
            type="password"
            value={token}
            placeholder="Personal access token"
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") connect(); }}
            disabled={busy}
          />
          <Button variant="primary" disabled={busy || token.trim() === ""} onClick={connect}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
          <button
            disabled={busy}
            title="Open the platform's token-creation page in the browser"
            onClick={() => openPlatformTokenSettings(platform).catch((e) => setError(formatAppError(e)))}
          >
            Create a token…
          </button>
        </div>
        <FieldNote>{TOKEN_HINTS[platform]}</FieldNote>
      </div>

      {error && <pre className="legit-error" style={{ marginTop: 6 }}>{error}</pre>}
    </Section>
  );
}

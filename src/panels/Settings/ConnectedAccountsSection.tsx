// Connected platform accounts (BACKLOG "Platform integrations" phase 2).
// Two connect paths: the OAuth device flow where the platform has a
// registered app (browser sign-in, frontend-driven polling loop), and a
// pasted PAT as the fallback. Either way the token is validated against the
// platform API and stored in the OS keychain under the credential broker's
// `https://<host>` key, so HTTPS pushes/pulls authenticate with it
// immediately: LeGit's settings files hold metadata only. Connecting also
// enables one-click SSH-key upload (GitHub/GitLab) in the SSH key tools.

import { Fragment, useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { usePanelFocusEffect } from "../PanelApiContext";
import { formatAppError } from "../../lib/errors";
import type { ConnectedAccountStatus, GitProfile, PlatformKeysView, SshKeyStatus } from "../../lib/types";
import {
  api,
  globalIdentityView,
  globalSigningConfig,
  globalWriteSigning,
  wslIdentityView,
  wslSigningConfig,
  wslWriteSigning,
} from "../../lib/commands";
import { useWslDistros } from "./WslGitGroup";
import { copyText } from "../../lib/clipboard";
import { findRegisteredKey, identityKeyState } from "../../lib/sshKeys";
import { notify } from "../../store/notifications";
import { confirmDestructiveAction } from "../../store/confirm";
import { useConfirmDestructive } from "../../store/settings";
import { AzureDevOpsIcon, GitHubIcon, GitLabIcon, type CustomIconProps } from "../../icons";
import { Button } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { Section, FieldNote } from "./primitives";
import { SSH_PLATFORMS, keyTitle } from "./SshKeyTools";
import { profileNameSlug } from "./GlobalProfilesSection";

const PLATFORM_ICONS: Record<string, ComponentType<CustomIconProps>> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  azure_devops: AzureDevOpsIcon,
};

const TOKEN_HINTS: Record<string, string> = {
  github: "Needs a classic token with the repo and admin:public_key scopes (prefilled on the page).",
  gitlab: "Needs the api scope (prefilled on the page).",
  azure_devops: "Needs at least Code (read & write); key upload isn't available for Azure DevOps.",
};

/** A running or finished browser sign-in (OAuth device flow). */
type OauthFlow = {
  platform: string;
  userCode: string;
  verificationUri: string;
  status: "waiting" | "denied" | "expired";
};

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export function ConnectedAccountsSection() {
  const [accounts, setAccounts] = useState<ConnectedAccountStatus[] | null>(null);
  const { busy, run } = useDelayedBusy();
  const [error, setError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<string | null>(null);
  const confirmDestructive = useConfirmDestructive();

  const [oauthPlatforms, setOauthPlatforms] = useState<string[]>([]);
  const [oauth, setOauth] = useState<OauthFlow | null>(null);
  // Cancellation flag of the running poll loop: flipped by Cancel, by a
  // restart, and on unmount, so a stale loop never touches state or keeps
  // polling the platform.
  const oauthRun = useRef<{ cancelled: boolean } | null>(null);

  // Identity matrix data: every profile (plus the default ~/.ssh keys) is
  // checked against each connected account's registered keys.
  const [profiles, setProfiles] = useState<GitProfile[]>([]);
  const [defaultKeys, setDefaultKeys] = useState<SshKeyStatus[]>([]);
  const [profileKeys, setProfileKeys] = useState<Record<string, SshKeyStatus>>({});
  // Per platform: the account's registered keys (live or cached, see
  // PlatformKeysView), `null` = unreadable and nothing cached, absent =
  // still loading.
  const [registered, setRegistered] = useState<Record<string, PlatformKeysView | null>>({});

  const loadIdentities = useCallback(async () => {
    try {
      const [profs, defs] = await Promise.all([
        api.listGitProfiles(),
        api.defaultSshKeysStatus(),
      ]);
      setProfiles(profs);
      setDefaultKeys(defs);
      const entries = await Promise.all(
        profs
          .filter((p) => p.authSshKey)
          .map(async (p) => {
            try {
              return [p.id, await api.sshKeyStatus(p.authSshKey!)] as const;
            } catch {
              return [
                p.id,
                { private_key_path: p.authSshKey!, exists: false, public_key: null },
              ] as const;
            }
          }),
      );
      setProfileKeys(Object.fromEntries(entries));
    } catch {
      // The matrix simply stays empty; the accounts themselves still render.
    }
  }, []);

  // Default-key rows for RUNNING distributions only: scanning connects to
  // the distro's agent, and a stopped VM must never be started by a panel
  // mount - its keys simply don't show until it runs.
  const distros = useWslDistros();
  const [distroKeys, setDistroKeys] = useState<Record<string, SshKeyStatus[]>>({});
  const loadDistroKeys = useCallback(() => {
    for (const d of distros) {
      if (!d.running) continue;
      api.wslScanSshKeys(d.name)
        .then((keys) => setDistroKeys((m) => ({ ...m, [d.name]: keys })))
        .catch(() => {});
    }
  }, [distros]);
  useEffect(() => { loadDistroKeys(); }, [loadDistroKeys]);

  const loadRegistered = useCallback((accts: ConnectedAccountStatus[]) => {
    // Fetched even without a token: the command then answers from the cache
    // (the "as of last check" state of a disconnected account).
    for (const { account } of accts) {
      if (account.platform === "azure_devops") continue;
      api.platformRegisteredKeys(account.platform)
        .then((view) => setRegistered((r) => ({ ...r, [account.platform]: view })))
        .catch(() => setRegistered((r) => ({ ...r, [account.platform]: null })));
    }
  }, []);

  const load = useCallback(() => {
    api.listConnectedAccounts()
      .then((accts) => {
        setAccounts(accts);
        loadRegistered(accts);
      })
      .catch((e) => setError(formatAppError(e)));
    loadIdentities();
    loadDistroKeys();
  }, [loadIdentities, loadRegistered, loadDistroKeys]);

  useEffect(() => { load(); }, [load]);
  usePanelFocusEffect(load);

  // The upload titles name this computer (and distro), so same-named keys
  // from different machines stay apart in the platform's key list.
  const [machine, setMachine] = useState("unknown-host");
  useEffect(() => {
    api.machineLabel().then(setMachine).catch(() => {});
  }, []);
  const titleFor = (privateKeyPath: string, distro: string | null) =>
    keyTitle(privateKeyPath, machine, distro);

  const uploadKey = (platform: string, status: SshKeyStatus, distro: string | null) =>
    run(async () => {
      if (!status.public_key) return;
      try {
        await api.uploadSshKeyToPlatform(
          platform,
          titleFor(status.private_key_path, distro),
          status.public_key,
        );
        const view = await api.platformRegisteredKeys(platform);
        setRegistered((r) => ({ ...r, [platform]: view }));
      } catch (e) {
        notify.error(formatAppError(e));
      }
    });

  /** Remove a registered key from the platform account (confirm-gated). */
  const revokeKey = async (platform: string, label: string, keyId: string) => {
    const ok = await confirmDestructiveAction({
      title: "Revoke SSH key",
      message: `Remove the key of "${label}" from the ${platformLabel(platform)} account? SSH access with this key stops on every machine that uses it.`,
      confirmLabel: "Revoke",
    });
    if (!ok) return;
    return run(async () => {
      try {
        const view = await api.revokePlatformKey(platform, keyId);
        setRegistered((r) => ({ ...r, [platform]: view }));
      } catch (e) {
        notify.error(formatAppError(e));
      }
    });
  };

  const revokeSigningKey = async (platform: string, label: string, keyId: string) => {
    const ok = await confirmDestructiveAction({
      title: "Revoke signing key",
      message: `Remove the signing key of "${label}" from the ${platformLabel(platform)} account? Commits signed with it stop showing as verified there.`,
      confirmLabel: "Revoke",
    });
    if (!ok) return;
    return run(async () => {
      try {
        const view = await api.revokePlatformSigningKey(platform, keyId);
        setRegistered((r) => ({ ...r, [platform]: view }));
      } catch (e) {
        notify.error(formatAppError(e));
      }
    });
  };

  /** The combined one-click signing setup: ensure the identity has a key
   *  (generating one and wiring it into the profile when needed), register
   *  it on the account for auth and signing (GitLab's signing registration
   *  covers both; GitHub keeps separate lists), add the identity to
   *  ~/.ssh/allowed_signers so local verification works, and write the
   *  signing config (profile fields, or the global git config for the
   *  default identity). */
  /** An identity row's owner: a profile, a WSL distro's default keys, or
   *  (both null) the app machine's default keys. */
  const setupSigning = (
    platform: string,
    profile: GitProfile | null,
    statuses: SshKeyStatus[],
    authConnected: boolean,
    distro: string | null,
  ) =>
    run(async () => {
      try {
        let status = statuses.find((s) => s.public_key) ?? null;
        if (!status) {
          if (distro) {
            status = await api.wslGenerateSshKey(distro, "id_ed25519", "ed25519", "");
          } else {
            const fileName = profile ? `id_ed25519_${profileNameSlug(profile.name)}` : "id_ed25519";
            status = await api.generateSshKey(fileName, "ed25519", profile?.userEmail ?? "");
          }
        }
        if (!status.public_key) {
          notify.error(`${status.private_key_path}.pub is missing, so the key cannot be registered`);
          return;
        }
        const title = titleFor(status.private_key_path, distro);
        if (!authConnected && platform !== "gitlab") {
          await api.uploadSshKeyToPlatform(platform, title, status.public_key);
        }
        await api.uploadSshSigningKeyToPlatform(platform, title, status.public_key);
        const email = distro
          ? ((await wslIdentityView(distro)).email_resolved.value ?? "")
          : profile
            ? (profile.userEmail ?? "")
            : ((await globalIdentityView()).email_resolved.value ?? "");
        const signersPath =
          email.trim() === ""
            ? null
            : distro
              ? await api.wslRegisterAllowedSigner(distro, email, status.public_key)
              : await api.registerAllowedSigner(email, status.public_key);
        const pubPath = `${status.private_key_path}.pub`;
        if (profile) {
          await api.updateGitProfile({
            ...profile,
            authSshKey: status.private_key_path,
            gpgFormat: "ssh",
            signingKey: pubPath,
            commitGpgsign: "true",
            allowedSignersFile: signersPath ?? profile.allowedSignersFile,
          });
        } else if (distro) {
          // Same preserve-on-null rule as the local global config below.
          const current = (await wslSigningConfig(distro)).allowed_signers.global.value;
          await wslWriteSigning(distro, "true", "ssh", pubPath, signersPath ?? current);
        } else {
          // `null` would UNSET gpg.ssh.allowedSignersFile: keep the current
          // value when no new path was produced.
          const current = (await globalSigningConfig()).allowed_signers.global.value;
          await globalWriteSigning("true", "ssh", pubPath, signersPath ?? current);
        }
      } catch (e) {
        notify.error(formatAppError(e));
      }
      load();
    });

  /** Generate a key for the identity (naming it after the profile, wiring it
   *  into the profile's `auth_ssh_key`; for a distro row, generating inside
   *  the distro), then upload it to the account. */
  const createAndUploadKey = (platform: string, profile: GitProfile | null, distro: string | null) =>
    run(async () => {
      try {
        let status: SshKeyStatus;
        if (distro) {
          status = await api.wslGenerateSshKey(distro, "id_ed25519", "ed25519", "");
        } else {
          const fileName = profile ? `id_ed25519_${profileNameSlug(profile.name)}` : "id_ed25519";
          status = await api.generateSshKey(fileName, "ed25519", profile?.userEmail ?? "");
          if (profile) {
            await api.updateGitProfile({ ...profile, authSshKey: status.private_key_path });
          }
        }
        if (status.public_key) {
          await api.uploadSshKeyToPlatform(
            platform,
            titleFor(status.private_key_path, distro),
            status.public_key,
          );
        }
      } catch (e) {
        notify.error(formatAppError(e));
      }
      load();
    });

  useEffect(() => {
    api.listDeviceFlowPlatforms().then(setOauthPlatforms).catch(() => setOauthPlatforms([]));
    return () => {
      if (oauthRun.current) oauthRun.current.cancelled = true;
    };
  }, []);

  const platformLabel = (id: string) => SSH_PLATFORMS.find((p) => p.id === id)?.label ?? id;

  const startOauth = async (platformId: string) => {
    setError(null);
    if (oauthRun.current) oauthRun.current.cancelled = true;
    const run = { cancelled: false };
    oauthRun.current = run;
    try {
      const start = await api.connectAccountOauthStart(platformId);
      if (run.cancelled) return;
      copyText(start.user_code).catch(() => {});
      setOauth({
        platform: platformId,
        userCode: start.user_code,
        verificationUri: start.verification_uri,
        status: "waiting",
      });
      let intervalSecs = start.interval_secs;
      const deadline = Date.now() + start.expires_in_secs * 1000;
      while (!run.cancelled && Date.now() < deadline) {
        await sleep(intervalSecs * 1000);
        if (run.cancelled) return;
        const result = await api.connectAccountOauthPoll(platformId, start.device_code);
        if (run.cancelled) return;
        if (result.kind === "connected") {
          setOauth(null);
          load();
          return;
        }
        if (result.kind === "denied" || result.kind === "expired") {
          const status = result.kind;
          setOauth((s) => (s ? { ...s, status } : s));
          return;
        }
        if (result.kind === "slow_down") intervalSecs += 5;
      }
      if (!run.cancelled) setOauth((s) => (s ? { ...s, status: "expired" } : s));
    } catch (e) {
      if (!run.cancelled) {
        setError(formatAppError(e));
        setOauth(null);
      }
    }
  };

  const cancelOauth = () => {
    if (oauthRun.current) oauthRun.current.cancelled = true;
    setOauth(null);
  };

  /** Disconnect keeps the entry (cached keys stay visible); remove forgets
   *  it entirely. Neither touches keys registered on the platform. */
  const doDisconnect = (id: string, removeEntry: boolean) =>
    run(async () => {
      setError(null);
      try {
        if (removeEntry) await api.removeAccount(id);
        else await api.disconnectAccount(id);
        setConfirmingDisconnect(null);
        load();
      } catch (e) {
        setError(formatAppError(e));
      }
    });

  const onDisconnect = (id: string, removeEntry: boolean) => {
    if (!confirmDestructive) return void doDisconnect(id, removeEntry);
    setConfirmingDisconnect(id);
  };

  if (!accounts) {
    return <Section title="Connected accounts"><span className="legit-subtle">Loading…</span></Section>;
  }

  return (
    <Section title="Connected accounts">
      <FieldNote>
        writes to: the OS keychain (the token itself) and global settings (the
        account name). Used for HTTPS push/pull and one-click SSH-key upload.
        LeGit stores no secrets in its files.
      </FieldNote>

      <div style={{ marginTop: "0.667em", display: "flex", flexDirection: "column", gap: "0.5em" }}>
        {SSH_PLATFORMS.map((p) => {
          const Logo = PLATFORM_ICONS[p.id];
          const status = accounts.find((s) => s.account.platform === p.id) ?? null;
          const a = status?.account ?? null;
          const tokenPresent = status?.token_present ?? false;
          const flowHere = oauth?.platform === p.id ? oauth : null;
          return (
            <div
              key={p.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5em",
                padding: "0.5em 0.667em",
                background: "var(--button-hover-bg)",
                borderRadius: 4,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.667em" }}>
                <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: "0.5em" }}>
                  {Logo && <Logo />}
                  <span style={{ fontWeight: 600 }}>{p.label}</span>
                  {a ? (
                    <span className="legit-subtle">
                      {a.display_name ? `${a.display_name} (${a.username})` : a.username}
                    </span>
                  ) : (
                    <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
                      not connected
                    </span>
                  )}
                  {a && !tokenPresent && (
                    <span style={{ color: "var(--warning-fg)", fontSize: "var(--fz-sm)" }}>
                      disconnected
                    </span>
                  )}
                </div>
                {a &&
                  (confirmingDisconnect === p.id ? (
                    <>
                      <span style={{ fontSize: "var(--fz-sm)" }}>
                        {tokenPresent
                          ? "Remove the token from the keychain?"
                          : "Forget this account and its cached key list? (keys on the platform are kept)"}
                      </span>
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => doDisconnect(p.id, !tokenPresent)}
                      >
                        {tokenPresent ? "Disconnect" : "Remove"}
                      </Button>
                      <button disabled={busy} onClick={() => setConfirmingDisconnect(null)}>Cancel</button>
                    </>
                  ) : (
                    <button disabled={busy} onClick={() => onDisconnect(p.id, !tokenPresent)}>
                      {(tokenPresent ? "Disconnect" : "Remove") + (confirmDestructive ? "…" : "")}
                    </button>
                  ))}
              </div>
              {a && tokenPresent && p.id === "azure_devops" && (
                <div style={{ display: "flex", alignItems: "center", gap: "0.5em", flexWrap: "wrap" }}>
                  <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
                    Azure DevOps has no SSH-key API: add keys in the browser.
                  </span>
                  <button
                    disabled={busy}
                    onClick={() =>
                      api.openPlatformKeySettings(p.id).catch((e) => notify.error(formatAppError(e)))
                    }
                  >
                    Open key settings…
                  </button>
                </div>
              )}
              {a && p.id !== "azure_devops" && (
                <AccountIdentityMatrix
                  platform={p.id}
                  view={registered[p.id]}
                  defaultKeys={defaultKeys}
                  distroKeys={distroKeys}
                  profiles={profiles}
                  profileKeys={profileKeys}
                  busy={busy}
                  onUpload={(status, distro) => uploadKey(p.id, status, distro)}
                  onCreate={(profile, distro) => createAndUploadKey(p.id, profile, distro)}
                  onRevoke={(label, keyId) => revokeKey(p.id, label, keyId)}
                  onSetupSigning={(profile, statuses, authConnected, distro) =>
                    setupSigning(p.id, profile, statuses, authConnected, distro)
                  }
                  onRevokeSigning={(label, keyId) => revokeSigningKey(p.id, label, keyId)}
                />
              )}
              {flowHere ? (
                flowHere.status === "waiting" ? (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.667em", flexWrap: "wrap" }}>
                      <code style={{ fontSize: "var(--fz-xl)", fontWeight: 600, letterSpacing: "0.1em" }}>
                        {flowHere.userCode}
                      </code>
                      <button onClick={() => copyText(flowHere.userCode).catch(() => {})}>Copy code</button>
                      <button onClick={cancelOauth}>Cancel</button>
                    </div>
                    <FieldNote>
                      Waiting for authorization: the code is copied - enter it on the{" "}
                      {p.label} page that opened in the browser
                      {" "}(<code>{flowHere.verificationUri}</code>).
                    </FieldNote>
                  </>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5em", flexWrap: "wrap" }}>
                    <span style={{ color: "var(--warning-fg)", fontSize: "var(--fz-sm)" }}>
                      {flowHere.status === "denied"
                        ? "The authorization was declined."
                        : "The code expired before the sign-in finished."}
                    </span>
                    <Button variant="primary" onClick={() => startOauth(p.id)}>Try again</Button>
                    <button onClick={cancelOauth}>Dismiss</button>
                  </div>
                )
              ) : (
                !tokenPresent && (
                  <ConnectControls
                    platform={p.id}
                    canOauth={oauthPlatforms.includes(p.id)}
                    reconnect={a !== null}
                    disabled={busy}
                    onOauth={() => startOauth(p.id)}
                    onConnected={load}
                  />
                )
              )}
            </div>
          );
        })}
      </div>

      {error && <pre className="legit-error" style={{ marginTop: "0.5em" }}>{error}</pre>}
    </Section>
  );
}

/**
 * Connect (or reconnect) one platform from inside its block: browser
 * sign-in where an OAuth app is registered, pasted PAT otherwise or as the
 * fallback. The PAT error renders next to its input (the allowed adjacency
 * exception).
 */
function ConnectControls({
  platform,
  canOauth,
  reconnect,
  disabled,
  onOauth,
  onConnected,
}: {
  platform: string;
  canOauth: boolean;
  /** An account entry exists (token missing): connecting replaces it. */
  reconnect: boolean;
  disabled: boolean;
  onOauth: () => void;
  onConnected: () => void;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useDelayedBusy();
  const off = disabled || busy;

  const connect = () => {
    if (token.trim() === "") return;
    return run(async () => {
      setError(null);
      try {
        await api.connectAccountPat(platform, token);
        setToken("");
        onConnected();
      } catch (e) {
        setError(formatAppError(e));
      }
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5em" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5em", flexWrap: "wrap" }}>
        {canOauth && (
          <Button variant="primary" disabled={off} onClick={onOauth}>
            {reconnect ? "Sign in again with the browser…" : "Sign in with the browser…"}
          </Button>
        )}
        <input
          style={{ flex: 1, minWidth: "12em" }}
          type="password"
          value={token}
          placeholder="Personal access token"
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") connect(); }}
          disabled={off}
        />
        <Button
          variant={canOauth ? undefined : "primary"}
          disabled={off || token.trim() === ""}
          onClick={connect}
        >
          {busy ? "Connecting…" : canOauth ? "Connect with token" : "Connect"}
        </Button>
        <button
          disabled={off}
          title="Open the platform's token-creation page in the browser"
          onClick={() => api.openPlatformTokenSettings(platform).catch((e) => setError(formatAppError(e)))}
        >
          Create a token…
        </button>
      </div>
      <FieldNote>{TOKEN_HINTS[platform]}</FieldNote>
      {error && <pre className="legit-error" style={{ margin: 0 }}>{error}</pre>}
    </div>
  );
}

/**
 * One row per identity (the default ~/.ssh keys, then every profile),
 * each showing its standing against THIS account's registered keys:
 * connected (with a revoke action), upload the existing key, or
 * create-and-upload a new one. Matching is by key material, so several
 * profiles may share one account (each with its own key, or sharing a key
 * file). A non-live view (disconnected account, platform unreachable) shows
 * the cached last-verified state and offers no actions.
 */
function AccountIdentityMatrix({
  platform,
  view,
  defaultKeys,
  distroKeys,
  profiles,
  profileKeys,
  busy,
  onUpload,
  onCreate,
  onRevoke,
  onSetupSigning,
  onRevokeSigning,
}: {
  platform: string;
  /** The account's registered keys; `null` = unreadable and nothing cached,
   *  `undefined` = loading. */
  view: PlatformKeysView | null | undefined;
  defaultKeys: SshKeyStatus[];
  /** Default keys of each RUNNING WSL distribution, keyed by distro name. */
  distroKeys: Record<string, SshKeyStatus[]>;
  profiles: GitProfile[];
  profileKeys: Record<string, SshKeyStatus>;
  busy: boolean;
  onUpload: (status: SshKeyStatus, distro: string | null) => void;
  onCreate: (profile: GitProfile | null, distro: string | null) => void;
  onRevoke: (identityLabel: string, keyId: string) => void;
  onSetupSigning: (
    profile: GitProfile | null,
    statuses: SshKeyStatus[],
    authConnected: boolean,
    distro: string | null,
  ) => void;
  onRevokeSigning: (identityLabel: string, keyId: string) => void;
}) {
  if (view === undefined) {
    return (
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
        Checking the account's keys…
      </span>
    );
  }
  if (view === null) {
    return (
      <span style={{ color: "var(--warning-fg)", fontSize: "var(--fz-sm)" }}>
        Could not read the account's SSH keys (the token may lack the key scope).
      </span>
    );
  }
  const registered = view.keys.map((k) => k.key);

  const rows: {
    key: string;
    label: string;
    statuses: SshKeyStatus[];
    profile: GitProfile | null;
    distro: string | null;
  }[] = [
    {
      key: "default",
      label: "Default keys (~/.ssh)",
      statuses: defaultKeys.filter((k) => k.exists),
      profile: null,
      distro: null,
    },
    ...profiles.map((p) => ({
      key: p.id,
      label: p.name,
      statuses: p.authSshKey
        ? [profileKeys[p.id] ?? { private_key_path: p.authSshKey, exists: false, public_key: null }]
        : [],
      profile: p,
      distro: null,
    })),
    ...Object.entries(distroKeys).map(([name, keys]) => ({
      key: `wsl:${name}`,
      label: `Default keys (WSL: ${name})`,
      statuses: keys.filter((k) => k.exists),
      profile: null,
      distro: name,
    })),
  ];

  const signingKeys = view.signing_keys ?? null;
  const subtle = { fontSize: "var(--fz-sm)" } as const;

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: signingKeys
            ? "max-content minmax(0, 1fr) minmax(0, 1fr)"
            : "max-content minmax(0, 1fr)",
          columnGap: "0.667em",
          rowGap: "0.333em",
          alignItems: "center",
        }}
      >
        {signingKeys && (
          <>
            <span />
            <span className="legit-subtle" style={subtle}>Authentication</span>
            <span className="legit-subtle" style={subtle}>Signing</span>
          </>
        )}
        {rows.map((row) => {
          const state = identityKeyState(row.statuses, registered);
          const usable = row.statuses.filter((s) => s.public_key);
          const match = usable
            .map((s) => findRegisteredKey(s.public_key!, view.keys))
            .find((m) => m !== null);
          const signingMatch = signingKeys
            ? (usable.map((s) => findRegisteredKey(s.public_key!, signingKeys)).find((m) => m !== null) ?? null)
            : null;
          return (
            <Fragment key={row.key}>
              <span style={{ fontSize: "var(--fz-sm)", whiteSpace: "nowrap" }}>{row.label}</span>
              {/* Reserve the button height even for text-only states so rows
                  with and without a button stay the same height. */}
              <div style={{ display: "flex", alignItems: "center", gap: "0.5em", minWidth: 0, minHeight: "2em" }}>
                {state.kind === "connected" && (
                  <>
                    <span style={{ color: "var(--success-fg)", fontSize: "var(--fz-sm)", fontWeight: 600 }}>
                      ✓ Connected
                    </span>
                    {view.live && match && (
                      <button disabled={busy} onClick={() => onRevoke(row.label, match.id)}>
                        Revoke…
                      </button>
                    )}
                  </>
                )}
                {state.kind === "upload" &&
                  (view.live ? (
                    <button disabled={busy} onClick={() => onUpload(state.status, row.distro)}>
                      Upload key
                    </button>
                  ) : (
                    <span className="legit-subtle" style={subtle}>Not registered</span>
                  ))}
                {state.kind === "create" &&
                  (view.live ? (
                    <button disabled={busy} onClick={() => onCreate(row.profile, row.distro)}>
                      Create & upload key
                    </button>
                  ) : (
                    <span className="legit-subtle" style={subtle}>No key</span>
                  ))}
                {state.kind === "missing_file" && (
                  <span style={{ color: "var(--warning-fg)", fontSize: "var(--fz-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    Key file missing (<code>{state.path}</code>)
                  </span>
                )}
              </div>
              {signingKeys && (
                <div style={{ display: "flex", alignItems: "center", gap: "0.5em", minWidth: 0, minHeight: "2em" }}>
                  {signingMatch ? (
                    <>
                      <span style={{ color: "var(--success-fg)", fontSize: "var(--fz-sm)", fontWeight: 600 }}>
                        ✓ Signing
                      </span>
                      {view.live && (
                        <button disabled={busy} onClick={() => onRevokeSigning(row.label, signingMatch.id)}>
                          Revoke…
                        </button>
                      )}
                    </>
                  ) : view.live ? (
                    state.kind !== "missing_file" && (
                      <button
                        disabled={busy}
                        title="Create the key if needed, register it for authentication and signing, and configure signed commits for this identity"
                        onClick={() =>
                          onSetupSigning(row.profile, row.statuses, state.kind === "connected", row.distro)
                        }
                      >
                        Set up signing
                      </button>
                    )
                  ) : (
                    <span className="legit-subtle" style={subtle}>Not set up</span>
                  )}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      {!signingKeys && (
        <span className="legit-subtle" style={subtle}>
          Signing-key status unavailable: reconnect the account to grant the signing permission.
        </span>
      )}
      {!view.live && (
        <span className="legit-subtle" style={subtle}>
          Showing the last verified state
          {view.checked_at ? ` (${new Date(view.checked_at).toLocaleString()})` : ""} - sign in
          again to refresh and manage keys.
        </span>
      )}
    </>
  );
}

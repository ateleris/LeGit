# GitHub account connect via the OAuth device flow

Status: shipped 2026-10-08. Connecting a GitHub account no longer requires a
hand-created PAT: the user clicks "Sign in with the browser", enters a short
code on github.com, and LeGit receives the token. The PAT path stays as the
universal fallback (and the only path for GitLab / Azure DevOps).

## Where the client ID is configured

`Platform::device_flow_client_id` in `crates/legit-providers/src/lib.rs`
holds the OAuth client ID per platform; `device_flow_config` next to it
holds the endpoints and scopes. A client ID is a public identifier (the
device flow involves no client secret), which is why it is committed.
`None` for a platform means "no registered app": the UI then offers only
the PAT path, driven by the `list_device_flow_platforms` command.

## The app registration behind the client ID

The ID belongs to a GitHub OAuth app named "LeGit" (GitHub > Settings >
Developer settings > OAuth Apps). Its registration must have:

- **Device Flow: enabled.** Without it every poll answers
  `device_flow_disabled`.
- **"Expire user access tokens": OFF is recommended** (fewer moving
  parts), but no longer required: since 2026-10-09 LeGit refreshes
  expiring tokens automatically (see "Expiring tokens and refresh"
  below), so an app with expiration on also works.
- The callback URL is required by the form but unused by the device flow
  (set to the homepage).

The app is currently registered under a personal account and is planned to
be transferred to the Ateleris GitHub org (transfer keeps the client ID, so
no code change). Until the transfer, orgs with OAuth app access
restrictions must approve the app before its tokens reach org-private
repos; an org-owned app is trusted by that org automatically.

Rotating or re-registering the app means replacing the constant; old
tokens users obtained keep working until revoked (they belong to the app
registration, which rotation does not delete).

## Flow shape

- Scopes: `repo admin:public_key admin:ssh_signing_key` - the same ones the
  PAT-creation deep link prefills (HTTPS push/pull, SSH-key upload, signing
  keys). Tokens connected before the signing scope was added cannot manage
  signing keys; the UI maps GitHub's 403/404 on those endpoints to a
  "reconnect to grant it" message, and the key matrix shows signing status
  as unavailable until the reconnect.
- `connect_account_oauth_start` obtains the codes and opens the
  verification page; the frontend shows the user code (auto-copied) and
  owns the polling loop (one `connect_account_oauth_poll` call per
  interval; `slow_down` adds 5s per RFC 8628), so Cancel is just "stop
  calling".
- A successful poll stores the token exactly like a connected PAT
  (`store_connected_token`: validate "who am I", OS keychain under the
  broker's `https://<host>` key, metadata in global settings).
- GitHub signals flow states (`authorization_pending`, `slow_down`,
  `access_denied`, `expired_token`) as error codes in HTTP 200 bodies;
  `classify_device_poll` reads the body, never the status, and is
  unit-tested against canned responses.

## Expiring tokens and refresh (added 2026-10-09)

Token responses are parsed as a full set (`TokenSet`: access token +
optional refresh token + optional `expires_in`). When a refresh token is
present, `crate::oauth` (src-tauri) persists it in a SIDECAR keychain
entry (`oauth-refresh:https://<host>`, same keyring service) holding
`{platform, username, refresh_token, expires_at}`; the access token stays
in the broker's normal `https://<host>` entry, so settings files still
hold no secrets and PATs/non-expiring tokens have no sidecar at all.

`oauth::ensure_fresh(broker_key)` runs before BOTH token uses - the
platform API calls (`read_platform_token`) and the credential broker's
`get` (git over HTTPS, including requests relayed from the WSL agent).
When the stored expiry is within a 2-minute margin it exchanges the
refresh token (`refresh_oauth_token`, RFC 6749 §6) and re-stores both
entries, evicting the broker's session cache. Constraints encoded there:

- **Refresh tokens are single-use on GitLab** (rotated per exchange, and
  reuse can revoke the whole token family): refreshes are serialized by a
  global lock and the record is RE-read under it before exchanging.
- `invalid_grant` means the refresh token itself is dead: the sidecar is
  dropped (stop re-trying), the stale access token stays, and its next
  rejection surfaces the normal "reconnect" classification. Transient
  failures (offline) change nothing.
- git `erase`s rejected credentials, which deletes the access entry of an
  expired token: the sidecar carries the git username so `ensure_fresh`
  can recreate the entry from a refresh alone.
- The stored git USERNAME for an OAuth connect comes from
  `Platform::oauth_git_username`: GitLab only accepts OAuth tokens over
  HTTPS as `oauth2:<token>` (PATs take any username); GitHub uses the
  account username as before.

GitLab API calls authenticate with `Authorization: Bearer` (switched from
`PRIVATE-TOKEN`): PATs work under both headers, OAuth tokens only as
Bearer.

## GitLab: only the app registration is missing

`device_flow_config` already carries the GitLab endpoints
(`/oauth/authorize_device`, `/oauth/token`, scope `api`); the connect
button appears as soon as `device_flow_client_id` returns an ID for
GitLab. To register (gitlab.com > User settings > Applications - or a
group-owned application under the Ateleris group, preferred for the same
reason as the GitHub org transfer):

- Name "LeGit"; scope **api** (git over HTTPS + user/key endpoints).
- **Confidential: OFF** - the device flow runs without a client secret.
- The redirect URI field is required by the form but unused by the device
  flow (`urn:ietf:wg:oauth:2.0:oob` is the conventional filler).
- GitLab.com supports the device grant (RFC 8628) since GitLab 17.2; no
  per-app opt-in needed.

Tokens expire after 2h and refresh automatically (section above).

## Why not Azure DevOps yet

Azure DevOps needs a Microsoft Entra app registration and the device code
flow against the Microsoft identity platform. Stays on the BACKLOG
platform-integrations entry.

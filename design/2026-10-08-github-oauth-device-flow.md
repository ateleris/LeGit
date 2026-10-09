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
- **"Expire user access tokens": OFF.** LeGit has no refresh-token
  handling; with expiration on, tokens die after 8 hours and HTTPS pushes
  silently start failing mid-day.
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

## Why not GitLab / Azure DevOps yet

- GitLab supports the device grant, but its OAuth tokens expire after 2
  hours: shipping it needs refresh-token handling in the credential broker
  first.
- Azure DevOps needs a Microsoft Entra app registration and the device
  code flow against the Microsoft identity platform.

Both stay on the BACKLOG platform-integrations entry.

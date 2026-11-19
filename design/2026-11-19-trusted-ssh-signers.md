# Trusted SSH signers (trust-this-signer + guided setup)

Status: approved design, not yet implemented.

## Intent

Commits with a valid SSH signature whose key is not in
`gpg.ssh.allowedSignersFile` show as "?" (`SignatureStatus::Untrusted`), and
when no signers file is configured at all, every SSH-signed commit does. The
user has no in-app way to say "I trust this person". Add a one-click,
confirm-gated "Trust this signer" action in Commit Details, a guided setup
path when no signers file is configured yet, and a small management view so
trust decisions are inspectable and reversible.

## Goals

- From an Untrusted commit, trust its signer in one confirmed click; the open
  Commit Details panel re-verifies and flips to "Good" without a restart.
- When `gpg.ssh.allowedSignersFile` is unconfigured, the same action offers to
  create a file and set it in the global git config of the repo's host, so
  command-line `git verify-commit` benefits too.
- A "Trusted signers" list (principal, key type, fingerprint) with a remove
  action in the global settings near the existing signing config, listing
  signers **per configured file**: each host's global file plus each
  profile-referenced file, so profile-backed repos are never a blind spot.
- Works identically for `wsl://` repos: file and config live in the distro,
  reached through the Host seam.

## Non-goals

- GPG key import / ownertrust (`UnknownKey` on GPG commits keeps its current
  presentation; no trust action).
- Per-repo trust scopes (trust is in a person, not a repo).
- Cross-checking fingerprints against GitHub/GitLab (backlog candidate).
- Editing principals or key options of existing entries; management is
  list + remove only.

## Anti-goals

- Never trust silently or by default; every trust addition goes through the
  confirm dialog (a workflow prompt, always shown - it is a security decision,
  not a destructive one, so it is NOT gated by the destructive-confirm
  setting).
- Never store trust in LeGit-private state: the single source of truth is the
  allowed-signers file that git itself reads.
- Never rewrite a hand-maintained signers file: mutations append one line or
  remove exactly one matched line; all other bytes (comments, exotic entries,
  ordering) are preserved.

## Constraints

- The bulk log must never verify signatures (existing invariant); verification
  stays on-demand in `commit_details`.
- Commands never compose git flows: the git-touching sequences live as
  backend methods covered by `flow_tests/` + `git_flows.rs`; decision logic is
  pure and unit-tested.
- Repo-host file access goes through the Host fs seam (`HostPath`), never raw
  `std::fs` - the signers file lives on the host that runs git.
- All new UI colours via theme tokens; dialog via `confirmDialog` host;
  busy feedback follows the delayed-150ms rule.

## Approaches considered

1. **Trust button only**, using an already-configured signers file; disabled
   hint otherwise. Rejected: most users have never configured verification,
   which is exactly why they see "?" - the button would be dead weight.
2. **Trust button + guided setup + management list** (chosen): the button
   also bootstraps the signers file + global config when unset, and a
   settings view lists/removes entries so a mis-click is fixable in-app.
3. **Full trust manager** (per-repo scopes, forge key cross-check). Rejected:
   per-repo trust contradicts the trust model; cross-check is a separable
   later feature.

## Design

### Trust model

TOFU (trust on first use), like SSH `known_hosts`: the public key comes from
the commit's own signature, the user confirms email + fingerprint. The
principal is the **committer email** of the inspected commit (that is the
identity git hands to ssh-keygen for matching). The appended entry is:

```
<committer-email> namespaces="git" <keytype> <base64-key>
```

If the same key is later seen under a different committer email, trusting it
appends a second line for that principal (keys may serve multiple
principals); an exact principal+key duplicate is a silent no-op reported as
success.

Trust domains (decided with the user): `gpg.ssh.allowedSignersFile` is
single-valued and unmerged in git, so a repo-local value *replaces* global
trust for that repo. LeGit's profile system writes the profile's
`allowed_signers_file` at local scope, which makes the profile a coherent
trust domain (e.g. a company-distributed roster vs personal trust). The
feature embraces that: trust always lands in the repo's **effective** file
(anything else would not turn the badge green), the dialog names the target
file, and management enumerates the distinct configured files rather than
assuming one per host. Profiles without a signers file inherit the host
global file, so single-domain users live entirely in that one file.

### Getting the public key

The `gpgsig` header of the commit object contains an armored SSHSIG blob,
which embeds the signer's full wire-encoded public key. New pure parser in
`cli_impl/parsers/` (feeding on the `cat-file -p` output `commit_details`
already fetches):

- strip the `-----BEGIN/END SSH SIGNATURE-----` armor, base64-decode;
- parse the SSHSIG wire format: 6-byte magic `SSHSIG`, u32 version, then a
  string field holding the public key blob (whose own first string field is
  the key type, e.g. `ssh-ed25519`);
- return key type + base64 of the key blob; any mismatch (GPG armor,
  `mergetag`, truncated data) returns None and the UI simply shows no trust
  action.

Unit tests use a real captured SSH signature. The fingerprint shown in the
dialog comes from the existing verify output (`key_id`, `SHA256:...`), so no
hashing is needed there.

### Resolving / bootstrapping the signers file

- Read effective `gpg.ssh.allowedSignersFile` via the existing config module
  on the repo's executor. Expand a leading `~` against the host's home
  directory (builder: the Host seam must expose or already exposes home
  lookup; `wsl://` repos resolve inside the distro).
- Configured but file missing: treated as configured; the file is created on
  first trust.
- Unconfigured: the trust dialog becomes the setup variant. On confirm:
  create `~/.config/git/allowed_signers` on the repo's host (creating parent
  dirs), write the entry, and set `gpg.ssh.allowedSignersFile` in the
  **global** git config of that host via the existing global/WSL signing
  config command path. The dialog text states both side effects plainly.

### Backend surface

New backend methods (exact seam split left to the builder, respecting
"pure decision logic in legit-core, host fs via Host seam"):

- `signer_trust_info(sha)` -> principal, key type, key blob, fingerprint,
  and the resolved signers-file state: unconfigured, or the effective path
  plus the scope it came from (local/global/system), so the dialog can name
  the target file and say when it is a profile/repo-scoped one.
  Frontend calls it when rendering the action for an Untrusted commit (or
  lazily on click; builder's call - prefer lazy to keep details rendering
  cheap).
- `trust_signer(principal, keytype, key, create_and_configure: bool)` ->
  appends (dedupe-aware); when bootstrapping, also creates the file and sets
  the global config.
- `list_allowed_signers(file)` / `remove_allowed_signer(file, entry)` ->
  take an explicit host path; the settings view enumerates the files to show
  (each host's global config value plus the `allowed_signers_file` of every
  profile, deduplicated by resolved path). Parse the file into entries (pure parser: principal(s), options, key type, key,
  original line index); removal deletes exactly the matched original line.
  Lines the parser cannot classify (comments, cert-authority, unknown
  options) are preserved and listed as opaque "unrecognized" rows without a
  remove action in v1 - display-only pass-through, never dropped on write.

Both composed flows get `flow_tests/` coverage (exact command sequence,
incl. the config write) and a `git_flows.rs` real-git case: sign with a key
absent from the signers file -> Untrusted; trust; re-verify -> Good (extend
the existing SSH-verification scenario around `git_flows_suite.rs:5210`).

Fingerprints for the settings list are computed from the stored key blob
(SHA256, base64, `SHA256:` prefix) - add the `sha2` crate (RustCrypto,
likely already in the lock transitively).

### UI

**Commit Details** - the signature row, when status is `Untrusted` and
pubkey extraction succeeds, gains one action button:

```
Signature  ? Unverified - signer not in allowed signers   [Trust this signer...]
```

Click -> `confirmDialog` (near pointer, Cancel-focused, Esc cancels):

- Configured: title "Trust this signer?", body naming the email, the key
  fingerprint, and the signers file the entry will be added to (so a
  profile-scoped file is visible at the moment of trusting), and stating
  that commits signed with this key will show as verified.
- Unconfigured: title "Set up signature verification?", same identity block,
  plus: a new allowed-signers file will be created at `~/.config/git/
  allowed_signers` and set in the global git config (named host/distro).

On confirm: run `trust_signer`, then clear the repo's entry in the signature
store and invalidate the commit-details query so the open panel re-verifies
and the badge flips. Errors surface as toasts (`notify.error`). Busy state
follows the 150ms-delayed rule with a re-entry guard.

**Settings** - a "Trusted signers" block in the global settings' signing
area: one group per configured signers file (each host's global file, named
like the existing per-scope sections in `GlobalGitConfigSection`, plus each
profile-referenced file labelled with the profile's name), showing the
resolved file path and a table of principal, key type, fingerprint; per-row
remove goes through `useMenuConfirm`-style destructive confirmation (THIS
one is a normal destructive confirm, gated by the global setting). An
empty/unconfigured state explains that trust is added from a commit's
details. Manifest entry
with searchable keywords ("signature", "signers", "trust", "ssh",
"verification"); mirrored group naming between panels where applicable.

### Cache invalidation

`src/store/signatures.ts` currently documents entries as never invalidated
("trust config changes are rare enough that a restart is acceptable"). That
assumption dies with this feature: add a `clearRepo(repoId)` action, called
after any trust mutation (add, remove, setup). Already-inspected commits
lose their chip until re-inspected - acceptable; the currently open details
panel re-verifies immediately via query invalidation. Update the store's
header comment accordingly.

### Copy / presentation tweaks

- `Untrusted` tooltip gains a pointer to the action ("open the commit to
  trust this signer").
- CHANGELOG bullet under Added: "Trust SSH commit signers from the commit
  details (with guided allowed-signers setup) and manage trusted signers in
  the settings".

## Left to the builder

- Exact placement of the fs glue (src-tauri command vs legit-core method
  taking an fs handle) - follow the closest existing precedent for
  non-repo-relative host file access (profile/SSH key handling).
- Lazy vs eager `signer_trust_info` fetch (prefer lazy on click).
- Dialog copy final wording; settings table layout using `primitives.tsx`.
- Whether `sha2` is already a transitive dep or needs adding to the
  workspace manifest.

## Calls made by Claude (not user-decided)

- Principal = committer email, non-editable in v1.
- Bootstrap path `~/.config/git/allowed_signers`, global-scope config write.
- Entries written with `namespaces="git"`.
- Unrecognized signers-file lines are preserved but not removable in-app.
- Management lives in global settings, grouped per configured signers file
  (decided with the user: profile files are deliberate trust domains, not a
  blind spot), not per repo.

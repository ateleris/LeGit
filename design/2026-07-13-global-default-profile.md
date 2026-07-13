# Global identity (identity parity for Global Settings)

Status: implemented 2026-07-13 (vitest/UI verification from PowerShell still
pending). Revised the same day: the first cut was a "default profile" picker
that applied any profile to `~/.gitconfig`; per discussion it became an
**edit-only, identity-only** section instead (decision log below).

## Problem

Global Settings and Repo Settings have two-scope parity for line endings and
signing, but identity (`user.name`, `user.email`) existed only at repo scope,
via profiles (applied `--local`). Most users have exactly one identity, and a
fresh machine could not set one from LeGit at all: the first commit failed
with git's "Please tell me who you are" until the user applied a profile to
that one repo or used the terminal.

## Decision

**One combined, edit-only "global git config" form in Global Settings**
(`GlobalGitConfigSection`): identity (`user.name`/`user.email`), commit
signing (`commit.gpgsign`, `gpg.format`, `user.signingkey`,
`gpg.ssh.allowedSignersFile`), and the HTTPS `credential.helper`, all inside
a single bordered panel with a single Save, styled like the profile editor
so it reads as ONE `~/.gitconfig` edit view. Live system-scope + resolved
values shown per key; empty field = unset; always an explicit
preview-and-confirm listing every changed key before the global write.
Line endings keep their own separate global section (rarely edited together
with these). The previous standalone global signing section is replaced by
this form (`SigningSettings` remains for Repo Settings).

Explicitly NOT a profile picker:

- **No profile applies at global scope.** The global config is fixed and
  edited in place; profiles remain the per-repo mechanism (that is exactly
  their use case). No `default_profile_id` state, no Active/Drift matching
  against `~/.gitconfig`.
- **`credential.helper` is globally editable, but only in the safe shape**:
  a single plain value (or unset), never the empty reset entry the per-repo
  apply uses: at global scope that entry would mask system-scope helpers
  (Git Credential Manager) machine-wide. Helpers accumulate across scopes,
  so the view shows global and system separately instead of one "resolved"
  value.
- **`core.sshCommand` is never written globally**: SSH auth stays per-repo
  via profiles.
- **No "copy from profile" prefill** (considered, rejected): per-repo
  profiles already cover "use this named bundle here".

Repos interact with the global config exactly as before: applying a profile
overrides it (git scope precedence), clearing the profile in Repo Settings
resets the repo to it.

## Implementation

- `src-tauri/src/commands/identity.rs`: `IdentityView` (name/email at
  global + system + resolved), `global_identity_view`,
  `global_write_identity` (unbound runner; `write_config_global`).
- `src-tauri/src/commands/credential_helper.rs`: `CredentialHelperView`
  (global + system entries; last non-empty entry per scope, unit-tested),
  `global_credential_helper_view`, `global_write_credential_helper`
  (reset-then-add single value; never the empty reset entry), and
  `list_available_credential_helpers` (helpers are executables, so
  availability is detectable: scans `git --exec-path` for
  `git-credential-*` - excluding the cache daemon - plus GCM/libsecret on
  PATH; filename parsing and the secure-first ranking are pure and
  unit-tested).
- `CredentialHelperField.tsx`: guided picker shared by the global form and
  the profile editor: dropdown of installed helpers with descriptions,
  known-but-missing ones greyed out, "Custom…" for values with arguments,
  and contextual guidance ("already handled by the system-scope helper" /
  "recommended on this machine").
- `repo_resolved_identity` (`profiles.rs`): `user.name`/`user.email` as git
  resolves them for a repo; both `None` means a commit would fail.
- UI: `GlobalGitConfigSection.tsx` (the combined bordered form; reuses
  `ConfigRow`/`ResolvedBadge`/`RadioGroup` exported from
  `SigningSettings.tsx`); Repo Settings' "Inherit" badge now shows the
  resolved inherited identity or a nothing-set warning; the Working Changes
  commit box warns when no identity resolves at any scope and links to
  Global Settings ("Set identity…").
- Real-git validation: `git_flows.rs` encodes the global-scope `git config`
  exit-code assumptions (`--unset-all` exits 5 on missing file/absent key;
  values round-trip via `--get-all`) with `GIT_CONFIG_GLOBAL` redirected
  into a tempdir through `run_with_env`, so tests never touch the real
  `~/.gitconfig`.

## Bug found in testing: local scope leaked into global views

The global views run on an UNBOUND runner, and an unbound runner inherits
the app process's cwd: under `tauri dev` that is inside the LeGit source
repo, so `read_config_all_scopes` (resolved = local > global > system)
showed "resolved: … (from local)" from a completely unrelated repo. The
pre-existing global line-endings and signing views had the same latent leak.
Fix: `config_util::read_config_global_scopes` (global + system only,
resolution extracted into the unit-tested `resolve_precedence`), used by all
three global views; `git_flows.rs` encodes why (`--global`-flagged reads are
immune to a repo cwd, unflagged reads are not).

## Decision log

- 2026-07-13: first implementation had `apply_profile_global` and friends
  plus a scope-generalized managed-key writer whose credential-helper plan
  differed per scope (no empty reset entry at global scope). Replaced the
  same day by the edit-only design: simpler (no global profile state), more
  consistent with the other Global Settings git-config sections, and
  strictly safer (no global auth writes exist at all). The scope
  generalization was reverted rather than kept as dead code.

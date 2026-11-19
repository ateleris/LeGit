# Trusted SSH Signers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Do NOT create git commits at any point** - the user commits manually. Where this plan says a task is done, leave the changes in the working tree. Do not create or switch branches.

**Goal:** One-click, confirm-gated trust for SSH commit signers (with guided allowed-signers setup) and a per-file trusted-signers management view in settings.

**Architecture:** Pure SSHSIG/allowed-signers logic in a new `legit_core::signers` module; composed flows as free async functions over `(&dyn GitExecutor, &dyn RepoFs)`, exposed repo-bound through two new `GitBackend` methods and settings-bound through new Tauri commands. Frontend adds a trust action to the Commit Details signature row and a per-file settings section.

**Tech Stack:** Rust (legit-core, src-tauri), React + TypeScript, specta bindings, sha2 (new direct dep, already in Cargo.lock transitively).

**Spec:** `design/2026-11-19-trusted-ssh-signers.md` (read it first; it carries the trust model and all user-decided calls).

## Global Constraints

- Never commit or push; leave all changes uncommitted (user rule, overrides any skill default).
- The bulk log must never verify signatures; verification stays in `commit_details`.
- Repo-host file access only via `RepoFs`/`HostPath`, never raw `std::fs` on repo-host paths.
- Signers-file mutations preserve all other bytes: append one line, or remove exactly one matched line.
- Entry format written by LeGit: `<principal> namespaces="git" <keytype> <base64>`.
- Bootstrap path (config value, unexpanded): `~/.config/git/allowed_signers`, written to **global** scope.
- Tilde expansion always happens on the host that runs git: `git config --type=path` (verified: `--show-scope --type=path --get` prints `scope\texpanded-path`, exit 1 when unset).
- The trust confirmation is a workflow prompt, always shown (NOT gated by the destructive-confirm setting); the settings-side remove IS a gated destructive confirm (`useConfirmDestructive`).
- No literal colours; no em-dashes or center dots in any output; comments only for non-derivable constraints.
- UI text sizes/dimensions derive from `--ui-font-size` / `--fz-*`.
- Output-only Rust types must not carry field-level `#[serde(default)]`.

## Review Focus

Failure modes the spec implies; each has its pinning test added to the owning task:

1. A hand-maintained signers file with comments, blank lines, multi-principal and option-carrying entries must survive an append and a remove byte-identical except for the one line (Task 2).
2. `verify-commit` reporting Untrusted for a GPG signature (no SSHSIG in the object) must yield `key: None` and no trust action, not a crash or a bogus entry (Task 1/4).
3. The signers file changing between list and remove (external edit) must make the remove fail with an error, not delete the wrong line (Task 2/5).
4. An unconfigured `gpg.ssh.allowedSignersFile` whose bootstrap write races a configured-but-missing file: trust with `bootstrap: false` against Unconfigured must error, never write a file git will not read (Task 4).
5. Multiple config entries for the key (git uses the last): resolution must take the last line of `--show-scope --get-all` style output (Task 3).

---

### Task 1: Pure SSHSIG public-key extraction (`legit_core::signers`, part 1)

**Files:**
- Create: `crates/legit-core/src/signers.rs` (register `pub mod signers;` in `crates/legit-core/src/lib.rs`)
- Modify: `crates/legit-core/src/types.rs` (new IPC types)
- Modify: `crates/legit-core/Cargo.toml` (add `sha2`, workspace-style like `base64`; add to root `Cargo.toml` `[workspace.dependencies]` if that is the project pattern)

**Interfaces:**
- Produces (types.rs, all `Serialize + Deserialize + Type`, derives matching `SignatureVerification`):
  - `pub struct SshSignerKey { pub key_type: String, pub key_b64: String, pub fingerprint: String }`
- Produces (signers.rs):
  - `pub fn extract_sshsig_armor(raw_object: &str) -> Option<String>` - pulls the `gpgsig ` header value plus its space-prefixed continuation lines from `git cat-file -p` output, returns the reassembled armored block; `None` when the header is absent or the armor is not `-----BEGIN SSH SIGNATURE-----` (GPG armor, `mergetag`).
  - `pub fn parse_sshsig_pubkey(armor: &str) -> Option<SshSignerKey>` - strips armor lines, base64-decodes, checks 6-byte magic `SSHSIG` + u32 version, reads the next SSH wire string (u32 length-prefixed) as the public key blob; the blob's own first wire string is `key_type`; `key_b64` is the base64 of the whole blob; `fingerprint` is `"SHA256:"` + unpadded base64 of the blob's SHA-256.

- [ ] **Step 1: Write failing unit tests in `signers.rs` `#[cfg(test)]`**

Fixture captured from real `ssh-keygen -Y sign -n git` (ed25519):

```rust
const SAMPLE_ARMOR: &str = "-----BEGIN SSH SIGNATURE-----\n\
U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgGgs4DPYouR7YDhk0ErtrScaFek\n\
TSkA31EP6lvsqOj/IAAAADZ2l0AAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1lZDI1NTE5\n\
AAAAQOZ6F+q2sc+tO2hVJv1guIGe8QxCQSpj8ld6EMp76g8TcMrESD0QUnEik2fDQGrvuV\n\
I887k4vDkdncGGeN6+Vwo=\n\
-----END SSH SIGNATURE-----";
```

Tests and their assertions:
- `parses_real_sshsig_pubkey`: `parse_sshsig_pubkey(SAMPLE_ARMOR)` yields `key_type == "ssh-ed25519"`, `key_b64 == "AAAAC3NzaC1lZDI1NTE5AAAAIBoLOAz2KLke2A4ZNBK7a0nGhXpE0pAN9RD+pb7Kjo/y"`, `fingerprint == "SHA256:z32N43bv72WO4aL/FvB4GVxkbkSYGUzMh1XCuQCfTjs"` (all three values verified against `ssh-keygen -lf`).
- `rejects_gpg_armor`: input starting `-----BEGIN PGP SIGNATURE-----` returns `None`.
- `rejects_truncated_blob`: SAMPLE_ARMOR with its last body line dropped returns `None` (no panic).
- `extracts_armor_from_cat_file_output`: a raw commit object string with `gpgsig <first armor line>` + ` `-prefixed continuation lines returns the reassembled armor; an object without `gpgsig` and one with a PGP armor return `None`.

- [ ] **Step 2: Run tests, verify they fail to compile/run** - `cargo test -p legit-core signers` from repo root.
- [ ] **Step 3: Implement the two functions + `SshSignerKey`.** Wire-format reads are plain length-prefixed slices; no new error types - every malformed input is `None`.
- [ ] **Step 4: Run `cargo test -p legit-core signers` - all pass.**

### Task 2: Pure allowed-signers file logic (`legit_core::signers`, part 2)

**Files:**
- Modify: `crates/legit-core/src/signers.rs`
- Modify: `crates/legit-core/src/types.rs`

**Interfaces:**
- Produces (types.rs):
  - `pub struct AllowedSigner { pub line_index: u32, pub principal: String, pub key_type: String, pub key_b64: String, pub fingerprint: String }` (principal holds a comma-separated list verbatim when the line has one)
  - `pub struct UnrecognizedSignerLine { pub line_index: u32, pub text: String }`
- Produces (signers.rs):
  - `pub fn format_signer_entry(principal: &str, key_type: &str, key_b64: &str) -> String` -> `{principal} namespaces="git" {key_type} {key_b64}`
  - `pub fn parse_allowed_signers(text: &str) -> (Vec<AllowedSigner>, Vec<UnrecognizedSignerLine>)` - skips blank and `#` comment lines silently; a line parses as `principals [options...] keytype base64 [comment]` where option tokens are `cert-authority` or contain `=`; a quoted option value containing whitespace, or any line that does not fit, becomes an `UnrecognizedSignerLine`. `cert-authority` lines are also Unrecognized (not removable per spec).
  - `pub fn append_signer(text: &str, principal: &str, key_type: &str, key_b64: &str) -> Option<String>` - `None` when an exact principal+key_b64 duplicate exists among parsed entries; otherwise returns text + one new line (ensuring exactly one trailing `\n` separates it; original bytes untouched).
  - `pub fn remove_signer_line(text: &str, line_index: u32, expected_principal: &str) -> Option<String>` - `None` unless the line at `line_index` currently parses to an `AllowedSigner` with that principal; removes exactly that line.

- [ ] **Step 1: Write failing unit tests.** One fixture file exercising Review Focus 1 and 3:

```rust
const FILE: &str = "# team roster\n\
alice@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBoLOAz2KLke2A4ZNBK7a0nGhXpE0pAN9RD+pb7Kjo/y alice laptop\n\
\n\
bob@x.ch,bob@y.ch namespaces=\"git\" valid-after=\"20240101\" ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDJ bob\n\
cert-authority *@corp.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n\
not a parseable line\n";
```

- `parses_mixed_file`: 2 `AllowedSigner`s (indices 1 and 3; bob's principal is the verbatim comma list; alice's trailing comment tolerated) and 2 unrecognized (indices 4 and 5); blank/comment lines appear in neither.
- `append_preserves_bytes`: `append_signer(FILE, "carol@example.com", "ssh-ed25519", "AAAATEST")` == `FILE` + the `format_signer_entry` line + `\n`.
- `append_detects_duplicate`: appending alice's exact principal+key returns `None`; same key under `carol@...` returns `Some`.
- `remove_exact_line`: `remove_signer_line(FILE, 3, "bob@x.ch,bob@y.ch")` drops only line 3; comment, blank, cert-authority and junk lines survive byte-identical.
- `remove_refuses_mismatch`: `remove_signer_line(FILE, 3, "alice@example.com")` and `remove_signer_line(FILE, 0, ...)` return `None` (Review Focus 3).
- `append_to_empty_and_no_trailing_newline`: appending to `""` and to a file missing its final `\n` both yield exactly one entry line with single separators.

- [ ] **Step 2: Run `cargo test -p legit-core signers` - new tests fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `cargo test -p legit-core signers` - pass.**

### Task 3: Composed signer flows (executor + fs) and backend methods

**Files:**
- Modify: `crates/legit-core/src/signers.rs` (composed async fns)
- Modify: `crates/legit-core/src/types.rs`, `crates/legit-core/src/backend.rs`, `crates/legit-core/src/cli_impl/mod.rs`
- Create: `crates/legit-core/src/cli_impl/signers.rs` (domain file; add `mod signers;` next to the other domains)
- Create: `crates/legit-core/src/cli_impl/flow_tests/signers.rs` (+ `mod signers;` in `flow_tests/mod.rs`)

**Interfaces:**
- Produces (types.rs):
  - `pub enum SignersFileTarget { Configured { path: String, scope: ConfigScope }, Unconfigured }` (reuse `config::ConfigScope`; re-export or move as needed for the Type derive - follow how `SigningView` handles it)
  - `pub struct SignerTrustInfo { pub principal: String, pub key: Option<SshSignerKey>, pub target: SignersFileTarget }`
  - `pub enum TrustSignerOutcome { Added { path: String }, AlreadyTrusted { path: String } }`
  - `pub struct AllowedSignersView { pub path: String, pub exists: bool, pub signers: Vec<AllowedSigner>, pub unrecognized: Vec<UnrecognizedSignerLine> }`
- Produces (signers.rs, free async fns; `exec: &dyn GitExecutor`, `fs: &dyn RepoFs`):
  - `pub const BOOTSTRAP_SIGNERS_PATH: &str = "~/.config/git/allowed_signers";`
  - `pub async fn resolve_signers_target(exec) -> SignersFileTarget` - runs `["config", "--show-scope", "--type=path", "--get-all", "gpg.ssh.allowedSignersFile"]`; non-zero exit -> Unconfigured; parses the LAST `scope\tpath` line (Review Focus 5); scope strings `local|global|system|worktree|command` map onto `ConfigScope` (worktree->Local, command->treat as the printed scope closest fit; pick and pin in a unit test).
  - `pub async fn expand_config_path(exec, raw: &str) -> Result<String, GitError>` - `["-c", "legit.expandpath=<raw>", "config", "--type=path", "--get", "legit.expandpath"]`, trimmed stdout; expansion thereby happens on the host that runs git.
  - `pub async fn list_signers(fs, path: &str) -> Result<AllowedSignersView, GitError>` - missing file -> `exists: false`, empty lists.
  - `pub async fn add_signer(fs, path, principal, key_type, key_b64) -> Result<TrustSignerOutcome, GitError>` - read (missing -> ""), `append_signer`, write; duplicate -> AlreadyTrusted without writing.
  - `pub async fn remove_signer(fs, path, line_index, expected_principal) -> Result<(), GitError>` - `remove_signer_line` miss -> error "signers file changed, reload" (plain GitError string surfaced by `formatAppError`).
  - `pub async fn bootstrap_signers_file(exec, fs) -> Result<String, GitError>` - `config::write(exec, WriteScope::Global, KEY, Some(BOOTSTRAP_SIGNERS_PATH))`, then `expand_config_path`, then `fs.create_dir_all(parent)`; returns the expanded path. (The `gpg.ssh.allowedSignersFile` key constant moves to or is duplicated in legit-core - today it lives in `src-tauri/commands/signing.rs:22`; move the constant into `legit_core::signers` as `pub const KEY_ALLOWED_SIGNERS` and re-import it in signing.rs to keep one definition.)
  - FsError mapping: follow the `fs_internal` precedent in `cli_impl/mod.rs:863` (make it reusable or add a sibling mapper in signers.rs).
- Produces (backend.rs trait + mod.rs delegation + cli_impl/signers.rs bodies):
  - `async fn signer_trust_info(&self, id: &CommitId) -> Result<SignerTrustInfo, GitError>` - `cat-file -p` (reuse the existing run pattern from `history.rs:204`), committer email via `parsers::commit::parse_cat_file`, `key` from `extract_sshsig_armor` + `parse_sshsig_pubkey` (None stays None - Review Focus 2), target via `resolve_signers_target`.
  - `async fn trust_signer(&self, principal: &str, key_type: &str, key_b64: &str, bootstrap: bool) -> Result<TrustSignerOutcome, GitError>` - resolve target; Configured -> `add_signer` at its (already expanded) path; Unconfigured + bootstrap -> `bootstrap_signers_file` then `add_signer`; Unconfigured without bootstrap -> error (Review Focus 4).

- [ ] **Step 1: Write failing flow tests** in `flow_tests/signers.rs` using the shared `backend()` helper (real `LocalFs`, so file assertions use a tempdir path inside the scripted config output; use the `tempfile` crate the suite already uses, or a path under `std::env::temp_dir()` consistent with neighboring flow tests):
- `trust_info_sequence`: scripts `cat-file -p <sha>` (object WITH the Task 1 `gpgsig` fixture embedded as header continuation lines) + the `config --show-scope --type=path --get-all` call returning `local\t/tmp/.../signers\n`; asserts principal = committer email, key extracted, target Configured{Local}.
- `trust_appends_to_configured_file`: config resolve returns a tempdir file pre-seeded with one entry; after `trust_signer(...,  bootstrap=false)` the file contains both lines, original bytes intact; asserts NO `config --global` write ran (`assert_done`).
- `trust_duplicate_is_noop`: pre-seeded identical entry -> `AlreadyTrusted`, file bytes unchanged.
- `trust_bootstrap_sequence`: resolve returns exit-1; expects `config --global gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers` then the `-c legit.expandpath...` expansion call (script it to return a tempdir path); asserts the file was created with the entry and parent dirs exist.
- `trust_unconfigured_without_bootstrap_errors`: resolve exit-1, `bootstrap=false` -> Err, no writes.
- `gpg_signed_commit_yields_no_key`: cat-file object with PGP armor -> `key: None` (Review Focus 2).
- [ ] **Step 2: Run `cargo test -p legit-core flow_tests::signers` - fails.**
- [ ] **Step 3: Implement composed fns, trait methods, delegations.**
- [ ] **Step 4: Run `cargo test -p legit-core` - full crate green (flow tests + unit tests + existing suites).**

### Task 4: Real-git validation (`git_flows`)

**Files:**
- Modify: `crates/legit-core/tests/suite/git_flows_suite.rs` (extend `commit_details_classifies_real_ssh_signatures`, around line 5210)

**Interfaces:** consumes Task 3's `signer_trust_info` / `trust_signer` via `repo.backend`.

- [ ] **Step 1: Extend the test** after its existing Untrusted assertion (the commit signed by the `unknown` key): call `signer_trust_info` on that sha; assert principal is the pinned committer email, `key` is Some with `key_type == "ssh-ed25519"`, target is Configured pointing at the test's signers file. Then `trust_signer(principal, key_type, key_b64, false)`, assert `Added`; re-run `commit_details` and assert the status is now `Good` with the signer principal. Also assert the file's first line (the originally trusted key) is byte-identical to what the test wrote.
- [ ] **Step 2: Run `cargo test -p legit-core --test git_flows commit_details_classifies_real_ssh_signatures` (match the suite's actual test-target name used by neighboring runs) - passes against the real binary.**

### Task 5: Tauri commands + bindings

**Files:**
- Create: `src-tauri/src/commands/trusted_signers.rs` (+ module registration next to `signing.rs`)
- Modify: `src-tauri/src/lib.rs` (`collect_commands!`)
- Modify: `src-tauri/src/commands/signing.rs` (KEY constant now re-imported from legit-core)
- Modify (generated): `src/lib/bindings.ts`

**Interfaces (produces, all `#[tauri::command] #[specta::specta]`):**
- `signer_trust_info(state, repo_id: String, commit_id: String) -> Result<SignerTrustInfo, AppError>` - session backend call.
- `trust_commit_signer(state, repo_id: String, principal: String, key_type: String, key_b64: String, bootstrap: bool) -> Result<TrustSignerOutcome, AppError>` - session backend call.
- `list_trusted_signers(app, state, distro: Option<String>, path: String) -> Result<AllowedSignersView, AppError>` - `SettingsHost` from `distro` (`None` = Local, mirroring `wsl_config.rs:55`); `expand_config_path` on the settings executor, then `signers::list_signers` on `settings_fs`.
- `remove_trusted_signer(app, state, distro: Option<String>, path: String, line_index: u32, expected_principal: String) -> Result<AllowedSignersView, AppError>` - expand, `remove_signer`, return the refreshed `list_signers` view.

Repo-bound commands resolve their session the same way the neighboring session commands do (follow any existing `commands/` file that calls a backend method for the exact session-lookup helper).

- [ ] **Step 1: Write command-level tests** only where logic exists beyond delegation (the `distro -> SettingsHost` mapping is already pinned by `settings_host.rs` tests; pure delegation commands need no new tests - the backend flow tests own the behavior). If no testable logic remains in this file, skip tests and note it.
- [ ] **Step 2: Register all four commands in `collect_commands!` in `src-tauri/src/lib.rs`.**
- [ ] **Step 3: Regenerate bindings:** `LEGIT_UPDATE_BINDINGS=1 cargo test -p legit-app bindings`, then `cargo test -p legit-app` - green (bindings not stale).

### Task 6: Frontend - signature store invalidation + trust action in Commit Details

**Files:**
- Modify: `src/store/signatures.ts` (+ test `src/store/signatures.test.ts`, create if absent)
- Modify: `src/panels/CommitDetails/CommitDetailsPanel.tsx`
- Modify: `src/lib/signature.ts` + `src/lib/signature.test.ts` (Untrusted tooltip copy)

**Interfaces:**
- Consumes: `api.signerTrustInfo`, `api.trustCommitSigner` (generated; no hand wrapper), `confirmDialog` from `store/confirm.ts`, query key shape `[repo.id, "commit-details", sha]` (CommitDetailsPanel.tsx:37).
- Produces: `clearRepo(repoId: string)` on `useSignatureStore`.

- [ ] **Step 1: Write failing store test:** `clearRepo` removes only that repo's recorded verifications; other repos untouched.
- [ ] **Step 2: Implement `clearRepo`** and rewrite the store's header comment: entries are immutable per SHA *until a trust mutation*, which clears the repo via `clearRepo` (drop the "restart is acceptable" sentence).
- [ ] **Step 3: Update `signaturePresentation` Untrusted `title`** to `"Valid signature, but the signer is not in your allowed signers - open the commit to trust them"`; adjust `signature.test.ts` if it pins the old copy.
- [ ] **Step 4: Implement the trust action in `SignatureView`** (CommitDetailsPanel.tsx:144): when `sig.status === "Untrusted"`, render a compact button `Trust this signer...`. On click (guarded by a `useRef` re-entry flag; no instant busy UI):
  1. `api.signerTrustInfo({ repoId, commitId })`; if `key` is null -> `notify.error` ("Cannot trust: not an SSH signature").
  2. `confirmDialog` with `danger: false`; Configured target: title `"Trust this signer?"`, message naming that commits signed with this key will show as verified and which file gains the entry, `detail` = `${principal}\n${fingerprint}\n-> ${path}` (or equivalent fields split across `detail`/`message`); Unconfigured: title `"Set up signature verification?"`, message additionally stating a new allowed-signers file will be created at `~/.config/git/allowed_signers` and set in the global git config of this repo's host, confirmLabel `"Trust signer"`.
  3. On confirm: `api.trustCommitSigner({ repoId, principal, keyType, keyB64, bootstrap: target unconfigured })`; then `useSignatureStore.getState().clearRepo(repoId)` and `queryClient.invalidateQueries({ queryKey: [repoId, "commit-details"] })`; errors -> `notify.error`.
- [ ] **Step 5: Run frontend checks from WSL:** `npx tsc --noEmit` and vitest via the powershell interop (`powershell.exe -Command "npm run test -- --run src/store/signatures.test.ts src/lib/signature.test.ts"` - match the invocation used in previous sessions / package.json). Both green.

### Task 7: Settings - per-file Trusted signers section

**Files:**
- Create: `src/panels/Settings/TrustedSignersSection.tsx`
- Modify: `src/panels/Settings/globalSettingsManifest.tsx` (two section entries)
- Modify: `src/panels/Settings/settingsManifest.test.ts` expectations
- Modify (if WSL wrapper pattern requires): a `WslTrustedSignersSection` wrapper mirroring `WslConfigSection`

**Interfaces:**
- Consumes: `api.globalSigningConfig` / `WSL_GIT_CONFIG_COMMANDS.signingConfig(distro)` for the configured file per host scope; `api.listGitProfiles` for profile files; `api.listTrustedSigners` / `api.removeTrustedSigner`; `useConfirmDestructive` + `confirmDialog`; `primitives.tsx` building blocks.

- [ ] **Step 1: Build `TrustedSignersSection`** taking the same scope prop shape as `GlobalGitConfigSection`:
  - Gather files for the scope: the signing view's `allowed_signers` resolved value, plus - local scope only - each profile's `allowed_signers_file` (labelled with the profile name). Deduplicate by the expanded `path` that `list_trusted_signers` returns.
  - Per file: resolved path caption; table of principal, key type, fingerprint; unrecognized lines rendered as muted opaque rows without a remove action; `exists: false` -> "file not created yet" note; no file configured anywhere -> empty state: "No allowed-signers file is configured. Trust a signer from a signed commit's details to set one up."
  - Remove: `useConfirmDestructive()`-gated `confirmDialog` naming the principal, then `api.removeTrustedSigner(...)` with the row's `line_index` + principal; replace the view with the returned refreshed one; errors -> `notify.error`. Also call `useSignatureStore.getState().clearRepo` for every open repo (import `useRepoStore` open list) since a removal can downgrade Good verdicts.
  - All colours via `var(--token)` (existing tokens suffice: `subtle-fg`, table/text tokens used by sibling sections); sizes via `--fz-*`.
- [ ] **Step 2: Add manifest entries:** section id `trusted-signers`, title `Trusted signers`, keywords `["signature", "signers", "trust", "ssh", "verification", "allowed"]` in the "Git" group after `git-config`; mirrored `trusted-signers-wsl` / `Trusted signers (WSL)` in the WSL group. Update `settingsManifest.test.ts` pinned expectations.
- [ ] **Step 3: Run vitest (powershell interop) for `settingsManifest.test.ts`, `settingsSearch.test.ts`, theme suites (`noLiteralColors`, `contract`) and `npx tsc --noEmit` - green.**

### Task 8: Changelog + full verification

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]`, Added)

- [ ] **Step 1: Add the bullet:** `- Trust SSH commit signers from a commit's details (with guided allowed-signers setup) and manage trusted signers per file in the global settings`
- [ ] **Step 2: Full gates:** `cargo test -p legit-core && cargo test -p legit-app` from WSL; full vitest run via powershell interop; `npx tsc --noEmit`. All green; report any failure verbatim instead of claiming success.

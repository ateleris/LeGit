# Security policy

## Reporting a vulnerability

Please report security issues **privately**, not as a public issue:

- Open a private advisory via GitHub: **Security → Report a vulnerability**
  ([new advisory](https://github.com/ateleris/LeGit/security/advisories/new)).

Useful in a report: what an attacker controls (a repository? a remote? a theme
file?), the steps to reproduce, the LeGit version (Settings → About), your
OS, and your `git --version`.

What to expect: an acknowledgement within a few days and a first assessment
within two weeks. LeGit is maintained by a small team as a side project, so
please allow for that pace. Fixes land on the development branch and ship in
the next release; you will be credited in the release notes unless you ask
otherwise.

Only the latest release is supported. There are no backported security
releases for older versions.

## Threat model

LeGit is a desktop Git GUI. It runs your own `git` executable, on your own
machine, with your own permissions. Two boundaries are worth naming
explicitly, because they decide what counts as a vulnerability.

### Repository content is untrusted input

Anything that travels with a repository is attacker-controlled if you clone
from a source you do not trust: branch, tag and remote names, commit
messages, author names, file names and paths, submodule configuration in
`.gitmodules`, LFS pointers, and file content. LeGit treats all of it as
data. Notably, ref names can legally begin with `-`, so ref-ish values are
rejected before they reach a positional `git` argument (and the argument
vectors pass `--end-of-options` where git supports it) - otherwise a name like
`--exec=<cmd>` on a cloned tag would turn "Rebase onto" into command
execution.

**A bug report here is in scope**: any repository content that changes what
LeGit *executes* rather than what it *displays*.

**Out of scope**: what git itself does with a repository you point it at. A
repository directory you received from someone else (a zip, a shared drive, a
`.git` you did not create) can carry a `.git/config` that names programs git
will run - hooks, `core.fsmonitor`, `core.pager`, `diff.external`, filter
drivers. Running `git status` on such a directory executes those programs,
whether you do it in LeGit or in a terminal. Only open repositories you
trust, exactly as you would only run `git` in a directory you trust.

### The trust boundary is your user account

LeGit does not defend against a process already running as you. In
particular:

- The **credential broker** (the in-app credential and SSH-passphrase
  prompts) listens on `127.0.0.1` on a random port and requires a per-run
  token. That token is in the environment of every `git` child process, so any
  same-user process that can read a child's environment can ask the broker for
  credentials the session already holds, or trigger a genuine-looking prompt.
  This is deliberately the same boundary as git's own credential-helper model:
  a same-user process can equally run `git credential fill` or query your
  keychain directly. To make an unexpected prompt recognizable, the dialog
  always names the requesting `protocol://host` and the directory the git
  operation ran in.
- **Local privilege escalation is out of scope** when it depends on already
  controlling your account, your `PATH`, or your environment variables.

## What LeGit does with secrets

- **Nothing is stored in LeGit's own settings files.** No tokens, no
  passwords, no passphrases - the settings under your app-data directory
  contain configuration only.
- **HTTPS credentials** are held in memory for the session. They are written
  to the **OS keychain** (Windows Credential Manager, macOS Keychain, Secret
  Service on Linux) only if you tick "remember" *and* git confirms them, so a
  wrong password never gets stored. A git `erase` removes a stale entry.
- **SSH key passphrases** are held in memory for the session only - never the
  keychain, never disk.
- **Platform tokens** (GitHub/GitLab/Azure DevOps accounts) live in the OS
  keychain; the settings files keep only the metadata (host, user name).
- **Credentials are redacted from logs.** A remote URL may carry a token
  (`https://<token>@host/repo.git`), and git quotes such URLs back in its
  error messages. The user info is replaced with `***` before anything reaches
  the Git Log panel, a toast, or stdout. If you find a path where a secret
  still shows up, that is a bug worth reporting.
- LeGit never sends your repository, your credentials, or telemetry anywhere.
  The only network traffic is git's own (your remotes), the optional platform
  API calls you trigger from the accounts UI, and - **only if you enable
  author avatars** (off by default) - a hash of the author's email address to
  gravatar.com.

## Hardening notes

Some deliberate choices, so you do not have to read the source to find them:

- Every git invocation goes through one chokepoint with a hardened
  environment: `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=false`, a pinned
  `C.UTF-8` locale, and all inherited `GIT_*` variables scrubbed so a stray
  `GIT_DIR` or `GIT_SSH_COMMAND` cannot redirect an operation.
- No shell is involved in a git invocation: arguments are passed as an argv
  array, never interpolated into a command line. The built-in Console is not
  a shell either - it runs `git` only, with `-C`, `--git-dir` and
  `--work-tree` blocked, and its `| grep` stage is implemented in-process.
  (The one exception is not ours: git runs `credential.helper` values through
  `sh` itself, so LeGit's helper path is single-quoted for it.)
- Unknown SSH host keys use `accept-new`, the same trust-on-first-use a first
  clone would give you - never `StrictHostKeyChecking=no`.
- The webview has no remote content and no `innerHTML` sinks; repository text
  is rendered as text.

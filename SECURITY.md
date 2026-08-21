# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** via GitHub's
["Report a vulnerability"](../../security/advisories/new) flow (Security tab
of this repository) - not in a public issue.

You can expect an acknowledgement within a few days. Please include steps to
reproduce and, if relevant, your OS and LeGit version (Global Settings →
About).

## Scope notes

- LeGit executes your locally installed `git` binary and never reimplements
  repository internals; issues in git itself belong to the
  [git project](https://git-scm.com/community).
- LeGit stores no secrets of its own: credentials live in the OS keychain,
  SSH keys stay wherever you keep them. Reports about credential handling
  (the broker, the askpass shim, keychain entries) are especially welcome.

## Supported versions

Only the latest release receives security fixes.

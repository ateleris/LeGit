# Contributing to LeGit

Thanks for considering a contribution. Issues and pull requests are welcome.

## Before you start

- For anything larger than a small fix, **open an issue first** to discuss it.
  LeGit has a deliberate scope (see [BACKLOG.md](BACKLOG.md) for what is
  planned and what was decided against), and a quick discussion beats a
  rejected PR.
- Read [CLAUDE.md](CLAUDE.md) - it is the project's conventions document
  (architecture, layering, and the hard rules: every colour comes from a
  theme token, every dimension scales with the UI font size, every bugfix
  lands with a regression test).

## Building

See the [README's "Build from source"](README.md#build-from-source) section
for prerequisites. `npm run tauri:dev` runs the app in development.

## Tests

All of these must pass; CI runs them on every PR:

```bash
cargo test                    # Rust: unit, command-sequence, and real-git tests
npx tsc --noEmit              # frontend type check
npx vitest run                # frontend unit tests (incl. theme contract suites)
```

The end-to-end suite (`e2e/`, Linux-only) runs in CI; you rarely need it
locally.

Two suites deserve special mention because they fail for non-obvious reasons:

- `src/theme/contract.test.ts` - a new colour must be a theme token added in
  4 places, and built-in themes must meet the contrast floors.
- `crates/legit-core/tests/git_flows.rs` - assumptions about git's behaviour
  are validated against the real binary; encode new assumptions there, not
  in comments.

## Pull requests

- **A bugfix is not done until a regression test pins it** - at the most
  precise seam available (pure function, command-sequence test, real-git
  case, theme contract, or E2E as last resort).
- Keep PRs focused; unrelated refactoring belongs in its own PR.
- Match the surrounding code's style and comment density.

## Licensing

LeGit is licensed under [GPL-3.0-or-later](LICENSE). By submitting a
contribution you agree that it is provided under the same license
(inbound = outbound). There is no CLA and no copyright assignment - you keep
the copyright to your contribution.

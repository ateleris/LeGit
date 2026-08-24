# LFS Pointer Placeholder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Do NOT use subagent-driven-development (user rule). NO git commits anywhere (user rule).

**Goal:** Render a proper placeholder instead of raw LFS pointer text in File View, Diff, and Blame.

**Architecture:** One pure detection module (`src/lib/lfsPointer.ts`), one shared notice component, three display-only call sites. No Rust/IPC changes.

**Spec:** `docs/superpowers/specs/2026-08-17-lfs-pointer-placeholder-design.md`

## Global Constraints

- No commits. No em-dashes in output. Colors only via `var(--token)` / `legit-subtle` (no new tokens needed). Text sizes via `--fz-*`.
- Vitest runs via `powershell.exe -NoProfile -Command "cd <repo>; npx vitest run <file>"`; `npx tsc --noEmit` from WSL.

### Task 1: `parseLfsPointer` + `lfsPointerDiffSides` (TDD)

**Files:** Create `src/lib/lfsPointer.ts`, `src/lib/lfsPointer.test.ts`.
**Interfaces produced:**
- `interface LfsPointerInfo { oid: string; size: number }`
- `parseLfsPointer(text: string): LfsPointerInfo | null`
- `lfsPointerDiffSides(hunks: DiffHunk[]): { oldInfo: LfsPointerInfo | null; newInfo: LfsPointerInfo | null } | null`
(`DiffHunk`/`DiffLine` from `src/lib/types.ts:576-589`: `{ kind: "Context" | "Added" | "Removed"; content: string }`.)

- [ ] Step 1: write the failing tests (fixture pointer, trailing newline, near-miss first line, bad oid, missing size, >1024 chars, plain text; diff sides: change/add/delete/conversion/text-only/empty hunks).
- [ ] Step 2: run - expect FAIL (module missing).
- [ ] Step 3: implement (validation rules per spec; sides rebuilt as Context+Removed / Context+Added across all hunks, non-null only when every non-empty side parses and at least one side non-empty).
- [ ] Step 4: run - expect PASS. No commit.

### Task 2: `formatBytes` extraction + `LfsPointerNotice`

**Files:** Create `src/lib/formatBytes.ts` (move `formatByteSize` verbatim from `FileViewPanel.tsx:29-40`), create `src/panels/shared/LfsPointerNotice.tsx`, modify `FileViewPanel.tsx` (import instead of local fn).
**Interface produced:** `LfsPointerNotice({ info?: LfsPointerInfo | null; oldInfo?: LfsPointerInfo | null; newInfo?: LfsPointerInfo | null })` - single-blob form when `info` given; diff form otherwise ("added"/"removed" when a side is null). `legit-subtle` span, padding 8, `fontSize: var(--fz-md)`, oid shown short (12 chars).

- [ ] Step 1: create both files, update FileViewPanel import.
- [ ] Step 2: `npx tsc --noEmit` clean. No commit.

### Task 3: wire the three panels

- [ ] `FileViewPanel.tsx`: `const lfsInfo = content != null ? parseLfsPointer(content) : null;` - render `<LfsPointerNotice info={lfsInfo} />` before the `FileContentView` branch when non-null (inside the body, after the Binary branch).
- [ ] `DiffPanel.tsx`: after the `text.hunks.length === 0` branch, `const lfsSides = lfsPointerDiffSides(text.hunks);` - when non-null return `<div className="legit-panel__body"><LfsPointerNotice oldInfo={lfsSides.oldInfo} newInfo={lfsSides.newInfo} /></div>`.
- [ ] `BlamePanel.tsx`: `const lfsInfo = useMemo(() => (hunks.length ? parseLfsPointer(hunks.flatMap(h => h.lines).join("\n")) : null), [hunks]);` - render notice instead of the hunk list when non-null.
- [ ] `npx tsc --noEmit` clean. No commit.

### Task 4: verify + docs

- [ ] Full: `npx tsc --noEmit`, `powershell npm test` (all suites), `cargo test -p legit-core` untouched (no Rust changes - skip unless anything red).
- [ ] BACKLOG release blocker #4: record option (a) shipped; remainder = option (b) only.
- [ ] Manual check note for user: File View / Blame / Diff-at-revision on `logo.png` in LeGit-Test-LFS now show the notice.

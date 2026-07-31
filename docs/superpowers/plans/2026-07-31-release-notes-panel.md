# Release Notes Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. Do NOT use subagent-driven-development (user rule). Do NOT commit (user rule).

**Goal:** A repo-scoped Release Notes panel: pick a from..to rev range (tag/branch datalist + free text), preview a plain-text commit list, copy it.

**Architecture:** Zero backend changes - existing `repoLog` revision-range walk + tags/branches queries; a pure formatting module; one new panel component registered in the dockview registry.

**Tech Stack:** React/TypeScript, React Query, vitest.

**Spec:** `docs/superpowers/specs/2026-07-31-release-notes-panel-design.md`

## Global Constraints

- No commits; no em-dashes; theme tokens + `--fz-*`/em sizing only; delayed busy via `PanelLoadingBar`.
- Verification: `npx tsc --noEmit` (WSL), vitest via PowerShell interop.

---

### Task 1: pure `releaseNotes.ts` (TDD)

**Files:** Create `src/panels/ReleaseNotes/releaseNotes.ts`; Test `src/panels/ReleaseNotes/releaseNotes.test.ts`.

**Interfaces:** Produces `formatReleaseNotes(commits: Pick<Commit, "id" | "message">[]): string` and `latestTagName(tags: Pick<TagInfo, "name" | "created_at">[]): string | null`.

- [ ] Step 1: failing test (line shape `- subject (sha8)`, first-line-of-multiline, empty -> "", latestTagName max/empty).
- [ ] Step 2: run, expect module-not-found FAIL.
- [ ] Step 3: implement both functions.
- [ ] Step 4: run, expect PASS.

### Task 2: panel + registration

**Files:** Create `src/panels/ReleaseNotes/ReleaseNotesPanel.tsx`; Modify `src/panels/registry.tsx` (REPO_PANELS descriptor `{ id: "release-notes", title: "Release Notes", scope: "repo", defaultPlacement: { direction: "right", referencePanel: "log" } }` + `REPO_DOCKVIEW_COMPONENTS["release-notes"] = wrap(ReleaseNotesPanel)` + import).

**Interfaces:** Consumes Task 1's functions; existing `repoLog`, `repoTags`, `repoBranches`, `copyText`, `PanelLoadingBar`, `PanelError`, `Button`/`ToolbarButton`, `notify`.

Panel behavior:
- State `from: string | null` (null until tags load -> `latestTagName`), `to: string` (default "HEAD"); reset on repo change.
- Queries: tags `[repoId, "tags"]`, branches `[repoId, "branches"]`, log `[repoId, "log", "release-notes", from, to]` with `repoLog(repo.id, 10_000, 0, \`${from}..${to}\`)`, `enabled` when repo && from non-empty && to non-empty, `staleTime` 5s, `placeholderData: keepPreviousData`.
- Range row: two `<input>`s bound to shared `<datalist id="release-notes-revs">` (tags newest-first then local branch names).
- Body: PanelError on error; else count line (`N commits` + truncation notice when `N >= 10_000`), read-only monospace textarea `value={formatReleaseNotes(commits)}` (flex:1), "No commits in this range." subtle text when settled empty.
- Copy: `Button variant="primary"`, disabled while empty, `copyText(...)` + `notify.success("Release notes copied")`.

- [ ] Step 1: write the panel component.
- [ ] Step 2: register descriptor + component.
- [ ] Step 3: `npx tsc --noEmit` clean.

### Task 3: verification + backlog

- [ ] Step 1: full vitest + tsc.
- [ ] Step 2: remove the "Release notes generator" backlog item (shipped; note follow-up formats live in the spec).
- [ ] Step 3: manual smoke: View menu -> Release Notes; LeGit-Test tags; copy works; invalid rev shows git's error. Requires only frontend HMR (no Rust changes).
- [ ] Step 4: leave uncommitted.

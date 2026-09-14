# Frontend Consolidation Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Do NOT use subagent-driven-development (user config forbids it).

**Goal:** Clear the v1.3.0 "Frontend consolidation batch" release blocker:
shared `useDismissable`/`Popover` for the hand-rolled dropdowns, a shared
composite file-row menu section, named `STALE` query-time constants, the
fixed-px padding sweep, a theme.css value-equality test, and the last piece of
the `GlobalSettingsPanel` split (RepoSettingsPanel helper dedupe).

**Architecture:** Pure-frontend refactors plus new enforcement tests. New
shared primitives land in `src/panels/shared/` (existing convention:
PascalCase components, `use*.ts` hooks, colocated `*.test.ts(x)`, pure
decision logic extracted and unit-tested). Enforcement tests mirror
`src/theme/noLiteralColors.test.ts` (file walker + regex + `violations[]`).

**Tech Stack:** React 19 + TypeScript, vitest (happy-dom, no testing-library;
component tests use `createRoot` + `act` like
`src/panels/Commits/menu/submenu.test.tsx`), zustand, @tanstack/react-query.

**Spec:** `design/2026-07-11-hardening-review.md` section D + the
"Frontend consolidation batch" entry in `BACKLOG.md` (release blockers).

## Global Constraints

- **NEVER commit or push.** Leave all changes staged/unstaged for review.
  Any "commit" instruction in a skill is overridden by user config. Do not
  mention the uncommitted state in summaries.
- **No em-dashes** in any output: prose, comments, code, this plan's edits.
  Use a hyphen or a colon.
- **No literal colours** outside the theme system: `var(--token)` only
  (enforced by `src/theme/noLiteralColors.test.ts`).
- **All dimensions scale with `--ui-font-size`**: `em`, `calc(var(--ui-font-size) * X)`,
  or `Math.round(uiFontSize * X)`. Fixed px only for 1px hairline borders and
  true geometric constants.
- **Comments:** only for constraints not derivable from code; one short line;
  never historical ("was", "renamed from", "previously").
- **Verification commands** (run from WSL):
  - Typecheck: `npx tsc --noEmit`
  - Vitest (must go through PowerShell interop, never WSL node):
    `powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run <path>"`
    Full suite: `powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npm test"`
- Tasks 1, 2, 3 are independent of everything else. Task 5 and 6 depend on
  Task 4. Task 8 (px sweep) runs LAST among code tasks: it touches many files
  the other tasks also edit.

---

### Task 1: STALE query-time constants

**Files:**
- Create: `src/lib/queryTiming.ts`
- Create: `src/lib/queryTiming.test.ts`
- Modify: `src/main.tsx:35`
- Modify: ~33 files listed in the inventory below (mechanical literal swap)
- Modify: `src/lib/repoInvalidation.test.ts:92`, `src/lib/useRepoChangeListener.test.tsx:41,94`

**Interfaces:**
- Produces: `export const STALE: { live: 5000; relaxed: 10000; appDefault: 30000; stable: 60000; rare: 300000; immutable: number }`
  imported as `import { STALE } from "../../lib/queryTiming";` (path depth varies).

- [ ] **Step 1: Create the constants module**

```ts
// src/lib/queryTiming.ts

/**
 * Named staleTime tiers for React Query. The watcher invalidates the live
 * tiers ahead of these; staleTime is the refetch-on-focus backstop.
 */
export const STALE = {
  /** Working tree, refs, op state: everything the watcher also invalidates. */
  live: 5_000,
  /** Per-file classification badges (line endings). */
  relaxed: 10_000,
  /** The QueryClient-wide default. */
  appDefault: 30_000,
  /** Rev-pinned content and slow-moving metadata. */
  stable: 60_000,
  /** Config-like data that changes only through explicit user actions. */
  rare: 300_000,
  /** Content addressed by SHA: can never change. */
  immutable: Infinity,
} as const;
```

- [ ] **Step 2: Write the enforcement test (failing)**

```ts
// src/lib/queryTiming.test.ts
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Companion of noLiteralColors.test.ts: every staleTime in src/ must come
// from the STALE tiers so query freshness is tuned in one place.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED_FILES = new Set([
  "lib/queryTiming.ts",
  "lib/queryTiming.test.ts",
]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("query staleTime comes from the STALE tiers", () => {
  it("no literal staleTime values outside queryTiming.ts", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, "/");
      if (ALLOWED_FILES.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/staleTime:\s*(?!STALE\.)\S+/g)) {
        const line = text.slice(0, m.index!).split("\n").length;
        violations.push(`${rel}:${line}: ${m[0]}`);
      }
    }
    expect(
      violations,
      `staleTime must use the STALE constants (lib/queryTiming.ts):\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run src/lib/queryTiming.test.ts"`
Expected: FAIL listing ~85 violations (80 non-test + main.tsx + test mirrors).

- [ ] **Step 4: Sweep every literal to its tier**

Replace by VALUE, adding `import { STALE } from "<relative>/lib/queryTiming";`
to each touched file. Ternaries become tier picks, e.g.
`src/lib/useFilePreview.ts:19` `mutable ? 5_000 : 60_000` becomes
`mutable ? STALE.live : STALE.stable`, same for
`src/panels/FileView/FileViewPanel.tsx:121`.

| Literal | Constant | Sites |
|---|---|---|
| `5_000` | `STALE.live` | 53 sites: `lib/useGitProfiles.ts:18`, `lib/useOpState.ts:18`, `panels/OpStateStrip.tsx:64`, `panels/Branches/BranchesPanel.tsx:89,96`, `panels/ChangedFiles/ChangedFilesPanel.tsx:123`, `panels/Blame/BlamePanel.tsx:85`, `panels/Commits/RemoteSyncToolbar.tsx:74,83`, `panels/Commits/useCommitsQueries.ts:89,131,141,149,158,168,199,205`, `panels/Compare/ComparePanel.tsx:115`, `panels/Diff/DiffPanel.tsx:172,212`, `panels/Files/FilesPanel.tsx:93,125`, `panels/FileHistory/FileHistoryPanel.tsx:98`, `panels/Merge/MergePanel.tsx:113,138,145`, `panels/InteractiveRebase/InteractiveRebasePanel.tsx:112,122`, `panels/Reflog/ReflogSection.tsx:42`, `panels/ReleaseNotes/ReleaseNotesPanel.tsx:42,64`, `panels/Remotes/RemotesPanel.tsx:54`, `panels/Settings/RepoSettingsPanel.tsx:623`, `panels/shared/lineEndingStatus.ts:21`, `panels/shared/RevPicker.tsx:74,80`, `panels/Stashes/StashesPanel.tsx:69`, `panels/Submodules/SubmodulesSection.tsx:60`, `panels/Tags/TagsSection.tsx:53,59`, `panels/WorkingChanges/CommitComposer.tsx:122,131,145,150`, `panels/WorkingChanges/WorkingChangesPanel.tsx:208,218,261,317,324,334,344`, `panels/Worktrees/WorktreesSection.tsx:42,50` |
| `10_000` | `STALE.relaxed` | `panels/shared/LineEndingBadge.tsx:60,70` |
| `30_000` | `STALE.appDefault` | `src/main.tsx:35`, `panels/Commits/useCommitsQueries.ts:120`, `panels/WorkingChanges/CommitComposer.tsx:163` |
| `60_000` | `STALE.stable` | `panels/RepoTabBar.tsx:173`, `panels/CommitDetails/CommitDetailsPanel.tsx:42`, `panels/ChangedFiles/ChangedFilesPanel.tsx:102,111`, `panels/Diff/SubmoduleDiffView.tsx:71`, `panels/InteractiveRebase/InteractiveRebasePanel.tsx:217` |
| `300_000` | `STALE.rare` | `panels/LfsWarningBanner.tsx:48`, `panels/RepoTabBar.tsx:192`, `panels/Commits/useCommitsQueries.ts:220`, `panels/Files/FilesPanel.tsx:110`, `panels/Settings/RepoSettingsPanel.tsx:547`, `panels/Tags/TagsSection.tsx:76` |
| `Infinity` | `STALE.immutable` | `panels/Commits/useCommitsQueries.ts:243`, `panels/Files/FilesPanel.tsx:102` |
| test mirrors | `STALE.appDefault` | `lib/repoInvalidation.test.ts:92`, `lib/useRepoChangeListener.test.tsx:41,94` |

Line numbers are as of plan time; re-locate by grepping `staleTime` in each
file if drifted.

- [ ] **Step 5: Run test + typecheck to verify green**

Run: `npx tsc --noEmit` then
`powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run src/lib/queryTiming.test.ts src/lib/repoInvalidation.test.ts src/lib/useRepoChangeListener.test.tsx"`
Expected: PASS.

---

### Task 2: RepoSettingsPanel shared-helpers dedupe (the GlobalSettingsPanel split remainder)

**Files:**
- Modify: `src/panels/Settings/RepoSettingsPanel.tsx:914-1016` (delete) and its imports

**Interfaces:**
- Consumes: `RadioGroup`, `ConfigRow`, `ResolvedBadge` from
  `src/panels/Settings/SigningSettings.tsx` (already exported; identical
  signatures) and `AUTOCRLF_OPTIONS`, `EOL_OPTIONS`, `getChangedValues` from
  `src/panels/Settings/lineEndingOptions.ts` (already exported and tested).

The local copies were verified byte-identical to the shared exports
(`SigningSettings.tsx:22-90`, `lineEndingOptions.ts:6-44`); the swap is a
pure delete-and-import. Precedent: `LineEndingsGlobalSection.tsx:14-15`.

- [ ] **Step 1: Delete the duplicate block**

Delete `RepoSettingsPanel.tsx` lines 914-1016: everything from the
`// Shared helpers` banner comment through the end of `ResolvedBadge`
(`AUTOCRLF_OPTIONS`, `EOL_OPTIONS`, `interface ChangeItem`,
`getChangedValues`, `scopeLabel`, `RadioGroup`, `ConfigRow`,
`ResolvedBadge`).

- [ ] **Step 2: Add the imports**

```ts
import { ConfigRow, RadioGroup, ResolvedBadge } from "./SigningSettings";
import { AUTOCRLF_OPTIONS, EOL_OPTIONS, getChangedValues } from "./lineEndingOptions";
```

Existing call sites keep working unchanged: `getChangedValues` at :754,
`ConfigRow`/`RadioGroup`/`ResolvedBadge`/option tables at :800-824.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` then
`powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run src/panels/Settings/lineEndingOptions.test.ts"`
Expected: PASS, no unused-import or missing-symbol errors.

Note: do NOT split GlobalSettingsPanel further; the backlog scopes the
remainder of this item to exactly this dedupe.

---

### Task 3: theme.css value-equality test

**Files:**
- Modify: `src/theme/contract.test.ts` (new describe block + one import)

**Interfaces:**
- Consumes: `DEFAULT_THEME` (`./defaults`), `bindingRef` (`./filters`, already
  imported), `bindingCssValue` (`./filters`, add to the existing import),
  `themeCss` + `tokenVar` (already in the file at :13 and :63).

`applyTheme` writes tokens as
`bindingCssValue(binding, "var(--palette-<ref>)")` (`applier.ts:68-70`), which
is byte-for-byte the shape theme.css hand-writes (including the four
`color-mix()` filter lines). Comparison confirmed drift-free at plan time, so
the test is a pure regression guard.

- [ ] **Step 1: Add the test**

Add `bindingCssValue` to the `./filters` import at `contract.test.ts:8`, then
append:

```ts
// theme.css:root fallbacks must equal the built-in Dark theme exactly: the
// fallbacks are the pre-theme-load frame and must never drift from defaults.
const cssRootDecls = new Map<string, string>();
for (const m of themeCss.matchAll(/(?:^|[\s{;])(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/gm)) {
  cssRootDecls.set(m[1], m[2].trim());
}

describe("theme.css fallback values equal DEFAULT_THEME", () => {
  it("every palette fallback equals the default palette hex", () => {
    for (const [name, hex] of Object.entries(DEFAULT_THEME.palette)) {
      expect(cssRootDecls.get(`--palette-${name}`), `--palette-${name}`).toBe(hex);
    }
  });

  it("every token fallback equals the default binding's CSS value", () => {
    for (const [name, binding] of Object.entries(DEFAULT_THEME.tokens)) {
      const expected = bindingCssValue(binding, `var(--palette-${bindingRef(binding)})`);
      expect(cssRootDecls.get(tokenVar(name)), tokenVar(name)).toBe(expected);
    }
  });
});
```

- [ ] **Step 2: Verify it fails on drift**

Temporarily change one value in `src/styles/theme.css` (e.g.
`--palette-main-bg: #1e1e1e` to `#1e1e1f`), run
`powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run src/theme/contract.test.ts"`,
confirm the new test FAILS naming `--palette-main-bg`, then REVERT the
theme.css change.

- [ ] **Step 3: Run to verify green**

Same command. Expected: PASS (all contract.test.ts suites).

---

### Task 4: `useDismissable` + `clampToViewport` + `Popover` shared primitives

**Files:**
- Create: `src/panels/shared/useDismissable.ts`
- Create: `src/panels/shared/useDismissable.test.tsx`
- Create: `src/panels/shared/popoverPosition.ts`
- Create: `src/panels/shared/popoverPosition.test.ts`
- Create: `src/panels/shared/Popover.tsx`

**Interfaces:**
- Consumes: `MENU_LAYER_ATTR` from `src/panels/Commits/menu/primitives.tsx:25`.
- Produces:
  - `useDismissable(open: boolean, onClose: () => void, insideRefs: readonly React.RefObject<HTMLElement | null>[]): void`
  - `clampToViewport(args: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number; margin?: number }): { left: number; top: number }`
  - `Popover` component: `{ x: number; y: number; onClose: () => void; insideRefs?: readonly React.RefObject<HTMLElement | null>[]; style?: React.CSSProperties; children: React.ReactNode } & div props`
    (portals to `document.body`, `position: fixed`, measured in
    `useLayoutEffect`, clamped, marked with `MENU_LAYER_ATTR`, self-dismisses
    via `useDismissable`).

Dismissal policy being unified (today it is split three ways):
outside-`mousedown` in the CAPTURE phase; "inside" is any `insideRef` subtree
OR any element inside a `[data-legit-menu-layer]` surface (portaled submenu
flyouts); Escape closes and ALWAYS `stopPropagation()`s so closing a menu
never simultaneously exits a maximized panel (`isUnclaimedEscape` in
`src/store/dockview.ts:118-139` counts on consumers doing this).

- [ ] **Step 1: Write the pure-function test (failing)**

```ts
// src/panels/shared/popoverPosition.test.ts
import { describe, expect, it } from "vitest";
import { clampToViewport } from "./popoverPosition";

const vp = { viewportWidth: 1000, viewportHeight: 600 };

describe("clampToViewport", () => {
  it("keeps a fitting popover at its anchor", () => {
    expect(clampToViewport({ x: 100, y: 100, width: 200, height: 150, ...vp }))
      .toEqual({ left: 100, top: 100 });
  });
  it("clamps off the right and bottom edges with the margin", () => {
    expect(clampToViewport({ x: 950, y: 580, width: 200, height: 150, ...vp }))
      .toEqual({ left: 1000 - 200 - 4, top: 600 - 150 - 4 });
  });
  it("never goes above the top-left margin, even for oversized popovers", () => {
    expect(clampToViewport({ x: 0, y: 0, width: 2000, height: 900, ...vp }))
      .toEqual({ left: 4, top: 4 });
  });
  it("honours a custom margin", () => {
    expect(clampToViewport({ x: 999, y: 599, width: 100, height: 100, margin: 8, ...vp }))
      .toEqual({ left: 1000 - 100 - 8, top: 600 - 100 - 8 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run src/panels/shared/popoverPosition.test.ts"`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `clampToViewport`**

```ts
// src/panels/shared/popoverPosition.ts

/** Clamp a fixed-position popover into the viewport (MenuShell's rule). */
export function clampToViewport(args: {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}): { left: number; top: number } {
  const m = args.margin ?? 4;
  return {
    left: Math.max(m, Math.min(args.x, args.viewportWidth - args.width - m)),
    top: Math.max(m, Math.min(args.y, args.viewportHeight - args.height - m)),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Same command. Expected: PASS.

- [ ] **Step 5: Write the hook test (failing)**

```tsx
// src/panels/shared/useDismissable.test.tsx
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MENU_LAYER_ATTR } from "../Commits/menu/primitives";
import { useDismissable } from "./useDismissable";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let outside: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  outside = document.createElement("div");
  document.body.append(host, outside);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  outside.remove();
});

function Probe({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(open, onClose, [ref]);
  return <div ref={ref} data-testid="inside" />;
}

const mouseDownOn = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });

const pressEscape = () => {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e;
};

describe("useDismissable", () => {
  it("closes on outside mousedown, not on inside mousedown", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(<Probe open onClose={onClose} />));
    await mouseDownOn(host.querySelector("[data-testid=inside]")!);
    expect(onClose).not.toHaveBeenCalled();
    await mouseDownOn(outside);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("treats a marked menu layer as inside (portaled flyouts)", async () => {
    const onClose = vi.fn();
    outside.setAttribute(MENU_LAYER_ATTR, "");
    await act(async () => root.render(<Probe open onClose={onClose} />));
    await mouseDownOn(outside);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape and stops propagation (maximize-exit contract)", async () => {
    const onClose = vi.fn();
    const windowSpy = vi.fn();
    window.addEventListener("keydown", windowSpy);
    await act(async () => root.render(<Probe open onClose={onClose} />));
    await act(async () => void pressEscape());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(windowSpy).not.toHaveBeenCalled();
    window.removeEventListener("keydown", windowSpy);
  });

  it("does nothing while closed", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(<Probe open={false} onClose={onClose} />));
    await mouseDownOn(outside);
    await act(async () => void pressEscape());
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run src/panels/shared/useDismissable.test.tsx"`
Expected: FAIL (module not found).

- [ ] **Step 7: Implement the hook**

```ts
// src/panels/shared/useDismissable.ts
import { useEffect, useRef } from "react";
import type React from "react";
import { MENU_LAYER_ATTR } from "../Commits/menu/primitives";

/**
 * Shared dismissal for dropdowns/popovers: outside mousedown (capture phase,
 * so a stopPropagation elsewhere cannot keep the surface open) and Escape.
 * "Inside" is any insideRef subtree or any marked menu layer (submenu
 * flyouts portal to document.body). Include the trigger button's wrapper in
 * insideRefs, or its mousedown-close + click-toggle will reopen the surface.
 * Escape is consumed (stopPropagation): closing a surface must not also exit
 * a maximized panel - see isUnclaimedEscape in store/dockview.ts.
 */
export function useDismissable(
  open: boolean,
  onClose: () => void,
  insideRefs: readonly React.RefObject<HTMLElement | null>[],
): void {
  const refsRef = useRef(insideRefs);
  refsRef.current = insideRefs;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      if (!target) return;
      if (refsRef.current.some((r) => r.current?.contains(target))) return;
      if (target instanceof Element && target.closest(`[${MENU_LAYER_ATTR}]`)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", onMouseDown, { capture: true, signal: controller.signal });
    document.addEventListener("keydown", onKey, { signal: controller.signal });
    return () => controller.abort();
  }, [open, onClose]);
}
```

- [ ] **Step 8: Run to verify it passes**

Same command. Expected: PASS.

- [ ] **Step 9: Implement `Popover`**

```tsx
// src/panels/shared/Popover.tsx
import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MENU_LAYER_ATTR } from "../Commits/menu/primitives";
import { useDismissable } from "./useDismissable";
import { clampToViewport } from "./popoverPosition";

/**
 * Fixed-position dismissable surface, portaled to document.body, measured
 * after render and clamped into the viewport (no hardcoded size estimates).
 * Callers style the surface (background, border, padding) via `style`.
 */
export function Popover({
  x,
  y,
  onClose,
  insideRefs = [],
  style,
  children,
  ...divProps
}: {
  x: number;
  y: number;
  onClose: () => void;
  /** Extra elements that count as inside (e.g. a combobox's input). */
  insideRefs?: readonly React.RefObject<HTMLElement | null>[];
  style?: React.CSSProperties;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "style">) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(
      clampToViewport({
        x,
        y,
        width: r.width,
        height: r.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    );
  }, [x, y]);

  useDismissable(true, onClose, [ref, ...insideRefs]);

  return createPortal(
    <div
      ref={ref}
      {...{ [MENU_LAYER_ATTR]: "" }}
      {...divProps}
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 9999, ...style }}
    >
      {children}
    </div>,
    document.body,
  );
}
```

- [ ] **Step 10: Verify**

Run: `npx tsc --noEmit`
Expected: clean. (Popover gets exercised by Task 6's migrations; its
dismissal and clamp logic are covered by Steps 1-8.)

---

### Task 5: Migrate the tab-strip menus + CaretDropdown to `useDismissable`

**Files:**
- Modify: `src/panels/RepoAddMenu.tsx:56-75`
- Modify: `src/panels/ViewMenu.tsx:38-50`
- Modify: `src/panels/RepoOverflowMenu.tsx:112-121`
- Modify: `src/panels/shared/CaretDropdown.tsx`

**Interfaces:**
- Consumes: `useDismissable` from Task 4.

Behavior gains (deliberate, changelog-covered in Task 9): ViewMenu and
RepoOverflowMenu and all CaretDropdown menus become Escape-dismissable;
ViewMenu's outside-mousedown moves to the capture phase; CaretDropdown drops
its full-screen click-catcher (outside clicks now dismiss AND act, matching
every other menu).

- [ ] **Step 1: RepoAddMenu**

Delete the dismissal `useEffect` (lines 56-75, the block commented
"Dismiss on outside mousedown + Escape") and replace with:

```ts
useDismissable(open, close, [ref]);
```

(`close` and `ref` already exist; add the import.)

- [ ] **Step 2: ViewMenu**

Delete the dismissal `useEffect` (lines 38-50) and replace with:

```ts
const close = useCallback(() => setOpen(false), []);
useDismissable(open, close, [ref]);
```

Add `useCallback` to the react import and the `useDismissable` import. The
hook's built-in `MENU_LAYER_ATTR` check preserves the portaled-submenu
behavior the old handler special-cased.

- [ ] **Step 3: RepoOverflowMenu**

Delete the dismissal `useEffect` (lines 112-121, including its
"Capture phase" comment) and replace with:

```ts
const close = useCallback(() => setOpen(false), []);
useDismissable(open, close, [ref]);
```

- [ ] **Step 4: CaretDropdown**

Remove the click-catcher overlay
(`<div style={{ position: "fixed", inset: 0, zIndex: 10 }} onClick={onClose} />`
and the fragment wrapper) and dismiss via the hook. The anchor wrapper
(`menu.parentElement`, which also contains the caret trigger) becomes an
inside ref so the trigger's own toggle still works:

```tsx
export function CaretDropdown({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const [direction, setDirection] = useState<"down" | "up">("down");
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = menu?.parentElement;
    anchorRef.current = anchor ?? null;
    if (!menu || !anchor) return;
    const a = anchor.getBoundingClientRect();
    setDirection(
      caretDropDirection({
        anchorTop: a.top,
        anchorBottom: a.bottom,
        menuHeight: menu.getBoundingClientRect().height + 2,
        viewportHeight: window.innerHeight,
      }),
    );
  }, []);
  useDismissable(true, onClose, [menuRef, anchorRef]);
  return (
    <div
      ref={menuRef}
      ...            // keep the existing style object unchanged
    >
      {children}
    </div>
  );
}
```

(Keep `caretDropDirection` and its test untouched. The existing keep-open
comment about the overlay goes; update the component doc comment to say
dismissal is shared via useDismissable.)

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` then
`powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run src/panels/shared"`
Expected: clean typecheck; CaretDropdown + shared tests PASS.

---

### Task 6: Migrate the portal popovers + MenuShell to `Popover`

**Files:**
- Modify: `src/panels/Commits/LaneLockIndicator.tsx` (LockMenu, lines 93-181)
- Modify: `src/panels/Commits/cells/RefsCell.tsx` (OverflowPopover, lines 745-829)
- Modify: `src/panels/shared/RevPicker.tsx` (lines 115-129, 185-200)
- Modify: `src/panels/Commits/menu/PanelContextMenu.tsx` (MenuShell, lines 191-248)
- Modify: `src/store/dockview.ts:118-126` (doc comment)

**Interfaces:**
- Consumes: `Popover`, `useDismissable`, `clampToViewport` from Task 4.

- [ ] **Step 1: LockMenu**

Replace the outer `<div ref={menuRef} style={{ position: "fixed", ... }}>`
plus the dismissal effect and the manual `left`/`top` clamping (delete
`MENU_H_ESTIMATE`; keep `MENU_W` for `minWidth`) with:

```tsx
<Popover
  x={x}
  y={y}
  onClose={onClose}
  style={{
    minWidth: MENU_W,
    background: "var(--panel-bg, #1e1e1e)",
    border: "1px solid var(--panel-border, rgba(255,255,255,0.12))",
    borderRadius: 4,
    padding: "4px 0",
    boxShadow: "0 4px 12px var(--shadow-color)",
    fontSize: "var(--fz-lg)",
    color: "var(--panel-fg, #ccc)",
    userSelect: "none",
  }}
>
  ...existing header + Remove-lock children unchanged...
</Popover>
```

- [ ] **Step 2: OverflowPopover (RefsCell)**

Same replacement: delete the dismissal effect and the manual clamping
(delete `POPOVER_H_ESTIMATE`; `POPOVER_W` stays used by
`OVERFLOW_POPOVER_LAYOUT.maxWidth`), render:

```tsx
<Popover
  x={x}
  y={y + 8}
  onClose={onClose}
  onMouseEnter={onPointerEnter}
  onMouseLeave={onPointerLeave}
  style={{
    ...OVERFLOW_POPOVER_LAYOUT,
    background: "var(--panel-bg, #1e1e1e)",
    border: "1px solid var(--panel-border, rgba(255,255,255,0.12))",
    borderRadius: 4,
    padding: 8,
    boxShadow: "0 4px 12px var(--shadow-color)",
  }}
>
  {children}
</Popover>
```

Keep the hover open/close grace logic in RefsCell untouched. (Escape here
now stops propagation like everywhere else.)

- [ ] **Step 3: RevPicker**

Delete the outside-mousedown part of the dismissal effect (lines 118-129)
but KEEP the resize-close as its own effect:

```ts
useEffect(() => {
  if (!open) return;
  const controller = new AbortController();
  window.addEventListener("resize", close, { signal: controller.signal });
  return () => controller.abort();
}, [open, close]);
```

Replace the `createPortal(<div ref={listRef} style={{ position: "fixed", left, top, width, ... }}>` with a
`Popover` at the anchor, passing the input as an inside ref; `listRef` moves
to an inner wrapper so the scroll-into-view queries keep working:

```tsx
{open && anchor && flat.length > 0 && (
  <Popover
    x={anchor.left}
    y={anchor.top}
    onClose={close}
    insideRefs={[inputRef]}
    style={{
      width: anchor.width,
      minWidth: "16em",
      maxHeight: "40vh",
      overflowY: "auto",
      ...            // keep the remaining existing surface styles unchanged
    }}
  >
    <div ref={listRef}>
      ...existing grouped list children unchanged...
    </div>
  </Popover>
)}
```

Keep the input's own Escape handling in `onKeyDown` (it preventDefaults so
the focused-input case still only closes the dropdown). The picker gains
viewport clamping it never had.

- [ ] **Step 4: MenuShell**

Replace its body with `Popover` (same measured clamp, same layer-attr
dismissal, now portaled to document.body like its own submenu flyouts):

```tsx
function MenuShell({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  return (
    <Popover x={x} y={y} onClose={onClose} style={menuSurfaceStyle}>
      <MenuLevelProvider>{children}</MenuLevelProvider>
    </Popover>
  );
}
```

(`menuSurfaceStyle` already carries `position: fixed` and `zIndex`; Popover's
own values are equivalent, the spread order keeps the style's values.)
Delete the now-unused `useEffect`/`useLayoutEffect`/`useState` imports if
nothing else in the file uses them. Escape on a context menu now stops
propagation (consistent with the app-wide policy).

- [ ] **Step 5: Update the dockview comment**

Rewrite `src/store/dockview.ts:118-126` so it no longer hand-enumerates the
Escape consumers:

```ts
/**
 * True when a window-level Escape keydown is "unclaimed" and may exit focus
 * mode. Escape consumers keep it from qualifying by preventDefault
 * (InlineRenameInput, RevPicker's input), by stopPropagation on their
 * document-level listeners (useDismissable does this for every dropdown,
 * popover, and context menu; the confirm dialog, askpass prompt, and the
 * Commits quick-jump overlay do it themselves), or by being an editable
 * target, rejected here.
 */
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit` then
`powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npm test"`
Expected: full suite PASS (submenu.test.tsx exercises the menu primitives;
the RefsCell overflow-layout test still imports `OVERFLOW_POPOVER_LAYOUT`).

---

### Task 7: Shared composite file-row menu section

**Files:**
- Create: `src/panels/shared/FileRowMenuSection.tsx`
- Create: `src/panels/shared/FileRowMenuSection.test.tsx`
- Modify: `src/panels/WorkingChanges/FileRowMenu.tsx:86-197`
- Modify: `src/panels/WorkingChanges/WorkingChangesPanel.tsx:765-796` (case-drift menu)
- Modify: `src/panels/ChangedFiles/ChangedFilesPanel.tsx:323-409`
- Modify: `src/panels/Compare/ComparePanel.tsx:347-403`
- Modify: `src/panels/Files/FilesPanel.tsx:427-488`
- Modify: `src/panels/FileHistory/FileHistoryPanel.tsx:233-292`

**Interfaces:**
- Consumes: `MenuItem`, `SectionLabel` (`../Commits/menu/primitives`),
  `CopyPathMenuSection`, `OpenInEditorMenuItem`, `AddToGitignoreMenuItem`
  (existing shared entries), `useSummonStore` (`../../store/summon`).
- Produces: `FileRowMenuSection` component (props below). Panel-specific
  entries (stage/discard/restore/reveal/untrack/diff/submodule-open) stay in
  the panels, rendered BEFORE or AFTER the section.

Canonical order the section renders (one source of wording and order; panels
currently disagree, normalizing is the point):
`SectionLabel(path)` then View file, File history, Blame, CopyPathMenuSection,
OpenInEditorMenuItem, AddToGitignoreMenuItem, each optional per props.
Deliberate normalizations (changelog-covered): Working Changes menus gain the
path header and swap to history-before-blame order; hidden blame entries
become disabled-with-reason (`(untracked)` / `(submodule)`) like the Files
panel; "File history" on untracked/just-added rows becomes disabled like the
Files panel (it had nothing to show anyway); FileHistory's "Diff in this
commit" moves before the section.

- [ ] **Step 1: Write the component**

```tsx
// src/panels/shared/FileRowMenuSection.tsx
// Shared tail of every file-row context menu: one place for the wording,
// order, and disabled rules of the common entries, so panels cannot drift
// (the StashMenuSection lesson). Panel-specific entries render around it.
import React from "react";
import { MenuItem, SectionLabel } from "../Commits/menu/primitives";
import { CopyPathMenuSection } from "./CopyPathMenuSection";
import { OpenInEditorMenuItem } from "./OpenInEditorMenuItem";
import { AddToGitignoreMenuItem } from "./AddToGitignoreMenuItem";
import { useSummonStore } from "../../store/summon";

export interface FileRowRev {
  /** What file-view/blame are summoned with (sha or user-typed rev). */
  value: string;
  /** Wording: "View file at <label>" / "Blame file at <label>". */
  label: string;
}

export function FileRowMenuSection({
  path,
  header,
  rev = null,
  deleted = false,
  deletedIn = "in this commit",
  submodule = false,
  untracked = false,
  view = false,
  onView,
  onHistory,
  onBlame,
  editorPath = path,
  gitignore = null,
  onClose,
}: {
  /** Repo-relative path (labels, copy entries, default summon payloads). */
  path: string;
  /** Menu header; null hides it; default is the path. */
  header?: React.ReactNode | null;
  rev?: FileRowRev | null;
  /** No content at the shown rev: view/blame disabled. */
  deleted?: boolean;
  deletedIn?: string;
  /** Gitlink row: no blob content. */
  submodule?: boolean;
  /** Not in HEAD: history/blame disabled with the "(untracked)" suffix. */
  untracked?: boolean;
  /** Render the "View file" entry. */
  view?: boolean;
  onView?: () => void;
  onHistory?: () => void;
  onBlame?: () => void;
  /** Working-tree path for "Open in editor"; null hides the entry. */
  editorPath?: string | null;
  gitignore?: "file" | "dir" | null;
  onClose: () => void;
}) {
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const summon = useSummonStore.getState;

  const viewLabel = deleted
    ? `View file (deleted ${deletedIn})`
    : submodule
      ? "View file (submodule)"
      : rev
        ? `View file at ${rev.label}`
        : "View file";
  const blameLabel = submodule
    ? "Blame (submodule)"
    : untracked
      ? "Blame (untracked)"
      : deleted
        ? `Blame file (deleted ${deletedIn})`
        : rev
          ? `Blame file at ${rev.label}`
          : "Blame file";

  return (
    <>
      {header !== null && <SectionLabel>{header ?? path}</SectionLabel>}
      {view && (
        <MenuItem
          disabled={deleted || submodule}
          onClick={run(
            onView ?? (() => summon().summon("file-view", rev ? { path, rev: rev.value } : path)),
          )}
        >
          {viewLabel}
        </MenuItem>
      )}
      <MenuItem
        disabled={untracked}
        onClick={run(onHistory ?? (() => summon().summon("file-history", path)))}
      >
        {untracked ? "File history (untracked)" : "File history"}
      </MenuItem>
      <MenuItem
        disabled={untracked || submodule || deleted}
        onClick={run(onBlame ?? (() => summon().summon("blame", rev ? { path, rev: rev.value } : path)))}
      >
        {blameLabel}
      </MenuItem>
      <CopyPathMenuSection path={path} onClose={onClose} />
      {editorPath !== null && !deleted && !submodule && (
        <OpenInEditorMenuItem path={editorPath} onClose={onClose} />
      )}
      {gitignore !== null && (
        <AddToGitignoreMenuItem path={path} isDir={gitignore === "dir"} onClose={onClose} />
      )}
    </>
  );
}
```

- [ ] **Step 2: Write the render test (failing until sites migrate is fine; it tests the component directly)**

```tsx
// src/panels/shared/FileRowMenuSection.test.tsx
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileRowMenuSection } from "./FileRowMenuSection";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = async (el: React.ReactElement) => act(async () => root.render(el));
// Direct children only: the section renders a flat fragment (SectionLabel
// div, then menuitem buttons), so parents never concatenate child text.
const labels = () =>
  [...host.children].map((n) => n.textContent?.trim() ?? "").filter(Boolean);
const item = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find(
    (b) => b.textContent?.trim() === label,
  );

describe("FileRowMenuSection", () => {
  it("renders the canonical order for a working-tree file", async () => {
    await render(<FileRowMenuSection path="src/a.ts" onClose={() => {}} />);
    const l = labels();
    expect(l[0]).toBe("src/a.ts");
    expect(l.indexOf("File history")).toBeLessThan(l.indexOf("Blame file"));
    expect(l.indexOf("Blame file")).toBeLessThan(l.indexOf("Copy relative path"));
  });

  it("words view/blame with the rev label", async () => {
    await render(
      <FileRowMenuSection
        path="a.ts"
        view
        rev={{ value: "abc123", label: "this commit" }}
        onClose={() => {}}
      />,
    );
    expect(item("View file at this commit")).toBeDefined();
    expect(item("Blame file at this commit")).toBeDefined();
  });

  it("disables view/blame for a deleted file with the reason", async () => {
    await render(
      <FileRowMenuSection
        path="a.ts"
        view
        deleted
        deletedIn="in this range"
        rev={{ value: "v2", label: "v2" }}
        onClose={() => {}}
      />,
    );
    expect(item("View file (deleted in this range)")?.disabled).toBe(true);
    expect(item("Blame file (deleted in this range)")?.disabled).toBe(true);
  });

  it("disables history/blame for an untracked file with the reason", async () => {
    await render(<FileRowMenuSection path="a.ts" untracked gitignore="file" onClose={() => {}} />);
    expect(item("File history (untracked)")?.disabled).toBe(true);
    expect(item("Blame (untracked)")?.disabled).toBe(true);
  });

  it("disables blame for a submodule row", async () => {
    await render(<FileRowMenuSection path="sub" submodule onClose={() => {}} />);
    expect(item("Blame (submodule)")?.disabled).toBe(true);
    expect(item("File history")?.disabled).toBe(false);
  });
});
```

Note: with no active repo in the store, `OpenInEditorMenuItem` renders null
and `CopyPathMenuSection` renders only "Copy relative path"; the
`gitignore="file"` case needs no QueryClientProvider only if it is NOT
clicked - `AddToGitignoreMenuItem` calls `useQueryClient()` at hook level, so
if rendering throws, wrap the render in a
`<QueryClientProvider client={new QueryClient()}>` in this test file.

- [ ] **Step 3: Run the test**

Run: `powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run src/panels/shared/FileRowMenuSection.test.tsx"`
Expected: PASS (fix the component or the provider wrapper until green).

- [ ] **Step 4: Migrate `FileRowMenu` (Working Changes rows)**

In `src/panels/WorkingChanges/FileRowMenu.tsx`, replace the common tail
(lines 170-196: the blame entry, history entry, `CopyPathMenuSection`,
`OpenInEditorMenuItem`, `AddToGitignoreMenuItem`) with:

```tsx
{!many && (
  <FileRowMenuSection
    path={file.path}
    untracked={
      unstaged
        ? file.change === "Untracked"
        : file.change === "Added"
    }
    submodule={file.change === "SubmoduleChanged"}
    editorPath={file.change === "Deleted" ? null : file.path}
    gitignore={unstaged && file.change === "Untracked" ? "file" : null}
    onClose={closeMenu}
  />
)}
```

Keep the panel-specific entries above it (conflict takes, reopen, stage /
unstage, discard, stash, submodule-open) exactly as they are. Also replace
the `SubmoduleDirty` early-return's hand-rolled history entry (lines 92-99)
with `<FileRowMenuSection path={file.path} submodule editorPath={null} onClose={closeMenu} />`
after the "Open submodule" item. Delete the now-unused `blameHidden` logic
and the direct `CopyPathMenuSection`/`OpenInEditorMenuItem`/
`AddToGitignoreMenuItem`/`useSummonStore` imports if unused.

- [ ] **Step 5: Migrate the case-drift menu (WorkingChangesPanel)**

Replace `WorkingChangesPanel.tsx:774-795` (the blame/history/copy/editor
entries of the drift menu) with:

```tsx
<FileRowMenuSection
  path={f.path}
  untracked={d.is_dir}
  onHistory={() => useSummonStore.getState().summon("file-history", d.index_path)}
  onBlame={() => useSummonStore.getState().summon("blame", d.index_path)}
  editorPath={d.is_dir ? null : d.disk_path}
  onClose={closeMenu}
/>
```

(Stage rename / Discard rename stay above it. `untracked={d.is_dir}`
reproduces "no blame/history for a directory drift" as disabled entries.)

- [ ] **Step 6: Migrate `FileAtCommitMenuSection` (Changed Files / stash files)**

In `ChangedFilesPanel.tsx`, the section keeps its wrapper component (it owns
the confirm-gated restore) but its common middle collapses:

```tsx
return (
  <>
    {submodule && (
      <MenuItem onClick={() => { onClose(); onOpenSubmodule(); }}>Open submodule</MenuItem>
    )}
    <FileRowMenuSection
      path={file.path}
      rev={{ value: commitId, label: "this commit" }}
      deleted={deleted}
      deletedIn={stash ? "in this stash" : "in this commit"}
      submodule={submodule}
      view
      onView={onView}
      onHistory={onHistory}
      onBlame={onBlame}
      onClose={onClose}
    />
    <MenuItem disabled={deleted} onClick={requestRestore}>
      ...existing restore label logic unchanged...
    </MenuItem>
  </>
);
```

Pass the full `commitId` down instead of only `commitShort` (add it to the
props; the caller has `selectedId`; derive `commitId.slice(0, 8)` inside for
the restore-confirm wording). Order note: the header moves above
"Open submodule" and blame moves before copy-path; both are the canonical
order.

- [ ] **Step 7: Migrate `CompareFileMenuSection`**

`ComparePanel.tsx:347-403` becomes:

```tsx
function CompareFileMenuSection({ file, toRev, onClose }: { file: FileTreeEntry; toRev: string; onClose: () => void }) {
  const deleted = file.change === "Deleted";
  const submodule = file.change === "SubmoduleChanged";
  const revLabel = /^[0-9a-f]{40}$/.test(toRev) ? toRev.slice(0, 8) : toRev;
  return (
    <FileRowMenuSection
      path={file.path}
      rev={{ value: toRev, label: revLabel }}
      deleted={deleted}
      deletedIn="in this range"
      submodule={submodule}
      view
      editorPath={deleted || submodule ? null : file.path}
      onClose={onClose}
    />
  );
}
```

(The default view summon `summon("file-view", { path, rev })` matches the
current hand-rolled one; delete the now-unused imports.)

- [ ] **Step 8: Migrate `FileMenuSection` (Files panel)**

`FilesPanel.tsx:427-488`: keep the untrack confirm logic, collapse the rest:

```tsx
return (
  <>
    <FileRowMenuSection
      path={path}
      untracked={!tracked}
      submodule={submodule}
      view
      onView={onView}
      onHistory={onHistory}
      onBlame={onBlame}
      editorPath={atRev || submodule ? null : path}
      gitignore={!atRev && kind === "untracked" ? "file" : null}
      onClose={onClose}
    />
    {!atRev && (
      <>
        <MenuItem onClick={() => { onClose(); onReveal(); }}>Reveal in file manager</MenuItem>
        {tracked && !submodule && (
          <MenuItem onClick={requestUntrack}>
            {confirmDestructive ? "Stop tracking & ignore…" : "Stop tracking & ignore"}
          </MenuItem>
        )}
      </>
    )}
  </>
);
```

Note the wording normalizations: "Blame" gains the "file" word
("Blame file"), "View file" order moves before history per canonical order.
`DirMenuSection` stays as-is (a directory row is not the composite).

- [ ] **Step 9: Migrate the File History row menu**

`FileHistoryPanel.tsx:233-292`: keep "Diff in this commit" and the restore
entry, collapse the middle:

```tsx
const menu = useMemo(
  () => (
    <>
      <FileRowMenuSection
        path={entry.path}
        header={`${sha.slice(0, 8)} · ${entry.path}`}
        rev={{ value: sha, label: "this commit" }}
        view
        onClose={closeMenu}
      />
      <MenuItem onClick={() => { summon().summon("diff", { repoId, path: entry.path, source: { kind: "commit", commit_id: sha }, oldPath: entry.old_path } satisfies DiffRequest); closeMenu(); }}>
        Diff in this commit
      </MenuItem>
      <Separator />
      <MenuItem onClick={...existing restore logic unchanged...}>
        ...
      </MenuItem>
    </>
  ),
  [...same deps...],
);
```

Wording note: "Blame at this commit" becomes the canonical
"Blame file at this commit".

- [ ] **Step 10: Verify**

Run: `npx tsc --noEmit` then
`powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npm test"`
Expected: PASS. Also grep for leftover direct usages:
`grep -rn "CopyPathMenuSection\|OpenInEditorMenuItem" src/panels --include=*.tsx`
should list only `FileRowMenuSection.tsx`, `FilesPanel.tsx` (DirMenuSection)
and the shared files themselves.

---

### Task 8: Fixed-px padding sweep + enforcement test

**Files:**
- Create: `src/styles/noFixedPx.test.ts`
- Modify: `src/styles/global.css` (enumerated below)
- Modify: ~60 tsx files (padding/margin/gap/fontSize inline styles)

Scope (matches the backlog wording "padding sweep"): `padding*`, `margin*`,
`gap`/`rowGap`/`columnGap`, and `font-size`/`fontSize`. Widths, heights,
border-radii, borders, and positional offsets are OUT of scope. Convert at
the 12px base so default rendering is pixel-identical:

| px | em (12px base) | px | em |
|---|---|---|---|
| 1 | 0.083em | 10 | 0.833em |
| 2 | 0.167em | 12 | 1em |
| 3 | 0.25em | 14 | 1.167em |
| 4 | 0.333em | 16 | 1.333em |
| 5 | 0.417em | 18 | 1.5em |
| 6 | 0.5em | 20 | 1.667em |
| 8 | 0.667em | 24 | 2em |

In `global.css` use `calc(var(--ui-font-size) * F)` (immune to local
font-size differences); in tsx inline styles use `"Fem"` strings (scales
with the local text, which is the intent).

- [ ] **Step 1: Write the enforcement test (failing)**

```ts
// src/styles/noFixedPx.test.ts
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Spacing counterpart of noLiteralColors.test.ts: paddings, margins, gaps,
// and font sizes must scale with --ui-font-size (CLAUDE.md), so fixed px in
// those properties fails here. Widths/heights/borders are out of scope.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Deliberately unscaled files. */
const ALLOWED_FILES = new Set([
  // Dev-only ribbon, pinned appearance by decision (like noLiteralColors).
  "panels/DevRibbon.tsx",
]);

// CSS: a spacing property whose value contains a nonzero px length outside
// a var()-anchored calc().
const CSS_DECL = /(?:^|[;{\s])(padding|margin|gap|row-gap|column-gap|font-size)(?:-[a-z]+)?\s*:\s*([^;}]+)/g;
// TSX: a spacing style prop with a bare number or a px-containing string.
const TSX_DECL = /\b(padding(?:Top|Right|Bottom|Left|Block|Inline)?|margin(?:Top|Right|Bottom|Left|Block|Inline)?|gap|rowGap|columnGap|fontSize)\s*:\s*("(?:[^"]*)"|'(?:[^']*)'|[\d.]+)/g;
const NONZERO_PX = /(?<![\d.])(?:[1-9]\d*|0*[1-9]\d*|\d+\.\d*[1-9])(?:\.\d+)?px/;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(tsx|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

describe("no fixed-px spacing", () => {
  it("padding/margin/gap/font-size scale with the UI font size", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, "/");
      if (ALLOWED_FILES.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      if (rel.endsWith(".css")) {
        for (const m of text.matchAll(CSS_DECL)) {
          const value = m[2];
          if (!NONZERO_PX.test(value)) continue;
          // calc() anchored to a scale var may carry px offsets.
          if (/calc\([^)]*var\(--(ui-font-size|fz-)/.test(value)) continue;
          violations.push(`${rel}:${lineOf(text, m.index!)}: ${m[1]}: ${value.trim()}`);
        }
      } else {
        for (const m of text.matchAll(TSX_DECL)) {
          const value = m[2];
          const bareNumber = /^[\d.]+$/.test(value) && Number(value) !== 0;
          const pxString = value.startsWith('"') || value.startsWith("'")
            ? NONZERO_PX.test(value) && !/var\(--/.test(value)
            : false;
          if (bareNumber || pxString) {
            violations.push(`${rel}:${lineOf(text, m.index!)}: ${m[1]}: ${value}`);
          }
        }
      }
    }
    expect(
      violations,
      `Spacing must derive from --ui-font-size (em / calc / scale vars):\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it; capture the full violation list**

Run: `powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run src/styles/noFixedPx.test.ts"`
Expected: FAIL with several hundred entries. This list IS the sweep
worklist; fix in the cluster order below, re-running between clusters.
If the regexes over- or under-match (e.g. a matched object key that is not a
style prop), adjust the test first - it is the contract.

- [ ] **Step 3: Sweep `src/styles/global.css`**

Known sites (line numbers approximate): button padding `4px 10px` (L76),
input/select padding `4px 6px` (L121), region-divider toggle
`padding: 0 4px` + `font-size: 9px` (L224-225), splash margins (L256, 263,
267) + `font-size: 28px` title (L259), `.legit-panel__body` `padding: 8px`
(L287), toolbar `gap: 6px; padding: 6px 8px` (L300-302), compact-controls
`padding: 0 8px` (L320), tabs actions/icon/tab paddings + gaps (L376-449),
dockview tab `padding: 0 12px` (L517), palette-row `gap/padding` +
`font-size: 12px` hex (L605-617), toasts `gap: 8px` + body/close paddings
(L669-722), region-divider gaps (L198, 206). Convert each with
`calc(var(--ui-font-size) * F)` per the table (e.g.
`padding: 8px` becomes `padding: calc(var(--ui-font-size) * 0.667)`;
`font-size: 12px` on `.palette-row__hex` becomes `font-size: var(--fz-md)`;
`font-size: 9px` becomes `font-size: calc(var(--ui-font-size) * 0.75)`;
`font-size: 28px` becomes `font-size: calc(var(--ui-font-size) * 2.33)`).
Leave widths/heights/borders/radii untouched.

- [ ] **Step 4: Sweep the Settings cluster**

`GlobalSettingsPanel.tsx` (~64 hits), `RepoSettingsPanel.tsx` (~57),
`SigningSettings.tsx`, `primitives.tsx`, `SshKeyTools.tsx`,
`NormalizeLineEndingsBlock.tsx`, `GitSetupGate.tsx`,
`RepoIdentitySection.tsx`, `GlobalProfilesSection.tsx`,
`LineEndingsGlobalSection.tsx`, `GlobalGitConfigSection.tsx`,
`CustomConfigEditor.tsx`, `ConnectedAccountsSection.tsx`, `WslGitGroup.tsx`,
`EffectiveValuesSummary.tsx`, `GitExecutableSection.tsx`,
`CredentialHelperField.tsx`. The dominant idiom
`style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}`
becomes `gap: "0.667em", marginTop: "0.667em"` (mechanical per the table;
numbers only, do not restructure JSX).

- [ ] **Step 5: Sweep the Commits + menu cluster**

`CommitsPanel.tsx`, `cells/RefsCell.tsx` (ref chips `padding: "1px 5px"`
becomes `"0.083em 0.417em"`), `menu/primitives.tsx` (`padding: "6px 14px"`
becomes `"0.5em 1.167em"` etc.), `menu/RowMenu.tsx`, `menu/LaneLockSection.tsx`,
`LaneLockIndicator.tsx`, `RemoteSyncToolbar.tsx`, `columns/ColumnHeader.tsx`,
`CommitComposer.tsx`.

- [ ] **Step 6: Sweep the remaining panels + shared**

Work through the rest of the violation list (Branches, Remotes, ThemeEditor,
Stashes, Repositories, InteractiveRebase, Worktrees, Tags, Merge,
Submodules, Diff (incl. `DiffEditor.tsx`'s CodeMirror theme px strings,
which accept em), FileTree, toasts/dialog hosts, RepoAddMenu, ViewMenu,
RepoOverflowMenu, OpStateStrip, etc.). If a file has a genuine geometric
constant in a spacing prop, prefer converting anyway; only add an
`ALLOWED_FILES` entry with a one-line reason as a last resort.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit` then
`powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npm test"`
Expected: noFixedPx PASS and the whole suite green (toolbarControls.test.ts
guards the toolbar height normalization survives the padding changes).

---

### Task 9: CHANGELOG + BACKLOG bookkeeping

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]`)
- Modify: `BACKLOG.md` (release blockers)

- [ ] **Step 1: CHANGELOG entries**

Under `## [Unreleased]` (create the section if absent), grouped per
Keep-a-Changelog:

```markdown
### Changed
- File context menus now share one common section (view, history, blame, copy path, open in editor) with consistent wording and order across panels
- More UI spacing (paddings, margins, gaps) now scales with the global UI font size

### Fixed
- Every dropdown menu and popover now closes with Escape and dismisses consistently on outside clicks
```

- [ ] **Step 2: BACKLOG update**

Remove the "Frontend consolidation batch" bullet from the v1.3.0 release
blockers (all items done; completed items are removed). The parenthetical
about GitBackend naming normalization is already covered by its own entry
under "Smaller follow-ups", so nothing moves. If the keyboard-shortcuts
bullet is then the only blocker left, keep the section structure as-is.

- [ ] **Step 3: Final verification**

Run: `npx tsc --noEmit` then
`powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npm test"`
Expected: full suite green. Leave everything uncommitted.

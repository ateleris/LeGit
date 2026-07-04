# Conflict Resolve Mode in the Diff Panel (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> Do NOT use subagent-driven-development (user rule).
> **Do NOT commit or push at any point** (user rule). No em-dashes anywhere.

**Goal:** When the Diff panel shows a conflicted working-tree file it becomes
a resolve view: each conflict renders as a hunk (ours = removed side, theirs =
added side) with [Ours] [Theirs] [Both] buttons, both sides are editable, and
the header offers conflict count, Mark resolved, and whole-file take-side.

**Architecture:** A pure `conflictModel.ts` parses conflict markers (classic +
diff3) into sections, builds a synthetic `TextDiff` that feeds the existing
`DiffEditor` unchanged (inline AND split render for free), rewrites single
blocks for one-click choices, and reconstructs the full marker file from
edited editor regions. `editableState.createRowState` gains per-pane editable
kinds (inline: context+ours+theirs; split: ours-only left, context+theirs
right), and `editModel` gains region collectors that rebuild lead/ours/theirs/
trail per conflict from the edited document(s).

**Tech Stack:** React 18 + TypeScript, CodeMirror 6, TanStack Query, vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-merge-rebase-conflicts-design.md`
(Phase 3 section).

## Global Constraints

- Never commit/push; no em-dashes; no literal colours (no new tokens needed
  in this phase; existing `diff.*` tokens cover the rendering); all sizes
  scale from `--ui-font-size`.
- The synthetic diff flows through the EXISTING `DiffEditor` primitive; any
  new hunk capability must ride the shared helpers and apply to both inline
  and split (action parity invariant).
- EOL style (CRLF/LF) and trailing-newline state must survive every rewrite
  (`resolveBlock`, `reconstructResolvedFile`) — encoded in tests.
- Dirty rules from Phase 1 apply unchanged: refetch deferred, actions
  disabled while dirty, explicit save.
- Tests: `npx vitest run src/panels/Diff/` and full `npx vitest run`;
  `npx tsc --noEmit`.

---

### Task 1: Conflict model (`conflictModel.ts`, pure)

**Files:**
- Create: `src/panels/Diff/conflictModel.ts`
- Test: `src/panels/Diff/conflictModel.test.ts`

**Interfaces:**
- Consumes: `detectEol`, `hasTrailingNewline`, `splitLines`, `type Eol` from
  `./editModel`; `TextDiff`, `DiffHunk`, `DiffLine` types from `../../lib/types`.
- Produces (used by Tasks 3-4):
  - `interface CommonSection { kind: "common"; lines: string[] }`
  - `interface ConflictBlock { kind: "conflict"; oursLabel: string; theirsLabel: string; ours: string[]; base: string[] | null; baseLabel: string | null; theirs: string[] }`
  - `type Section = CommonSection | ConflictBlock`
  - `interface ParsedConflicts { sections: Section[]; conflictCount: number; eol: Eol; trailingNewline: boolean }`
  - `parseConflicts(text: string): ParsedConflicts`
  - `conflictsToDiff(parsed: ParsedConflicts, path: string): TextDiff`
  - `type ResolveChoice = "ours" | "theirs" | "both"`
  - `resolveBlock(text: string, conflictIndex: number, choice: ResolveChoice): string`
  - `reconstructResolvedFile` consumes `ResolveRegions`, which lives in
    `./editModel` (defined in Task 2's interface block; conflictModel imports
    it as a type, avoiding a circular value import)
  - `reconstructResolvedFile(parsed: ParsedConflicts, regions: ResolveRegions[]): string`

- [ ] **Step 1: Write the failing tests**

Create `src/panels/Diff/conflictModel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  conflictsToDiff,
  parseConflicts,
  reconstructResolvedFile,
  resolveBlock,
} from "./conflictModel";

const CLASSIC = [
  "before",
  "<<<<<<< HEAD",
  "ours1",
  "ours2",
  "=======",
  "theirs1",
  ">>>>>>> feature/x",
  "after",
].join("\n") + "\n";

const DIFF3 = [
  "<<<<<<< HEAD",
  "ours",
  "||||||| base123",
  "orig",
  "=======",
  "theirs",
  ">>>>>>> feature/x",
].join("\n") + "\n";

describe("parseConflicts", () => {
  it("parses a classic conflict with surrounding common lines", () => {
    const p = parseConflicts(CLASSIC);
    expect(p.conflictCount).toBe(1);
    expect(p.sections).toEqual([
      { kind: "common", lines: ["before"] },
      {
        kind: "conflict",
        oursLabel: "HEAD",
        theirsLabel: "feature/x",
        ours: ["ours1", "ours2"],
        base: null,
        baseLabel: null,
        theirs: ["theirs1"],
      },
      { kind: "common", lines: ["after"] },
    ]);
    expect(p.eol).toBe("\n");
    expect(p.trailingNewline).toBe(true);
  });

  it("parses diff3-style base sections", () => {
    const p = parseConflicts(DIFF3);
    expect(p.conflictCount).toBe(1);
    const c = p.sections[0];
    expect(c).toMatchObject({
      kind: "conflict",
      base: ["orig"],
      baseLabel: "base123",
    });
  });

  it("treats an unterminated conflict as common lines (fail-safe)", () => {
    const p = parseConflicts("a\n<<<<<<< HEAD\nx\ny\n");
    expect(p.conflictCount).toBe(0);
    expect(p.sections).toEqual([
      { kind: "common", lines: ["a", "<<<<<<< HEAD", "x", "y"] },
    ]);
  });

  it("parses multiple conflicts and empty sides", () => {
    const text = [
      "<<<<<<< HEAD",
      "=======",
      "t1",
      ">>>>>>> b",
      "mid",
      "<<<<<<< HEAD",
      "o2",
      "=======",
      ">>>>>>> b",
    ].join("\n") + "\n";
    const p = parseConflicts(text);
    expect(p.conflictCount).toBe(2);
    expect((p.sections[0] as { ours: string[] }).ours).toEqual([]);
    expect((p.sections[2] as { theirs: string[] }).theirs).toEqual([]);
  });
});

describe("conflictsToDiff", () => {
  it("maps ours to Removed, theirs to Added, commons to Context", () => {
    const diff = conflictsToDiff(parseConflicts(CLASSIC), "a.txt");
    expect(diff.hunks).toHaveLength(1);
    const h = diff.hunks[0];
    expect(h.lines.map((l) => l.kind)).toEqual([
      "Context", // before
      "Removed", // ours1
      "Removed", // ours2
      "Added", // theirs1
      "Context", // after (trailing common on the last hunk)
    ]);
    expect(h.lines.map((l) => l.content)).toEqual([
      "before", "ours1", "ours2", "theirs1", "after",
    ]);
    // ours-side numbering: before(1) ours1(2) ours2(3) after(4)
    expect(h.old_start).toBe(1);
    expect(h.old_lines).toBe(4);
    // theirs-side numbering: before(1) theirs1(2) after(3)
    expect(h.new_start).toBe(1);
    expect(h.new_lines).toBe(3);
    expect(h.header).toContain("Conflict 1/1");
    expect(h.header).toContain("HEAD");
    expect(h.header).toContain("feature/x");
  });

  it("assigns commons between conflicts as the next hunk's lead context", () => {
    const text = [
      "<<<<<<< a", "o1", "=======", "t1", ">>>>>>> b",
      "mid1",
      "mid2",
      "<<<<<<< a", "o2", "=======", "t2", ">>>>>>> b",
    ].join("\n") + "\n";
    const diff = conflictsToDiff(parseConflicts(text), "a.txt");
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0].lines.map((l) => l.content)).toEqual(["o1", "t1"]);
    expect(diff.hunks[1].lines.map((l) => l.content)).toEqual(["mid1", "mid2", "o2", "t2"]);
    // Second hunk's numbering starts after hunk 1 on each side.
    expect(diff.hunks[1].old_start).toBe(2); // o1(1) mid1(2)...
    expect(diff.hunks[1].new_start).toBe(2); // t1(1) mid1(2)...
  });
});

describe("resolveBlock", () => {
  it("takes ours / theirs / both and preserves EOL + trailing newline", () => {
    expect(resolveBlock(CLASSIC, 0, "ours")).toBe("before\nours1\nours2\nafter\n");
    expect(resolveBlock(CLASSIC, 0, "theirs")).toBe("before\ntheirs1\nafter\n");
    expect(resolveBlock(CLASSIC, 0, "both")).toBe(
      "before\nours1\nours2\ntheirs1\nafter\n",
    );
    const crlf = CLASSIC.replace(/\n/g, "\r\n");
    expect(resolveBlock(crlf, 0, "theirs")).toBe("before\r\ntheirs1\r\nafter\r\n");
    const noTrail = CLASSIC.slice(0, -1);
    expect(resolveBlock(noTrail, 0, "ours")).toBe("before\nours1\nours2\nafter");
  });

  it("resolves only the addressed conflict; diff3 base is dropped", () => {
    const text = [
      "<<<<<<< a", "o1", "=======", "t1", ">>>>>>> b",
      "mid",
      "<<<<<<< a", "o2", "=======", "t2", ">>>>>>> b",
    ].join("\n") + "\n";
    expect(resolveBlock(text, 1, "theirs")).toBe(
      ["<<<<<<< a", "o1", "=======", "t1", ">>>>>>> b", "mid", "t2"].join("\n") + "\n",
    );
    expect(resolveBlock(DIFF3, 0, "ours")).toBe("ours\n");
  });
});

describe("reconstructResolvedFile", () => {
  it("rebuilds the marker file from edited regions (diff3 base kept verbatim)", () => {
    const p = parseConflicts(DIFF3);
    const out = reconstructResolvedFile(p, [
      { lead: [], ours: ["ours EDITED"], theirs: ["theirs", "extra"], trail: [] },
    ]);
    expect(out).toBe(
      [
        "<<<<<<< HEAD",
        "ours EDITED",
        "||||||| base123",
        "orig",
        "=======",
        "theirs",
        "extra",
        ">>>>>>> feature/x",
      ].join("\n") + "\n",
    );
  });

  it("re-emits edited lead/trail context and preserves CRLF", () => {
    const p = parseConflicts(CLASSIC.replace(/\n/g, "\r\n"));
    const out = reconstructResolvedFile(p, [
      { lead: ["BEFORE"], ours: ["ours1", "ours2"], theirs: ["theirs1"], trail: ["after", "added"] },
    ]);
    expect(out).toBe(
      ["BEFORE", "<<<<<<< HEAD", "ours1", "ours2", "=======", "theirs1", ">>>>>>> feature/x", "after", "added"]
        .join("\r\n") + "\r\n",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/panels/Diff/conflictModel.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `conflictModel.ts`**

```ts
// Pure conflict model for the Diff panel's resolve mode: parse git conflict
// markers (classic and diff3), build the synthetic TextDiff the existing
// DiffEditor renders (ours = Removed side, theirs = Added side, commons =
// Context), rewrite one block for a one-click choice, and reconstruct the
// full marker file from edited editor regions. No CodeMirror imports.

import type { DiffLine, TextDiff } from "../../lib/types";
import {
  detectEol,
  hasTrailingNewline,
  splitLines,
  type Eol,
  type ResolveRegions,
} from "./editModel";

export interface CommonSection {
  kind: "common";
  lines: string[];
}

export interface ConflictBlock {
  kind: "conflict";
  /** Text after `<<<<<<< ` (usually HEAD). */
  oursLabel: string;
  /** Text after `>>>>>>> ` (the merged branch/commit). */
  theirsLabel: string;
  ours: string[];
  /** diff3 `|||||||` section, kept verbatim for reconstruction; not shown. */
  base: string[] | null;
  baseLabel: string | null;
  theirs: string[];
}

export type Section = CommonSection | ConflictBlock;

export interface ParsedConflicts {
  sections: Section[];
  conflictCount: number;
  eol: Eol;
  trailingNewline: boolean;
}

const OURS_MARK = "<<<<<<<";
const BASE_MARK = "|||||||";
const SEP_MARK = "=======";
const THEIRS_MARK = ">>>>>>>";

function markerLabel(line: string, mark: string): string {
  return line.slice(mark.length).trim();
}

/** Parse a working-tree file's conflict markers. An unterminated conflict is
 *  emitted back as plain common lines so no content is ever dropped. */
export function parseConflicts(text: string): ParsedConflicts {
  const eol = detectEol(text);
  const trailingNewline = hasTrailingNewline(text);
  const lines = splitLines(text);
  const sections: Section[] = [];
  let common: string[] = [];
  const flushCommon = () => {
    if (common.length) {
      sections.push({ kind: "common", lines: common });
      common = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith(OURS_MARK) && (line.length === 7 || line[7] === " ")) {
      // Scan ahead for a complete block before committing to it.
      const oursLabel = markerLabel(line, OURS_MARK);
      const ours: string[] = [];
      let base: string[] | null = null;
      let baseLabel: string | null = null;
      const theirs: string[] = [];
      let phase: "ours" | "base" | "theirs" = "ours";
      let end = -1;
      let theirsLabel = "";
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (phase !== "theirs" && l.startsWith(BASE_MARK) && (l.length === 7 || l[7] === " ")) {
          phase = "base";
          base = [];
          baseLabel = markerLabel(l, BASE_MARK);
          continue;
        }
        if (phase !== "theirs" && l === SEP_MARK) {
          phase = "theirs";
          continue;
        }
        if (phase === "theirs" && l.startsWith(THEIRS_MARK) && (l.length === 7 || l[7] === " ")) {
          theirsLabel = markerLabel(l, THEIRS_MARK);
          end = j;
          break;
        }
        if (phase === "ours") ours.push(l);
        else if (phase === "base") base!.push(l);
        else theirs.push(l);
      }
      if (end !== -1) {
        flushCommon();
        sections.push({ kind: "conflict", oursLabel, theirsLabel, ours, base, baseLabel, theirs });
        i = end + 1;
        continue;
      }
      // Unterminated: fall through, treat as a plain line.
    }
    common.push(line);
    i++;
  }
  flushCommon();

  return {
    sections,
    conflictCount: sections.filter((s) => s.kind === "conflict").length,
    eol,
    trailingNewline,
  };
}

/**
 * Build the synthetic diff: one hunk per conflict. The common run before a
 * conflict is that hunk's lead context; the common run after the LAST
 * conflict is appended to the last hunk as trailing context. Line numbers
 * count each side's "file as if that side were chosen".
 */
export function conflictsToDiff(parsed: ParsedConflicts, path: string): TextDiff {
  const hunks: TextDiff["hunks"] = [];
  const conflicts = parsed.sections.filter((s) => s.kind === "conflict").length;
  let oursNo = 1;
  let theirsNo = 1;
  let pendingCommon: string[] = [];
  let index = 0;

  for (const section of parsed.sections) {
    if (section.kind === "common") {
      pendingCommon = pendingCommon.concat(section.lines);
      continue;
    }
    const lines: DiffLine[] = [];
    const oldStart = oursNo;
    const newStart = theirsNo;
    for (const l of pendingCommon) {
      lines.push({ kind: "Context", content: l });
      oursNo++;
      theirsNo++;
    }
    pendingCommon = [];
    for (const l of section.ours) {
      lines.push({ kind: "Removed", content: l });
      oursNo++;
    }
    for (const l of section.theirs) {
      lines.push({ kind: "Added", content: l });
      theirsNo++;
    }
    index++;
    hunks.push({
      old_start: oldStart,
      old_lines: 0, // fixed up below
      new_start: newStart,
      new_lines: 0,
      header: `Conflict ${index}/${conflicts}: ours '${section.oursLabel}' vs theirs '${section.theirsLabel}'`,
      lines,
    });
  }
  // Trailing common lines belong to the last hunk as context.
  if (hunks.length > 0 && pendingCommon.length > 0) {
    const last = hunks[hunks.length - 1];
    for (const l of pendingCommon) {
      last.lines.push({ kind: "Context", content: l });
      oursNo++;
      theirsNo++;
    }
  }
  for (const h of hunks) {
    h.old_lines = h.lines.filter((l) => l.kind !== "Added").length;
    h.new_lines = h.lines.filter((l) => l.kind !== "Removed").length;
  }
  return { old_path: path, new_path: path, hunks };
}

export type ResolveChoice = "ours" | "theirs" | "both";

function joinLines(lines: string[], eol: Eol, trailingNewline: boolean): string {
  const body = lines.map((l) => l.replace(/\r$/, "")).join(eol);
  return trailingNewline && lines.length > 0 ? body + eol : body;
}

function conflictMarkerLines(c: ConflictBlock, ours: string[], theirs: string[]): string[] {
  const out = [`${OURS_MARK} ${c.oursLabel}`.trimEnd(), ...ours];
  if (c.base !== null) {
    out.push(`${BASE_MARK} ${c.baseLabel ?? ""}`.trimEnd(), ...c.base);
  }
  out.push(SEP_MARK, ...theirs, `${THEIRS_MARK} ${c.theirsLabel}`.trimEnd());
  return out;
}

/** Rewrite conflict #`conflictIndex` with the chosen side(s); all other
 *  content (including other conflicts) is preserved verbatim. */
export function resolveBlock(text: string, conflictIndex: number, choice: ResolveChoice): string {
  const parsed = parseConflicts(text);
  const out: string[] = [];
  let index = -1;
  for (const section of parsed.sections) {
    if (section.kind === "common") {
      out.push(...section.lines);
      continue;
    }
    index++;
    if (index !== conflictIndex) {
      out.push(...conflictMarkerLines(section, section.ours, section.theirs));
      continue;
    }
    if (choice === "ours" || choice === "both") out.push(...section.ours);
    if (choice === "theirs" || choice === "both") out.push(...section.theirs);
  }
  return joinLines(out, parsed.eol, parsed.trailingNewline);
}

/**
 * Rebuild the full marker file from the edited regions (one per conflict
 * hunk, in order). Region layout mirrors `conflictsToDiff`: lead context,
 * ours, theirs, and (last hunk only) trailing context. diff3 base sections
 * are re-emitted verbatim.
 */
export function reconstructResolvedFile(
  parsed: ParsedConflicts,
  regions: ResolveRegions[],
): string {
  const out: string[] = [];
  let index = -1;
  for (const section of parsed.sections) {
    if (section.kind === "common") continue; // covered by lead/trail regions
    index++;
    const r = regions[index];
    if (!r) continue;
    out.push(...r.lead);
    out.push(...conflictMarkerLines(section, r.ours, r.theirs));
    out.push(...r.trail);
  }
  return joinLines(out, parsed.eol, parsed.trailingNewline);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/panels/Diff/conflictModel.test.ts`
Expected: PASS.

---

### Task 2: Resolve region collectors + per-pane editable kinds

**Files:**
- Modify: `src/panels/Diff/editModel.ts` (append collectors)
- Modify: `src/panels/Diff/editableState.ts` (`createRowState` gains kinds param)
- Test: extend `src/panels/Diff/editModel.test.ts` and
  `src/panels/Diff/editableState.test.ts`

**Interfaces:**
- Produces (used by Task 3):
  - `editableState`: `createRowState(rows: RowMeta[], editableKinds?: ReadonlySet<string>): RowState` (default stays `EDITABLE_KINDS` = Context+Added)
  - `editModel`:
    - `interface ResolveRegions { lead: string[]; ours: string[]; theirs: string[]; trail: string[] }` (lives HERE; conflictModel imports the type)
    - `interface PaneDoc { docLines: string[]; rowIndexAt: (line: number) => number | null; rows: RowMeta[] }`
    - `collectResolveRegionsInline(pane: PaneDoc, hunkCount: number): ResolveRegions[]`
    - `collectResolveRegionsSplit(left: PaneDoc, right: PaneDoc, hunkCount: number): ResolveRegions[]`


- [ ] **Step 1: Extend `editableState.ts`**

Change the signature and the one `EDITABLE_KINDS` use inside:

```ts
export function createRowState(
  rows: RowMeta[],
  editableKinds: ReadonlySet<string> = EDITABLE_KINDS,
): RowState {
```

and in `isLineEditable`: `return row != null && editableKinds.has(row.kind);`

Add a test to `editableState.test.ts`:

```ts
  it("honours custom editable kinds (resolve mode: Removed is editable)", () => {
    const rowState = createRowState(ROWS, new Set(["Context", "Added", "Removed"]));
    const state = EditorState.create({ doc: DOC, extensions: [rowState.field, rowState.guard] });
    const old = state.doc.line(3); // "old" (Removed)
    const next = apply(state, old.from, old.to, "edited-ours");
    expect(next.doc.line(3).text).toBe("edited-ours");
    // The hunk header stays read-only regardless.
    const header = next.doc.line(1);
    const next2 = apply(next, header.from, header.from, "x");
    expect(next2.doc.line(1).text).toBe(next.doc.line(1).text);
  });
```

- [ ] **Step 2: Add the collectors to `editModel.ts` with tests first**

Append to `editModel.test.ts`:

```ts
import { collectResolveRegionsInline, collectResolveRegionsSplit } from "./editModel";

describe("collectResolveRegions (inline)", () => {
  // Rows of one conflict hunk: header, lead ctx, ours(2), theirs(1), trail ctx.
  const rows: RowMeta[] = [
    { kind: "Hunk", hunkIndex: 0 },
    { kind: "Context", hunkIndex: 0 },
    { kind: "Removed", hunkIndex: 0 },
    { kind: "Removed", hunkIndex: 0 },
    { kind: "Added", hunkIndex: 0 },
    { kind: "Context", hunkIndex: 0 },
  ];
  const doc = ["HEADER", "before", "ours1", "ours2", "theirs1", "after"];

  it("splits an unedited doc into lead/ours/theirs/trail", () => {
    const out = collectResolveRegionsInline(
      { docLines: doc, rowIndexAt: (i) => i, rows },
      1,
    );
    expect(out).toEqual([
      { lead: ["before"], ours: ["ours1", "ours2"], theirs: ["theirs1"], trail: ["after"] },
    ]);
  });

  it("attributes inserted lines to the region they were typed in", () => {
    // A line inserted after ours2 (doc line index 4) and one after theirs1.
    const edited = ["HEADER", "before", "ours1", "ours2", "ours3-new", "theirs1", "t-new", "after"];
    const rowAt = (i: number) =>
      i <= 3 ? i : i === 4 ? null : i === 5 ? 4 : i === 6 ? null : 5;
    const out = collectResolveRegionsInline({ docLines: edited, rowIndexAt: rowAt, rows }, 1);
    expect(out[0].ours).toEqual(["ours1", "ours2", "ours3-new"]);
    expect(out[0].theirs).toEqual(["theirs1", "t-new"]);
    expect(out[0].trail).toEqual(["after"]);
  });
});

describe("collectResolveRegions (split)", () => {
  it("takes ours from the left pane, lead/theirs/trail from the right", () => {
    // Left rows: header, ctx, Removed x2, ctx. Right: header, ctx, Added, Filler, ctx.
    const leftRows: RowMeta[] = [
      { kind: "Hunk", hunkIndex: 0 },
      { kind: "Context", hunkIndex: 0 },
      { kind: "Removed", hunkIndex: 0 },
      { kind: "Removed", hunkIndex: 0 },
      { kind: "Context", hunkIndex: 0 },
    ];
    const rightRows: RowMeta[] = [
      { kind: "Hunk", hunkIndex: 0 },
      { kind: "Context", hunkIndex: 0 },
      { kind: "Added", hunkIndex: 0 },
      { kind: "Filler", hunkIndex: 0 },
      { kind: "Context", hunkIndex: 0 },
    ];
    const out = collectResolveRegionsSplit(
      { docLines: ["H", "before", "ours1", "ours2-edit", "after"], rowIndexAt: (i) => i, rows: leftRows },
      { docLines: ["H", "before", "theirs1", "", "after"], rowIndexAt: (i) => i, rows: rightRows },
      1,
    );
    expect(out).toEqual([
      { lead: ["before"], ours: ["ours1", "ours2-edit"], theirs: ["theirs1"], trail: ["after"] },
    ]);
  });

  it("an empty theirs side (all fillers on the right) still classifies trail", () => {
    const leftRows: RowMeta[] = [
      { kind: "Hunk", hunkIndex: 0 },
      { kind: "Removed", hunkIndex: 0 },
      { kind: "Context", hunkIndex: 0 },
    ];
    const rightRows: RowMeta[] = [
      { kind: "Hunk", hunkIndex: 0 },
      { kind: "Filler", hunkIndex: 0 },
      { kind: "Context", hunkIndex: 0 },
    ];
    const out = collectResolveRegionsSplit(
      { docLines: ["H", "mine", "after"], rowIndexAt: (i) => i, rows: leftRows },
      { docLines: ["H", "", "after"], rowIndexAt: (i) => i, rows: rightRows },
      1,
    );
    expect(out[0]).toEqual({ lead: [], ours: ["mine"], theirs: [], trail: ["after"] });
  });
});
```

Run: `npx vitest run src/panels/Diff/editModel.test.ts` → FAIL (missing exports).

- [ ] **Step 3: Implement the collectors in `editModel.ts`**

```ts
/** Regions of one conflict hunk collected from the edited editor document
 *  (consumed by conflictModel.reconstructResolvedFile). */
export interface ResolveRegions {
  lead: string[];
  ours: string[];
  theirs: string[];
  trail: string[];
}

/** One editor pane's current document plus its row-identity lookup. */
export interface PaneDoc {
  docLines: string[];
  rowIndexAt: (line: number) => number | null;
  rows: RowMeta[];
}

type ResolvePhase = "lead" | "ours" | "theirs" | "trail";

function emptyRegions(hunkCount: number): ResolveRegions[] {
  return Array.from({ length: hunkCount }, () => ({
    lead: [],
    ours: [],
    theirs: [],
    trail: [],
  }));
}

/**
 * Rebuild each conflict hunk's lead/ours/theirs/trail from the edited inline
 * document. Row layout per hunk (from conflictsToDiff + buildRows): header,
 * lead Context run, Removed run (ours), Added run (theirs), trailing Context.
 * Inserted lines (no row marker) join the region the caret was in.
 */
export function collectResolveRegionsInline(
  pane: PaneDoc,
  hunkCount: number,
): ResolveRegions[] {
  const out = emptyRegions(hunkCount);
  let hunk = -1;
  let phase: ResolvePhase = "lead";
  for (let i = 0; i < pane.docLines.length; i++) {
    const rowIndex = pane.rowIndexAt(i);
    const row = rowIndex != null ? pane.rows[rowIndex] : null;
    if (row?.kind === "Hunk") {
      hunk = row.hunkIndex;
      phase = "lead";
      continue;
    }
    if (hunk < 0) continue;
    if (row) {
      if (row.kind === "Removed") phase = "ours";
      else if (row.kind === "Added") phase = "theirs";
      else if (row.kind === "Context" && phase !== "lead") phase = "trail";
    }
    out[hunk][phase].push(pane.docLines[i]);
  }
  return out;
}

/**
 * Split-view variant: the ours side lives in the LEFT pane (its Removed rows
 * are the editable ones there), lead/theirs/trail in the RIGHT pane. Filler
 * rows advance the phase (so an empty side still classifies what follows as
 * trail) but contribute no text.
 */
export function collectResolveRegionsSplit(
  left: PaneDoc,
  right: PaneDoc,
  hunkCount: number,
): ResolveRegions[] {
  const out = emptyRegions(hunkCount);

  // Right pane: lead context, Added (theirs), trailing context.
  let hunk = -1;
  let phase: ResolvePhase = "lead";
  for (let i = 0; i < right.docLines.length; i++) {
    const rowIndex = right.rowIndexAt(i);
    const row = rowIndex != null ? right.rows[rowIndex] : null;
    if (row?.kind === "Hunk") {
      hunk = row.hunkIndex;
      phase = "lead";
      continue;
    }
    if (hunk < 0) continue;
    if (row) {
      if (row.kind === "Added" || row.kind === "Filler") phase = "theirs";
      else if (row.kind === "Context" && phase !== "lead") phase = "trail";
    }
    if (row?.kind === "Filler") continue;
    if (phase === "ours") continue; // unreachable on the right pane
    out[hunk][phase].push(right.docLines[i]);
  }

  // Left pane: only the Removed run (ours) plus lines inserted inside it.
  hunk = -1;
  let inOurs = false;
  for (let i = 0; i < left.docLines.length; i++) {
    const rowIndex = left.rowIndexAt(i);
    const row = rowIndex != null ? left.rows[rowIndex] : null;
    if (row?.kind === "Hunk") {
      hunk = row.hunkIndex;
      inOurs = false;
      continue;
    }
    if (hunk < 0) continue;
    if (row) {
      if (row.kind === "Removed" || row.kind === "Filler") inOurs = true;
      else if (row.kind === "Context") inOurs = false;
    }
    if (row?.kind === "Removed" || (row == null && inOurs)) {
      out[hunk].ours.push(left.docLines[i]);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the Diff test suite**

Run: `npx vitest run src/panels/Diff/`
Expected: all PASS (conflictModel, editModel incl. new collectors,
editableState incl. kinds test, plus the existing files).

---

### Task 3: `DiffEditor` resolve wiring

**Files:**
- Modify: `src/panels/Diff/DiffEditor.tsx`

**Interfaces:**
- Consumes: Task 2 collectors, `ResolveRegions`, and the `createRowState`
  kinds param.
- Produces (used by Task 4):
  - `export type HunkAction = "stage" | "unstage" | "discard" | "ours" | "theirs" | "both"`
  - New prop `resolve?: boolean` on `DiffEditorProps` (implies which kinds are
    editable per pane; `editable` must also be true for editing).
  - `DiffEditorHandle` gains `collectResolveRegions(): ResolveRegions[] | null`
    (null unless mounted with `resolve` + `editable`).

- [ ] **Step 1: Extend the action vocabulary**

```ts
export type HunkAction = "stage" | "unstage" | "discard" | "ours" | "theirs" | "both";

const ACTION_LABEL: Record<HunkAction, string> = {
  stage: "Stage",
  unstage: "Unstage",
  discard: "Discard",
  ours: "Ours",
  theirs: "Theirs",
  both: "Both",
};

/** Hover text per action ("<label> this hunk" reads wrong for resolves). */
const ACTION_HOVER: Record<HunkAction, string> = {
  stage: "Stage this hunk",
  unstage: "Unstage this hunk",
  discard: "Discard this hunk",
  ours: "Take our side for this conflict",
  theirs: "Take their side for this conflict",
  both: "Take both sides (ours, then theirs)",
};
```

In `ActionWidget.toDOM`, replace `btn.title = \`${ACTION_LABEL[action]} this
hunk\`` with `btn.title = ACTION_HOVER[action]`.

- [ ] **Step 2: Editable kinds per pane + resolve collectors**

Module-level sets:

```ts
// Resolve mode: ours (Removed) and theirs (Added) are BOTH real working-tree
// content, so both are editable; in split view the panes divide the kinds.
const RESOLVE_INLINE_KINDS: ReadonlySet<string> = new Set(["Context", "Added", "Removed"]);
const RESOLVE_LEFT_KINDS: ReadonlySet<string> = new Set(["Removed"]);
const RESOLVE_RIGHT_KINDS: ReadonlySet<string> = new Set(["Context", "Added"]);
```

`MountedEditor` gains `collectResolve: () => ResolveRegions[]`.

`mountInline` / `mountSplit` gain a trailing `resolve: boolean` parameter:
- `mountInline`: `createRowState(rows, resolve ? RESOLVE_INLINE_KINDS : undefined)`;
  `collectResolve: () => collectResolveRegionsInline(paneDocOf(view, rowState, rows), diff.hunks.length)`.
- `mountSplit`: `pane(...)` takes `paneKinds: ReadonlySet<string> | undefined`;
  editable panes pass their kinds to `createRowState`. Left pane becomes
  editable in resolve mode: `pane(leftEl, left, false, editable && resolve, RESOLVE_LEFT_KINDS)`
  and right `pane(rightEl, right, true, editable, resolve ? RESOLVE_RIGHT_KINDS : undefined)`.
  `collectResolve` uses both panes via `collectResolveRegionsSplit`.

Shared helper:

```ts
function paneDocOf(view: EditorView, rowState: RowState, rows: RowMeta[]): PaneDoc {
  const state = view.state;
  const docLines: string[] = [];
  for (let i = 1; i <= state.doc.lines; i++) docLines.push(state.doc.line(i).text);
  return { docLines, rowIndexAt: (i) => rowState.rowIndexAtLine(state, i + 1), rows };
}
```

(refactor `collectFromView` to use it too). The existing `collect()` (normal
splice path) stays as-is; resolve mode never calls it.

- [ ] **Step 3: Props + handle**

`DiffEditorProps` gains `resolve?: boolean` (document: "conflict-resolve
rendering: ours/theirs blocks are editable and collected as regions").
`DiffEditorHandle` gains `collectResolveRegions(): ResolveRegions[] | null`.
`useImperativeHandle` returns it when `editable && resolve`, else null. Thread
`resolve = false` through the component into both mounts and ADD IT to the
mount effect dependency array. Update the ACTION PARITY comment to name
resolve kinds/collection as a shared capability applied to both views.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx vitest run src/panels/Diff/`
Expected: clean, all PASS. (DiffPanel still compiles: `ACTION_TITLE` /
`LINE_LABEL` records there must be extended in Task 4; if tsc complains NOW,
add the three keys with sensible strings as part of this step instead.)

---

### Task 4: DiffPanel resolve mode + verification

**Files:**
- Modify: `src/panels/Diff/DiffPanel.tsx`

**Interfaces:**
- Consumes: `parseConflicts`, `conflictsToDiff`, `resolveBlock`,
  `reconstructResolvedFile`, `ResolveChoice` (Task 1); `DiffEditorHandle.
  collectResolveRegions` + `resolve` prop (Task 3); `repoReadWorktreeFile`,
  `repoWriteWorktreeFile`, `repoResolveTakeSide`, `repoStage` (existing);
  `useOpState`/`OP_DOMAINS` not needed (invalidation lists spelled below).

- [ ] **Step 1: Records + detection + file query**

Extend the two records:

```ts
const ACTION_TITLE: Record<HunkAction, string> = {
  stage: "Stage chunk", unstage: "Unstage chunk", discard: "Discard chunk",
  ours: "Take ours", theirs: "Take theirs", both: "Take both",
};
const LINE_LABEL: Record<HunkAction, string> = {
  stage: "Stage line", unstage: "Unstage line", discard: "Discard line",
  ours: "Take ours", theirs: "Take theirs", both: "Take both",
};
```

In `DiffPanel()`:

```ts
  // Conflicted working-tree file: the panel renders resolve mode instead of
  // a regular diff (same summon flow; the row's change state rides along).
  const resolveMode = !!request && request.source.kind === "working_unstaged" && request.change === "Conflicted";

  const {
    data: conflictText,
    isError: isConflictReadError,
    error: conflictReadError,
    isFetching: isFetchingConflict,
  } = useQuery<string>({
    // Under the "diff" domain so all existing invalidations refresh it.
    queryKey: [request?.repoId, "diff", "resolve", request?.path],
    queryFn: () => repoReadWorktreeFile(request!.repoId, request!.path),
    enabled: resolveMode && !!request && request.repoId === activeRepoId && !dirty,
    staleTime: 5_000,
  });
  const parsed = useMemo(
    () => (resolveMode && conflictText != null ? parseConflicts(conflictText) : null),
    [resolveMode, conflictText],
  );
  const resolveDiff = useMemo(
    () => (parsed && request ? conflictsToDiff(parsed, request.path) : null),
    [parsed, request?.path],
  );
```

Gate the NORMAL diff query off in resolve mode (`enabled: ... && !resolveMode`).

- [ ] **Step 2: Choice + save + header actions**

```ts
  // One-click block resolution: rewrite that conflict in the file and let the
  // refetch re-render with one fewer conflict. hunkIndex === conflict index.
  const onResolveChoice = useCallback(async (hunkIndex: number, action: HunkAction) => {
    const req = requestRef.current;
    if (!req || dirtyRef.current) {
      if (dirtyRef.current) notify.error("Unsaved edits in the diff. Save or discard them first.");
      return;
    }
    if (action !== "ours" && action !== "theirs" && action !== "both") return;
    try {
      const current = await repoReadWorktreeFile(req.repoId, req.path);
      const next = resolveBlock(current, hunkIndex, action);
      await repoWriteWorktreeFile(req.repoId, req.path, next);
      invalidateRepoDomains(queryClient, req.repoId, ["status", "diff", "op_state"]);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  }, [queryClient]);

  // Whole-file actions (also the only offering for non-UTF-8 conflicts).
  const onTakeSide = useCallback(async (side: ConflictSide) => {
    const req = requestRef.current;
    if (!req) return;
    try {
      await repoResolveTakeSide(req.repoId, req.path, side);
      invalidateRepoDomains(queryClient, req.repoId, ["status", "log", "diff", "op_state"]);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  }, [queryClient]);

  const onMarkResolved = useCallback(async () => {
    const req = requestRef.current;
    if (!req) return;
    try {
      await repoStage(req.repoId, [req.path]);
      invalidateRepoDomains(queryClient, req.repoId, ["status", "log", "diff", "op_state"]);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  }, [queryClient]);
```

Extend `onSave` with a resolve branch BEFORE the normal splice path:

```ts
    if (resolveModeRef.current) {
      const regions = editorRef.current?.collectResolveRegions();
      const parsedNow = parsedRef.current;
      if (!req || !regions || !parsedNow) return;
      savingRef.current = true;
      try {
        await repoWriteWorktreeFile(req.repoId, req.path, reconstructResolvedFile(parsedNow, regions));
        setDirty(false);
        setRebuildKey((k) => k + 1);
        invalidateRepoDomains(queryClient, req.repoId, ["status", "diff", "op_state"]);
      } catch (e) {
        notify.error(formatAppError(e));
      } finally {
        savingRef.current = false;
      }
      return;
    }
```

with ref mirrors `resolveModeRef` / `parsedRef` kept current like the
existing `dirtyRef` pattern.

- [ ] **Step 3: Render**

Toolbar: when `resolveMode`, hide the Chunks/Full toggle and show instead
(before the Save/Discard block):

```tsx
        {resolveMode && (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
              {parsed
                ? `${parsed.conflictCount} conflict${parsed.conflictCount === 1 ? "" : "s"}`
                : "conflicted"}
            </span>
            <ToolbarButton label="Take ours" title="Resolve the whole file with our side" disabled={dirty} onClick={() => onTakeSide("ours")} />
            <ToolbarButton label="Take theirs" title="Resolve the whole file with their side" disabled={dirty} onClick={() => onTakeSide("theirs")} />
            <ToolbarButton
              label="Mark resolved"
              title={
                parsed && parsed.conflictCount > 0
                  ? "Stage the file as-is (conflict markers remain!)"
                  : "Stage the file as resolved"
              }
              disabled={dirty}
              onClick={onMarkResolved}
            />
          </span>
        )}
```

Body: when `resolveMode`, render instead of `DiffBody`:
- read error (binary/non-UTF-8): message "This conflicted file cannot be
  shown as text." + the header's whole-file buttons still work; show
  `formatAppError(conflictReadError)` in the existing error `<pre>`.
- `parsed.conflictCount === 0`: notice "No conflict markers left in this
  file. Use Mark resolved to stage it." (no editor).
- otherwise `DiffEditor` with:

```tsx
        <DiffEditor
          ref={editorRef}
          diff={resolveDiff}
          mode={mode}
          actions={["ours", "theirs", "both"]}
          onAction={onResolveChoice}
          lineActionOp={null}
          scrollResetKey={`${request.repoId}|${request.path}|resolve`}
          editable
          resolve
          dirty={dirty}
          onDirty={onDirty}
          onSaveRequest={onSave}
          rebuildKey={rebuildKey}
        />
```

(no `onContextMenu` / `onLineAction`: per-line ops do not apply to resolve).
The loading bar should include `isFetchingConflict`.

- [ ] **Step 4: Full verification**

Run: `npx tsc --noEmit && npx vitest run && cargo test -p legit-core && cargo test -p legit-app --lib`
Expected: all PASS.

- [ ] **Step 5: Manual checklist (user runs the app from PowerShell)**

In a repo with a conflicted merge (from the Phase 2 checklist setup):

1. Click a conflicted file in Working Changes: the Diff panel shows resolve
   mode: conflicts as blocks with word-level differences highlighted, header
   "Conflict i/n: ours 'HEAD' vs theirs '<branch>'", [Ours][Theirs][Both]
   buttons pinned right, "N conflicts" + whole-file buttons in the toolbar.
2. Click [Theirs] on one conflict: only that block resolves; the view
   re-renders with one fewer conflict; Working Changes count drops.
3. Edit inside an ours block AND a theirs block (inline view), Ctrl+S: the
   file on disk keeps its markers with your edits in the right sections.
4. Split view: left pane edits ours lines only, right pane theirs + context;
   save produces the same correct marker file.
5. [Both] concatenates ours then theirs.
6. Resolve all conflicts, Mark resolved: file staged, banner Continue enables.
7. Take ours / Take theirs on the whole file (and on a modify/delete conflict
   where the text view cannot render: the binary/non-text fallback).
8. CRLF repo: choices and saves do not rewrite line endings.
9. A diff3-style conflict (set `git config merge.conflictStyle diff3`,
   redo the merge): base section is hidden in the view but preserved on save;
   choices drop it correctly.

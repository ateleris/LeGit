import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GLOBAL_PANELS, REPO_PANELS, SUPPRESSIBLE_SUMMON_PANELS } from "./registry";

// Summon-registry cross-check: every summon target id written as a string
// literal in the source must be resolvable by the mechanism it is passed to.
// `summon` / `swapSummon` / `notifyIfOpen` look targets up in REPO_PANELS
// only (store/summon.ts), and `summonGlobalPanel` in GLOBAL_PANELS - an id
// from the wrong scope is a SILENT no-op. Regression for 2026-08-06: two
// buttons called `summon("global-settings")` (a global panel) and did
// nothing; the state-of-the-app review found them
// (design/2026-08-06-state-of-the-app-review.md).

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

const REPO_IDS = new Set(REPO_PANELS.map((p) => p.id));
const GLOBAL_IDS = new Set(GLOBAL_PANELS.map((p) => p.id));

// First string argument of each call. `swapSummon(show, hide)` checks both
// ids via a second capture.
const REPO_SCOPE_CALL = /\b(?:summon|notifyIfOpen)\(\s*"([^"]+)"/g;
const SWAP_CALL = /\bswapSummon\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g;
const GLOBAL_SCOPE_CALL = /\bsummonGlobalPanel\(\s*"([^"]+)"/g;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("summon targets resolve in the registry scope they are passed to", () => {
  const files = listSourceFiles(SRC).filter(
    // The summon store's own doc examples and the generated bindings are not
    // call sites; tests are excluded by the walker.
    (f) => !f.endsWith("lib/bindings.ts"),
  );

  it("summon/notifyIfOpen/swapSummon ids are repo panels", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const rel = relative(SRC, file);
      for (const m of text.matchAll(REPO_SCOPE_CALL)) {
        if (!REPO_IDS.has(m[1])) offenders.push(`${rel}: ${m[0]}"`);
      }
      for (const m of text.matchAll(SWAP_CALL)) {
        for (const id of [m[1], m[2]]) {
          if (!REPO_IDS.has(id)) offenders.push(`${rel}: swapSummon "${id}"`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("interactive-rebase is summon-only: it lives and dies with a rebase", () => {
    expect(REPO_PANELS.find((p) => p.id === "interactive-rebase")?.summonOnly).toBe(true);
  });

  it("only selection-side-effect panels are suppressible - never explicit commands", () => {
    // The "Auto-open panels" opt-out exists for panels that pop open as a
    // side effect of SELECTING data (a commit, a file row). A panel whose
    // summon is itself the action (context-menu "Blame" / "File history" /
    // "Compare" / "Browse files" / "View file" / "resolve in merge editor")
    // must NOT be suppressible: suppressing it turns that click into a
    // silent no-op (decided 2026-08-19).
    expect([...SUPPRESSIBLE_SUMMON_PANELS].sort()).toEqual([
      "changed-files",
      "commit-details",
      "diff",
      "working-changes",
    ]);
  });

  it("summon-only panels are never suppressible - suppression would make them unreachable", () => {
    // A summon to a suppressed panel degrades to notifyIfOpen; for a panel
    // whose ONLY entry point is the summon, that is a permanent no-op.
    for (const p of REPO_PANELS.filter((p) => p.summonOnly)) {
      expect(SUPPRESSIBLE_SUMMON_PANELS, `${p.id} must not be suppressible`).not.toContain(p.id);
    }
  });

  it("summonGlobalPanel ids are global panels", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const rel = relative(SRC, file);
      for (const m of text.matchAll(GLOBAL_SCOPE_CALL)) {
        if (!GLOBAL_IDS.has(m[1])) offenders.push(`${rel}: ${m[0]}"`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

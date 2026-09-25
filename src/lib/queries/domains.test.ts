import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ChangeDomain } from "../types";
import {
  CHANGE_DOMAINS,
  FRONTEND_DOMAINS,
  NAMED_DOMAIN_SETS,
  QUERY_DOMAINS,
  isQueryDomain,
  type QueryDomain,
} from "./domains";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("QueryDomain", () => {
  it("includes every watcher ChangeDomain", () => {
    expectTypeOf<ChangeDomain>().toMatchTypeOf<QueryDomain>();
    for (const d of CHANGE_DOMAINS) expect(isQueryDomain(d)).toBe(true);
  });

  it("frontend-only domains are disjoint from watcher domains and unique", () => {
    for (const d of FRONTEND_DOMAINS) expect((CHANGE_DOMAINS as readonly string[]).includes(d)).toBe(false);
    expect(new Set(QUERY_DOMAINS).size).toBe(QUERY_DOMAINS.length);
  });

  it("rejects unknown domains", () => {
    expect(isQueryDomain("remote")).toBe(false);
    expect(isQueryDomain("")).toBe(false);
  });

  it("named sets contain only known domains, without duplicates", () => {
    for (const [name, set] of Object.entries(NAMED_DOMAIN_SETS)) {
      for (const d of set) expect(isQueryDomain(d), `${name}: ${d}`).toBe(true);
      expect(new Set(set).size, name).toBe(set.length);
    }
  });

  it("every literal repo-scoped query key uses a known domain", () => {
    const unknown: string[] = [];
    for (const file of listSourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/queryKey:\s*\[[^,\]"]+,\s*"([^"]+)"/g)) {
        if (!isQueryDomain(m[1])) {
          const line = text.slice(0, m.index!).split("\n").length;
          unknown.push(`${relative(SRC, file).replace(/\\/g, "/")}:${line}: ${m[1]}`);
        }
      }
    }
    expect(unknown, `add new domains to FRONTEND_DOMAINS:\n${unknown.join("\n")}`).toEqual([]);
  });
});

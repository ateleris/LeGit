// Named layouts: user-saved snapshots of the REPOSITORY dock, stored as
// backend files (`layouts/<name>.legit-layout.json`). The View menu applies
// them; the Layouts panel manages them (save/override/rename/delete/
// import/export). The global section is app chrome with its own state -
// layouts never capture or rearrange it (a legacy document's `global` part
// is kept for round-tripping but ignored on apply). This module owns the
// document format plus the capture/apply glue; the store (store/layouts.ts)
// owns persistence and the dockview APIs.

import type { DockviewApi } from "dockview-react";
import type { LayoutDocument } from "../lib/types";
import {
  applyRepoLayoutEnvelope,
  captureRepoLayoutEnvelope,
  coerceRepoLayoutEnvelope,
} from "./layoutSnapshot";

export const LAYOUT_FORMAT = "legit-layout";
export const LAYOUT_FORMAT_VERSION = 1;

export function buildLayoutDocument(
  name: string,
  global: unknown,
  repo: unknown,
): LayoutDocument {
  return {
    format: LAYOUT_FORMAT,
    formatVersion: LAYOUT_FORMAT_VERSION,
    name,
    global: global ?? null,
    repo: repo ?? null,
  };
}

/** Snapshot the repo dock into a layout document (`global` is always null).
 *  Null when there is no repo dock to capture. */
export function captureLayoutDocument(
  name: string,
  repoApi: DockviewApi | null,
): LayoutDocument | null {
  const repo = repoApi ? captureRepoLayoutEnvelope(repoApi) : null;
  if (repo === null) return null;
  return buildLayoutDocument(name, null, repo);
}

/** Validate an untrusted value (an imported file, a loaded document) into a
 *  LayoutDocument. Mirrors the backend's structural rules: strict on the
 *  envelope, lenient on the dockview content (pruned on apply). */
export function asLayoutDocument(raw: unknown): LayoutDocument | null {
  if (!raw || typeof raw !== "object") return null;
  const doc = raw as Record<string, unknown>;
  if (doc.format !== LAYOUT_FORMAT) return null;
  if (typeof doc.formatVersion !== "number") return null;
  if (typeof doc.name !== "string" || doc.name.trim().length === 0) return null;
  const dockOk = (v: unknown) => v === null || (typeof v === "object" && !Array.isArray(v));
  if (!("global" in doc) || !("repo" in doc)) return null;
  if (!dockOk(doc.global) || !dockOk(doc.repo)) return null;
  if (doc.global === null && doc.repo === null) return null;
  return doc as unknown as LayoutDocument;
}

// A bundle carries the whole layout set in one file (moving LeGit to a new
// machine). Frontend-only: the backend stores layouts one file per name.
export const LAYOUT_BUNDLE_FORMAT = "legit-layout-bundle";
export const LAYOUT_BUNDLE_FORMAT_VERSION = 1;

export interface LayoutBundle {
  format: typeof LAYOUT_BUNDLE_FORMAT;
  formatVersion: number;
  layouts: LayoutDocument[];
}

export function buildLayoutBundle(layouts: LayoutDocument[]): LayoutBundle {
  return {
    format: LAYOUT_BUNDLE_FORMAT,
    formatVersion: LAYOUT_BUNDLE_FORMAT_VERSION,
    layouts,
  };
}

/** Validate an untrusted value into a bundle's layout documents. Lenient on
 *  entries (an invalid one is dropped, the rest import), strict on the
 *  envelope; null when it is not a bundle or nothing usable remains. */
export function asLayoutBundle(raw: unknown): LayoutDocument[] | null {
  if (!raw || typeof raw !== "object") return null;
  const bundle = raw as Record<string, unknown>;
  if (bundle.format !== LAYOUT_BUNDLE_FORMAT) return null;
  if (typeof bundle.formatVersion !== "number") return null;
  if (!Array.isArray(bundle.layouts)) return null;
  const docs = bundle.layouts
    .map(asLayoutDocument)
    .filter((d): d is LayoutDocument => d !== null);
  return docs.length > 0 ? docs : null;
}

/** `base`, or `base 2`, `base 3`, … — the first not in `taken`. */
export function chooseUniqueName(base: string, taken: ReadonlySet<string>): string {
  let name = base;
  let i = 1;
  while (taken.has(name)) name = `${base} ${++i}`;
  return name;
}

/**
 * Build the one-time migration of the legacy "saved default" snapshot
 * (localStorage) into a named layout. Returns null when neither part parses —
 * the caller then just clears the keys.
 */
export function migrateLegacyDefaultLayout(
  rawRepo: string | null,
  rawGlobal: string | null,
  taken: ReadonlySet<string>,
): LayoutDocument | null {
  const repo = rawRepo !== null ? coerceParsed(rawRepo, coerceRepoLayoutEnvelope) : null;
  const global = rawGlobal !== null ? coerceParsed(rawGlobal, (v) => v) : null;
  if (repo === null && global === null) return null;
  return buildLayoutDocument(chooseUniqueName("My layout", taken), global, repo);
}

function coerceParsed<T>(raw: string, coerce: (parsed: unknown) => T | null): T | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return coerce(parsed);
  } catch {
    return null;
  }
}

/**
 * Apply a layout document to the repo dock. A null repo part (or no open
 * repo) is a no-op; a legacy `global` part is ignored entirely. Returns
 * false when a present repo part failed to apply.
 */
export function applyLayoutDocument(
  doc: LayoutDocument,
  repoApi: DockviewApi | null,
): boolean {
  if (doc.repo === null || !repoApi) return true;
  const envelope = coerceRepoLayoutEnvelope(doc.repo);
  return envelope !== null && applyRepoLayoutEnvelope(repoApi, envelope);
}

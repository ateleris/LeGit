// Pure day-bucketing model for the Work Log window. No panel imports, no IO:
// the shell feeds it query results, it returns the fully grouped view.

import type { FileState, StashEntry, WorkLogCommit } from "../lib/bindings";

export interface RepoTabInput {
  repoId: string;
  name: string;
  commonDir: string;
}

/** Worktree tabs of one repository, merged (they share all local branches). */
export interface RepoGroup {
  key: string;
  name: string;
  repoIds: string[];
  primaryRepoId: string;
}

/** One uncommitted change, already in app shape (wire casing mapped away). */
export interface WorkLogUncommittedInput {
  repoId: string;
  /** The tab's display name; shown when a repository has several tabs. */
  repoName: string;
  path: string;
  /** Rename/copy source; the diff must pair both sides. */
  oldPath: string | null;
  state: FileState;
  staged: boolean;
  mtimeUnix: number | null;
}

export interface UncommittedRow extends WorkLogUncommittedInput {}

export interface RepoBlock {
  group: RepoGroup;
  /** min/max commit time of the day, null when the day has no commits. */
  span: { first: number; last: number } | null;
  /** Newest first, deduped by sha within the group. */
  commits: WorkLogCommit[];
  stashes: StashEntry[];
  uncommitted: UncommittedRow[];
}

export interface WorkLogDay {
  key: string;
  label: string;
  counts: { commits: number; repos: number };
  repoBlocks: RepoBlock[];
}

export interface OlderRepoBlock {
  group: RepoGroup;
  /** Newest last-touch first; unknown/deleted mtimes sort last. */
  rows: UncommittedRow[];
}

export interface OlderBucket {
  blocks: OlderRepoBlock[];
}

export interface WorkLogView {
  days: WorkLogDay[];
  older: OlderBucket;
  /** Distinct matched author emails (first-seen casing), for the filter. */
  emails: string[];
}

const DAY_SECS = 86400;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Calendar day ("YYYY-MM-DD") of a unix time in the given UTC offset. */
export function dayKeyFor(unixSecs: number, tzOffsetMinutes: number): string {
  const d = new Date((unixSecs + tzOffsetMinutes * 60) * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** "Thu 2026-11-12" for a day key; hand-rolled so no locale data shifts it. */
export function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[date.getUTCDay()]} ${key}`;
}

/** "HH:MM" on the clock of the given UTC offset (the author's clock for
 *  commits and stashes, so a row's time never contradicts its day header). */
export function timeOfInOffset(unixSecs: number, tzOffsetMinutes: number): string {
  const d = new Date((unixSecs + tzOffsetMinutes * 60) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Per-repo query failures flattened to labeled rows; a silently blanked
 *  stash or uncommitted list would underreport work, so every kind
 *  surfaces. Query arrays are index-aligned with `repos`. */
export function collectSweepErrors(
  repos: { id: string; name: string }[],
  kinds: { label: string; queries: { isError: boolean; error: unknown }[] }[],
  format: (e: unknown) => string
): { name: string; message: string }[] {
  const out: { name: string; message: string }[] = [];
  repos.forEach((repo, i) => {
    for (const kind of kinds) {
      const q = kind.queries[i];
      if (q?.isError) out.push({ name: repo.name, message: `${kind.label}: ${format(q.error)}` });
    }
  });
  return out;
}

/** `refs/heads/x` -> `x`; anything else (HEAD, tags) passes through. */
export function shortRef(sourceRef: string | null): string | null {
  if (sourceRef == null) return null;
  return sourceRef.startsWith("refs/heads/") ? sourceRef.slice("refs/heads/".length) : sourceRef;
}

export function groupRepoTabs(tabs: RepoTabInput[]): RepoGroup[] {
  const groups: RepoGroup[] = [];
  const byDir = new Map<string, RepoGroup>();
  for (const tab of tabs) {
    const existing = byDir.get(tab.commonDir);
    if (existing) {
      existing.repoIds.push(tab.repoId);
    } else {
      const group: RepoGroup = {
        key: tab.commonDir,
        name: tab.name,
        repoIds: [tab.repoId],
        primaryRepoId: tab.repoId,
      };
      byDir.set(tab.commonDir, group);
      groups.push(group);
    }
  }
  return groups;
}

export interface BuildWorkLogInput {
  groups: RepoGroup[];
  commitsByRepo: Record<string, WorkLogCommit[]>;
  stashesByRepo: Record<string, StashEntry[]>;
  uncommittedByRepo: Record<string, WorkLogUncommittedInput[]>;
  /** Empty = identity matching disabled (everything is "mine"). */
  allowedEmails: string[];
  /** One email to isolate (commits only); null = all identities. */
  identityFilter: string | null;
  rangeDays: number;
  nowUnix: number;
  localTzOffsetMinutes: number;
}

export function buildWorkLog(input: BuildWorkLogInput): WorkLogView {
  const allowed = new Set(input.allowedEmails.map((e) => e.toLowerCase()));
  const isolate = input.identityFilter?.toLowerCase() ?? null;
  const todayKey = dayKeyFor(input.nowUnix, input.localTzOffsetMinutes);

  // The visible day keys, newest first, derived by stepping whole days back
  // from "now" (DST shifts an hour, never a calendar day at local noon-ish;
  // keys are what matter, and duplicates collapse via the map below).
  const dayKeys: string[] = [];
  const dayIndex = new Map<string, number>();
  for (let i = 0; i < input.rangeDays; i++) {
    const key = dayKeyFor(input.nowUnix - i * DAY_SECS, input.localTzOffsetMinutes);
    if (!dayIndex.has(key)) {
      dayIndex.set(key, dayKeys.length);
      dayKeys.push(key);
    }
  }

  const emails: string[] = [];
  const seenEmails = new Set<string>();
  const olderByGroup = new Map<string, UncommittedRow[]>();
  const olderRowsFor = (group: RepoGroup): UncommittedRow[] => {
    let rows = olderByGroup.get(group.key);
    if (!rows) {
      rows = [];
      olderByGroup.set(group.key, rows);
    }
    return rows;
  };

  // day index -> group key -> block under construction
  const dayBlocks: Map<string, RepoBlock>[] = dayKeys.map(() => new Map());

  const blockFor = (dayIdx: number, group: RepoGroup): RepoBlock => {
    const map = dayBlocks[dayIdx];
    let block = map.get(group.key);
    if (!block) {
      block = { group, span: null, commits: [], stashes: [], uncommitted: [] };
      map.set(group.key, block);
    }
    return block;
  };

  for (const group of input.groups) {
    const seenShas = new Set<string>();
    const seenStashes = new Set<string>();
    for (const repoId of group.repoIds) {
      for (const c of input.commitsByRepo[repoId] ?? []) {
        if (seenShas.has(c.id)) continue;
        seenShas.add(c.id);
        const email = c.author.email.toLowerCase();
        if (allowed.size > 0 && !allowed.has(email)) continue;
        if (!seenEmails.has(email)) {
          seenEmails.add(email);
          emails.push(c.author.email);
        }
        if (isolate && email !== isolate) continue;
        const key = dayKeyFor(c.author.timestamp, c.author.tz_offset_minutes);
        const dayIdx = dayIndex.get(key);
        if (dayIdx === undefined) continue; // outside the visible range
        blockFor(dayIdx, group).commits.push(c);
      }

      for (const s of input.stashesByRepo[repoId] ?? []) {
        if (seenStashes.has(s.stash_sha)) continue;
        seenStashes.add(s.stash_sha);
        const key = dayKeyFor(s.timestamp, s.author.tz_offset_minutes);
        const dayIdx = dayIndex.get(key);
        if (dayIdx === undefined) continue;
        blockFor(dayIdx, group).stashes.push(s);
      }

      // Merge the staged+unstaged pair of a path into one row.
      const byPath = new Map<string, UncommittedRow>();
      for (const u of input.uncommittedByRepo[repoId] ?? []) {
        const existing = byPath.get(u.path);
        if (existing) {
          byPath.set(u.path, {
            ...u,
            staged: existing.staged || u.staged,
            // Prefer the unstaged entry's state (the working tree's truth).
            state: u.staged ? existing.state : u.state,
            oldPath: existing.oldPath ?? u.oldPath,
            mtimeUnix: existing.mtimeUnix ?? u.mtimeUnix,
          });
        } else {
          byPath.set(u.path, { ...u });
        }
      }
      for (const row of byPath.values()) {
        if (row.mtimeUnix == null) {
          olderRowsFor(group).push(row);
          continue;
        }
        let key = dayKeyFor(row.mtimeUnix, input.localTzOffsetMinutes);
        if (key > todayKey) key = todayKey; // clock skew: clamp to today
        const dayIdx = dayIndex.get(key);
        if (dayIdx === undefined) {
          olderRowsFor(group).push(row);
          continue;
        }
        blockFor(dayIdx, group).uncommitted.push(row);
      }
    }
  }

  const days: WorkLogDay[] = dayKeys.map((key, i) => {
    // Preserve the input group order inside each day.
    const blocks = input.groups
      .map((g) => dayBlocks[i].get(g.key))
      .filter((b): b is RepoBlock => b !== undefined);
    for (const block of blocks) {
      block.commits.sort((a, b) => b.author.timestamp - a.author.timestamp);
      block.stashes.sort((a, b) => b.timestamp - a.timestamp);
      block.uncommitted.sort((a, b) => (b.mtimeUnix ?? 0) - (a.mtimeUnix ?? 0));
      if (block.commits.length > 0) {
        const times = block.commits.map((c) => c.author.timestamp);
        block.span = { first: Math.min(...times), last: Math.max(...times) };
      }
    }
    const commits = blocks.reduce((n, b) => n + b.commits.length, 0);
    return {
      key,
      label: dayLabel(key),
      counts: { commits, repos: blocks.length },
      repoBlocks: blocks,
    };
  });

  const olderBlocks: OlderRepoBlock[] = input.groups
    .map((g) => ({ group: g, rows: olderByGroup.get(g.key) ?? [] }))
    .filter((b) => b.rows.length > 0);
  for (const block of olderBlocks) {
    block.rows.sort((a, b) => (b.mtimeUnix ?? 0) - (a.mtimeUnix ?? 0));
  }

  return { days, older: { blocks: olderBlocks }, emails };
}

// Opening and following diffs from the Working Changes lists: conflicted
// files go to the Merge panel, everything else to the Diff panel (the two
// share one dock slot), and an ALREADY-OPEN viewer follows the selection
// without being forced open.

import { useCallback } from "react";
import type { CaseDriftEntry, DiffRequest, DiffSource, FileStatus, RepoSummary } from "../../lib/types";
import { useSummonStore } from "../../store/summon";
import type { Section as ListSection, Selection } from "./selection";

export function useDiffSync(args: {
  repo: RepoSummary | null;
  entryFor: (section: ListSection, path: string) => FileStatus | undefined;
}) {
  const { repo, entryFor } = args;

  const openDiff = useCallback(
    (section: ListSection, path: string) => {
      if (!repo) return;
      const source: DiffSource =
        section === "staged" ? { kind: "working_staged" } : { kind: "working_unstaged" };
      const entry = entryFor(section, path);
      const change = entry?.state;
      // Conflicted files open the dedicated Merge panel; everything else the
      // Diff panel. The two share one dock slot (swapSummon closes the other).
      if (change === "Conflicted") {
        useSummonStore.getState().swapSummon("merge", "diff", { repoId: repo.id, path });
      } else {
        useSummonStore.getState().swapSummon("diff", "merge", {
          repoId: repo.id,
          path,
          source,
          change,
          // Lets the diff pair a rename's sides; without it a staged rename
          // reads as a whole-file add.
          oldPath: entry?.old_path ?? null,
        } satisfies DiffRequest);
      }
    },
    [repo, entryFor],
  );

  // A case-drift row's diff request: the rename pair, whose diff is empty
  // (git sees a clean tree), so the Diff panel renders the "Renamed from
  // old → new (no content changes)" notice - mirroring the staged side.
  const driftDiffRequest = useCallback(
    (d: CaseDriftEntry): DiffRequest => ({
      repoId: repo!.id,
      path: d.disk_path,
      source: { kind: "working_unstaged" },
      change: "Renamed",
      oldPath: d.index_path,
    }),
    [repo],
  );

  // After a stage/unstage/discard, keep an ALREADY-OPEN diff viewer in sync with
  // the resulting selection (without forcing it open). If a single file is
  // selected after the op, show its diff in the new section (e.g. staging flips
  // it from the unstaged to the staged diff). If a previously single-selected
  // file is now gone (discarded), clear the viewer. Otherwise leave it alone.
  const syncOpenDiff = useCallback(
    (prev: Selection | null, next: Selection | null) => {
      if (!repo) return;
      const store = useSummonStore.getState();
      if (next && next.paths.length === 1) {
        const source: DiffSource =
          next.section === "staged" ? { kind: "working_staged" } : { kind: "working_unstaged" };
        const entry = entryFor(next.section, next.paths[0]);
        if (entry?.state === "Conflicted") {
          store.notifyIfOpen("merge", { repoId: repo.id, path: next.paths[0] });
          store.notifyIfOpen("diff", null);
        } else {
          store.notifyIfOpen("diff", {
            repoId: repo.id,
            path: next.paths[0],
            source,
            change: entry?.state,
            oldPath: entry?.old_path ?? null,
          } satisfies DiffRequest);
          store.notifyIfOpen("merge", null);
        }
        return;
      }
      if (prev && prev.paths.length === 1 && !next?.paths.includes(prev.paths[0])) {
        store.notifyIfOpen("diff", null);
        store.notifyIfOpen("merge", null);
      }
    },
    [repo, entryFor],
  );

  return { openDiff, driftDiffRequest, syncOpenDiff };
}

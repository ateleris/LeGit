import { useCallback, useMemo, useState } from "react";
import { PanelError } from "../shared/PanelError";
import { useRepoSwitchClear } from "../shared/useRepoSwitchClear";
import { useQuery } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useSettingsStore } from "../../store/settings";
import { useSummonStore, useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import { repoDiffFiles, repoMergeBase } from "../../lib/commands";
import type { CommitFileChange, DiffRequest } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { Button } from "../shared/buttons";
import { segStyle } from "../shared/segmented";
import { TOOLBAR_FIELD_STYLE } from "../shared/fields";
import { FileTree } from "../shared/FileTree/FileTree";
import { useFileRowMetrics } from "../shared/FileTree/useFileRowMetrics";
import type { FileTreeEntry, ViewMode } from "../shared/FileTree/buildTree";
import { PanelContextMenuProvider } from "../Commits/menu/PanelContextMenu";
import { MenuItem, SectionLabel } from "../Commits/menu/primitives";
import { CopyPathMenuSection } from "../shared/CopyPathMenuSection";
import { OpenInEditorMenuItem } from "../shared/OpenInEditorMenuItem";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { RevPicker } from "../shared/RevPicker";
import type { FileViewRequest } from "../FileView/FileViewPanel";

/** Payload for summoning the Compare panel with a prefilled range. */
export interface CompareRequest {
  from: string;
  to: string;
}

/** Two-dot compares the snapshots directly; three-dot from the merge base. */
type CompareMode = "two-dot" | "three-dot";

/** The submitted comparison: `from` is already the effective base (the
 *  merge base in three-dot mode); `displayFrom` is what the user typed. */
interface SubmittedRange {
  from: string;
  to: string;
  displayFrom: string;
}

/**
 * Compare panel - a snapshot diff between two arbitrary revs (branch names,
 * tags, shas, `HEAD~3`, …), directly (two-dot) or from their merge base
 * (three-dot, "what would merging `to` bring on top of `from`"). Lists the
 * changed files in the shared FileTree shell (same rows, status icons,
 * Tree/Flat toggle, and keyboard behaviour as Changed Files); clicking one
 * opens the read-only range diff in the Diff panel. Summoned from a commit
 * row ("Compare with HEAD") with the range prefilled, or opened bare from
 * the View menu.
 */
export function ComparePanel() {
  const repo = useActiveRepo();

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("HEAD");
  const [mode, setMode] = useState<CompareMode>("two-dot");
  // The submitted range — compare runs on demand, not per keystroke.
  const [range, setRange] = useState<SubmittedRange | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Merge-base resolution failure (three-dot only) - shown in place of results.
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Deliberately LOCAL, unlike Changed Files / Working Changes: those two
  // share a panel slot, so their toggles flipping together reads as one
  // view - Compare is its own surface and keeps its own mode (seeded from
  // the shared preference on mount, not persisted).
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    useSettingsStore.getState().settings?.changed_files_view_mode === "tree" ? "tree" : "flat",
  );
  const { rowHeight, iconSize } = useFileRowMetrics();

  // Every range change invalidates the file selection; an already-open Diff
  // would otherwise keep showing the previous comparison (never force-opens).
  const applyRange = useCallback((next: SubmittedRange | null) => {
    setRange(next);
    setSelectedPath(null);
    useSummonStore.getState().notifyIfOpen("diff", null);
  }, []);

  // Reset when the repo changes - the revs (and any resolved merge base)
  // belong to the previous repo; the repo-keyed query would otherwise re-run
  // them against the new one. Except when the range was summoned FOR the
  // repo being switched to, and not on first mount (useRepoSwitchClear).
  const markDelivered = useRepoSwitchClear(
    repo?.id,
    useCallback(() => {
      setFrom("");
      setTo("HEAD");
      setRange(null);
      setSelectedPath(null);
      setResolveError(null);
    }, []),
  );

  const onReceive = useCallback((payload: unknown) => {
    const p = payload as Partial<CompareRequest> | null;
    if (p && typeof p.from === "string") {
      const next = { from: p.from, to: typeof p.to === "string" ? p.to : "HEAD" };
      setFrom(next.from);
      setTo(next.to);
      setMode("two-dot"); // a summoned range is a direct snapshot compare
      setResolveError(null);
      applyRange({ ...next, displayFrom: next.from });
      markDelivered();
    }
  }, [applyRange, markDelivered]);
  useSummonTarget("compare", onReceive);

  const { data: files = [], isFetching, isError, error, refetch } = useQuery<CommitFileChange[]>({
    queryKey: [repo?.id, "log", "compare", range],
    queryFn: () => repoDiffFiles(repo!.id, range!.from, range!.to),
    enabled: !!repo && !!range,
    staleTime: 5_000,
  });
  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  const totals = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const f of files) {
      add += f.additions;
      del += f.deletions;
    }
    return { add, del };
  }, [files]);

  const compare = async (nextMode: CompareMode = mode) => {
    const f = from.trim();
    const t = to.trim();
    if (!f || !t || !repo) return;
    setResolveError(null);
    if (nextMode === "three-dot") {
      // Resolve the merge base once here; the file list AND the per-file
      // diffs (DiffSource::CommitRange) then share the same concrete base.
      try {
        const base = await repoMergeBase(repo.id, f, t);
        if (!base) {
          applyRange(null);
          setResolveError(`${f} and ${t} have no common ancestor.`);
          return;
        }
        applyRange({ from: base, to: t, displayFrom: f });
      } catch (e) {
        applyRange(null);
        setResolveError(formatAppError(e));
      }
    } else {
      applyRange({ from: f, to: t, displayFrom: f });
    }
  };

  const setModeAndRerun = (m: CompareMode) => {
    setMode(m);
    // Re-run an existing comparison under the new mode right away.
    if (range) void compare(m);
  };

  const swap = () => {
    setFrom(to);
    setTo(from);
    applyRange(null);
    setResolveError(null);
  };

  const diffRequest = useCallback(
    (f: FileTreeEntry): DiffRequest | null => {
      if (!repo || !range || !f.change) return null;
      return {
        repoId: repo.id,
        path: f.path,
        source: { kind: "commit_range", from: range.from, to: range.to },
        change: f.change,
        oldPath: f.old_path,
      };
    },
    [repo, range],
  );

  const handleSelect = useCallback(
    (f: FileTreeEntry) => {
      setSelectedPath(f.path);
      const req = diffRequest(f);
      if (req) useSummonStore.getState().summon("diff", req);
    },
    [diffRequest],
  );

  // Right-click targeting mirrors Changed Files: the selection moves to the
  // clicked row, and an ALREADY-OPEN diff follows it - but a right-click
  // never force-opens one (notifyIfOpen, unlike handleSelect's summon).
  const selectForMenu = useCallback(
    (f: FileTreeEntry) => {
      setSelectedPath(f.path);
      const req = diffRequest(f);
      if (req) useSummonStore.getState().notifyIfOpen("diff", req);
    },
    [diffRequest],
  );

  if (!repo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">No repository open.</span>
        </div>
      </div>
    );
  }

  return (
    <PanelContextMenuProvider baseline={[]}>
      {({ openMenu, closeMenu }) => (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <RevPicker
          repoId={repo.id}
          value={from}
          onChange={setFrom}
          onEnter={() => void compare()}
          placeholder="from (branch / sha / HEAD~n)"
          style={{ ...TOOLBAR_FIELD_STYLE, flex: 1, minWidth: 0 }}
        />
        <Button variant="ghost" title="Swap sides" onClick={swap}>
          ⇄
        </Button>
        <RevPicker
          repoId={repo.id}
          value={to}
          onChange={setTo}
          onEnter={() => void compare()}
          placeholder="to"
          style={{ ...TOOLBAR_FIELD_STYLE, flex: 1, minWidth: 0 }}
        />
        <div style={{ display: "flex", flexShrink: 0 }} role="group" aria-label="Compare mode">
          <button
            onClick={() => setModeAndRerun("two-dot")}
            aria-pressed={mode === "two-dot"}
            title="Two-dot: diff the two snapshots directly"
            style={{ ...segStyle(mode === "two-dot", "left"), fontFamily: "monospace" }}
          >
            A..B
          </button>
          <button
            onClick={() => setModeAndRerun("three-dot")}
            aria-pressed={mode === "three-dot"}
            title="Three-dot: diff from the merge base, what B adds on top of A"
            style={{ ...segStyle(mode === "three-dot", "right"), fontFamily: "monospace" }}
          >
            A...B
          </button>
        </div>
        <Button variant="primary" disabled={!from.trim() || !to.trim()} onClick={() => void compare()}>
          Compare
        </Button>
      </div>

      {range && files.length > 0 && (
        <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex" }}>
            <button onClick={() => setViewMode("tree")} aria-pressed={viewMode === "tree"} style={segStyle(viewMode === "tree", "left")}>
              Tree
            </button>
            <button onClick={() => setViewMode("flat")} aria-pressed={viewMode === "flat"} style={segStyle(viewMode === "flat", "right")}>
              List
            </button>
          </div>
          <span
            className="legit-subtle"
            style={{ fontSize: "var(--fz-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
          >
            {files.length} file{files.length === 1 ? "" : "s"}
            {totals.add > 0 && (
              <> · <span style={{ color: "var(--status-added)" }}>+{totals.add}</span></>
            )}
            {totals.del > 0 && (
              <> <span style={{ color: "var(--status-deleted)" }}>−{totals.del}</span></>
            )}
            {" · "}
            <code>
              {range.displayFrom}
              {mode === "three-dot" ? "..." : ".."}
              {range.to}
            </code>
          </span>
        </div>
      )}

      {isError && <PanelError error={error} />}
      {resolveError && <PanelError error={resolveError} />}

      {!range && !resolveError && !isError && (
        <div className="legit-panel__body">
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            Enter two revs to compare - the file list shows what changed going
            from the left rev to the right one. A...B compares from the merge
            base instead (what B would bring into A).
          </span>
        </div>
      )}

      {range && files.length === 0 && !isFetching && !isError && (
        <div className="legit-panel__body">
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No differences between {range.displayFrom} and {range.to}
            {mode === "three-dot" ? " since their merge base" : ""}.
          </span>
        </div>
      )}

      {files.length > 0 && (
        <FileTree
          files={files}
          viewMode={viewMode}
          selectedPath={selectedPath}
          onSelect={handleSelect}
          rowHeight={rowHeight}
          iconSize={iconSize}
          onContextMenu={(file, e) => {
            selectForMenu(file);
            openMenu(
              e,
              <CompareFileMenuSection
                file={file}
                toRev={range!.to}
                onClose={closeMenu}
              />,
            );
          }}
        />
      )}
    </div>
      )}
    </PanelContextMenuProvider>
  );
}

/**
 * Context-menu section for one file of the comparison: read-only actions at
 * the range's right rev (view/blame the content the compare arrived at),
 * plus history / copy path / open the working-tree copy. No staging or
 * restore entries - a compare row is a snapshot diff, not a working-tree
 * change (unlike Changed Files' menu).
 */
function CompareFileMenuSection({
  file,
  toRev,
  onClose,
}: {
  file: FileTreeEntry;
  /** The comparison's right rev, as the user typed it (full shas shortened). */
  toRev: string;
  onClose: () => void;
}) {
  // The file was deleted going from -> to: there is no content at `to`.
  const deleted = file.change === "Deleted";
  // A gitlink has no file content: view/blame would error on it.
  const submodule = file.change === "SubmoduleChanged";
  const revLabel = /^[0-9a-f]{40}$/.test(toRev) ? toRev.slice(0, 8) : toRev;

  return (
    <>
      <SectionLabel>{file.path}</SectionLabel>
      <MenuItem
        disabled={deleted || submodule}
        onClick={() => {
          onClose();
          useSummonStore.getState().summon("file-view", {
            path: file.path,
            rev: toRev,
          } satisfies FileViewRequest);
        }}
      >
        {deleted ? `View file (deleted in this range)` : `View file at ${revLabel}`}
      </MenuItem>
      <MenuItem
        onClick={() => {
          onClose();
          useSummonStore.getState().summon("file-history", file.path);
        }}
      >
        File history
      </MenuItem>
      <CopyPathMenuSection path={file.path} onClose={onClose} />
      {/* Opens the current working-tree file (not the content at the rev);
          a deleted row has no working-tree file to open. */}
      {!deleted && !submodule && (
        <OpenInEditorMenuItem path={file.path} onClose={onClose} />
      )}
      <MenuItem
        disabled={deleted || submodule}
        onClick={() => {
          onClose();
          useSummonStore.getState().summon("blame", { path: file.path, rev: toRev });
        }}
      >
        {deleted ? "Blame file (deleted in this range)" : `Blame file at ${revLabel}`}
      </MenuItem>
    </>
  );
}

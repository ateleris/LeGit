import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useSummonStore, useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import { repoDiffFiles, repoMergeBase } from "../../lib/commands";
import type { CommitFileChange, DiffRequest } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { Button } from "../shared/buttons";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { RevPicker } from "../shared/RevPicker";

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
 * changed files; clicking one opens the read-only range diff in the Diff
 * panel. Summoned from a commit row ("Compare with HEAD") with the range
 * prefilled, or opened bare from the View menu.
 */
export function ComparePanel() {
  const repo = useActiveRepo();

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("HEAD");
  const [mode, setMode] = useState<CompareMode>("two-dot");
  // The submitted range — compare runs on demand, not per keystroke.
  const [range, setRange] = useState<SubmittedRange | null>(null);
  // Merge-base resolution failure (three-dot only) - shown in place of results.
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Reset when the repo changes - the revs (and any resolved merge base)
  // belong to the previous repo; the repo-keyed query would otherwise re-run
  // them against the new one. Same guard as Blame/FileView/ChangedFiles.
  const prevRepoId = useRef(repo?.id);
  useEffect(() => {
    if (prevRepoId.current === repo?.id) return;
    prevRepoId.current = repo?.id;
    setFrom("");
    setTo("HEAD");
    setRange(null);
    setResolveError(null);
  }, [repo?.id]);

  const onReceive = useCallback((payload: unknown) => {
    const p = payload as Partial<CompareRequest> | null;
    if (p && typeof p.from === "string") {
      const next = { from: p.from, to: typeof p.to === "string" ? p.to : "HEAD" };
      setFrom(next.from);
      setTo(next.to);
      setMode("two-dot"); // a summoned range is a direct snapshot compare
      setResolveError(null);
      setRange({ ...next, displayFrom: next.from });
    }
  }, []);
  useSummonTarget("compare", onReceive);

  const { data: files = [], isFetching, isError, error, refetch } = useQuery<CommitFileChange[]>({
    queryKey: [repo?.id, "log", "compare", range],
    queryFn: () => repoDiffFiles(repo!.id, range!.from, range!.to),
    enabled: !!repo && !!range,
    staleTime: 5_000,
  });
  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

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
          setRange(null);
          setResolveError(`${f} and ${t} have no common ancestor.`);
          return;
        }
        setRange({ from: base, to: t, displayFrom: f });
      } catch (e) {
        setRange(null);
        setResolveError(formatAppError(e));
      }
    } else {
      setRange({ from: f, to: t, displayFrom: f });
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
    setRange(null);
    setResolveError(null);
  };

  const openFileDiff = (f: CommitFileChange) => {
    if (!repo || !range) return;
    useSummonStore.getState().summon("diff", {
      repoId: repo.id,
      path: f.path,
      source: { kind: "commit_range", from: range.from, to: range.to },
      change: f.change,
      oldPath: f.old_path,
    } satisfies DiffRequest);
  };

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
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <RevPicker
          repoId={repo.id}
          value={from}
          onChange={setFrom}
          onEnter={() => void compare()}
          placeholder="from (branch / sha / HEAD~n)"
          style={{ flex: 1, minWidth: 0 }}
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
          style={{ flex: 1, minWidth: 0 }}
        />
        <div style={{ display: "flex", flexShrink: 0 }} role="group" aria-label="Compare mode">
          <button
            onClick={() => setModeAndRerun("two-dot")}
            aria-pressed={mode === "two-dot"}
            title="Two-dot: diff the two snapshots directly"
            style={modeSegStyle(mode === "two-dot", "left")}
          >
            A..B
          </button>
          <button
            onClick={() => setModeAndRerun("three-dot")}
            aria-pressed={mode === "three-dot"}
            title="Three-dot: diff from the merge base, what B adds on top of A"
            style={modeSegStyle(mode === "three-dot", "right")}
          >
            A...B
          </button>
        </div>
        <Button variant="primary" disabled={!from.trim() || !to.trim()} onClick={() => void compare()}>
          Compare
        </Button>
      </div>

      <div className="legit-panel__body" style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
        {isError && (
          <pre className="legit-error" style={{ margin: 0, fontSize: "var(--fz-md)" }}>
            {String((error as Error)?.message ?? error)}
          </pre>
        )}
        {resolveError && (
          <pre className="legit-error" style={{ margin: 0, fontSize: "var(--fz-md)" }}>
            {resolveError}
          </pre>
        )}
        {!range ? (
          !resolveError && (
            <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
              Enter two revs to compare - the file list shows what changed going
              from the left rev to the right one. A...B compares from the merge
              base instead (what B would bring into A).
            </span>
          )
        ) : files.length === 0 && !isFetching && !isError ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No differences between {range.displayFrom} and {range.to}
            {mode === "three-dot" ? " since their merge base" : ""}.
          </span>
        ) : (
          files.map((f) => (
            <button
              key={`${f.path}|${f.old_path ?? ""}`}
              onClick={() => openFileDiff(f)}
              title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                textAlign: "left",
                background: "transparent",
                border: "none",
                borderRadius: 3,
                padding: "2px 6px",
                cursor: "pointer",
                minWidth: 0,
              }}
            >
              <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", width: "1.5em", flexShrink: 0 }}>
                {f.change.slice(0, 1)}
              </span>
              <span
                style={{
                  fontSize: "var(--fz-md)",
                  fontFamily: "monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                }}
              >
                {f.path}
              </span>
              {!f.binary && (
                <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", fontFamily: "monospace", flexShrink: 0 }}>
                  +{f.additions} −{f.deletions}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/** Segmented-toggle button style (matches the Changed Files Tree/List toggle). */
function modeSegStyle(active: boolean, side: "left" | "right"): React.CSSProperties {
  return {
    fontSize: "var(--fz-sm)",
    fontFamily: "monospace",
    padding: "2px 8px",
    border: "1px solid var(--panel-border)",
    borderRadius: side === "left" ? "3px 0 0 3px" : "0 3px 3px 0",
    marginLeft: side === "right" ? -1 : 0,
    background: active ? "var(--button-active-bg, rgba(255,255,255,0.12))" : "transparent",
    color: "var(--panel-fg)",
    cursor: "pointer",
  };
}

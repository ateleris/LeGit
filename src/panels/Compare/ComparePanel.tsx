import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useSummonStore, useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import { repoDiffFiles } from "../../lib/commands";
import type { CommitFileChange, DiffRequest } from "../../lib/types";
import { Button } from "../shared/buttons";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";

/** Payload for summoning the Compare panel with a prefilled range. */
export interface CompareRequest {
  from: string;
  to: string;
}

const monoInput: React.CSSProperties = {
  fontSize: "var(--fz-md)",
  fontFamily: "monospace",
  flex: 1,
  minWidth: 0,
};

/**
 * Compare panel — a direct snapshot diff between two arbitrary revs (branch
 * names, tags, shas, `HEAD~3`, …). Lists the changed files; clicking one
 * opens the read-only range diff in the Diff panel. Summoned from a commit
 * row ("Compare with HEAD") with the range prefilled, or opened bare from
 * the View menu.
 */
export function ComparePanel() {
  const repo = useActiveRepo();

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("HEAD");
  // The submitted range — compare runs on demand, not per keystroke.
  const [range, setRange] = useState<CompareRequest | null>(null);

  const onReceive = useCallback((payload: unknown) => {
    const p = payload as Partial<CompareRequest> | null;
    if (p && typeof p.from === "string") {
      const next = { from: p.from, to: typeof p.to === "string" ? p.to : "HEAD" };
      setFrom(next.from);
      setTo(next.to);
      setRange(next);
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

  const compare = () => {
    const f = from.trim();
    const t = to.trim();
    if (f && t) setRange({ from: f, to: t });
  };

  const swap = () => {
    setFrom(to);
    setTo(from);
    if (range) setRange({ from: range.to, to: range.from });
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
        <input
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && compare()}
          placeholder="from (branch / sha / HEAD~n)"
          style={monoInput}
        />
        <Button variant="ghost" title="Swap sides" onClick={swap}>
          ⇄
        </Button>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && compare()}
          placeholder="to"
          style={monoInput}
        />
        <Button variant="primary" disabled={!from.trim() || !to.trim()} onClick={compare}>
          Compare
        </Button>
      </div>

      <div className="legit-panel__body" style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
        {isError && (
          <pre className="legit-error" style={{ margin: 0, fontSize: "var(--fz-md)" }}>
            {String((error as Error)?.message ?? error)}
          </pre>
        )}
        {!range ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            Enter two revs to compare — the file list shows what changed going
            from the left rev to the right one.
          </span>
        ) : files.length === 0 && !isFetching && !isError ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No differences between {range.from} and {range.to}.
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

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useSummonStore, useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import { repoBlame } from "../../lib/commands";
import type { BlameHunk } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { formatRelative } from "../../lib/time";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";

const UNCOMMITTED = "0".repeat(40);

/**
 * Blame panel — the working-tree file annotated per hunk with the commit
 * that last touched those lines (git blame --porcelain; contents come from
 * the blame output itself, so meta and code can never misalign). Clicking a
 * hunk's meta opens the commit; uncommitted lines show as such. Summoned
 * with a path (Search results, file context menus).
 */
export function BlamePanel() {
  const repo = useActiveRepo();
  const [path, setPath] = useState<string | null>(null);

  // Reset when the repo changes — the path belongs to the previous repo.
  const prevRepoId = useRef(repo?.id);
  useEffect(() => {
    if (prevRepoId.current === repo?.id) return;
    prevRepoId.current = repo?.id;
    setPath(null);
  }, [repo?.id]);

  const onReceive = useCallback((payload: unknown) => {
    if (typeof payload === "string") setPath(payload);
  }, []);
  useSummonTarget("blame", onReceive);

  const { data: hunks = [], isFetching, isError, error, refetch } = useQuery<BlameHunk[]>({
    // Under the "log" domain: blame changes exactly when history/worktree do.
    queryKey: [repo?.id, "log", "blame", path],
    queryFn: () => repoBlame(repo!.id, path!),
    enabled: !!repo && !!path,
    staleTime: 5_000,
  });
  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  const openCommit = (h: BlameHunk) => {
    if (h.sha === UNCOMMITTED) return;
    const summon = useSummonStore.getState();
    summon.summon("commit-details", h.sha);
    summon.swapSummon("changed-files", "working-changes", h.sha);
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

  if (!path) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            Blame a file from the Search panel's path results or a file's
            context menu.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          className="legit-subtle"
          style={{
            fontSize: "var(--fz-sm)",
            fontFamily: "monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={path}
        >
          {path}
        </span>
      </div>

      <div className="legit-panel__body" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 0 }}>
        {isError ? (
          <pre className="legit-error" style={{ margin: 8, fontSize: "var(--fz-md)" }}>
            {formatAppError(error)}
          </pre>
        ) : (
          hunks.map((h, i) => <HunkRow key={`${h.sha}-${h.start_line}`} hunk={h} tinted={i % 2 === 1} onOpen={() => openCommit(h)} />)
        )}
      </div>
    </div>
  );
}

function HunkRow({ hunk, tinted, onOpen }: { hunk: BlameHunk; tinted: boolean; onOpen: () => void }) {
  const uncommitted = hunk.sha === UNCOMMITTED;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        background: tinted ? "var(--button-hover-bg)" : "transparent",
        borderBottom: "1px solid var(--panel-border)",
      }}
    >
      <button
        onClick={onOpen}
        disabled={uncommitted}
        title={
          uncommitted
            ? "Uncommitted changes"
            : `${hunk.sha.slice(0, 8)} · ${hunk.author} · ${hunk.summary}`
        }
        style={{
          width: "16em",
          flexShrink: 0,
          textAlign: "left",
          background: "transparent",
          border: "none",
          borderRight: "1px solid var(--panel-border)",
          padding: "2px 8px",
          cursor: uncommitted ? "default" : "pointer",
          overflow: "hidden",
        }}
      >
        <span style={{ display: "block", fontSize: "var(--fz-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {uncommitted ? <span className="legit-subtle">uncommitted</span> : hunk.summary}
        </span>
        <span className="legit-subtle" style={{ display: "block", fontSize: "var(--fz-sm)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {uncommitted ? "" : `${hunk.sha.slice(0, 8)} · ${hunk.author} · ${formatRelative(hunk.timestamp)}`}
        </span>
      </button>
      <pre
        style={{
          margin: 0,
          padding: "2px 8px",
          fontSize: "var(--fz-md)",
          fontFamily: "monospace",
          flex: 1,
          overflowX: "auto",
        }}
      >
        {hunk.lines
          .map((line, i) => `${String(hunk.start_line + i).padStart(5)}  ${line}`)
          .join("\n")}
      </pre>
    </div>
  );
}

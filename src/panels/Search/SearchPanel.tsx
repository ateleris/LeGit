import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useActiveRepo } from "../../store/repos";
import { useSummonStore } from "../../store/summon";
import { useRestoreVirtualizerScroll } from "../PanelApiContext";
import { repoSearchCommits, repoSearchPaths } from "../../lib/commands";
import type { Commit, CommitSearchKind } from "../../lib/types";
import { formatRelative } from "../../lib/time";
import { Button } from "../shared/buttons";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { useFileRowMetrics } from "../shared/FileTree/useFileRowMetrics";
import { PanelContextMenuProvider } from "../Commits/menu/PanelContextMenu";
import { MenuItem, SectionLabel } from "../Commits/menu/primitives";
import { CopyPathMenuSection } from "../shared/CopyPathMenuSection";

type SearchKind = CommitSearchKind | "paths";

const KIND_LABELS: Record<SearchKind, string> = {
  message: "Message",
  author: "Author",
  content: "Content (pickaxe)",
  content_regex: "Content (regex)",
  paths: "File paths",
};

// Results render in a virtualized list, so a big cap costs only git time.
const MAX_RESULTS = 1000;

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  textAlign: "left",
  background: "transparent",
  border: "none",
  borderRadius: 3,
  padding: "0 6px",
  cursor: "pointer",
  minWidth: 0,
  width: "100%",
  boxSizing: "border-box",
};

/**
 * Search panel — commits by message/author, commits by content (git's
 * pickaxe: commits changing the number of occurrences of a literal string),
 * or tracked file paths. Commit hits open Commit Details; path hits open
 * the Blame view.
 */
export function SearchPanel() {
  const repo = useActiveRepo();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SearchKind>("message");
  // Submitted search — runs on demand (content search is expensive).
  const [submitted, setSubmitted] = useState<{ query: string; kind: SearchKind } | null>(null);

  // Reset the submitted search when the repo changes so an expensive content
  // search doesn't silently re-run against the new repo (query/kind inputs
  // are repo-agnostic and kept). Same guard as the sibling summon panels.
  const prevRepoId = useRef(repo?.id);
  useEffect(() => {
    if (prevRepoId.current === repo?.id) return;
    prevRepoId.current = repo?.id;
    setSubmitted(null);
  }, [repo?.id]);

  const { data: commits = [], isFetching: fetchingCommits, isError, error } = useQuery<Commit[]>({
    queryKey: [repo?.id, "log", "search-commits", submitted],
    queryFn: () =>
      repoSearchCommits(repo!.id, submitted!.query, submitted!.kind as CommitSearchKind, MAX_RESULTS),
    enabled: !!repo && !!submitted && submitted.kind !== "paths",
    staleTime: 30_000,
  });

  const { data: paths = [], isFetching: fetchingPaths } = useQuery<string[]>({
    queryKey: [repo?.id, "log", "search-paths", submitted],
    queryFn: () => repoSearchPaths(repo!.id, submitted!.query, MAX_RESULTS),
    enabled: !!repo && !!submitted && submitted.kind === "paths",
    staleTime: 30_000,
  });

  const search = useCallback(() => {
    const q = query.trim();
    if (q) setSubmitted({ query: q, kind });
  }, [query, kind]);

  // Virtualized results (the cap is high enough that plain mapping would
  // put thousands of DOM rows in the panel).
  const { rowHeight } = useFileRowMetrics();
  const parentRef = useRef<HTMLDivElement>(null);
  const showCommitRows = submitted && submitted.kind !== "paths";
  const resultCount = showCommitRows ? commits.length : paths.length;
  const virtualizer = useVirtualizer({
    count: resultCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });
  useEffect(() => {
    virtualizer.scrollToOffset(0);
    // A new submission restarts the list from the top.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitted]);

  // Restore scroll (and re-render) when this panel is tab-shown again.
  useRestoreVirtualizerScroll(virtualizer, parentRef);

  const openCommit = (c: Commit) => {
    const summon = useSummonStore.getState();
    summon.summon("commit-details", c.id);
    summon.swapSummon("changed-files", "working-changes", c.id);
    // Keep the Commits graph highlight in step (only if that panel is open).
    summon.notifyIfOpen("log", c.id);
  };

  const openBlame = (path: string) => {
    useSummonStore.getState().summon("blame", path);
  };

  const openFileHistory = (path: string) => {
    useSummonStore.getState().summon("file-history", path);
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

  const busy = fetchingCommits || fetchingPaths;

  return (
    <PanelContextMenuProvider baseline={[]}>
      {({ openMenu, closeMenu }) => (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={busy} />
      <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as SearchKind)}
          style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}
        >
          {(Object.keys(KIND_LABELS) as SearchKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder={
            kind === "paths"
              ? "path substring…"
              : kind === "content"
                ? "literal string (finds commits changing it)…"
                : kind === "content_regex"
                  ? "regex (finds commits whose diff touches a matching line)…"
                  : "search…"
          }
          style={{ fontSize: "var(--fz-md)", flex: 1, minWidth: 0 }}
        />
        <Button variant="primary" disabled={!query.trim() || busy} onClick={search}>
          Search
        </Button>
      </div>

      <div
        className="legit-panel__body"
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 2 }}
      >
        {isError && (
          <pre className="legit-error" style={{ margin: 0, fontSize: "var(--fz-md)" }}>
            {String((error as Error)?.message ?? error)}
          </pre>
        )}
        {!submitted ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            Search commit messages, authors, file contents (which commits added
            or removed a string), or tracked file paths.
          </span>
        ) : resultCount === 0 ? (
          !busy && (
            <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>No matches.</span>
          )
        ) : (
          <div ref={parentRef} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const positioned: React.CSSProperties = {
                  ...rowStyle,
                  position: "absolute",
                  top: 0,
                  left: 0,
                  height: vi.size,
                  transform: `translateY(${vi.start}px)`,
                };
                if (showCommitRows) {
                  const c = commits[vi.index];
                  return (
                    <button key={c.id} onClick={() => openCommit(c)} style={positioned} title={c.message}>
                      <span className="legit-subtle" style={{ fontFamily: "monospace", fontSize: "var(--fz-sm)", flexShrink: 0 }}>
                        {c.id.slice(0, 8)}
                      </span>
                      <span
                        style={{
                          fontSize: "var(--fz-md)",
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {c.message.split("\n")[0]}
                      </span>
                      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
                        {c.author.name} · {formatRelative(c.timestamp)}
                      </span>
                    </button>
                  );
                }
                const p = paths[vi.index];
                return (
                  <button
                    key={p}
                    onClick={() => openBlame(p)}
                    onContextMenu={(e) =>
                      openMenu(
                        e,
                        <>
                          <SectionLabel>{p}</SectionLabel>
                          <MenuItem onClick={() => { closeMenu(); openFileHistory(p); }}>
                            File history
                          </MenuItem>
                          <MenuItem onClick={() => { closeMenu(); openBlame(p); }}>
                            Blame
                          </MenuItem>
                          <CopyPathMenuSection path={p} onClose={closeMenu} />
                        </>,
                      )
                    }
                    style={positioned}
                    title={`Blame ${p}`}
                  >
                    <span
                      style={{
                        fontSize: "var(--fz-md)",
                        fontFamily: "monospace",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {submitted && resultCount >= MAX_RESULTS && (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
            Showing the first {MAX_RESULTS} matches - refine the query for more.
          </span>
        )}
      </div>
    </div>
      )}
    </PanelContextMenuProvider>
  );
}

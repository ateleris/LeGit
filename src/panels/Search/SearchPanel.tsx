import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useSummonStore } from "../../store/summon";
import { repoSearchCommits, repoSearchPaths } from "../../lib/commands";
import type { Commit, CommitSearchKind } from "../../lib/types";
import { formatRelative } from "../../lib/time";
import { Button } from "../shared/buttons";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";

type SearchKind = CommitSearchKind | "paths";

const KIND_LABELS: Record<SearchKind, string> = {
  message: "Message",
  author: "Author",
  content: "Content (pickaxe)",
  paths: "File paths",
};

const MAX_RESULTS = 100;

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 8,
  textAlign: "left",
  background: "transparent",
  border: "none",
  borderRadius: 3,
  padding: "2px 6px",
  cursor: "pointer",
  minWidth: 0,
  width: "100%",
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

  const openCommit = (c: Commit) => {
    const summon = useSummonStore.getState();
    summon.summon("commit-details", c.id);
    summon.swapSummon("changed-files", "working-changes", c.id);
  };

  const openBlame = (path: string) => {
    useSummonStore.getState().summon("blame", path);
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
  const showCommits = submitted && submitted.kind !== "paths";

  return (
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
        style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}
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
        ) : showCommits ? (
          commits.length === 0 && !busy ? (
            <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>No matches.</span>
          ) : (
            commits.map((c) => (
              <button key={c.id} onClick={() => openCommit(c)} style={rowStyle} title={c.message}>
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
            ))
          )
        ) : paths.length === 0 && !busy ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>No matches.</span>
        ) : (
          paths.map((p) => (
            <button key={p} onClick={() => openBlame(p)} style={rowStyle} title={`Blame ${p}`}>
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
          ))
        )}
        {submitted && (showCommits ? commits.length : paths.length) >= MAX_RESULTS && (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            Showing the first {MAX_RESULTS} matches — refine the query for more.
          </span>
        )}
      </div>
    </div>
  );
}

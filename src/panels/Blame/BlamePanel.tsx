import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useSettingsStore } from "../../store/settings";
import { useSummonStore, useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import { repoBlame } from "../../lib/commands";
import type { BlameHunk } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { formatRelative } from "../../lib/time";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { RevPicker } from "../shared/RevPicker";
import {
  MAX_SYNTAX_CHARS,
  computeFileSyntaxSegments,
  syntaxVarFor,
  type SyntaxSegment,
} from "../Diff/syntaxModel";
import { loadParserForPath } from "../Diff/syntaxLanguages";

const UNCOMMITTED = "0".repeat(40);

/** Summon payload for blaming at a revision (a bare string = working tree). */
export interface BlameRequest {
  path: string;
  /** Tree-ish to blame at; null/absent blames the working tree. */
  rev?: string | null;
}

/**
 * Blame panel - a file annotated per hunk with the commit that last touched
 * those lines (git blame --porcelain; contents come from the blame output
 * itself, so meta and code can never misalign). Blames the working tree by
 * default, or the file as of a revision ("time-travel": each hunk offers a
 * re-blame at its commit's parent, stepping past that change). Clicking a
 * hunk's meta opens the commit; uncommitted lines show as such. Summoned
 * with a path string (Search results, file context menus) or a
 * `BlameRequest` with a rev.
 */
export function BlamePanel() {
  const repo = useActiveRepo();
  const [path, setPath] = useState<string | null>(null);
  const [rev, setRev] = useState<string | null>(null);
  // Toolbar rev input draft - applied on Enter, kept in sync when the rev
  // changes through other paths (summon payload, per-hunk time travel).
  const [revDraft, setRevDraft] = useState("");
  useEffect(() => setRevDraft(rev ?? ""), [rev]);

  // Reset when the repo changes — the path belongs to the previous repo.
  const prevRepoId = useRef(repo?.id);
  useEffect(() => {
    if (prevRepoId.current === repo?.id) return;
    prevRepoId.current = repo?.id;
    setPath(null);
    setRev(null);
  }, [repo?.id]);

  const onReceive = useCallback((payload: unknown) => {
    if (typeof payload === "string") {
      setPath(payload);
      setRev(null);
      return;
    }
    const p = payload as Partial<BlameRequest> | null;
    if (p && typeof p.path === "string") {
      setPath(p.path);
      setRev(typeof p.rev === "string" ? p.rev : null);
    }
  }, []);
  useSummonTarget("blame", onReceive);

  const { data: hunks = [], isFetching, isError, error, refetch } = useQuery<BlameHunk[]>({
    // Under the "log" domain: blame changes exactly when history/worktree do.
    queryKey: [repo?.id, "log", "blame", rev, path],
    queryFn: () => repoBlame(repo!.id, path!, rev),
    enabled: !!repo && !!path,
    staleTime: 5_000,
  });
  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  // Syntax highlighting (global opt-in). Blame hunks tile the whole file in
  // order, so the full file is reconstructed and parsed once (full fidelity);
  // segments are addressed by absolute line via each hunk's start_line.
  const syntaxEnabled = useSettingsStore((s) => s.settings?.diff_syntax_highlighting ?? false);
  const [segments, setSegments] = useState<SyntaxSegment[][] | null>(null);
  useEffect(() => {
    setSegments(null);
    if (!syntaxEnabled || !path || hunks.length === 0) return;
    const lines = hunks.flatMap((h) => h.lines);
    if (lines.reduce((n, l) => n + l.length, 0) > MAX_SYNTAX_CHARS) return;
    let cancelled = false;
    void loadParserForPath(path).then((parser) => {
      if (cancelled || !parser) return;
      setSegments(computeFileSyntaxSegments(lines, parser));
    });
    return () => {
      cancelled = true;
    };
  }, [syntaxEnabled, path, hunks]);

  const openCommit = (h: BlameHunk) => {
    if (h.sha === UNCOMMITTED) return;
    const summon = useSummonStore.getState();
    summon.summon("commit-details", h.sha);
    summon.swapSummon("changed-files", "working-changes", h.sha);
  };

  // Time-travel: blame the file as it was just before this hunk's commit.
  // `<sha>^` may not contain the file (the commit added it) - git's error is
  // shown as-is, and the previous result stays one "Working tree" click away.
  const reblameParent = (h: BlameHunk) => {
    if (h.sha === UNCOMMITTED) return;
    setRev(`${h.sha}^`);
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
            minWidth: 0,
          }}
          title={rev ? `${path} @ ${rev}` : `${path} (working tree)`}
        >
          {path} @ {rev ? rev.slice(0, 12) : "working tree"}
        </span>
        <RevPicker
          repoId={repo.id}
          value={revDraft}
          onChange={setRevDraft}
          onEnter={() => setRev(revDraft.trim() || null)}
          placeholder="blame at rev (blank = working tree)"
          style={{ marginLeft: "auto", width: "18em", flexShrink: 0 }}
        />
        {rev && (
          <button
            onClick={() => setRev(null)}
            title="Back to blaming the current working-tree file"
            style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}
          >
            Working tree
          </button>
        )}
      </div>

      <div className="legit-panel__body" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 0 }}>
        {isError ? (
          <pre className="legit-error" style={{ margin: 8, fontSize: "var(--fz-md)" }}>
            {formatAppError(error)}
          </pre>
        ) : (
          hunks.map((h, i) => (
            <HunkRow
              key={`${h.sha}-${h.start_line}`}
              hunk={h}
              tinted={i % 2 === 1}
              segments={segments}
              onOpen={() => openCommit(h)}
              onReblameParent={() => reblameParent(h)}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** One line's text as syntax-coloured spans (plain text when no segments).
 *  Segments are row-local, ascending, non-overlapping (highlightTree order);
 *  colours inline the `syntax.*` token vars - the `cm-syn-*` classes are
 *  scoped to CodeMirror's theme and do nothing in this DOM. */
function renderLine(text: string, segs: SyntaxSegment[] | undefined): React.ReactNode {
  if (!segs || segs.length === 0) return text;
  const out: React.ReactNode[] = [];
  let pos = 0;
  segs.forEach((s, i) => {
    if (s.from > pos) out.push(text.slice(pos, s.from));
    out.push(
      <span key={i} style={{ color: syntaxVarFor(s.cls) }}>
        {text.slice(s.from, s.to)}
      </span>
    );
    pos = s.to;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

function HunkRow({
  hunk,
  tinted,
  segments,
  onOpen,
  onReblameParent,
}: {
  hunk: BlameHunk;
  tinted: boolean;
  /** Whole-file per-line syntax segments (absolute 0-based line index). */
  segments: SyntaxSegment[][] | null;
  onOpen: () => void;
  onReblameParent: () => void;
}) {
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
      <div
        style={{
          width: "16em",
          flexShrink: 0,
          display: "flex",
          alignItems: "stretch",
          borderRight: "1px solid var(--panel-border)",
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
            flex: 1,
            minWidth: 0,
            textAlign: "left",
            background: "transparent",
            border: "none",
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
        {!uncommitted && (
          <button
            onClick={onReblameParent}
            title="Blame at this commit's parent: see the file before this change"
            style={{
              flexShrink: 0,
              background: "transparent",
              border: "none",
              borderLeft: "1px solid var(--panel-border)",
              padding: "0 5px",
              cursor: "pointer",
              fontSize: "var(--fz-sm)",
              color: "var(--subtle-fg)",
            }}
          >
            ↶
          </button>
        )}
      </div>
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
        {hunk.lines.map((line, i) => (
          <div key={i}>
            <span className="legit-subtle">{String(hunk.start_line + i).padStart(5)}</span>
            {"  "}
            {renderLine(line, segments?.[hunk.start_line - 1 + i])}
          </div>
        ))}
      </pre>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { PanelError } from "../shared/PanelError";
import { useQuery } from "@tanstack/react-query";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useActiveRepo } from "../../store/repos";
import { useSettingsStore } from "../../store/settings";
import { useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import { repoFileAtRevision, repoFileWorktree } from "../../lib/commands";
import type { FileAtRevision } from "../../lib/types";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { LineEndingBadge } from "../shared/LineEndingBadge";
import { baseTheme, readOnly } from "../Diff/DiffEditor";
import { loadLanguageForPath, syntaxColorTheme } from "../Diff/syntaxLanguages";

/**
 * Summon payload: which file, at which tree-ish. Omit `rev` (or pass null) to
 * view the current working-tree content instead of a committed revision — used
 * by the Files panel, and the only way to view untracked files.
 */
export interface FileViewRequest {
  path: string;
  rev?: string | null;
}

/** "51234" -> "50.0 KiB" (exact bytes for small values). */
function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = "bytes";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit} (${bytes.toLocaleString()} bytes)`;
}

function isFileViewRequest(payload: unknown): payload is FileViewRequest {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as FileViewRequest;
  // `rev` is optional (working-tree mode): accept a string, null, or absent.
  return typeof p.path === "string" && (p.rev == null || typeof p.rev === "string");
}

/**
 * Read-only CodeMirror pane over a whole real file - so, unlike the diff
 * views' reconstructed hunk sides, the language support attaches directly
 * (full-fidelity highlighting). The language chunk loads lazily and is
 * appended to the live config when it arrives.
 */
function FileContentView({
  content,
  path,
  syntaxEnabled,
}: {
  content: string;
  path: string;
  syntaxEnabled: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [baseTheme, ...readOnly, lineNumbers()],
      }),
      parent: host,
    });
    let disposed = false;
    if (syntaxEnabled) {
      void loadLanguageForPath(path).then((support) => {
        if (disposed || !support) return;
        view.dispatch({ effects: StateEffect.appendConfig.of([support, syntaxColorTheme]) });
      });
    }
    return () => {
      disposed = true;
      view.destroy();
    };
  }, [content, path, syntaxEnabled]);

  return <div ref={hostRef} style={{ height: "100%" }} />;
}

/**
 * File View panel — a file's full content as of a specific revision
 * (`git show <rev>:<path>`), read-only with a line-number gutter. Summoned
 * from the Changed Files context menu ("View file at this commit").
 */
export function FileViewPanel() {
  const repo = useActiveRepo();
  const [request, setRequest] = useState<FileViewRequest | null>(null);

  // Reset when the repo changes — the request belongs to the previous repo.
  const prevRepoId = useRef(repo?.id);
  useEffect(() => {
    if (prevRepoId.current === repo?.id) return;
    prevRepoId.current = repo?.id;
    setRequest(null);
  }, [repo?.id]);

  const onReceive = useCallback((payload: unknown) => {
    if (isFileViewRequest(payload)) setRequest(payload);
  }, []);
  useSummonTarget("file-view", onReceive);

  // Working-tree mode when no rev is given: read the file from disk (works for
  // untracked files too). Keyed under "status" so on-disk edits refresh it;
  // the revision mode stays under "log" (content at a rev changes with history).
  const worktree = request != null && request.rev == null;
  const { data, isFetching, isError, error, refetch } = useQuery<FileAtRevision>({
    queryKey: worktree
      ? [repo?.id, "status", "file-worktree", request?.path]
      : [repo?.id, "log", "file-at-rev", request?.rev, request?.path],
    queryFn: () =>
      worktree
        ? repoFileWorktree(repo!.id, request!.path)
        : repoFileAtRevision(repo!.id, request!.rev!, request!.path),
    enabled: !!repo && !!request,
    staleTime: worktree ? 5_000 : 60_000,
  });
  const content = data && "Text" in data ? data.Text : null;
  const syntaxEnabled = useSettingsStore((s) => s.settings?.diff_syntax_highlighting ?? false);
  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  if (!repo || !request) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            Select a file in Files, or view one at a revision from the Changed Files context menu.
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
          title={worktree ? `${request.path} (working tree)` : `${request.path} @ ${request.rev}`}
        >
          {request.path} {worktree ? "(working tree)" : `@ ${request.rev!.slice(0, 8)}`}
        </span>
        <LineEndingBadge repoId={repo.id} path={request.path} rev={worktree ? null : request.rev} />
      </div>

      <div className="legit-panel__body" style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: 0 }}>
        {isError ? (
          <PanelError error={error} margin={8} />
        ) : data && "Binary" in data ? (
          <span className="legit-subtle" style={{ display: "block", padding: 8, fontSize: "var(--fz-md)" }}>
            Binary file, {formatByteSize(data.Binary.size_bytes)}. No text content to show.
          </span>
        ) : (
          content != null && (
            <FileContentView content={content} path={request.path} syntaxEnabled={syntaxEnabled} />
          )
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import { repoFileAtRevision } from "../../lib/commands";
import { formatAppError } from "../../lib/types";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";

/** Summon payload: which file, at which tree-ish. */
export interface FileViewRequest {
  path: string;
  rev: string;
}

function isFileViewRequest(payload: unknown): payload is FileViewRequest {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as FileViewRequest).path === "string" &&
    typeof (payload as FileViewRequest).rev === "string"
  );
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

  const { data: content, isFetching, isError, error, refetch } = useQuery<string>({
    // Under the "log" domain: content at a rev changes exactly when history
    // does (e.g. the rev is rewritten away).
    queryKey: [repo?.id, "log", "file-at-rev", request?.rev, request?.path],
    queryFn: () => repoFileAtRevision(repo!.id, request!.rev, request!.path),
    enabled: !!repo && !!request,
    staleTime: 60_000,
  });
  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  if (!repo || !request) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            View a file at a revision from the Changed Files context menu.
          </span>
        </div>
      </div>
    );
  }

  const lines = content != null ? content.split("\n") : [];
  // A trailing newline produces one phantom empty line at the end — drop it.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const gutterWidth = String(lines.length).length;

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
          title={`${request.path} @ ${request.rev}`}
        >
          {request.path} @ {request.rev.slice(0, 8)}
        </span>
      </div>

      <div className="legit-panel__body" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 0 }}>
        {isError ? (
          <pre className="legit-error" style={{ margin: 8, fontSize: "var(--fz-md)" }}>
            {formatAppError(error)}
          </pre>
        ) : (
          content != null && (
            <pre
              style={{
                margin: 0,
                padding: "4px 8px",
                fontSize: "var(--fz-md)",
                fontFamily: "monospace",
              }}
            >
              {lines
                .map((line, i) => `${String(i + 1).padStart(gutterWidth)}  ${line}`)
                .join("\n")}
            </pre>
          )
        )}
      </div>
    </div>
  );
}

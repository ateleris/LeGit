import { useEffect, useMemo, useRef } from "react";
import { useGitLogStore } from "../../store/gitLog";
import { useActiveRepo } from "../../store/repos";

/**
 * Git Log — a live, passive log of every git command the app runs (args, cwd,
 * duration, exit code, and stderr on failure). Distinct from the interactive
 * Git Console; this is read-only history, and where toasts send you for the
 * full detail of a failed command.
 */
export function GitLogPanel() {
  const allEntries = useGitLogStore((s) => s.entries);
  const clear = useGitLogStore((s) => s.clear);
  const repo = useActiveRepo();
  const endRef = useRef<HTMLDivElement | null>(null);

  // Only the active repo's commands — each invocation's `cwd` is its repo's
  // path, which matches the active repo's `path` for session-run commands.
  const entries = useMemo(
    () => (repo ? allEntries.filter((e) => e.cwd === repo.path) : []),
    [allEntries, repo]
  );

  // Auto-scroll to the newest entry (console convention).
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length]);

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <div
        className="legit-panel__toolbar"
        style={{ display: "flex", alignItems: "center", gap: 8 }}
      >
        <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
          {entries.length} command{entries.length === 1 ? "" : "s"}
        </span>
        <button onClick={clear} disabled={entries.length === 0} style={{ marginLeft: "auto", fontSize: "var(--fz-sm)" }}>
          Clear
        </button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
          fontSize: "var(--fz-md)",
          padding: "4px 8px",
        }}
      >
        {entries.length === 0 ? (
          <span className="legit-subtle">
            {repo ? "No git commands for this repository yet." : "No repository selected."}
          </span>
        ) : (
          entries.map((e) => (
            <div key={e.id} style={{ padding: "1px 0" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span
                  aria-hidden
                  style={{ color: e.success ? "var(--success-fg)" : "var(--error-fg)", flexShrink: 0 }}
                >
                  {e.success ? "✓" : "✗"}
                </span>
                <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  git {e.args.join(" ")}
                </span>
                <span className="legit-subtle" style={{ flexShrink: 0, fontSize: "var(--fz-sm)" }}>
                  {e.duration_ms}ms{e.exit_code != null && e.exit_code !== 0 ? ` · exit ${e.exit_code}` : ""}
                </span>
              </div>
              {!e.success && e.stderr.trim() && (
                <pre
                  style={{
                    margin: "2px 0 4px 20px",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    color: "var(--error-fg)",
                    fontSize: "var(--fz-sm)",
                  }}
                >
                  {e.stderr.trim()}
                </pre>
              )}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

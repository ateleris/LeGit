import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  repoRenormalize,
  repoRenormalizePreview,
  repoWriteGitattributesEol,
} from "../../lib/commands";
import { formatAppError } from "../../lib/types";
import type { LineEndingsView, RenormalizePreview } from "../../lib/types";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { useConfirmDestructive } from "../../store/settings";
import { Button } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";

/**
 * The Normalize block of the Repo Settings "Line endings" section: a
 * simulated-renormalize preview, an optional covers-all `.gitattributes`
 * step, and the `git add --renormalize` action. The result is staged for
 * review, never committed; the working tree is never rewritten.
 */
export function NormalizeLineEndingsBlock({
  repoId,
  view,
  onViewChange,
}: {
  repoId: string;
  view: LineEndingsView;
  onViewChange: (v: LineEndingsView) => void;
}) {
  const [preview, setPreview] = useState<RenormalizePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run: guardedRun } = useDelayedBusy();
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [eolChoice, setEolChoice] = useState<"" | "lf" | "crlf">("");
  const confirmDestructive = useConfirmDestructive();
  const qc = useQueryClient();

  const loadPreview = useCallback(() => {
    repoRenormalizePreview(repoId)
      .then(setPreview)
      .catch((e) => setError(formatAppError(e)));
  }, [repoId]);

  // Follows the section's load/focus cycle: `view` is replaced on every
  // section load, so the preview refetches alongside it.
  useEffect(() => {
    loadPreview();
  }, [loadPreview, view]);

  // Delayed busy indicator + re-entry guard (useDelayedBusy); errors land in
  // the inline error state next to the actions.
  const run = (fn: () => Promise<void>) =>
    guardedRun(async () => {
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(formatAppError(e));
      }
    });

  const writeAttributes = () =>
    run(async () => {
      const updated = await repoWriteGitattributesEol(repoId, eolChoice === "" ? null : eolChoice);
      setOutcome(null);
      onViewChange(updated);
    });

  const executeRenormalize = () =>
    run(async () => {
      setConfirming(false);
      const result = await repoRenormalize(repoId);
      setOutcome(
        result.restaged.length === 0
          ? "Nothing restaged - line endings already matched the policy."
          : `Restaged ${result.restaged.length} file${result.restaged.length === 1 ? "" : "s"} - staged for review, nothing committed.`,
      );
      invalidateRepoDomains(qc, repoId, ["status"]);
      loadPreview();
    });

  const attrLine = eolChoice === "" ? "* text=auto" : `* text=auto eol=${eolChoice}`;
  const count = preview?.files.length ?? 0;

  return (
    <div style={{ marginTop: "1.167em" }}>
      <div style={{ fontWeight: 600, fontSize: "var(--fz-md)" }}>Normalize line endings</div>
      <div className="legit-subtle" style={{ fontSize: "var(--fz-sm)", marginTop: "0.167em" }}>
        Re-runs git's clean filter over all tracked files (git add --renormalize).
        The result is staged for review; the working tree is never rewritten.
      </div>

      {!view.gitattributes_covers_all && (
        <div style={{ marginTop: "0.667em", padding: "0.5em 0.667em", background: "var(--button-hover-bg)", borderRadius: 4, fontSize: "var(--fz-md)" }}>
          <div>
            No covers-all rule in <code>.gitattributes</code> yet - without one,
            normalization has no repo-wide policy to apply. Add:
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.667em", marginTop: "0.5em", flexWrap: "wrap" }}>
            <code style={{ fontFamily: "monospace" }}>{attrLine}</code>
            <label style={{ display: "flex", alignItems: "center", gap: "0.333em" }}>
              eol:
              <select value={eolChoice} onChange={(e) => setEolChoice(e.target.value as "" | "lf" | "crlf")}>
                <option value="">platform default</option>
                <option value="lf">lf</option>
                <option value="crlf">crlf</option>
              </select>
            </label>
            <Button variant="primary" disabled={busy} onClick={writeAttributes}>
              Write .gitattributes
            </Button>
          </div>
          <div className="legit-subtle" style={{ fontSize: "var(--fz-sm)", marginTop: "0.333em" }}>
            Inserted above existing rules so specific patterns keep winning.
            The file is left unstaged for you to commit.
          </div>
        </div>
      )}

      <div style={{ marginTop: "0.667em", fontSize: "var(--fz-md)" }}>
        {preview === null ? (
          <span className="legit-subtle">Checking…</span>
        ) : count === 0 ? (
          <span className="legit-subtle">
            No content changes needed. Running it anyway refreshes git's
            line-ending bookkeeping (clears "modified" entries whose only
            difference is line endings).
          </span>
        ) : (
          <details>
            <summary style={{ cursor: "pointer" }}>
              {count} tracked file{count === 1 ? "" : "s"} would be renormalized
            </summary>
            <ul style={{ margin: "0.333em 0 0", paddingLeft: "1.4em", fontFamily: "monospace", fontSize: "var(--fz-sm)" }}>
              {preview.files.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {confirming ? (
        <div style={{ marginTop: "0.667em", padding: "0.833em 1em", background: "var(--button-hover-bg)", border: "1px solid var(--panel-border)", borderRadius: 4 }}>
          <div style={{ fontWeight: 600, marginBottom: "0.5em" }}>
            {count === 0 ? "Renormalize tracked files?" : `Renormalize ${count} file${count === 1 ? "" : "s"}?`}
          </div>
          <div style={{ fontSize: "var(--fz-md)", marginBottom: "0.667em" }}>
            The result will be staged for review - nothing is committed.
            {preview !== null && preview.unstaged_changes > 0 && (
              <>
                {" "}Restaging will also stage the current unstaged changes of{" "}
                {preview.unstaged_changes} modified file{preview.unstaged_changes === 1 ? "" : "s"}.
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: "0.5em" }}>
            <Button variant="primary" disabled={busy} onClick={executeRenormalize}>Renormalize</Button>
            <button onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: "0.5em", marginTop: "0.667em" }}>
          <Button
            variant="primary"
            disabled={busy || preview === null}
            onClick={() => (confirmDestructive ? setConfirming(true) : executeRenormalize())}
          >
            Renormalize
          </Button>
        </div>
      )}

      {outcome && <div className="legit-success" style={{ marginTop: "0.5em", fontSize: "var(--fz-md)" }}>{outcome}</div>}
      {error && <pre className="legit-error" style={{ marginTop: "0.5em" }}>{error}</pre>}
    </div>
  );
}

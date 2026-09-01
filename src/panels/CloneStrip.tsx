import { useCloneStore } from "../store/clone";
import type { CloneJob } from "../store/clone";
import { useRemoteProgressStore } from "../store/remoteProgress";
import { ToolbarButton } from "./shared/ToolbarButton";

// The strip's ghost buttons sit on banner-op-bg, not a panel surface, so
// their text and border must follow the banner's own foreground token.
const BANNER_BUTTON_STYLE: React.CSSProperties = {
  color: "var(--banner-op-fg)",
  borderColor: "var(--banner-op-fg)",
};

/**
 * App-chrome surface for running clones: rendered by AppLayout above the
 * repo-scoped OpStateStrip, so a clone stays visible and cancellable after
 * its dialog is dismissed — the form owns no part of the operation.
 *
 * Not repo-scoped (a clone has no repo yet), so it shows with no repo open
 * too. Renders nothing while no clone is running.
 */
export function CloneStrip() {
  const jobs = useCloneStore((s) => s.jobs);
  const ids = Object.keys(jobs);
  if (ids.length === 0) return null;
  return (
    <div data-testid="clone-strip">
      {ids
        .map((id) => jobs[id])
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((job) => (
          <CloneRow key={job.opId} job={job} />
        ))}
    </div>
  );
}

function CloneRow({ job }: { job: CloneJob }) {
  const cancel = useCloneStore((s) => s.cancel);
  // Live transfer progress (legit://remote-progress, keyed by our opId). It
  // only exists once git has printed its first meter line.
  const progress = useRemoteProgressStore((s) => s.byOp[job.opId]);

  const status = job.cancelling
    ? "cancelling…"
    : progress
      ? `${progress.phase}${progress.percent != null ? ` ${progress.percent}%` : "…"}`
      : "starting…";

  return (
    <div
      data-testid="clone-strip-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        background: "var(--banner-op-bg)",
        color: "var(--banner-op-fg)",
        fontSize: "var(--fz-sm)",
        // Hairline: separates this row from a row or banner stacked below it.
        borderBottom: "1px solid var(--panel-border)",
      }}
    >
      <span className="legit-spinner" aria-hidden="true" />
      <span
        title={`${job.url} → ${job.parentDir}`}
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        Cloning {job.name} · {status}
      </span>
      <span style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
        <ToolbarButton
          label="Cancel"
          title="Stop the clone and remove its partial files"
          disabled={job.cancelling}
          onClick={() => cancel(job.opId)}
          style={BANNER_BUTTON_STYLE}
        />
      </span>
    </div>
  );
}

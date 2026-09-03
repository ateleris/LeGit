import { cloneTargetPath, useCloneStore } from "../store/clone";
import type { CloneJob } from "../store/clone";
import { useRemoteProgressStore } from "../store/remoteProgress";
import { useConfirmDestructive } from "../store/settings";
import { Button } from "./shared/buttons";
import { cancelCloneWithConfirm } from "./cloneCancel";

/**
 * What the repo region shows while a "Cloning" tab is selected: the clone's
 * source, destination, phase and a progress bar, plus Cancel. Rendered by
 * AppLayout as an overlay covering the repo dock (the dock stays mounted so
 * the active repo's panel layout is untouched); nothing while no clone tab
 * is selected.
 */
export function CloneProgressView() {
  const job = useCloneStore((s) => (s.focusedOpId ? s.jobs[s.focusedOpId] : undefined));
  if (!job) return null;
  return <CloneProgressCard job={job} />;
}

function CloneProgressCard({ job }: { job: CloneJob }) {
  const confirm = useConfirmDestructive();
  const progress = useRemoteProgressStore((s) => s.byOp[job.opId]);
  const percent = progress?.percent ?? null;
  const status = job.cancelling
    ? "Cancelling…"
    : progress
      ? `${progress.phase}${percent != null ? ` ${percent}%` : "…"}`
      : "Starting…";

  return (
    <div
      data-testid="clone-progress-view"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 11,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--app-bg)",
        color: "var(--app-fg)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.75em",
          width: "min(36em, 90%)",
          padding: "1.25em 1.5em",
          background: "var(--panel-bg)",
          color: "var(--panel-fg)",
          border: "1px solid var(--panel-border)",
          borderRadius: 4,
          boxShadow: "0 4px 12px var(--shadow-color)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.6em", fontSize: "var(--fz-lg)" }}>
          <span className="legit-spinner" aria-hidden="true" />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Cloning {job.name}
          </span>
        </div>
        <Detail label="From" value={job.url} />
        <Detail label="Into" value={cloneTargetPath(job)} />
        <div>
          <div className="legit-subtle" style={{ fontSize: "var(--fz-sm)", marginBottom: "0.35em" }}>
            {status}
          </div>
          <ProgressBar percent={job.cancelling ? null : percent} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button
            variant="danger"
            disabled={job.cancelling}
            onClick={() => void cancelCloneWithConfirm(job, confirm)}
            title="Cancel the clone and remove its partial files"
          >
            Cancel clone
          </Button>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: "0.6em", minWidth: 0, fontSize: "var(--fz-md)" }}>
      <span className="legit-subtle" style={{ flex: "0 0 3em" }}>{label}</span>
      <span
        title={value}
        style={{ fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {value}
      </span>
    </div>
  );
}

/** Determinate when git reports a percentage, else the shared indeterminate
 *  slide (`.legit-progress`). Track and fill are theme tokens. */
function ProgressBar({ percent }: { percent: number | null }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      style={{
        position: "relative",
        height: "0.4em",
        borderRadius: 2,
        overflow: "hidden",
        background: "var(--panel-border)",
      }}
    >
      {percent != null ? (
        <div
          style={{
            height: "100%",
            width: `${Math.max(0, Math.min(100, percent))}%`,
            background: "var(--progress-bar-bg)",
            transition: "width 200ms linear",
          }}
        />
      ) : (
        <div className="legit-progress" style={{ height: "100%" }} aria-hidden="true" />
      )}
    </div>
  );
}

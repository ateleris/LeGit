import { useCloneStore } from "../store/clone";
import type { CloneJob } from "../store/clone";
import { useRemoteProgressStore } from "../store/remoteProgress";
import { useConfirmDestructive } from "../store/settings";
import { cancelCloneWithConfirm } from "./cloneCancel";

/**
 * One "Cloning" tab per running clone, rendered by `RepoTabBar` after the
 * repo tabs. A clone has no repo yet, so its tab is not a repo tab: it
 * cannot be dragged, and its close button CANCELS the clone (after
 * confirmation) instead of closing anything. Selecting it shows the clone's
 * progress view in the repo region (`CloneProgressView`).
 */
export function CloneTabs() {
  const jobs = useCloneStore((s) => s.jobs);
  const ids = Object.keys(jobs);
  if (ids.length === 0) return null;
  return (
    <>
      {ids
        .map((id) => jobs[id])
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((job) => <CloneTab key={job.opId} job={job} />)}
    </>
  );
}

function CloneTab({ job }: { job: CloneJob }) {
  const focused = useCloneStore((s) => s.focusedOpId === job.opId);
  const focus = useCloneStore((s) => s.focus);
  const confirm = useConfirmDestructive();
  // Live transfer progress (legit://remote-progress, keyed by the op id). It
  // only exists once git has printed its first meter line.
  const percent = useRemoteProgressStore((s) => s.byOp[job.opId]?.percent ?? null);

  const cancel = () => void cancelCloneWithConfirm(job, confirm);
  const status = job.cancelling ? "cancelling…" : percent != null ? `${percent}%` : null;

  return (
    <div
      role="tab"
      data-testid="clone-tab"
      aria-selected={focused}
      className={`legit-tab legit-tab--cloning${focused ? " is-active" : ""}`}
      onClick={() => focus(job.opId)}
      onAuxClick={(e) => {
        // Middle-click closes a repo tab; here "close" means cancel.
        if (e.button === 1) {
          e.preventDefault();
          cancel();
        }
      }}
      title={`Cloning ${job.name} from ${job.url}`}
    >
      <span className="legit-spinner" aria-hidden="true" />
      <span className="legit-tab__name">Cloning</span>
      {status && (
        <span
          className="legit-tab__status"
          style={{ flex: "none", fontSize: "var(--fz-sm)", opacity: 0.8 }}
        >
          {status}
        </span>
      )}
      <button
        className="legit-tab__close"
        disabled={job.cancelling}
        onClick={(e) => {
          e.stopPropagation();
          cancel();
        }}
        aria-label={`Cancel cloning ${job.name}`}
        title="Cancel the clone and remove its partial files"
      >
        <svg className="dv-svg" width="11" height="11" viewBox="0 0 28 28" aria-hidden="true">
          <path d="M2.1 27.3L0 25.2L11.55 13.65L0 2.1L2.1 0L13.65 11.55L25.2 0L27.3 2.1L15.75 13.65L27.3 25.2L25.2 27.3L13.65 15.75L2.1 27.3Z" />
        </svg>
      </button>
    </div>
  );
}

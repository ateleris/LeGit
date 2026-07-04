import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfirmDestructive } from "../../store/settings";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { OP_DOMAINS } from "../../lib/useOpState";
import {
  repoMergeAbort,
  repoMergeContinue,
  repoRebaseAbort,
  repoRebaseContinue,
  repoRebaseSkip,
} from "../../lib/commands";
import type { RepoOpState } from "../../lib/types";
import {
  notifyMergeOutcome,
  notifyOpError,
  notifyRebaseOutcome,
} from "../../lib/mergeFeedback";
import { ToolbarButton } from "../shared/ToolbarButton";

/**
 * "Merge/rebase in progress" banner at the top of Working Changes: what is
 * running, how many conflicts remain, Continue / Skip / Abort. Renders only
 * for merge/rebase (cherry-pick/revert are detected but get no UI yet).
 * Abort is destructive (discards resolutions): inline confirm, gated by the
 * global destructive-confirmation setting.
 */
export function OpStateBanner({
  repoId,
  opState,
  conflictCount,
}: {
  repoId: string;
  opState: RepoOpState;
  conflictCount: number;
}) {
  const queryClient = useQueryClient();
  const confirmDestructive = useConfirmDestructive();
  const [confirmingAbort, setConfirmingAbort] = useState(false);
  const [busy, setBusy] = useState(false);
  const runningRef = useRef(false);

  if (opState.kind !== "merge" && opState.kind !== "rebase") return null;
  const isMerge = opState.kind === "merge";

  const run = async (fn: () => Promise<void>) => {
    if (runningRef.current) return;
    runningRef.current = true;
    // Delayed busy state (150ms) so fast operations never flicker the UI.
    const busyTimer = window.setTimeout(() => setBusy(true), 150);
    try {
      await fn();
    } catch (e) {
      notifyOpError(e);
    } finally {
      window.clearTimeout(busyTimer);
      runningRef.current = false;
      setBusy(false);
      setConfirmingAbort(false);
      invalidateRepoDomains(queryClient, repoId, OP_DOMAINS);
    }
  };

  const target = isMerge ? (opState.branch ?? "branch") : (opState.onto ?? "target");

  const onContinue = () =>
    run(async () => {
      if (isMerge) notifyMergeOutcome(await repoMergeContinue(repoId), target);
      else notifyRebaseOutcome(await repoRebaseContinue(repoId), target);
    });
  const onSkip = () =>
    run(async () => {
      notifyRebaseOutcome(await repoRebaseSkip(repoId), target);
    });
  const doAbort = () =>
    run(async () => {
      if (isMerge) await repoMergeAbort(repoId);
      else await repoRebaseAbort(repoId);
    });
  const onAbort = () => {
    if (!confirmDestructive) return void doAbort();
    setConfirmingAbort(true);
  };

  const title = isMerge
    ? `Merging '${opState.branch ?? "…"}'`
    : `Rebasing${opState.head_name ? ` '${opState.head_name}'` : ""} onto ${opState.onto ?? "…"}` +
      (opState.current_step != null && opState.total_steps != null
        ? ` (step ${opState.current_step}/${opState.total_steps})`
        : "");
  const conflictsText =
    conflictCount > 0
      ? `${conflictCount} conflict${conflictCount === 1 ? "" : "s"} remaining`
      : "all conflicts resolved";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        background: "var(--op-banner-bg)",
        color: "var(--op-banner-fg)",
        fontSize: "var(--fz-sm)",
      }}
    >
      {confirmingAbort ? (
        <>
          <span style={{ minWidth: 0 }}>
            Abort {isMerge ? "merge" : "rebase"}? Conflict resolutions will be discarded.
          </span>
          <span style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
            <ToolbarButton
              label={isMerge ? "Abort merge" : "Abort rebase"}
              disabled={busy}
              onClick={doAbort}
            />
            <ToolbarButton label="Cancel" disabled={busy} onClick={() => setConfirmingAbort(false)} />
          </span>
        </>
      ) : (
        <>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {title} · {conflictsText}
          </span>
          <span style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
            <ToolbarButton
              label="Continue"
              title={
                conflictCount > 0
                  ? "Resolve all conflicts first"
                  : isMerge
                    ? "Commit the merge"
                    : "Continue the rebase"
              }
              disabled={busy || conflictCount > 0}
              onClick={onContinue}
            />
            {!isMerge && (
              <ToolbarButton
                label="Skip"
                title="Skip the current commit"
                disabled={busy}
                onClick={onSkip}
              />
            )}
            <ToolbarButton
              label={confirmDestructive ? "Abort…" : "Abort"}
              title={isMerge ? "Abort the merge" : "Abort the rebase"}
              disabled={busy}
              onClick={onAbort}
            />
          </span>
        </>
      )}
    </div>
  );
}

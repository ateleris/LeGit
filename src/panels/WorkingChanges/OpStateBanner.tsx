import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfirmDestructive } from "../../store/settings";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { OP_DOMAINS } from "../../lib/useOpState";
import {
  repoCherryPickAbort,
  repoCherryPickContinue,
  repoCherryPickSkip,
  repoMergeAbort,
  repoMergeContinue,
  repoRebaseAbort,
  repoRebaseContinue,
  repoRebaseSkip,
  repoRevertAbort,
  repoRevertContinue,
  repoRevertSkip,
} from "../../lib/commands";
import type { RepoOpState } from "../../lib/types";
import {
  notifyMergeOutcome,
  notifyOpError,
  notifyRebaseOutcome,
  notifySequenceOutcome,
} from "../../lib/mergeFeedback";
import { ToolbarButton } from "../shared/ToolbarButton";

/** What the banner shows and can do per in-progress operation kind. */
const OP_META = {
  merge: { noun: "merge", canSkip: false },
  rebase: { noun: "rebase", canSkip: true },
  cherry_pick: { noun: "cherry-pick", canSkip: true },
  revert: { noun: "revert", canSkip: true },
} as const;

/**
 * "Operation in progress" banner at the top of Working Changes: what is
 * running (merge / rebase / cherry-pick / revert), how many conflicts remain,
 * Continue / Skip / Abort. Abort is destructive (discards resolutions):
 * inline confirm, gated by the global destructive-confirmation setting.
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

  if (opState.kind === "none") return null;
  const kind = opState.kind;
  const meta = OP_META[kind];

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

  const target =
    opState.kind === "merge"
      ? (opState.branch ?? "branch")
      : opState.kind === "rebase"
        ? (opState.onto ?? "target")
        : opState.sha.slice(0, 8);

  const onContinue = () =>
    run(async () => {
      switch (opState.kind) {
        case "merge":
          notifyMergeOutcome(await repoMergeContinue(repoId), target);
          break;
        case "rebase":
          notifyRebaseOutcome(await repoRebaseContinue(repoId), target);
          break;
        case "cherry_pick":
          notifySequenceOutcome(await repoCherryPickContinue(repoId), "cherry-pick", target);
          break;
        case "revert":
          notifySequenceOutcome(await repoRevertContinue(repoId), "revert", target);
          break;
      }
    });

  const onSkip = () =>
    run(async () => {
      switch (opState.kind) {
        case "rebase":
          notifyRebaseOutcome(await repoRebaseSkip(repoId), target);
          break;
        case "cherry_pick":
          notifySequenceOutcome(await repoCherryPickSkip(repoId), "cherry-pick", target);
          break;
        case "revert":
          notifySequenceOutcome(await repoRevertSkip(repoId), "revert", target);
          break;
      }
    });

  const doAbort = () =>
    run(async () => {
      switch (opState.kind) {
        case "merge":
          await repoMergeAbort(repoId);
          break;
        case "rebase":
          await repoRebaseAbort(repoId);
          break;
        case "cherry_pick":
          await repoCherryPickAbort(repoId);
          break;
        case "revert":
          await repoRevertAbort(repoId);
          break;
      }
    });
  const onAbort = () => {
    if (!confirmDestructive) return void doAbort();
    setConfirmingAbort(true);
  };

  const title =
    opState.kind === "merge"
      ? `Merging '${opState.branch ?? "…"}'`
      : opState.kind === "rebase"
        ? `Rebasing${opState.head_name ? ` '${opState.head_name}'` : ""} onto ${opState.onto ?? "…"}` +
          (opState.current_step != null && opState.total_steps != null
            ? ` (step ${opState.current_step}/${opState.total_steps})`
            : "")
        : opState.kind === "cherry_pick"
          ? `Cherry-picking ${target}`
          : `Reverting ${target}`;
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
            Abort {meta.noun}? Conflict resolutions will be discarded.
          </span>
          <span style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
            <ToolbarButton label={`Abort ${meta.noun}`} disabled={busy} onClick={doAbort} />
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
                  : `Conclude the ${meta.noun}`
              }
              disabled={busy || conflictCount > 0}
              onClick={onContinue}
            />
            {meta.canSkip && (
              <ToolbarButton
                label="Skip"
                title="Skip the current commit"
                disabled={busy}
                onClick={onSkip}
              />
            )}
            <ToolbarButton
              label={confirmDestructive ? "Abort…" : "Abort"}
              title={`Abort the ${meta.noun}`}
              disabled={busy}
              onClick={onAbort}
            />
          </span>
        </>
      )}
    </div>
  );
}

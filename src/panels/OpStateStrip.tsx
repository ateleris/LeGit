import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConfirmDestructive } from "../store/settings";
import { useRepoStore } from "../store/repos";
import { invalidateRepoDomains } from "../lib/repoInvalidation";
import { OP_DOMAINS, useOpState } from "../lib/useOpState";
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
  repoStatus,
} from "../lib/commands";
import type { FileStatus, RepoOpState } from "../lib/types";
import {
  notifyMergeOutcome,
  notifyOpError,
  notifyRebaseOutcome,
  notifySequenceOutcome,
} from "../lib/mergeFeedback";
import { ToolbarButton } from "./shared/ToolbarButton";
import { usePanelRunner } from "./shared/usePanelRunner";

/** What the strip shows and can do per in-progress operation kind. */
const OP_META = {
  merge: { noun: "merge", canSkip: false },
  rebase: { noun: "rebase", canSkip: true },
  cherry_pick: { noun: "cherry-pick", canSkip: true },
  revert: { noun: "revert", canSkip: true },
} as const;

/**
 * App-chrome surface for the active repo's in-progress operation: rendered by
 * AppLayout directly below the repo tab bar, so a merge / rebase / cherry-pick
 * / revert is always visible and abortable no matter which panels are open.
 * Renders nothing while no operation is in progress.
 */
export function OpStateStrip() {
  const activeRepoId = useRepoStore((s) => s.activeRepoId);
  const opState = useOpState(activeRepoId ?? undefined);
  const opActive = !!opState && opState.kind !== "none";

  // Same key + fetcher as Working Changes, so the cache is shared; this own
  // subscription keeps the conflict count watcher-fresh when that panel is
  // closed. Only fetched while an operation is actually in progress.
  const { data: status = [] } = useQuery<FileStatus[]>({
    queryKey: [activeRepoId, "status"],
    queryFn: () => repoStatus(activeRepoId!),
    enabled: !!activeRepoId && opActive,
    staleTime: 5_000,
  });
  const conflictCount = useMemo(
    () => status.filter((s) => s.state === "Conflicted").length,
    [status],
  );

  if (!activeRepoId || !opState || opState.kind === "none") return null;
  return <OpStateBanner repoId={activeRepoId} opState={opState} conflictCount={conflictCount} />;
}

/**
 * "Operation in progress" banner: what is running (merge / rebase /
 * cherry-pick / revert), how many conflicts remain, Continue / Skip / Abort.
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
  // Success means the op state is about to change (usually to "none",
  // unmounting the banner): HOLD the rendering disabled until the refreshed
  // state arrives - flipping back to live Continue/Abort buttons during the
  // refetch gap reads as "the abort didn't work". The opState effect below
  // releases if the banner stays mounted.
  const { busy, run, release } = usePanelRunner({
    holdBusyOnSuccess: true,
    onSettled: () => invalidateRepoDomains(queryClient, repoId, OP_DOMAINS),
    onError: (e) => {
      notifyOpError(e);
      setConfirmingAbort(false);
    },
  });

  if (opState.kind === "none") return null;
  const kind = opState.kind;
  const meta = OP_META[kind];

  // A genuinely new op state re-enables the banner (e.g. rebase continue
  // advancing to the next conflicted step). React-query structurally shares
  // unchanged data, so this fires only when the state actually changed.
  useEffect(() => {
    release();
    setConfirmingAbort(false);
  }, [opState, release]);

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
      data-testid="op-state-banner"
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

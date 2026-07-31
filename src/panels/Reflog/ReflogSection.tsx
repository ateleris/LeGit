import { useCallback, useState } from "react";
import { PanelError } from "../shared/PanelError";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { autoUpdateSubmodules } from "../../lib/submodules";
import { repoCheckoutCommit, repoReflog, repoReset } from "../../lib/commands";
import { notify } from "../../store/notifications";
import { useConfirmDestructive } from "../../store/settings";
import { notifySwitchOutcome, formatSwitchError } from "../../lib/switchFeedback";
import type { ReflogEntry } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { formatRelative } from "../../lib/time";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { usePanelRunner } from "../shared/usePanelRunner";
import { Button } from "../shared/buttons";
import { ToolbarButton } from "../shared/ToolbarButton";

const MAX_ENTRIES = 200;

// Restoring / checking out from the reflog moves HEAD like any other op.
const AFFECTED_DOMAINS = ["status", "log", "branches", "diff", "op_state", "tracking", "stashes"];

/**
 * Reflog section — HEAD's reflog as the undo safety net: every HEAD movement
 * (commits, resets, rebases, checkouts) with two ways back: check out an
 * entry (detached, non-destructive) or hard-reset the current branch to it
 * (destructive — inline confirm, gated by the global setting). Rendered as a
 * pane inside the combined Refs panel, which supplies the header — body-only.
 */
export function ReflogSection() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();

  // Keyed under the "log" domain: every mutation that moves HEAD already
  // invalidates "log", which is exactly when the reflog changes too.
  const { data: entries = [], isFetching, refetch } = useQuery<ReflogEntry[]>({
    queryKey: [repo?.id, "log", "reflog"],
    queryFn: () => repoReflog(repo!.id, MAX_ENTRIES),
    enabled: !!repo,
    staleTime: 5_000,
  });

  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);

  const [error, setError] = useState<string | null>(null);
  // Two runners, one per error classification (checkout failures go through
  // the switch classifier). Delayed busy + double-click guard per convention.
  const { busy: switchBusy, run: runSwitch } = usePanelRunner({
    enabled: !!repo,
    onStart: () => setError(null),
    onError: (e) => setError(formatSwitchError(e)),
  });
  const { busy: resetBusy, run: runReset } = usePanelRunner({
    enabled: !!repo,
    onStart: () => setError(null),
    onError: (e) => setError(formatAppError(e)),
  });
  const busy = switchBusy || resetBusy;
  const confirmDestructive = useConfirmDestructive();
  // Keyed by selector: unlike stashes, a reflog entry's sha can appear many
  // times (checkout back and forth), so the selector is the unique row key.
  const [confirmReset, setConfirmReset] = useState<string | null>(null);

  const invalidate = useCallback(() => {
    if (!repo) return;
    invalidateRepoDomains(queryClient, repo.id, AFFECTED_DOMAINS);
  }, [queryClient, repo]);

  const doCheckout = (e: ReflogEntry) =>
    runSwitch(async () => {
      const outcome = await repoCheckoutCommit(repo!.id, e.sha);
      invalidate();
      notifySwitchOutcome(outcome, e.sha.slice(0, 8));
      void autoUpdateSubmodules(queryClient, repo!.id);
    });

  const doReset = (e: ReflogEntry) =>
    runReset(async () => {
      await repoReset(repo!.id, e.sha, "hard");
      invalidate();
      setConfirmReset(null);
      notify.info(`Hard-reset to ${e.sha.slice(0, 8)} (${e.selector}).`);
    });

  const requestReset = (e: ReflogEntry) => {
    setError(null);
    if (confirmDestructive) setConfirmReset(e.selector);
    else void doReset(e);
  };

  if (!repo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">No repository open.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div
        className="legit-panel__body"
        style={{ display: "flex", flexDirection: "column", gap: 4 }}
      >
        {error && (
          <PanelError error={error} margin={0} />
        )}

        {entries.length === 0 ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No reflog entries.
          </span>
        ) : (
          entries.map((e) => (
            <ReflogRow
              key={e.selector}
              entry={e}
              busy={busy}
              confirmingReset={confirmReset === e.selector}
              onCheckout={() => doCheckout(e)}
              onRequestReset={() => requestReset(e)}
              onConfirmReset={() => doReset(e)}
              onCancelReset={() => setConfirmReset(null)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ReflogRow({
  entry,
  busy,
  confirmingReset,
  onCheckout,
  onRequestReset,
  onConfirmReset,
  onCancelReset,
}: {
  entry: ReflogEntry;
  busy: boolean;
  confirmingReset: boolean;
  onCheckout: () => void;
  onRequestReset: () => void;
  onConfirmReset: () => void;
  onCancelReset: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        padding: "4px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
        <span
          className="legit-subtle"
          style={{ fontSize: "var(--fz-sm)", fontFamily: "monospace", flexShrink: 0 }}
          title={entry.selector}
        >
          {entry.sha.slice(0, 8)}
        </span>
        {entry.action && (
          <span style={{ fontSize: "var(--fz-sm)", color: "var(--accent)", flexShrink: 0 }}>
            {entry.action}
          </span>
        )}
        <span
          style={{
            fontSize: "var(--fz-md)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={entry.subject}
        >
          {entry.subject}
        </span>
        <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
          {formatRelative(entry.timestamp)}
        </span>
      </div>

      {confirmingReset ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: "var(--fz-md)", flex: 1 }}>
            Hard-reset to {entry.sha.slice(0, 8)}? Uncommitted changes will be discarded.
          </span>
          <Button variant="danger" disabled={busy} onClick={onConfirmReset}>
            Reset
          </Button>
          <button disabled={busy} onClick={onCancelReset}>
            Cancel
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <ToolbarButton
            label="Checkout"
            title="Check out this commit (detached HEAD)"
            disabled={busy}
            onClick={onCheckout}
          />
          <ToolbarButton
            label="Reset here"
            title="Hard-reset the current branch to this entry"
            disabled={busy}
            onClick={onRequestReset}
          />
        </div>
      )}
    </div>
  );
}

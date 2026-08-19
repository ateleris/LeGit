import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useSummonTarget } from "../../store/summon";
import { confirmDialog } from "../../store/confirm";
import { usePanelApi, usePanelFocusEffect } from "../PanelApiContext";
import { repoLog, repoRebaseInteractive, repoRebaseRangeInfo } from "../../lib/commands";
import type { Commit, RebaseAction, RebaseRangeInfo, RebaseStep } from "../../lib/types";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { OP_DOMAINS, useOpState } from "../../lib/useOpState";
import { notifyOpError, notifyRebaseOutcome } from "../../lib/mergeFeedback";
import { Button, IconButton } from "../shared/buttons";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { usePanelRunner } from "../shared/usePanelRunner";
import { useRepoSwitchClear } from "../shared/useRepoSwitchClear";
import { useRowDragReorder } from "../shared/useRowDragReorder";
import {
  closesAfterOutcome,
  isUnchanged,
  nextRebaseWatch,
  planError,
  pushedShas,
  toTodoOrder,
  type PlanRow,
} from "./planModel";

const ACTIONS: RebaseAction[] = ["pick", "reword", "squash", "fixup", "drop"];

/** Listing cap for the plan query. A plan that does not cover ALL of
 *  base..HEAD would make git silently drop the unlisted commits (the injected
 *  todo replaces git's own), so a range larger than this is refused rather
 *  than truncated - and the backend independently verifies plan == range. */
const PLAN_LIMIT = 200;

/**
 * Interactive Rebase panel — summoned from a commit row with the base sha:
 * lists `base..HEAD` NEWEST FIRST (matching the commit graph; git's
 * oldest-first todo order is internal) with per-row
 * pick/reword/squash/fixup/drop, drag or arrow reordering, and an inline
 * message editor for rewords. Pushed commits carry a chip and Start
 * confirms before rewriting them; a base outside HEAD's ancestry shows the
 * transplant notice. Conflicts pause the normal rebase machinery, so the
 * Working Changes banner's Continue/Skip/Abort takes over from there.
 *
 * The panel is TRANSIENT (summon-only, no View-menu entry): it closes itself
 * once it has no further role. A clean Start closes it immediately; a
 * conflicted Start keeps it open as a pointer to Working Changes until the
 * rebase ends (finished via Continue or aborted) - see `closesAfterOutcome` /
 * `nextRebaseWatch`. A failed Start keeps the plan for a retry.
 */
export function InteractiveRebasePanel() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();
  const panelApi = usePanelApi();

  const [base, setBase] = useState<string | null>(null);
  const [rows, setRows] = useState<PlanRow[]>([]);
  // Conflicted Start: the plan is gone (git owns the todo) and the panel only
  // waits for the rebase to end. `armed` per nextRebaseWatch's stale guard.
  const [inProgress, setInProgress] = useState(false);
  const armedRef = useRef(false);
  // Live vertical drag-to-reorder (same pattern as RepoTabBar): the grabbed
  // row follows the pointer and the row ORDER updates live, so it visibly
  // lands where it is dragged. All state is local; nothing commits on drop.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { busy, run } = usePanelRunner({
    enabled: !!repo,
    onError: notifyOpError,
    // Even a failed start can leave op state behind; refresh either way.
    onSettled: () => {
      // "stashes" too: the rebase always runs --autostash, which creates and
      // reapplies (or, on conflict, keeps) a stash entry.
      if (repo) invalidateRepoDomains(queryClient, repo.id, [...OP_DOMAINS, "tracking", "stashes"]);
    },
  });

  const clearPlan = useCallback(() => {
    setBase(null);
    setRows([]);
  }, []);

  const closePanel = useCallback(() => {
    if (panelApi) panelApi.close();
    else clearPlan(); // outside dockview (should not happen) - degrade to reset
  }, [panelApi, clearPlan]);

  // Close when the active repo changes (a transient panel for the old repo's
  // rebase has no meaning in the new one) - except when the base was summoned
  // FOR the repo being switched to, and not on first mount. Full rationale in
  // useRepoSwitchClear.
  const markDelivered = useRepoSwitchClear(repo?.id, closePanel);

  const onReceive = useCallback((payload: unknown) => {
    if (typeof payload === "string") {
      setBase(payload);
      setRows([]);
      // A fresh summon always (re)enters plan editing, even if the panel was
      // idling in its waiting-for-the-rebase-to-end state.
      setInProgress(false);
      armedRef.current = false;
      markDelivered();
    }
  }, [markDelivered]);
  useSummonTarget("interactive-rebase", onReceive);

  // base..HEAD, newest first (git log's own order = the graph's order).
  // Fetched one past PLAN_LIMIT so truncation is detectable, not silent.
  const { data: commits = [], isFetching, refetch } = useQuery<Commit[]>({
    queryKey: [repo?.id, "log", "interactive-rebase", base],
    queryFn: () => repoLog(repo!.id, PLAN_LIMIT + 1, undefined, `${base}..HEAD`),
    enabled: !!repo && !!base,
    staleTime: 5_000,
  });
  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  // Pushed set + ancestry, one probe. Passive: failure or a missing
  // upstream just means no chips, no dialog, no notice.
  const { data: rangeInfo } = useQuery<RebaseRangeInfo>({
    queryKey: [repo?.id, "log", "rebase-range-info", base],
    queryFn: () => repoRebaseRangeInfo(repo!.id, base!),
    enabled: !!repo && !!base,
    staleTime: 5_000,
  });
  const pushed = useMemo(
    () => pushedShas(rows.map((r) => r.sha), rangeInfo?.unpushed),
    [rows, rangeInfo],
  );

  // Ranges the plan cannot represent are refused outright: a truncated plan
  // (or one containing merges, which `pick` cannot replay) would make git
  // silently drop or wedge on the affected commits.
  const rangeError =
    commits.length > PLAN_LIMIT
      ? `More than ${PLAN_LIMIT} commits after this base - pick a closer base.`
      : commits.some((c) => c.parents.length > 1)
        ? "The commits after this base include a merge commit - interactive rebase across merges is not supported."
        : null;

  // (Re)build the editable plan whenever the underlying range changes.
  // Deliberately NOT on every refetch result identity — only when the actual
  // commit ids change, so an in-progress plan edit survives focus refreshes.
  const commitIds = useMemo(() => commits.map((c) => c.id).join(","), [commits]);
  useEffect(() => {
    setRows(
      rangeError
        ? []
        : commits.map((c) => ({
            sha: c.id,
            shortSha: c.id.slice(0, 8),
            subject: c.message.split("\n")[0],
            action: "pick" as RebaseAction,
            originalMessage: c.message,
            message: "",
          })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitIds]);

  const opState = useOpState(repo?.id);
  const opInProgress = !!opState && opState.kind !== "none";

  // Conflict handoff: the panel waits out the rebase and closes when it ends
  // (finished via Continue or aborted via Abort - both land on kind "none").
  useEffect(() => {
    if (!inProgress) return;
    const next = nextRebaseWatch(armedRef.current, opState?.kind ?? null);
    armedRef.current = next.armed;
    if (next.close) closePanel();
  }, [inProgress, opState, closePanel]);

  const move = (index: number, delta: -1 | 1) => {
    setRows((rs) => {
      const next = [...rs];
      const target = index + delta;
      if (target < 0 || target >= next.length) return rs;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const { draggingKey: draggingSha, dragY, registerItem, beginDrag } = useRowDragReorder({
    container: bodyRef,
    order: rows.map((r) => r.sha),
    onReorder: (next) =>
      setRows((rs) => next.flatMap((sha) => rs.find((r) => r.sha === sha) ?? [])),
    disabled: busy,
  });

  const setAction = (index: number, action: RebaseAction) => {
    setRows((rs) =>
      rs.map((r, i) =>
        i === index
          ? {
              ...r,
              action,
              // Prefill the reword draft with the full original message the
              // first time; leaving reword discards the draft.
              message:
                action === "reword"
                  ? r.action === "reword"
                    ? r.message
                    : r.originalMessage
                  : "",
            }
          : r,
      ),
    );
  };

  // The base commit itself, shown as a non-interactive anchor row below the
  // plan: it is what the commits are applied ONTO (and it visualises the
  // newest-first direction). `log <base> -1` is exactly that commit.
  const { data: baseCommit } = useQuery<Commit | null>({
    queryKey: [repo?.id, "log", "rebase-base-commit", base],
    queryFn: async () => (await repoLog(repo!.id, 1, undefined, base!))[0] ?? null,
    enabled: !!repo && !!base,
    staleTime: 60_000,
  });

  const error = planError(toTodoOrder(rows));
  const unchanged = useMemo(
    () => isUnchanged(rows, commits.map((c) => c.id)),
    [rows, commits],
  );

  const start = async () => {
    if (!base) return;
    // Rewriting commits the upstream already has needs a deliberate choice:
    // the branch will diverge and need a force-push. Deliberately NOT gated
    // by the destructive-confirmation setting (history-warning house rule,
    // same as amend-pushed).
    if (pushed.size > 0) {
      const ok = await confirmDialog({
        title: "Rewrite pushed commits?",
        message: `${pushed.size} of the ${rows.length} commits in this plan ${
          pushed.size === 1 ? "is" : "are"
        } already on the upstream. Running the plan rewrites them - the branch will need a force-push afterwards.`,
        detail: base.slice(0, 8),
        confirmLabel: "Rewrite history",
      });
      if (!ok) return;
    }
    await run(async () => {
      const plan: RebaseStep[] = toTodoOrder(rows).map((r) => ({
        action: r.action,
        sha: r.sha,
        message: r.action === "reword" ? r.message : null,
      }));
      const outcome = await repoRebaseInteractive(repo!.id, base, plan);
      notifyRebaseOutcome(outcome, base.slice(0, 8));
      if (closesAfterOutcome(outcome.kind)) {
        // Rebase over (completed / up to date / done with a stash-reapply
        // conflict, which Working Changes surfaces) - the panel's job ends.
        closePanel();
      } else {
        // Conflict: git owns the todo now; wait for the rebase to end.
        clearPlan();
        armedRef.current = false;
        setInProgress(true);
      }
    });
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

  if (inProgress) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            Rebase in progress - resolve the conflicts in Working Changes;
            Continue, Skip and Abort live there. This panel closes when the
            rebase ends.
          </span>
        </div>
      </div>
    );
  }

  if (!base) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            Right-click a commit in the graph and choose "Interactive rebase from
            here…" — the commits after it become the editable plan.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
          Rebasing {rows.length} commit{rows.length === 1 ? "" : "s"} onto{" "}
          <span style={{ fontFamily: "monospace" }}>{base.slice(0, 8)}</span> · newest on top, like
          the graph - applied bottom to top
        </span>
      </div>

      <div
        ref={bodyRef}
        className="legit-panel__body"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          // offsetTop of the rows must resolve against THIS scroll container
          // (the drag math runs in its content space).
          position: "relative",
        }}
      >
        {rangeInfo?.transplant && rows.length > 0 && (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            The base is not an ancestor of the current branch: these commits are REPLAYED ONTO{" "}
            <span style={{ fontFamily: "monospace" }}>{base.slice(0, 8)}</span> and move to that
            commit's history.
          </span>
        )}
        {rows.length === 0 && !isFetching && (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            {rangeError ?? "No commits after the chosen base."}
          </span>
        )}
        {rows.map((r, i) => (
          <div
            key={r.sha}
            ref={registerItem(r.sha)}
            onPointerDown={(e) => beginDrag(e, r.sha)}
            style={{
              display: "flex",
              flexDirection: "column",
              border: "1px solid var(--panel-border)",
              borderRadius: 4,
              padding: "4px 8px",
              background: "var(--panel-bg)",
              // Rows are drag handles: without this, dragging selects the
              // subject text along the way (same fix as the repo tabs).
              userSelect: "none",
              opacity: r.action === "drop" ? 0.5 : 1,
              cursor: busy ? undefined : draggingSha === r.sha ? "grabbing" : "grab",
              // The dragged row follows the pointer and floats above its
              // (live-reordered) siblings.
              transform: draggingSha === r.sha ? `translateY(${dragY}px)` : undefined,
              zIndex: draggingSha === r.sha ? 1 : undefined,
              boxShadow: draggingSha === r.sha ? "0 2px 8px var(--shadow-color)" : undefined,
              position: "relative",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <select
                value={r.action}
                disabled={busy}
                onChange={(e) => setAction(i, e.target.value as RebaseAction)}
                style={{ fontSize: "var(--fz-sm)", width: "6.5em" }}
              >
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              <span
                className="legit-subtle"
                style={{ fontFamily: "monospace", fontSize: "var(--fz-sm)", flexShrink: 0 }}
              >
                {r.shortSha}
              </span>
              <span
                style={{
                  fontSize: "var(--fz-md)",
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  textDecoration: r.action === "drop" ? "line-through" : undefined,
                }}
                title={r.subject}
              >
                {r.subject}
              </span>
              {pushed.has(r.sha) && (
                <span
                  className="legit-subtle"
                  title="Already on the upstream - running this plan rewrites published history"
                  style={{
                    fontSize: "var(--fz-sm)",
                    border: "1px solid var(--panel-border)",
                    borderRadius: 3,
                    padding: "0 4px",
                    flexShrink: 0,
                  }}
                >
                  pushed
                </span>
              )}
              <IconButton
                title="Move up (applied later)"
                disabled={busy || i === 0}
                onClick={() => move(i, -1)}
              >
                ↑
              </IconButton>
              <IconButton
                title="Move down (applied earlier)"
                disabled={busy || i === rows.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </IconButton>
            </div>
            {r.action === "reword" && (
              <textarea
                value={r.message}
                disabled={busy}
                rows={Math.min(8, Math.max(2, r.message.split("\n").length))}
                onChange={(e) =>
                  setRows((rs) =>
                    rs.map((row2, i2) => (i2 === i ? { ...row2, message: e.target.value } : row2)),
                  )
                }
                style={{
                  width: "100%",
                  marginTop: 4,
                  fontSize: "var(--fz-md)",
                  fontFamily: "monospace",
                  resize: "vertical",
                  boxSizing: "border-box",
                  // Editable text stays selectable despite the row's
                  // drag-handle user-select: none.
                  userSelect: "text",
                }}
              />
            )}
          </div>
        ))}
        {rows.length > 0 && (
          // The base itself: a non-interactive anchor showing what the plan
          // is applied ONTO (and thereby the newest-first direction).
          <div
            className="legit-subtle"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              border: "1px dashed var(--panel-border)",
              borderRadius: 4,
              padding: "4px 8px",
            }}
          >
            <span style={{ fontSize: "var(--fz-sm)", width: "6.5em", flexShrink: 0 }}>base</span>
            <span style={{ fontFamily: "monospace", fontSize: "var(--fz-sm)", flexShrink: 0 }}>
              {base.slice(0, 8)}
            </span>
            <span
              style={{
                fontSize: "var(--fz-md)",
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={baseCommit?.message}
            >
              {baseCommit ? baseCommit.message.split("\n")[0] : ""}
            </span>
            <span style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
              commits above are applied onto this
            </span>
          </div>
        )}
      </div>

      <div
        style={{
          flexShrink: 0,
          borderTop: "1px solid var(--panel-border)",
          padding: 8,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {error || rangeError ? (
          <span className="legit-error" style={{ fontSize: "var(--fz-sm)", flex: 1 }}>
            {error ?? rangeError}
          </span>
        ) : opInProgress ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flex: 1 }}>
            Another operation is in progress — finish it first.
          </span>
        ) : (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flex: 1 }}>
            Conflicts pause the rebase — resolve them in Working Changes.
          </span>
        )}
        {/* Cancel discards the (never-started) plan - and the panel with it:
            transient panels don't linger in the hint state. */}
        <Button disabled={busy} onClick={closePanel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={busy || !!error || !!rangeError || rows.length === 0 || unchanged || opInProgress}
          loading={busy}
          onClick={start}
          title={unchanged ? "The plan doesn't change anything yet" : "Run the rebase plan"}
        >
          Start rebase
        </Button>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import { repoLog, repoRebaseInteractive } from "../../lib/commands";
import type { Commit, RebaseAction, RebaseStep } from "../../lib/types";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { OP_DOMAINS, useOpState } from "../../lib/useOpState";
import { notifyOpError, notifyRebaseOutcome } from "../../lib/mergeFeedback";
import { Button, IconButton } from "../shared/buttons";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { usePanelRunner } from "../shared/usePanelRunner";
import { useRepoSwitchClear } from "../shared/useRepoSwitchClear";

/** One editable plan row (UI order = todo order, oldest first). */
interface PlanRow {
  sha: string;
  shortSha: string;
  subject: string;
  action: RebaseAction;
}

const ACTION_LABELS: Record<RebaseAction, string> = {
  pick: "pick",
  squash: "squash",
  fixup: "fixup",
  drop: "drop",
};

/** First kept (non-drop) step must be a pick — squash/fixup meld upward. */
function planError(rows: PlanRow[]): string | null {
  const kept = rows.filter((r) => r.action !== "drop");
  if (rows.length === 0) return null;
  if (kept.length === 0) return "Every commit is dropped — nothing to rebase onto.";
  if (kept[0].action !== "pick")
    return "The first kept commit must be a pick — squash/fixup meld into the previous one.";
  return null;
}

/**
 * Interactive Rebase panel — summoned from a commit row with the base sha:
 * lists `base..HEAD` (oldest first, git's todo order) with per-row
 * pick/squash/fixup/drop and reordering, then runs the plan in one go.
 * Conflicts pause the normal rebase machinery, so the Working Changes
 * banner's Continue/Skip/Abort takes over from there. Rewording is not a
 * step here (see the HEAD reword / reword-beyond-HEAD plans).
 */
export function InteractiveRebasePanel() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();

  const [base, setBase] = useState<string | null>(null);
  const [rows, setRows] = useState<PlanRow[]>([]);
  const { busy, run } = usePanelRunner({
    enabled: !!repo,
    onError: notifyOpError,
    // Even a failed start can leave op state behind; refresh either way.
    onSettled: () => {
      if (repo) invalidateRepoDomains(queryClient, repo.id, [...OP_DOMAINS, "tracking"]);
    },
  });

  // Reset when the active repo changes (the base belongs to the old repo) -
  // except when the base was summoned FOR the repo being switched to, and
  // not on first mount. Full rationale in useRepoSwitchClear.
  const markDelivered = useRepoSwitchClear(
    repo?.id,
    useCallback(() => {
      setBase(null);
      setRows([]);
    }, []),
  );

  const onReceive = useCallback((payload: unknown) => {
    if (typeof payload === "string") {
      setBase(payload);
      setRows([]);
      markDelivered();
    }
  }, [markDelivered]);
  useSummonTarget("interactive-rebase", onReceive);

  // base..HEAD, oldest first (git log returns newest first).
  const { data: commits = [], isFetching, refetch } = useQuery<Commit[]>({
    queryKey: [repo?.id, "log", "interactive-rebase", base],
    queryFn: () => repoLog(repo!.id, 200, undefined, `${base}..HEAD`),
    enabled: !!repo && !!base,
    staleTime: 5_000,
  });
  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  // (Re)build the editable plan whenever the underlying range changes.
  // Deliberately NOT on every refetch result identity — only when the actual
  // commit ids change, so an in-progress plan edit survives focus refreshes.
  const commitIds = useMemo(() => commits.map((c) => c.id).join(","), [commits]);
  useEffect(() => {
    const oldestFirst = [...commits].reverse();
    setRows(
      oldestFirst.map((c) => ({
        sha: c.id,
        shortSha: c.id.slice(0, 8),
        subject: c.message.split("\n")[0],
        action: "pick" as RebaseAction,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitIds]);

  const opState = useOpState(repo?.id);
  const opInProgress = !!opState && opState.kind !== "none";

  const move = (index: number, delta: -1 | 1) => {
    setRows((rs) => {
      const next = [...rs];
      const target = index + delta;
      if (target < 0 || target >= next.length) return rs;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const setAction = (index: number, action: RebaseAction) => {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, action } : r)));
  };

  const error = planError(rows);
  const unchanged = rows.every((r, i) => {
    const oldestFirst = [...commits].reverse();
    return r.action === "pick" && oldestFirst[i]?.id === r.sha;
  });

  const start = async () => {
    if (!base) return;
    await run(async () => {
      const plan: RebaseStep[] = rows.map((r) => ({ action: r.action, sha: r.sha }));
      const outcome = await repoRebaseInteractive(repo!.id, base, plan);
      notifyRebaseOutcome(outcome, base.slice(0, 8));
      setBase(null);
      setRows([]);
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
          <span style={{ fontFamily: "monospace" }}>{base.slice(0, 8)}</span> · applied top to bottom
        </span>
      </div>

      <div
        className="legit-panel__body"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}
      >
        {rows.length === 0 && !isFetching && (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No commits after the chosen base.
          </span>
        )}
        {rows.map((r, i) => (
          <div
            key={r.sha}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              border: "1px solid var(--panel-border)",
              borderRadius: 4,
              padding: "4px 8px",
              opacity: r.action === "drop" ? 0.5 : 1,
            }}
          >
            <select
              value={r.action}
              disabled={busy}
              onChange={(e) => setAction(i, e.target.value as RebaseAction)}
              style={{ fontSize: "var(--fz-sm)", width: "6.5em" }}
            >
              {(Object.keys(ACTION_LABELS) as RebaseAction[]).map((a) => (
                <option key={a} value={a}>
                  {ACTION_LABELS[a]}
                </option>
              ))}
            </select>
            <span className="legit-subtle" style={{ fontFamily: "monospace", fontSize: "var(--fz-sm)", flexShrink: 0 }}>
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
            <IconButton title="Move up (earlier)" disabled={busy || i === 0} onClick={() => move(i, -1)}>
              ↑
            </IconButton>
            <IconButton
              title="Move down (later)"
              disabled={busy || i === rows.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </IconButton>
          </div>
        ))}
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
        {error ? (
          <span className="legit-error" style={{ fontSize: "var(--fz-sm)", flex: 1 }}>{error}</span>
        ) : opInProgress ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flex: 1 }}>
            Another operation is in progress — finish it first.
          </span>
        ) : (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flex: 1 }}>
            Conflicts pause the rebase — resolve them in Working Changes.
          </span>
        )}
        <Button disabled={busy} onClick={() => { setBase(null); setRows([]); }}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={busy || !!error || rows.length === 0 || unchanged || opInProgress}
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

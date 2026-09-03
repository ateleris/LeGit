import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ToolbarButton } from "../shared/ToolbarButton";
import { Button } from "../shared/buttons";
import { CaretDropdown } from "../shared/CaretDropdown";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { autoUpdateSubmodules } from "../../lib/submodules";
import { consoleCancel, repoFetch, repoListRemotes, repoPull, repoTrackingStatus } from "../../lib/commands";
import type { Branch, PullStrategy, PushOptions, Remote, TrackingStatus } from "../../lib/types";
import { useRemoteProgressStore } from "../../store/remoteProgress";
import { useSettingsStore } from "../../store/settings";
import { remoteOpErrorMessage } from "../../lib/pushFeedback";
import { pushWithTagFollowUp } from "../../lib/autoPushTags";
import { notifyLfsStubs } from "../../lib/lfsFeedback";
import { notify } from "../../store/notifications";
import { BranchPlusIcon, FetchIcon, PullIcon, PushIcon, ChevronDownIcon, StashIcon } from "../../icons";
import { MenuItem, Separator } from "./menu/primitives";

// ---------------------------------------------------------------------------
// Remote sync toolbar
// ---------------------------------------------------------------------------

type SyncOp = "fetch" | "pull" | "push";

/**
 * Fetch / Pull / Push controls plus an ahead/behind indicator for the current
 * branch. Auth is driven entirely by the repo's local git config (the active
 * git profile's SSH command + credential helper) — these calls add nothing
 * auth-specific; failures are classified by the backend and surfaced as toasts.
 *
 * Long-running ops are cancellable: the frontend mints the `op_id`, passes it
 * into the sync command, and cancels via `consoleCancel` (the same shared
 * GitRunner). A user-cancelled op suppresses its error toast.
 */
const PULL_STRATEGY_LABELS: Record<PullStrategy, string> = {
  Default: "Repo default",
  Rebase: "Rebase",
  Merge: "Merge",
  FfOnly: "Fast-forward only",
};

/** Stash-button modes: whether `git stash push` includes untracked files.
 *  Ordered for the caret menu; keys mirror `stash_include_untracked`. */
const STASH_MODES: { includeUntracked: boolean; label: string }[] = [
  { includeUntracked: false, label: "Tracked changes only" },
  { includeUntracked: true, label: "Include untracked files" },
];

export function RemoteSyncToolbar({
  repoId,
  branches,
  onCreateBranch,
  onStash,
  hasUncommittedChanges,
  trailing,
}: {
  repoId: string;
  branches: Branch[];
  /** Opens the create-new-branch input on the HEAD row (see CommitsPanel). */
  onCreateBranch: () => void;
  /** Stashes the working tree (same action as the uncommitted-changes row's menu). */
  onStash: (includeUntracked: boolean) => void;
  /** Whether the working tree has anything to stash (drives the disabled state). */
  hasUncommittedChanges: boolean;
  /** Extra controls rendered right of the git buttons (the search/filter bar). */
  trailing?: React.ReactNode;
}) {
  const queryClient = useQueryClient();

  const { data: tracking } = useQuery<TrackingStatus | null>({
    queryKey: [repoId, "tracking"],
    queryFn: () => repoTrackingStatus(repoId),
    enabled: !!repoId,
    staleTime: 5_000,
  });

  // Configured remotes (not just fetched ones) — so Publish works the moment a
  // remote is added, before any fetch creates remote-tracking branches.
  const { data: remotes = [] } = useQuery<Remote[]>({
    queryKey: [repoId, "remotes"],
    queryFn: () => repoListRemotes(repoId),
    enabled: !!repoId,
    staleTime: 5_000,
  });

  const [busyOp, setBusyOp] = useState<SyncOp | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pullMenuOpen, setPullMenuOpen] = useState(false);
  const [stashMenuOpen, setStashMenuOpen] = useState(false);
  const opIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);

  // Persisted pull integration strategy ("Default" = the repo's pull.rebase
  // config decides). Picking one in the caret menu changes the default for
  // every future pull, not just the next one.
  const pullStrategy = useSettingsStore((s) => s.settings?.pull_strategy ?? "Default");
  const pushRecurseSubmodules = useSettingsStore(
    (st) => st.settings?.push_recurse_submodules ?? null,
  );
  const setPullStrategy = useSettingsStore((s) => s.setPullStrategy);

  // Persisted default for the Stash button (pull-strategy style): whether
  // stashing includes untracked files. Picking a mode in the caret menu
  // changes the default for every future stash, not just the next one.
  const stashIncludeUntracked = useSettingsStore(
    (s) => s.settings?.stash_include_untracked ?? false,
  );
  const setStashIncludeUntracked = useSettingsStore((s) => s.setStashIncludeUntracked);

  // Latest --progress update for the in-flight op (cleared when it settles).
  const progress = useRemoteProgressStore((s) =>
    opIdRef.current ? s.byOp[opIdRef.current] : undefined,
  );

  // The checked-out local branch (none when detached / unborn).
  const currentBranch = useMemo(
    () => branches.find((b) => b.is_current && !b.is_remote) ?? null,
    [branches],
  );
  const hasUpstream = !!currentBranch?.upstream;

  // The remote to push/publish to: the upstream's remote when set, else a
  // configured remote (prefer "origin", else the first). Null only when the repo
  // has no remotes configured at all.
  const remoteName = useMemo((): string | null => {
    const up = currentBranch?.upstream; // e.g. "refs/remotes/origin/main"
    if (up) {
      const parts = up.split("/");
      if (parts[0] === "refs" && parts[1] === "remotes" && parts.length >= 4) return parts[2];
    }
    if (remotes.length === 0) return null;
    const names = remotes.map((r) => r.name);
    return names.includes("origin") ? "origin" : names[0];
  }, [remotes, currentBranch]);

  const runSync = useCallback(
    async (kind: SyncOp, fn: (opId: string) => Promise<unknown>, successMsg: string) => {
      const opId = crypto.randomUUID();
      opIdRef.current = opId;
      cancelRequestedRef.current = false;
      setBusyOp(kind);
      try {
        await fn(opId);
        notify.success(successMsg);
        // "tags" because push/pull/fetch move remote-tracking refs, which the
        // tag list's per-tag `target_on_remote` flag is computed against.
        invalidateRepoDomains(queryClient, repoId, ["log", "branches", "status", "tracking", "tags"]);
      } catch (e) {
        if (cancelRequestedRef.current) {
          // User cancelled — the failure is expected, no toast.
        } else {
          // Classified wording shared with the branch menus' push action.
          notify.error(remoteOpErrorMessage(e, kind === "pull" ? "pull" : "generic"));
        }
      } finally {
        useRemoteProgressStore.getState().clear(opId);
        setBusyOp(null);
        opIdRef.current = null;
      }
    },
    [queryClient, repoId],
  );

  const cancelSync = useCallback(() => {
    if (opIdRef.current) {
      cancelRequestedRef.current = true;
      void consoleCancel(repoId, opIdRef.current);
    }
  }, [repoId]);

  const doFetch = () =>
    runSync("fetch", (opId) => repoFetch(repoId, { all: true, prune: true, remote: null }, opId), "Fetched");

  const doPull = () =>
    runSync(
      "pull",
      (opId) =>
        repoPull(repoId, { strategy: pullStrategy }, opId).then((r) => {
          // git can exit 0 yet leave LFS pointer stubs (skipdownloaderrors,
          // non-required filter) - the user must learn the files hold no
          // real content, never a bare "Pulled".
          notifyLfsStubs(r.lfs_stubs, "pull");
          // A pull can move submodule pointers exactly like a switch does.
          void autoUpdateSubmodules(queryClient, repoId);
          return r;
        }),
      "Pulled",
    );

  const doPush = (forceWithLease: boolean, remoteOverride?: string) => {
    setMenuOpen(false);
    const remote = remoteOverride ?? remoteName;
    if (!currentBranch || !remote) return;
    const opts: PushOptions = {
      remote,
      branch: currentBranch.name,
      set_upstream: !hasUpstream,
      force_with_lease: forceWithLease,
      recurse_submodules: pushRecurseSubmodules,
    };
    return runSync(
      "push",
      // Auto-push-tags follow-up rides inside the op (gated on the setting);
      // its failures toast separately and never fail the push.
      (opId) => pushWithTagFollowUp(queryClient, repoId, opts, opId),
      hasUpstream ? `Pushed to ${remote}` : "Published branch",
    );
  };

  const busy = busyOp !== null;
  const pushLabel = hasUpstream ? "Push" : "Publish";

  return (
    <div
      className="legit-panel__toolbar"
      // Wraps when the panel is narrow: the search controls (trailing) move
      // to their own line instead of crushing the git buttons. Vertical
      // padding stays the class default (6px): with the 2em controls that
      // lands exactly on the toolbar min-height, so the spacing around the
      // controls is identical whether or not the row wraps.
      style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}
    >
      {/* While an op runs, ITS button becomes the Cancel button (spinner +
          "Cancel", still enabled) — the cancel affordance sits exactly where
          the user just clicked. The other buttons disable as before. */}
      <ToolbarButton
        title={busyOp === "fetch" ? "Cancel fetch" : "Fetch all remotes (prune)"}
        disabled={busyOp === "fetch" ? false : busy || !remoteName}
        loading={busyOp === "fetch"}
        icon={<FetchIcon />}
        label={busyOp === "fetch" ? "Cancel" : "Fetch"}
        onClick={busyOp === "fetch" ? cancelSync : doFetch}
      />
      {/* Pull with a caret menu picking the integration strategy. */}
      <div style={{ position: "relative", display: "flex" }}>
        <ToolbarButton
          title={
            busyOp === "pull"
              ? "Cancel pull"
              : hasUpstream
                ? `Pull from ${tracking?.upstream ?? "upstream"}` +
                  (pullStrategy !== "Default" ? ` (${PULL_STRATEGY_LABELS[pullStrategy]})` : "")
                : "No upstream for the current branch"
          }
          disabled={busyOp === "pull" ? false : busy || !hasUpstream}
          loading={busyOp === "pull"}
          icon={<PullIcon />}
          label={busyOp === "pull" ? "Cancel" : "Pull"}
          onClick={busyOp === "pull" ? cancelSync : doPull}
          rounded="left"
        />
        <Button
          variant="ghost"
          rounded="right"
          title="Pull strategy"
          disabled={busy || !hasUpstream}
          onClick={() => setPullMenuOpen((o) => !o)}
          style={{ padding: "2px 4px", marginLeft: -1 }}
        >
          <ChevronDownIcon />
        </Button>
        {pullMenuOpen && (
          <CaretDropdown onClose={() => setPullMenuOpen(false)}>
            {(Object.keys(PULL_STRATEGY_LABELS) as PullStrategy[]).map((s) => (
              <MenuItem
                key={s}
                onClick={() => {
                  void setPullStrategy(s);
                  setPullMenuOpen(false);
                }}
              >
                <span style={{ fontWeight: s === pullStrategy ? 600 : 400 }}>
                  {s === pullStrategy ? "✓ " : " "}
                  {PULL_STRATEGY_LABELS[s]}
                </span>
              </MenuItem>
            ))}
          </CaretDropdown>
        )}
      </div>

      {/* Push / Publish with a caret menu for force-push (with lease). */}
      <div style={{ position: "relative", display: "flex" }}>
        <ToolbarButton
          title={
            busyOp === "push"
              ? "Cancel push"
              : !currentBranch
              ? "Detached HEAD — no branch to push"
              : !remoteName
              ? "No remote configured"
              : hasUpstream
              ? `Push to ${remoteName}`
              : `Publish branch to ${remoteName} (sets upstream)`
          }
          disabled={busyOp === "push" ? false : busy || !currentBranch || !remoteName}
          loading={busyOp === "push"}
          icon={<PushIcon />}
          label={busyOp === "push" ? "Cancel" : pushLabel}
          onClick={busyOp === "push" ? cancelSync : () => doPush(false)}
          rounded="left"
        />
        <Button
          variant="ghost"
          rounded="right"
          title="More push options"
          disabled={busy || !currentBranch || !remoteName}
          onClick={() => setMenuOpen((o) => !o)}
          style={{ padding: "2px 4px", marginLeft: -1 }}
        >
          <ChevronDownIcon />
        </Button>
        {menuOpen && (
          <CaretDropdown onClose={() => setMenuOpen(false)}>
            <MenuItem onClick={() => doPush(true)}>Force-push (with lease)</MenuItem>
            {/* With several remotes, offer a one-off push to each other one
                (the button itself targets the upstream's / default remote). */}
            {remotes.length > 1 && (
              <>
                <Separator />
                {remotes
                  .filter((r) => r.name !== remoteName)
                  .map((r) => (
                    <MenuItem key={r.name} onClick={() => doPush(false, r.name)}>
                      Push to {r.name}
                    </MenuItem>
                  ))}
              </>
            )}
          </CaretDropdown>
        )}
      </div>

      {/* Create a new branch at HEAD — opens an inline name input on the
          HEAD row's ref chips (local op; independent of the sync busy state). */}
      <ToolbarButton
        title="Create a new branch at HEAD"
        disabled={false}
        loading={false}
        icon={<BranchPlusIcon />}
        label="Branch"
        // Explicitly argument-free: the DOM click event must not leak into
        // the handler's optional startPoint parameter.
        onClick={() => onCreateBranch()}
      />

      {/* Stash the working tree - same action as the uncommitted-changes
          row's context menu. The caret picks the persisted default mode
          (tracked only / incl. untracked), pull-strategy style: selecting a
          mode configures the button, it does not stash. Local op; independent
          of the sync busy state. */}
      <div style={{ position: "relative", display: "flex" }}>
        <ToolbarButton
          title={
            hasUncommittedChanges
              ? "Stash uncommitted changes" +
                (stashIncludeUntracked ? " (incl. untracked)" : "")
              : "No uncommitted changes to stash"
          }
          disabled={!hasUncommittedChanges}
          loading={false}
          icon={<StashIcon />}
          label="Stash"
          onClick={() => onStash(stashIncludeUntracked)}
          rounded="left"
        />
        <Button
          variant="ghost"
          rounded="right"
          title="Stash mode"
          disabled={!hasUncommittedChanges}
          onClick={() => setStashMenuOpen((o) => !o)}
          style={{ padding: "2px 4px", marginLeft: -1 }}
        >
          <ChevronDownIcon />
        </Button>
        {stashMenuOpen && (
          <CaretDropdown onClose={() => setStashMenuOpen(false)}>
            {STASH_MODES.map((mode) => (
              <MenuItem
                key={mode.label}
                onClick={() => {
                  void setStashIncludeUntracked(mode.includeUntracked);
                  setStashMenuOpen(false);
                }}
              >
                <span
                  style={{
                    fontWeight:
                      mode.includeUntracked === stashIncludeUntracked ? 600 : 400,
                  }}
                >
                  {mode.includeUntracked === stashIncludeUntracked ? "✓ " : " "}
                  {mode.label}
                </span>
              </MenuItem>
            ))}
          </CaretDropdown>
        )}
      </div>

      {/* Ahead/behind indicator for the current branch, right of the buttons. */}
      {tracking && (
        <span
          title={`${tracking.ahead} ahead, ${tracking.behind} behind ${tracking.upstream}`}
          style={{
            fontSize: "var(--fz-sm)",
            color: "var(--subtle-fg)",
            fontFamily: "monospace",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {tracking.ahead === 0 && tracking.behind === 0 ? (
            <span>in sync</span>
          ) : (
            <>
              <span>↑{tracking.ahead}</span>
              <span>↓{tracking.behind}</span>
            </>
          )}
        </span>
      )}

      {/* Live transfer progress for the in-flight op (fed by the
          legit://remote-progress event; cleared when the op settles). */}
      {busy && progress && (
        <span
          title={`${progress.phase}${progress.percent != null ? ` ${progress.percent}%` : ""}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: "var(--fz-sm)",
            color: "var(--subtle-fg)",
            minWidth: 0,
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {progress.phase}
            {progress.percent != null ? ` ${progress.percent}%` : "…"}
          </span>
          {progress.percent != null && (
            <span
              aria-hidden
              style={{
                width: "6em",
                height: "0.4em",
                borderRadius: 2,
                background: "var(--panel-border)",
                overflow: "hidden",
                display: "inline-block",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  display: "block",
                  height: "100%",
                  width: `${progress.percent}%`,
                  background: "var(--progress-bar-bg)",
                }}
              />
            </span>
          )}
        </span>
      )}

      {/* Search controls (owned by CommitsPanel): float right of the flexible
          gap after the buttons + indicators, capped in width. */}
      {trailing}
    </div>
  );
}


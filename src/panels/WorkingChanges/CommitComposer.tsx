import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRepoStore } from "../../store/repos";
import { useSettingsStore } from "../../store/settings";
import {
  repoBranches,
  repoCommit,
  repoGitmodulesConsistency,
  repoListRemotes,
  repoLog,
  repoResolvedIdentity,
  repoTrackingStatus,
} from "../../lib/commands";
import type {
  Branch,
  Commit,
  CommitButtonMode,
  GitmodulesFinding,
  Remote,
  RepoSummary,
  ResolvedIdentity,
  TrackingStatus,
} from "../../lib/types";
import { useCommitDraftStore } from "../../store/commitDraft";
import { notify } from "../../store/notifications";
import { Button } from "../shared/buttons";
import { ChevronDownIcon, WarningIcon } from "../../icons";
import { MenuItem } from "../Commits/menu/primitives";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { summonGlobalPanel } from "../GlobalDock";
import { isDetachedHead } from "../../lib/detachedHead";
import { pushWithTagFollowUp } from "../../lib/autoPushTags";
import { remoteOpErrorMessage } from "../../lib/pushFeedback";
import { PUSH_DOMAINS } from "../Commits/useCommitActions";
import { CaretDropdown } from "../shared/CaretDropdown";
import {
  commitAndPushMenuLabel,
  commitButtonPlan,
  commitPushFailureMessage,
  commitPushSuccessMessage,
  type CommitPushTarget,
} from "./commitButtonMode";
import { gitmodulesFindingLabel } from "./gitmodulesWarning";
import { formatEolChanges, type StagedEolChange } from "./lineEndingWarning";

/** Shared chrome of the composer's inline confirm banners. */
const bannerStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid var(--panel-border)",
  borderRadius: 4,
  background: "var(--button-hover-bg)",
};

/**
 * The commit box below/between the file sections: message draft, amend
 * toggle, the split Commit / Commit-and-Push button, and the inline commit
 * gates (detached HEAD, amend-pushed, .gitmodules consistency, line
 * endings). Owns all commit-side state and queries; the panel supplies the
 * shared busy runner so buttons disable coherently across sections.
 */
export function CommitComposer({
  repo,
  stagedCount,
  busy,
  run,
  eolChanges,
  warnEolCommit,
}: {
  repo: RepoSummary;
  stagedCount: number;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<boolean>;
  /** Staged line-ending changes the next commit would record. */
  eolChanges: StagedEolChange[];
  warnEolCommit: boolean;
}) {
  const queryClient = useQueryClient();
  const repoSettings = useRepoStore((s) => s.repoSettings[repo.id]);
  const updateRepoSetting = useRepoStore((s) => s.updateRepoSetting);
  // Commit button default: plain commit vs commit-and-push. Per-repo ONLY,
  // set via the button's caret menu (deliberately no settings-panel section).
  const commitMode: CommitButtonMode = repoSettings?.commit_button_mode ?? "commit";
  const pushRecurseSubmodules = useSettingsStore(
    (s) => s.settings?.push_recurse_submodules ?? null,
  );

  // The draft commit message lives in a per-repo store, not component state:
  // this panel shares a dock slot and unmounts whenever the user opens e.g. a
  // commit, and a typed draft must survive that round-trip.
  const message = useCommitDraftStore((s) => s.drafts[repo.id] ?? "");
  const setDraft = useCommitDraftStore((s) => s.setDraft);
  const clearDraft = useCommitDraftStore((s) => s.clearDraft);
  const setMessage = (m: string) => {
    if (m.length === 0) clearDraft(repo.id);
    else setDraft(repo.id, m);
  };
  // When set, the commit rewrites HEAD (`git commit --amend`) instead of
  // creating a new commit. Reset after each successful commit.
  const [amend, setAmend] = useState(false);
  const [confirmDetachedCommit, setConfirmDetachedCommit] = useState(false);
  const [confirmAmendPushed, setConfirmAmendPushed] = useState(false);
  const [confirmEolCommit, setConfirmEolCommit] = useState(false);
  // Non-empty = the .gitmodules consistency warning banner is up.
  const [gitmodulesFindings, setGitmodulesFindings] = useState<GitmodulesFinding[]>([]);
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);

  // A pending .gitmodules gate from the previous repo must not fire against
  // the new one (the other gates self-clear via their applicability effects).
  const prevRepoId = useRef(repo.id);
  useEffect(() => {
    if (prevRepoId.current === repo.id) return;
    prevRepoId.current = repo.id;
    setGitmodulesFindings([]);
  }, [repo.id]);

  // The latest commit — drives amend message prefill and the "has commits"
  // guard (amend is impossible on an unborn branch). Kept fresh because
  // refresh() invalidates the [repo.id, "log"] key after each commit.
  const { data: headLog = [] } = useQuery<Commit[]>({
    queryKey: [repo.id, "log", "head1"],
    queryFn: () => repoLog(repo.id, 1),
    staleTime: 5_000,
  });
  const head = headLog[0] ?? null;

  // Tracking status — to warn before amending a commit that's already pushed.
  // Shares React Query's cache with the Commits panel (same key).
  const { data: tracking } = useQuery<TrackingStatus | null>({
    queryKey: [repo.id, "tracking"],
    queryFn: () => repoTrackingStatus(repo.id),
    staleTime: 5_000,
  });
  // HEAD is already published when it has an upstream and no local-only commits
  // ahead of it (ahead === 0 → the tip is on the remote). Amending then rewrites
  // pushed history and needs a force-push.
  const amendingPushed = amend && !!tracking && tracking.ahead === 0;

  // Branches + remotes — drive the split commit button's Push/Publish label
  // and push target (`tracking` cannot: it is null for detached, untracked
  // AND gone upstreams alike, and `upstream_gone` lives only on `Branch`).
  // Both share React Query's cache with the Commits panel (same keys).
  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: [repo.id, "branches"],
    queryFn: () => repoBranches(repo.id),
    staleTime: 5_000,
  });
  const { data: remotes = [] } = useQuery<Remote[]>({
    queryKey: [repo.id, "remotes"],
    queryFn: () => repoListRemotes(repo.id),
    staleTime: 5_000,
  });
  const currentBranch = branches.find((b) => b.is_current && !b.is_remote) ?? null;
  const remoteNames = remotes.map((r) => r.name);

  // Commit identity resolved across all config scopes: when name or email is
  // missing everywhere, a commit fails with git's "Please tell me who you are";
  // the composer warns BEFORE that and links to the profile settings. Identity
  // changes rarely and ~/.gitconfig isn't watched, so a moderate staleTime plus
  // the panel-focus refetch keeps it honest after the user sets one.
  const { data: identity } = useQuery<ResolvedIdentity>({
    queryKey: [repo.id, "identity"],
    queryFn: () => repoResolvedIdentity(repo.id),
    staleTime: 30_000,
  });
  const identityMissing = !!identity && (!identity.user_name || !identity.user_email);

  // The push leg the in-flight commit chains (set by requestCommit from the
  // plan, consumed by commit). A ref, not state: the confirm banners defer
  // commit() to a later click and the value must survive that gap unchanged.
  const pendingPushRef = useRef<CommitPushTarget | null>(null);
  const commit = () =>
    run(async () => {
      const push = pendingPushRef.current;
      pendingPushRef.current = null;
      await repoCommit(repo.id, message, amend);
      setMessage("");
      setAmend(false);
      if (push) {
        // Push failures are their own outcome — the commit already stands, so
        // they must never surface through run()'s onError as a failed commit.
        try {
          await pushWithTagFollowUp(
            queryClient,
            repo.id,
            {
              remote: push.remote,
              branch: push.branch,
              set_upstream: push.setUpstream,
              force_with_lease: false,
              recurse_submodules: pushRecurseSubmodules,
            },
            crypto.randomUUID(),
          );
          notify.success(commitPushSuccessMessage(push));
        } catch (e) {
          notify.error(commitPushFailureMessage(remoteOpErrorMessage(e)));
        }
        invalidateRepoDomains(queryClient, repo.id, PUSH_DOMAINS);
      }
    });

  // A detached-HEAD commit is reachable only through the reflog once HEAD
  // moves on, so always ask first — this is a data-loss warning, not a
  // destructive-action confirm, so it is deliberately NOT gated by the
  // global confirmation setting. Judged from the HEAD commit's log
  // decorations: a bare `head` decoration = detached.
  const detached = isDetachedHead(head);
  // Final gate before the actual commit: the line-ending warning (per its
  // setting). Runs LAST so it also covers commits approved through the
  // detached-HEAD / amend-pushed / .gitmodules confirms.
  const proceedEolGate = () => {
    if (warnEolCommit && eolChanges.length > 0) {
      setConfirmEolCommit(true);
      return;
    }
    void commit();
  };
  // .gitmodules consistency gate: warn before committing a staged state
  // whose .gitmodules and gitlinks disagree (manual edits, half-done
  // removals). Always on - it fires only on genuinely broken states, and it
  // is a repo-integrity warning like detached-HEAD, deliberately not gated
  // by the confirm setting. Best-effort: a failing CHECK must never block
  // committing.
  const proceedCommit = () => {
    void (async () => {
      const findings = await repoGitmodulesConsistency(repo.id).catch(
        () => [] as GitmodulesFinding[],
      );
      if (findings.length > 0) {
        setGitmodulesFindings(findings);
        return;
      }
      proceedEolGate();
    })();
  };
  // The split button's plan under the persisted mode: the label shown, and
  // whether the commit chains a push. Amend/detached/no-target all degrade to
  // a plain commit inside the plan, so the label never over-promises.
  const commitPlan = commitButtonPlan({
    mode: commitMode,
    amend,
    detached,
    currentBranch,
    remotes: remoteNames,
  });
  const requestCommit = () => {
    // The push leg is decided at request time and parked in the ref: the
    // confirm banners defer commit() to a later click, and the plan must
    // survive that gap unchanged.
    pendingPushRef.current = commitPlan.push;
    if (detached) {
      setConfirmDetachedCommit(true);
      return;
    }
    // Amending an already-pushed commit rewrites published history (force-push
    // needed, disrupts collaborators). Warn first — like the detached case, a
    // history-safety warning, deliberately NOT gated by the confirm setting.
    if (amendingPushed) {
      setConfirmAmendPushed(true);
      return;
    }
    proceedCommit();
  };
  // Caret-menu pick configures the button (persists the mode for this repo),
  // it does not commit — the same semantics as the Stash and Pull-strategy
  // carets. Committing stays one explicit click on the (now relabeled) button.
  const pickCommitMode = (mode: CommitButtonMode) => {
    setCommitMenuOpen(false);
    void updateRepoSetting(repo.id, "commit_button_mode", mode);
  };

  // Drop a pending detached-HEAD confirmation once HEAD is back on a branch
  // (e.g. the user switched away with the prompt still open).
  useEffect(() => {
    if (!detached) setConfirmDetachedCommit(false);
  }, [detached]);

  // Drop a pending amend-pushed confirmation if it no longer applies (amend
  // toggled off, or new local commits mean the tip is no longer published).
  useEffect(() => {
    if (!amendingPushed) setConfirmAmendPushed(false);
  }, [amendingPushed]);

  // Drop a pending line-ending confirmation once it no longer applies
  // (files unstaged, endings reverted, or the setting turned off).
  useEffect(() => {
    if (!warnEolCommit || eolChanges.length === 0) setConfirmEolCommit(false);
  }, [warnEolCommit, eolChanges.length]);

  // Prefill HEAD's message when turning amend on, but only if the box is empty
  // so typed-but-uncommitted text is never clobbered.
  const toggleAmend = (next: boolean) => {
    setAmend(next);
    if (next && head && message.trim().length === 0) setMessage(head.message);
  };

  // Amend allows a message-only commit (no staged files required), but needs an
  // existing HEAD to rewrite.
  const canCommit = amend
    ? !!head && message.trim().length > 0 && !busy
    : stagedCount > 0 && message.trim().length > 0 && !busy;

  return (
    <div style={{ flexShrink: 0, borderTop: "1px solid var(--panel-border)", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
      {identityMissing && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 8px",
            border: "1px solid var(--panel-border)",
            borderRadius: 4,
            background: "var(--button-hover-bg)",
            fontSize: "var(--fz-md)",
          }}
        >
          <span style={{ display: "inline-flex", color: "var(--warning-fg)" }}>
            <WarningIcon />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            No git identity is set ({!identity?.user_name && <code>user.name</code>}
            {!identity?.user_name && !identity?.user_email && ", "}
            {!identity?.user_email && <code>user.email</code>}): committing will fail.
          </span>
          <button onClick={() => summonGlobalPanel("global-settings")}>
            Set identity…
          </button>
        </div>
      )}
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Commit message"
        rows={3}
        style={{ resize: "vertical", fontFamily: "inherit", fontSize: "var(--fz-md)" }}
      />
      {confirmDetachedCommit ? (
        <div style={bannerStyle}>
          <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
            HEAD is <strong>detached</strong> — no branch points here, so once you
            switch away this commit is only reachable via the reflog. Commit anyway?
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setConfirmDetachedCommit(false);
                proceedCommit();
              }}
            >
              Commit anyway
            </Button>
            <button disabled={busy} onClick={() => setConfirmDetachedCommit(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : confirmAmendPushed ? (
        <div style={bannerStyle}>
          <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
            The last commit is <strong>already pushed</strong>
            {tracking?.upstream ? <> to <code>{tracking.upstream}</code></> : null}. Amending
            rewrites it, so you'll need to force-push and it may disrupt anyone who has pulled
            it. Amend anyway?
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setConfirmAmendPushed(false);
                proceedCommit();
              }}
            >
              Amend anyway
            </Button>
            <button disabled={busy} onClick={() => setConfirmAmendPushed(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : gitmodulesFindings.length > 0 ? (
        <div style={bannerStyle}>
          <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
            This commit records a <strong>.gitmodules</strong> that does not match its
            submodules:
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {gitmodulesFindings.map((f) => (
                <li key={`${f.kind}:${"name" in f ? f.name : ""}:${f.path}`}>
                  {gitmodulesFindingLabel(f)}
                </li>
              ))}
            </ul>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setGitmodulesFindings([]);
                proceedEolGate();
              }}
            >
              Commit anyway
            </Button>
            <button disabled={busy} onClick={() => setGitmodulesFindings([])}>
              Cancel
            </button>
          </div>
        </div>
      ) : confirmEolCommit ? (
        <div style={bannerStyle}>
          <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
            {eolChanges.length === 1 ? (
              <>1 file changes <strong>line endings</strong>: </>
            ) : (
              <>{eolChanges.length} files change <strong>line endings</strong>: </>
            )}
            <code>{formatEolChanges(eolChanges)}</code>. Commit anyway?
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setConfirmEolCommit(false);
                void commit();
              }}
            >
              Commit anyway
            </Button>
            <button disabled={busy} onClick={() => setConfirmEolCommit(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fz-sm)", color: "var(--subtle-fg)" }}>
            <input type="checkbox" checked={amend} disabled={!head || busy} onChange={(e) => toggleAmend(e.target.checked)} />
            Amend last commit
          </label>
          {/* Split button: the action half runs the persisted mode, the
              caret configures it (persist-only, per repo, like the Stash
              caret). The label is the plan's — it already degrades
              (amend/detached/no target), so it never promises a push that
              will not happen. */}
          <div style={{ position: "relative", display: "flex", marginLeft: "auto" }}>
            <Button variant="primary" rounded="left" data-testid="commit-button" disabled={!canCommit} onClick={requestCommit}>
              {commitPlan.label} {!amend && stagedCount > 0 ? `(${stagedCount})` : ""}
            </Button>
            <Button
              variant="primary"
              rounded="right"
              title="Commit mode"
              disabled={busy}
              onClick={() => setCommitMenuOpen((o) => !o)}
              style={{ padding: "2px 4px", marginLeft: 1 }}
            >
              <ChevronDownIcon />
            </Button>
            {commitMenuOpen && (
              <CaretDropdown onClose={() => setCommitMenuOpen(false)}>
                {(
                  [
                    { mode: "commit" as const, label: "Commit" },
                    {
                      mode: "commit_and_push" as const,
                      label: commitAndPushMenuLabel(currentBranch, remoteNames),
                    },
                  ]
                ).map((entry) => (
                  <MenuItem key={entry.mode} onClick={() => pickCommitMode(entry.mode)}>
                    <span style={{ fontWeight: entry.mode === commitMode ? 600 : 400 }}>
                      {entry.mode === commitMode ? "✓ " : " "}
                      {entry.label}
                    </span>
                  </MenuItem>
                ))}
              </CaretDropdown>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

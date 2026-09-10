import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo, useRepoStore } from "../../store/repos";
import { useConfirmDestructive } from "../../store/settings";
import {
  repoBranches,
  repoWorktreeAdd,
  repoWorktreeList,
  repoWorktreePrune,
  repoWorktreeRemove,
} from "../../lib/commands";
import type { Branch, WorktreeAddMode, WorktreeInfo } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { supportsHostFolderPicker, worktreeLocator } from "../../lib/locator";
import { notify } from "../../store/notifications";
import { confirmDialog } from "../../store/confirm";
import { usePanelRunner } from "../shared/usePanelRunner";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { ToolbarButton } from "../shared/ToolbarButton";
import { worktreeBadges, worktreeLabel } from "./worktreeRows";

const normalize = (p: string) => p.replaceAll("\\", "/");

/** The Refs panel's Worktrees pane: list, open-as-tab, add, remove, prune. */
export function WorktreesSection() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();
  const openRepo = useRepoStore((s) => s.openRepo);
  const confirmDestructive = useConfirmDestructive();
  const [adding, setAdding] = useState(false);
  const [addPath, setAddPath] = useState("");
  const [addMode, setAddMode] = useState<"new_branch" | "checkout">("new_branch");
  const [addBranch, setAddBranch] = useState("");

  const { data: worktrees = [] } = useQuery<WorktreeInfo[]>({
    queryKey: [repo?.id, "worktrees"],
    queryFn: () => repoWorktreeList(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });
  // Existing local branches feed the checkout mode's picker; branches
  // checked out in some worktree are filtered out (git would refuse them).
  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: [repo?.id, "branches"],
    queryFn: () => repoBranches(repo!.id),
    enabled: !!repo && adding,
    staleTime: 5_000,
  });

  const refresh = () => {
    if (!repo) return;
    invalidateRepoDomains(queryClient, repo.id, ["worktrees", "branches", "log"]);
  };
  const { busy, run } = usePanelRunner({
    enabled: !!repo,
    onSuccess: refresh,
    onError: (e) => notify.error(formatAppError(e)),
  });

  if (!repo) return null;
  const currentPath =
    worktrees.find((w) => normalize(w.path) === normalize(repo.path))?.path ?? null;

  const checkedOut = new Set(worktrees.map((w) => w.branch).filter(Boolean));
  const addableBranches = branches.filter((b) => !b.is_remote && !checkedOut.has(b.name));

  // Native folder picker, local repos only (a Windows dialog cannot name a
  // distro path). The picked folder is usually the PARENT: git wants a new
  // or empty directory, so a picked existing folder gets the new worktree's
  // suggested name appended for the user to adjust.
  const browse = async () => {
    // Start where the user thinks in: the MAIN repo's folder (the current
    // tab may itself be a linked worktree).
    const mainPath = worktrees.find((w) => w.is_main)?.path ?? repo.path;
    const sel = await openDialog({ directory: true, multiple: false, defaultPath: mainPath });
    if (typeof sel !== "string") return;
    const name = addBranch.trim() ? addBranch.trim().replaceAll("/", "-") : "worktree";
    setAddPath(`${sel.replaceAll("\\", "/")}/${name}`);
  };

  const submitAdd = () =>
    run(async () => {
      const mode: WorktreeAddMode =
        addMode === "new_branch"
          ? { kind: "new_branch", name: addBranch, start_point: null }
          : { kind: "checkout", branch: addBranch };
      await repoWorktreeAdd(repo.id, addPath.trim(), mode);
      setAdding(false);
      setAddPath("");
      setAddBranch("");
    });

  const requestRemove = async (w: WorktreeInfo) => {
    if (confirmDestructive) {
      const ok = await confirmDialog({
        title: "Remove worktree",
        message:
          "Deletes the worktree checkout from disk. The branch and its commits are kept.",
        detail: w.path,
        confirmLabel: "Remove",
      });
      if (!ok) return;
    }
    void run(async () => {
      try {
        await repoWorktreeRemove(repo.id, w.path, false);
      } catch (e) {
        // Dirty worktree: git refuses without --force. Always confirm the
        // force (data loss), independent of the confirm setting - this is a
        // data-loss warning, not a routine destructive confirm.
        const msg = formatAppError(e);
        if (!msg.includes("--force")) throw e;
        const ok = await confirmDialog({
          title: "Worktree has local changes",
          message: "Force-removing deletes its uncommitted changes permanently.",
          detail: w.path,
          confirmLabel: "Force remove",
        });
        if (!ok) return;
        await repoWorktreeRemove(repo.id, w.path, true);
      }
    });
  };

  return (
    <div className="legit-panel__body" style={{ padding: "4px 0", overflowY: "auto" }}>
      <div style={{ display: "flex", gap: 6, padding: "2px 8px" }}>
        <ToolbarButton label="Add…" disabled={busy} onClick={() => setAdding((a) => !a)} />
        {worktrees.some((w) => w.prunable !== null) && (
          <ToolbarButton
            label="Prune"
            disabled={busy}
            onClick={() => void run(async () => { await repoWorktreePrune(repo.id); })}
          />
        )}
      </div>
      {adding && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 8px" }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              placeholder="Absolute path for the new worktree"
              value={addPath}
              onChange={(e) => setAddPath(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            />
            {supportsHostFolderPicker(repo.host) && (
              <button disabled={busy} onClick={() => void browse()}>
                Browse…
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select
              value={addMode}
              onChange={(e) => setAddMode(e.target.value as "new_branch" | "checkout")}
            >
              <option value="new_branch">New branch</option>
              <option value="checkout">Existing branch</option>
            </select>
            {addMode === "new_branch" ? (
              <input
                placeholder="Branch name"
                value={addBranch}
                onChange={(e) => setAddBranch(e.target.value)}
                style={{ flex: 1, minWidth: 0 }}
              />
            ) : (
              <select
                value={addBranch}
                onChange={(e) => setAddBranch(e.target.value)}
                style={{ flex: 1, minWidth: 0 }}
              >
                <option value="">Select branch…</option>
                {addableBranches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
            <button
              disabled={busy || addPath.trim() === "" || addBranch.trim() === ""}
              onClick={() => void submitAdd()}
            >
              Create
            </button>
          </div>
        </div>
      )}
      {worktrees.map((w) => {
        const badges = worktreeBadges(w, currentPath);
        const isCurrent = badges.includes("current");
        return (
          <div
            key={w.path}
            title={w.locked !== null ? `Locked${w.locked ? `: ${w.locked}` : ""}` : w.path}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "2px 8px",
              fontSize: "var(--fz-md)",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {worktreeLabel(w)}
            </span>
            <span
              className="legit-subtle"
              style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {w.branch ?? (w.detached ? w.head?.slice(0, 8) : "")}
            </span>
            {badges.map((b) => (
              <span
                key={b}
                className="legit-subtle"
                style={{
                  fontSize: "var(--fz-xs)",
                  border: "1px solid var(--panel-border)",
                  borderRadius: 3,
                  padding: "0 0.35em",
                  whiteSpace: "nowrap",
                }}
              >
                {b}
              </span>
            ))}
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              {!isCurrent && (
                <ToolbarButton
                  label="Open"
                  disabled={busy}
                  onClick={() =>
                    void openRepo(worktreeLocator(repo.locator ?? repo.path, w.path)).catch(
                      (e: unknown) => notify.error(formatAppError(e)),
                    )
                  }
                />
              )}
              {!w.is_main && !isCurrent && (
                <ToolbarButton
                  label="Remove"
                  disabled={busy}
                  onClick={() => void requestRemove(w)}
                />
              )}
            </span>
          </div>
        );
      })}
      {worktrees.length <= 1 && !adding && (
        <div className="legit-subtle" style={{ padding: "2px 8px", fontSize: "var(--fz-sm)" }}>
          No linked worktrees.
        </div>
      )}
    </div>
  );
}

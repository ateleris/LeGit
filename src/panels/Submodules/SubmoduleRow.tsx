import { useState } from "react";
import { submoduleBadge } from "../../lib/submodules";
import type { SubmoduleInfo } from "../../lib/types";
import { ToolbarButton } from "../shared/ToolbarButton";
import { Button } from "../shared/buttons";
import { InlineRenameInput } from "../Commits/cells/InlineRenameInput";

/**
 * One submodule row: path, branch or "(detached)", state badge, short SHA,
 * and the operation buttons. URL/branch edits happen in place
 * (InlineRenameInput: Enter approves, Esc discards - per the app-wide rename
 * convention); the remove confirmation renders inline and is gated by the
 * section (global destructive-confirm setting).
 */
export function SubmoduleRow({
  info,
  busy,
  removing,
  onOpen,
  onInitUpdate,
  onUpdate,
  onPullLatest,
  onSync,
  onFetch,
  onSetUrl,
  onSetBranch,
  onMovePath,
  onCreateBranch,
  onRemove,
  onConfirmRemove,
  onCancelRemove,
}: {
  info: SubmoduleInfo;
  busy: boolean;
  /** Non-null when this row's remove is awaiting inline confirmation. */
  removing: "confirm" | null;
  onOpen: () => void;
  onInitUpdate: () => void;
  onUpdate: () => void;
  onPullLatest: () => void;
  onSync: () => void;
  onFetch: () => void;
  onSetUrl: (url: string) => void;
  onSetBranch: (branch: string | null) => void;
  /** Move the submodule to a new path (git mv; stages the result). */
  onMovePath: (to: string) => void;
  /** Create a branch at the submodule's detached HEAD. */
  onCreateBranch: (name: string) => void;
  onRemove: () => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
}) {
  const badge = submoduleBadge(info);
  const sha = info.checked_out_sha ?? info.recorded_sha;
  const uninitialized = !info.state.initialized || !info.state.populated;
  const [editing, setEditing] = useState<"url" | "branch" | "new-branch" | "path" | null>(null);

  return (
    <div
      style={{
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        padding: "6px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
      title={info.url ?? info.gitmodules_url ?? undefined}
      onDoubleClick={onOpen}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: "var(--fz-md)",
            fontFamily: "monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={`${info.path} - double-click to open as a repo tab`}
        >
          {info.path}
        </span>
        <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
          {info.state.populated ? info.head_branch ?? "(detached)" : ""}
        </span>
        {badge && (
          <span
            style={{
              fontSize: "var(--fz-sm)",
              color: badge.color,
              border: "1px solid currentColor",
              borderRadius: "0.75em",
              padding: "0 0.5em",
              flexShrink: 0,
            }}
          >
            {badge.label}
          </span>
        )}
        {sha && (
          <span
            className="legit-subtle"
            style={{
              fontSize: "var(--fz-sm)",
              fontFamily: "monospace",
              marginLeft: "auto",
              flexShrink: 0,
            }}
            title={sha}
          >
            {sha.slice(0, 8)}
          </span>
        )}
      </div>

      {editing === "url" && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
            URL
          </span>
          <InlineRenameInput
            initialValue={info.url ?? info.gitmodules_url ?? ""}
            placeholder="submodule URL"
            disabled={busy}
            onSave={(v) => {
              setEditing(null);
              if (v.trim()) onSetUrl(v.trim());
            }}
            onCancel={() => setEditing(null)}
            style={{ fontSize: "var(--fz-sm)", flex: 1 }}
            title="New URL for .gitmodules - synced into the local config and the submodule's origin on Enter"
          />
        </div>
      )}
      {editing === "branch" && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
            Branch
          </span>
          <InlineRenameInput
            initialValue={info.branch ?? ""}
            placeholder="tracked branch (empty = remote default)"
            disabled={busy}
            onSave={(v) => {
              setEditing(null);
              onSetBranch(v.trim() === "" ? null : v.trim());
            }}
            onCancel={() => setEditing(null)}
            style={{ fontSize: "var(--fz-sm)", flex: 1 }}
            title="Branch used by Pull latest (update --remote) - empty clears to the remote default"
          />
        </div>
      )}

      {editing === "new-branch" && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
            New branch
          </span>
          <InlineRenameInput
            initialValue=""
            placeholder="branch name at the current commit"
            disabled={busy}
            onSave={(v) => {
              setEditing(null);
              if (v.trim()) onCreateBranch(v.trim());
            }}
            onCancel={() => setEditing(null)}
            style={{ fontSize: "var(--fz-sm)", flex: 1 }}
            title="Create a branch at the submodule's detached HEAD so commits cannot be lost"
          />
        </div>
      )}

      {editing === "path" && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
            Move to
          </span>
          <InlineRenameInput
            initialValue={info.path}
            placeholder="new path for the submodule"
            disabled={busy}
            onSave={(v) => {
              setEditing(null);
              const to = v.trim();
              if (to && to !== info.path) onMovePath(to);
            }}
            onCancel={() => setEditing(null)}
            style={{ fontSize: "var(--fz-sm)", flex: 1 }}
            title="git mv: moves the working tree, updates .gitmodules, and stages the move"
          />
        </div>
      )}

      {removing === "confirm" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: "var(--fz-md)", flex: 1 }}>
            Remove this submodule? Its .gitmodules entry and working tree go
            away; the repository data under .git/modules is kept.
          </span>
          <Button variant="danger" disabled={busy} onClick={onConfirmRemove}>
            Remove
          </Button>
          <button disabled={busy} onClick={onCancelRemove}>
            Cancel
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
          {uninitialized ? (
            <ToolbarButton
              label={"Init & update"}
              title="git submodule update --init: register and check out this submodule"
              disabled={busy}
              onClick={onInitUpdate}
            />
          ) : (
            <>
              <ToolbarButton
                label="Open"
                title="Open as a repo tab"
                disabled={busy}
                onClick={onOpen}
              />
              <ToolbarButton
                label="Update"
                title="git submodule update: check out the recorded commit (detaches HEAD)"
                disabled={busy || !info.state.pointer_moved}
                onClick={onUpdate}
              />
              <ToolbarButton
                label="Pull latest"
                title="git submodule update --remote: fetch and integrate the tracked branch, then stage the pointer"
                disabled={busy}
                onClick={onPullLatest}
              />
              <ToolbarButton
                label="Fetch"
                title="git fetch inside this submodule"
                disabled={busy}
                onClick={onFetch}
              />
              <ToolbarButton
                label="Sync"
                title="git submodule sync: copy the .gitmodules URL into the local config and the submodule's origin"
                disabled={busy}
                onClick={onSync}
              />
              <ToolbarButton
                label="Set URL"
                title="Edit the submodule URL in place (auto-syncs)"
                disabled={busy}
                onClick={() => setEditing(editing === "url" ? null : "url")}
              />
              <ToolbarButton
                label="Set branch"
                title="Edit the tracked branch in place"
                disabled={busy}
                onClick={() => setEditing(editing === "branch" ? null : "branch")}
              />
              <ToolbarButton
                label="Move"
                title="Move the submodule to another path in place (git mv; stages the move)"
                disabled={busy}
                onClick={() => setEditing(editing === "path" ? null : "path")}
              />
              {info.head_branch === null && (
                <ToolbarButton
                  label="Branch here"
                  title="The submodule is on a detached HEAD - create a branch at the current commit so work cannot be lost"
                  disabled={busy}
                  onClick={() => setEditing(editing === "new-branch" ? null : "new-branch")}
                />
              )}
              {info.state.config_drift && (
                <ToolbarButton
                  label="Repair"
                  title="URL in .gitmodules and local config disagree - re-sync the registration (git submodule sync)"
                  disabled={busy}
                  onClick={onSync}
                />
              )}
            </>
          )}
          <ToolbarButton
            label="Remove"
            title="Remove the submodule (keeps its repository data under .git/modules)"
            disabled={busy}
            onClick={onRemove}
          />
        </div>
      )}
    </div>
  );
}

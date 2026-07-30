import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import {
  repoCreateTag,
  repoDeleteTag,
  repoDeleteRemoteTag,
  repoListRemotes,
  repoPushTag,
  repoRemoteTags,
  repoTags,
} from "../../lib/commands";
import { pickTagRemote, pushedTagNames } from "../../lib/tags";
import { notify } from "../../store/notifications";
import type { Remote, RemoteTag, TagInfo } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { RemoteIcon, TagIcon } from "../../icons";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { usePanelRunner } from "../shared/usePanelRunner";
import { ToolbarButton } from "../shared/ToolbarButton";
import { isRowBackgroundClick, jumpPanelsToCommit } from "../shared/jumpToCommit";
import { Button } from "../shared/buttons";
import { useConfirmDestructive, useSettingsStore } from "../../store/settings";
import { coerceRefsSortMode, sortRefs } from "../../lib/refSort";

// A tag mutation touches the tag list and the graph decorations.
const AFFECTED_DOMAINS = ["tags", "log"];

/**
 * Tags section — list local tags with their pushed state, create (optionally
 * annotated) tags at HEAD, push a tag to the remote, and delete tags.
 * Rendered as a pane inside the combined Refs panel (see `Refs/RefsPanel`),
 * which supplies the header — body-only.
 */
export function TagsSection() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();
  const confirmDestructive = useConfirmDestructive();

  const { data: tags = [], isFetching, refetch } = useQuery<TagInfo[]>({
    queryKey: [repo?.id, "tags"],
    queryFn: () => repoTags(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });
  const { data: remotes = [] } = useQuery<Remote[]>({
    queryKey: [repo?.id, "remotes"],
    queryFn: () => repoListRemotes(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });
  // Remote targeted by push / delete-on-remote / the pushed indicator.
  // Default is `pickTagRemote` (origin, else first); with multiple remotes a
  // selector overrides it. A stale selection (remote removed) falls back.
  const [remoteChoice, setRemoteChoice] = useState("");
  const tagRemote = useMemo(() => {
    if (remoteChoice && remotes.some((r) => r.name === remoteChoice)) return remoteChoice;
    return pickTagRemote(remotes);
  }, [remoteChoice, remotes]);
  const { data: remoteTags = [] } = useQuery<RemoteTag[]>({
    queryKey: [repo?.id, "remote-tags", tagRemote],
    queryFn: () => repoRemoteTags(repo!.id, tagRemote!, crypto.randomUUID()),
    enabled: !!repo && tagRemote !== null,
    staleTime: 300_000,
    retry: false,
  });
  const pushed = useMemo(() => pushedTagNames(tags, remoteTags), [tags, remoteTags]);

  // User-selected sort order (global setting); display order only.
  const sortMode = coerceRefsSortMode(useSettingsStore((s) => s.settings?.refs_sort_mode));
  const sortedTags = useMemo(
    () => sortRefs(tags, sortMode, (t) => t.name, (t) => t.created_at),
    [tags, sortMode],
  );

  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);

  const [error, setError] = useState<string | null>(null);
  const [createName, setCreateName] = useState("");
  const [createMsg, setCreateMsg] = useState("");
  // Pending delete confirmation: which tag, and whether it targets the remote
  // copy (local and remote deletion are separate actions, GitKraken-style).
  const [confirmDelete, setConfirmDelete] = useState<
    { name: string; remote: boolean } | null
  >(null);

  const { busy, run } = usePanelRunner({
    enabled: !!repo,
    onStart: () => setError(null),
    onSuccess: () => invalidateRepoDomains(queryClient, repo!.id, AFFECTED_DOMAINS),
    onError: (e) => setError(formatAppError(e)),
  });

  const doCreate = () =>
    run(async () => {
      const name = createName.trim();
      if (!name) return;
      await repoCreateTag(repo!.id, name, undefined, createMsg.trim() || undefined);
      setCreateName("");
      setCreateMsg("");
    });

  const doDelete = (name: string) =>
    run(async () => {
      await repoDeleteTag(repo!.id, name);
      setConfirmDelete(null);
    });

  const doDeleteRemote = (name: string) =>
    run(async () => {
      await repoDeleteRemoteTag(repo!.id, tagRemote!, name, crypto.randomUUID());
      notify.success(`Deleted tag '${name}' from ${tagRemote}`);
      setConfirmDelete(null);
      invalidateRepoDomains(queryClient, repo!.id, ["remote-tags"]);
    });

  const doPush = (name: string) =>
    run(async () => {
      await repoPushTag(repo!.id, tagRemote!, name, crypto.randomUUID());
      notify.success(`Pushed tag '${name}' to ${tagRemote}`);
      invalidateRepoDomains(queryClient, repo!.id, ["remote-tags"]);
    });

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
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        {error && (
          <pre className="legit-error" style={{ margin: 0, fontSize: "var(--fz-md)" }}>
            {error}
          </pre>
        )}

        {remotes.length > 1 && (
          <label
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fz-md)" }}
          >
            <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
              Remote
            </span>
            <select
              value={tagRemote ?? ""}
              onChange={(e) => setRemoteChoice(e.target.value)}
              style={{ flex: 1 }}
              title="Remote used for pushing tags, deleting remote tags, and the pushed indicator"
            >
              {remotes.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {tags.length === 0 ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No tags.
          </span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {sortedTags.map((t) => (
              <TagRow
                key={t.name}
                tag={t}
                pushed={pushed.has(t.name)}
                remote={tagRemote}
                busy={busy}
                confirming={confirmDelete?.name === t.name ? confirmDelete.remote ? "remote" : "local" : null}
                onPush={() => doPush(t.name)}
                onOpenDelete={(remoteSide) => {
                  setError(null);
                  if (confirmDestructive) setConfirmDelete({ name: t.name, remote: remoteSide });
                  else void (remoteSide ? doDeleteRemote(t.name) : doDelete(t.name));
                }}
                onConfirmDelete={(remoteSide) =>
                  remoteSide ? doDeleteRemote(t.name) : doDelete(t.name)
                }
                onCancelDelete={() => setConfirmDelete(null)}
              />
            ))}
          </div>
        )}

        <div
          style={{
            borderTop: "1px solid var(--panel-border)",
            paddingTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <span
            style={{
              fontSize: "var(--fz-sm)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "var(--subtle-fg)",
            }}
          >
            New tag at HEAD
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doCreate()}
              placeholder="name"
              style={{ fontSize: "var(--fz-md)", fontFamily: "monospace", flex: 1, minWidth: 0 }}
            />
            <Button variant="primary" disabled={busy || !createName.trim()} onClick={doCreate}>
              Tag
            </Button>
          </div>
          <input
            value={createMsg}
            onChange={(e) => setCreateMsg(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doCreate()}
            placeholder="message (optional — creates an annotated tag)"
            style={{ fontSize: "var(--fz-md)" }}
          />
        </div>
      </div>
    </div>
  );
}

function TagRow({
  tag,
  pushed,
  remote,
  busy,
  confirming,
  onPush,
  onOpenDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  tag: TagInfo;
  pushed: boolean;
  remote: string | null;
  busy: boolean;
  /** Which delete is awaiting confirmation, if any. */
  confirming: "local" | "remote" | null;
  onPush: () => void;
  onOpenDelete: (remoteSide: boolean) => void;
  onConfirmDelete: (remoteSide: boolean) => void;
  onCancelDelete: () => void;
}) {
  return (
    <div
      onClick={(e) => {
        // Background click = show the tagged commit in the graph; not while
        // the delete confirmation is open, and never for the row's buttons.
        if (confirming === null && isRowBackgroundClick(e.target)) {
          jumpPanelsToCommit(tag.target_sha);
        }
      }}
      style={{
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--ref-tag-fg)", flexShrink: 0, display: "inline-flex" }}>
          <TagIcon />
        </span>
        <span
          style={{
            fontSize: "var(--fz-md)",
            fontFamily: "monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={tag.name}
        >
          {tag.name}
        </span>
        {pushed && (
          <span
            title={`Pushed to ${remote}`}
            style={{ color: "var(--ref-remote-fg)", flexShrink: 0, display: "inline-flex" }}
          >
            <RemoteIcon />
          </span>
        )}
        {tag.message && (
          <span
            className="legit-subtle"
            style={{
              fontSize: "var(--fz-sm)",
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={tag.message}
          >
            {tag.message}
          </span>
        )}
        <span
          className="legit-subtle"
          style={{ fontSize: "var(--fz-sm)", fontFamily: "monospace", marginLeft: "auto", flexShrink: 0 }}
          title={tag.target_sha}
        >
          {tag.target_sha.slice(0, 8)}
        </span>
      </div>

      {confirming !== null ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: "var(--fz-md)", flex: 1 }}>
            {confirming === "remote"
              ? `Delete this tag from ${remote}?`
              : "Delete this tag locally?"}
          </span>
          <Button variant="danger" disabled={busy} onClick={() => onConfirmDelete(confirming === "remote")}>
            Delete
          </Button>
          <button disabled={busy} onClick={onCancelDelete}>
            Cancel
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <ToolbarButton
            label={pushed ? "Pushed" : remote ? `Push to ${remote}` : "Push"}
            title={
              pushed
                ? `Already on ${remote} with the same target`
                : remote === null
                  ? "No remote configured"
                  : tag.target_on_remote
                    ? `Push tag to ${remote}`
                    : "The tagged commit is not on the remote - push its branch first"
            }
            disabled={busy || pushed || remote === null || !tag.target_on_remote}
            onClick={onPush}
          />
          <ToolbarButton label="Delete" disabled={busy} onClick={() => onOpenDelete(false)} />
          {pushed && remote !== null && (
            <ToolbarButton
              label={`Delete on ${remote}`}
              title={`Delete the tag on ${remote} — the local tag stays`}
              disabled={busy}
              onClick={() => onOpenDelete(true)}
            />
          )}
        </div>
      )}
    </div>
  );
}

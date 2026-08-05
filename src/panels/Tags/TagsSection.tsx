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
import { autoPushTagAfterCreate } from "../../lib/autoPushTags";
import { notify } from "../../store/notifications";
import { confirmDialog } from "../../store/confirm";
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

  const [createName, setCreateName] = useState("");
  const [createMsg, setCreateMsg] = useState("");

  const { busy, run } = usePanelRunner({
    enabled: !!repo,
    onSuccess: () => invalidateRepoDomains(queryClient, repo!.id, AFFECTED_DOMAINS),
    onError: (e) => notify.error(formatAppError(e)),
  });

  const doCreate = () =>
    run(async () => {
      const name = createName.trim();
      if (!name) return;
      await repoCreateTag(repo!.id, name, undefined, createMsg.trim() || undefined);
      setCreateName("");
      setCreateMsg("");
      // Create-time auto-push trigger (gated on the setting inside).
      void autoPushTagAfterCreate(queryClient, repo!.id, name);
    });

  const doDelete = (name: string) => run(() => repoDeleteTag(repo!.id, name));

  const doDeleteRemote = (name: string) =>
    run(async () => {
      await repoDeleteRemoteTag(repo!.id, tagRemote!, name, crypto.randomUUID());
      notify.success(`Deleted tag '${name}' from ${tagRemote}`);
      invalidateRepoDomains(queryClient, repo!.id, ["remote-tags"]);
    });

  // Central confirmation dialog: local and remote deletion are separate
  // actions (GitKraken-style). Gated by the global destructive-confirm
  // setting; when off, delete runs immediately.
  const requestDelete = async (name: string, remoteSide: boolean) => {
    if (confirmDestructive) {
      const ok = await confirmDialog({
        title: remoteSide ? "Delete remote tag" : "Delete tag",
        message: remoteSide
          ? `Deletes the tag from ${tagRemote}. Local copies (yours and other clones') stay.`
          : "Deletes the local tag. A copy already pushed to a remote stays there.",
        detail: name,
        confirmLabel: remoteSide ? `Delete from ${tagRemote}` : "Delete tag",
      });
      if (!ok) return;
    }
    void (remoteSide ? doDeleteRemote(name) : doDelete(name));
  };

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
                onPush={() => doPush(t.name)}
                onOpenDelete={(remoteSide) => void requestDelete(t.name, remoteSide)}
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
  onPush,
  onOpenDelete,
}: {
  tag: TagInfo;
  pushed: boolean;
  remote: string | null;
  busy: boolean;
  onPush: () => void;
  onOpenDelete: (remoteSide: boolean) => void;
}) {
  return (
    <div
      onClick={(e) => {
        // Background click = show the tagged commit in the graph; never for
        // the row's buttons.
        if (isRowBackgroundClick(e.target)) {
          jumpPanelsToCommit(tag.target_sha);
        }
      }}
      style={{
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        padding: "8px 10px",
        // One line when it fits: the info group and the action strip are
        // siblings in a wrapping row, so the actions drop to their own line
        // only when the pane is too narrow (the info group's minWidth is the
        // wrap threshold).
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px 8px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flex: "1 1 auto",
          minWidth: "min(100%, 14em)",
        }}
      >
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

      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap", marginLeft: "auto" }}>
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
    </div>
  );
}

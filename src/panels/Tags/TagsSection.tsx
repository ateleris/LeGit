import { useCallback, useMemo, useState } from "react";
import {
  createTag,
  deleteRemoteTag,
  deleteTag,
  pushTag,
  type RefActionContext,
} from "../../lib/refActions";
import { confirmDestructiveAction } from "../../store/confirm";
import { useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import { pushedTagNames, resolveTagRemote } from "../../lib/tags";
import { notify } from "../../store/notifications";
import type { TagInfo } from "../../lib/types";
import { formatAppError } from "../../lib/errors";
import { RemoteIcon, TagIcon } from "../../icons";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { ShrinkingPathText } from "../shared/ShrinkingPathText";
import { splitRefName } from "../shared/pathSplit";
import { RefFilterRow } from "../shared/RefFilterRow";
import { matchesRefFilter } from "../../lib/refFilter";
import { usePanelRunner } from "../shared/usePanelRunner";
import { ToolbarButton } from "../shared/ToolbarButton";
import { isRowBackgroundClick, jumpPanelsToCommit } from "../shared/jumpToCommit";
import { Button } from "../shared/buttons";
import { useSettingsStore } from "../../store/settings";
import { useTagRemoteChoice, useTagRemoteStore } from "../../store/tagRemote";
import { resolveTagsSortMode, sortRefs } from "../../lib/refSort";
import { useRemoteTags, useRemotes, useTags } from "../../lib/queries/useRepoQueries";

/**
 * Tags section — list local tags with their pushed state, create (optionally
 * annotated) tags at HEAD, push a tag to the remote, and delete tags.
 * Rendered as a pane inside the combined Refs panel (see `Refs/RefsPanel`),
 * which supplies the header — body-only.
 */
export function TagsSection() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();

  const { data: tags = [], isFetching, refetch } = useTags(repo?.id);
  const { data: remotes = [] } = useRemotes(repo?.id);
  // Remote targeted by push / delete-on-remote / the pushed indicator.
  // Default is `pickTagRemote` (origin, else first); with multiple remotes a
  // selector overrides it. A stale selection (remote removed) falls back.
  // The choice lives in a shared per-repo store so the Commits panel's tag
  // indicators resolve the SAME remote (and share the remote-tags query).
  const remoteChoice = useTagRemoteChoice(repo?.id);
  const setRemoteChoice = useTagRemoteStore((s) => s.setChoice);
  const tagRemote = useMemo(
    () => resolveTagRemote(remoteChoice, remotes),
    [remoteChoice, remotes],
  );
  const { data: remoteTags = [] } = useRemoteTags(repo?.id, tagRemote);
  const pushed = useMemo(() => pushedTagNames(tags, remoteTags), [tags, remoteTags]);

  // User-selected sort order (own setting, inheriting the branches mode
  // until set); display order only.
  const sortMode = useSettingsStore((s) =>
    resolveTagsSortMode(s.settings?.tags_sort_mode, s.settings?.refs_sort_mode),
  );
  const sortedTags = useMemo(
    () => sortRefs(tags, sortMode, (t) => t.name, (t) => t.created_at),
    [tags, sortMode],
  );
  const [filterQuery, setFilterQuery] = useState("");
  const filteredTags = useMemo(
    () => sortedTags.filter((t) => matchesRefFilter(t.name, filterQuery)),
    [sortedTags, filterQuery],
  );

  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);

  const [createName, setCreateName] = useState("");
  const [createMsg, setCreateMsg] = useState("");

  // The shared actions report their own errors and refresh their domains;
  // the runner adds the re-entry guard and delayed busy state.
  const { busy, run } = usePanelRunner({
    enabled: !!repo,
    onError: (e) => notify.error(formatAppError(e)),
  });
  const guarded = async (action: (c: RefActionContext) => Promise<boolean>) => {
    if (!repo) return false;
    let ok = false;
    await run(async () => {
      ok = await action({ queryClient, repo });
    });
    return ok;
  };

  const doCreate = async () => {
    const name = createName.trim();
    if (!name) return;
    if (await guarded((c) => createTag(c, name, undefined, createMsg.trim() || undefined))) {
      setCreateName("");
      setCreateMsg("");
    }
  };

  // Local and remote deletion are separate actions (GitKraken-style).
  const requestDelete = async (name: string, remoteSide: boolean) => {
    const ok = await confirmDestructiveAction({
      title: remoteSide ? "Delete remote tag" : "Delete tag",
      message: remoteSide
        ? `Deletes the tag from ${tagRemote}. Local copies (yours and other clones') stay.`
        : "Deletes the local tag. A copy already pushed to a remote stays there.",
      detail: name,
      confirmLabel: remoteSide ? `Delete from ${tagRemote}` : "Delete tag",
    });
    if (!ok) return;
    void guarded((c) => (remoteSide ? deleteRemoteTag(c, name, tagRemote!) : deleteTag(c, name)));
  };

  const doPush = (name: string) => guarded((c) => pushTag(c, name, tagRemote!));

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
        style={{ display: "flex", flexDirection: "column", gap: "0.833em" }}
      >
        {remotes.length > 1 && (
          <label
            style={{ display: "flex", alignItems: "center", gap: "0.5em", fontSize: "var(--fz-md)" }}
          >
            <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
              Remote
            </span>
            <select
              value={tagRemote ?? ""}
              onChange={(e) => setRemoteChoice(repo.id, e.target.value)}
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

        {tags.length > 0 && (
          <RefFilterRow query={filterQuery} onQueryChange={setFilterQuery} sortScope="tags" label="tags" />
        )}
        {tags.length === 0 ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No tags.
          </span>
        ) : filteredTags.length === 0 ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No matches.
          </span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5em" }}>
            {filteredTags.map((t) => (
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
            paddingTop: "0.833em",
            display: "flex",
            flexDirection: "column",
            gap: "0.5em",
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
          <div style={{ display: "flex", gap: "0.5em", flexWrap: "wrap" }}>
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
        padding: "0.667em 0.833em",
        // One line when it fits: the info group and the action strip are
        // siblings in a wrapping row, so the actions drop to their own line
        // only when the pane is too narrow (the info group's minWidth is the
        // wrap threshold).
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "0.5em 0.667em",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.667em",
          flex: "1 1 auto",
          minWidth: "min(100%, 14em)",
        }}
      >
        <span style={{ color: "var(--ref-tag-fg)", flexShrink: 0, display: "inline-flex" }}>
          <TagIcon />
        </span>
        <ShrinkingPathText
          {...splitRefName(tag.name)}
          style={{ fontSize: "var(--fz-md)", fontFamily: "monospace" }}
          title={tag.name}
        />
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

      <div style={{ display: "flex", gap: "0.5em", justifyContent: "flex-end", flexWrap: "wrap", marginLeft: "auto" }}>
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

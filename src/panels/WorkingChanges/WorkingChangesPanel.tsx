import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useSettingsStore } from "../../store/settings";
import { usePanelActiveEffect, usePanelFocusEffect } from "../PanelApiContext";
import { repoCommit, repoDiscard, repoStage, repoStatus, repoUnstage } from "../../lib/commands";
import type { FileStatus } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { FileTree } from "../shared/FileTree/FileTree";
import { useFileRowMetrics } from "../shared/FileTree/useFileRowMetrics";
import type { FileTreeEntry, ViewMode } from "../shared/FileTree/buildTree";
import { StageIcon, UnstageIcon, TrashIcon } from "../../icons";
import { PanelContextMenuProvider, type BaselineEntry } from "../Commits/menu/PanelContextMenu";
import { MenuItem } from "../Commits/menu/primitives";

const toEntry = (s: FileStatus): FileTreeEntry => ({ path: s.path, change: s.state });

/**
 * Which list a selection lives in. A partially-staged file appears in BOTH
 * sections with the same path, so a path alone can't identify one entry —
 * selection is keyed by (section, path). Exactly one entry is selected across
 * both lists. (Ctrl/Shift multi-select would later widen this to a set.)
 */
type Section = "staged" | "unstaged";
interface Selection {
  section: Section;
  path: string;
}

/** A pending discard confirmation: which paths and a human label. */
interface DiscardRequest {
  paths: string[];
  label: string;
}

/**
 * Working Changes panel — Staged / Unstaged sections over the working tree,
 * with per-file and bulk stage/unstage/discard and a commit box. Summoned into
 * the shared side region when the uncommitted-changes row is selected.
 */
export function WorkingChangesPanel() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();

  const viewMode: ViewMode =
    useSettingsStore((s) => s.settings?.changed_files_view_mode) === "tree" ? "tree" : "flat";
  const setViewMode = useSettingsStore((s) => s.setChangedFilesViewMode);
  const { rowHeight, iconSize } = useFileRowMetrics();

  const [message, setMessage] = useState("");
  // The single selected entry across both sections (the future diff target).
  // Keyed by (section, path) so a partially-staged file — present in both
  // lists under one path — is only ever highlighted in one of them.
  const [selected, setSelected] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DiscardRequest | null>(null);

  const {
    data: status = [],
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery<FileStatus[]>({
    queryKey: [repo?.id, "status"],
    queryFn: () => repoStatus(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });

  // Refresh whenever the panel is focused or swapped/summoned into view, so the
  // working tree is re-read after edits made while it wasn't the shown panel.
  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);
  usePanelActiveEffect(reload);

  const staged = useMemo(() => status.filter((s) => s.staged).map(toEntry), [status]);
  const unstaged = useMemo(() => status.filter((s) => !s.staged).map(toEntry), [status]);

  const refresh = useCallback(() => {
    if (!repo) return;
    queryClient.invalidateQueries({ queryKey: [repo.id, "status"] });
    queryClient.invalidateQueries({ queryKey: [repo.id, "log"] });
    queryClient.invalidateQueries({ queryKey: [repo.id, "branches"] });
  }, [repo, queryClient]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (!repo) return;
      setBusy(true);
      setActionError(null);
      try {
        await fn();
        refresh();
      } catch (e) {
        setActionError(formatAppError(e));
      } finally {
        setBusy(false);
      }
    },
    [repo, refresh],
  );

  // Staging/unstaging moves a file between the two lists; keep it selected by
  // flipping the selection's section to follow it. Discarding removes the file
  // outright, so the selection (if it pointed there) is cleared.
  const stage = (paths: string[]) =>
    run(async () => {
      await repoStage(repo!.id, paths);
      setSelected((sel) =>
        sel?.section === "unstaged" && paths.includes(sel.path)
          ? { section: "staged", path: sel.path }
          : sel,
      );
    });
  const unstage = (paths: string[]) =>
    run(async () => {
      await repoUnstage(repo!.id, paths);
      setSelected((sel) =>
        sel?.section === "staged" && paths.includes(sel.path)
          ? { section: "unstaged", path: sel.path }
          : sel,
      );
    });
  const doDiscard = (paths: string[]) =>
    run(async () => {
      await repoDiscard(repo!.id, paths);
      setSelected((sel) =>
        sel?.section === "unstaged" && paths.includes(sel.path) ? null : sel,
      );
    });
  const commit = () =>
    run(async () => {
      await repoCommit(repo!.id, message);
      setMessage("");
    });

  // Confirm before discarding (destructive); then run it.
  const requestDiscard = (paths: string[], label: string) => setConfirm({ paths, label });
  const confirmDiscard = () => {
    if (confirm) doDiscard(confirm.paths);
    setConfirm(null);
  };

  if (!repo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">No repo open.</span>
        </div>
      </div>
    );
  }

  const canCommit = staged.length > 0 && message.trim().length > 0 && !busy;

  const baseline: BaselineEntry[] = [{ label: "Refresh", onClick: refresh, disabled: busy }];

  return (
    <PanelContextMenuProvider baseline={baseline}>
      {({ openMenu, closeMenu }) => (
        <div
          className="legit-panel"
          style={{ display: "flex", flexDirection: "column" }}
          onContextMenu={(e) => openMenu(e)}
        >
      <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex" }}>
          <button onClick={() => setViewMode("tree")} aria-pressed={viewMode === "tree"} style={segStyle(viewMode === "tree", "left")}>
            Tree
          </button>
          <button onClick={() => setViewMode("flat")} aria-pressed={viewMode === "flat"} style={segStyle(viewMode === "flat", "right")}>
            List
          </button>
        </div>
        <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>Working changes</span>
        {isFetching && (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", marginLeft: "auto" }}>Loading…</span>
        )}
      </div>

      {(isError || actionError) && (
        <pre className="legit-error" style={{ margin: "8px 12px", fontSize: "var(--fz-md)" }}>
          {actionError ?? formatAppError(error)}
        </pre>
      )}

      {confirm && (
        <div
          style={{
            margin: "8px 12px",
            padding: "8px 10px",
            border: "1px solid var(--panel-border)",
            borderRadius: 4,
            background: "var(--button-hover-bg)",
          }}
        >
          <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
            Discard changes to <strong>{confirm.label}</strong>? This cannot be undone.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="danger" disabled={busy} onClick={confirmDiscard}>Discard</button>
            <button disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}

      {status.length === 0 ? (
        <div className="legit-panel__body">
          <span className="legit-subtle">No changes.</span>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Section
            title="Unstaged"
            count={unstaged.length}
            actions={
              unstaged.length > 0 && (
                <>
                  <TextButton disabled={busy} onClick={() => requestDiscard(unstaged.map((f) => f.path), "all unstaged files")}>
                    Discard all
                  </TextButton>
                  <TextButton disabled={busy} onClick={() => stage(unstaged.map((f) => f.path))}>
                    Stage all
                  </TextButton>
                </>
              )
            }
          >
            <FileTree
              files={unstaged}
              viewMode={viewMode}
              selectedPath={selected?.section === "unstaged" ? selected.path : null}
              onSelect={(f) => setSelected({ section: "unstaged", path: f.path })}
              rowHeight={rowHeight}
              iconSize={iconSize}
              onContextMenu={(f, e) =>
                openMenu(
                  e,
                  <>
                    <MenuItem onClick={() => { stage([f.path]); closeMenu(); }}>Stage</MenuItem>
                    <MenuItem
                      onClick={() => { requestDiscard([f.path], f.path); closeMenu(); }}
                    >
                      {f.change === "Untracked" ? "Delete file" : "Discard changes"}
                    </MenuItem>
                  </>,
                )
              }
              renderActions={(f) => (
                <>
                  <IconButton
                    title={f.change === "Untracked" ? "Delete file" : "Discard changes"}
                    disabled={busy}
                    onClick={() => requestDiscard([f.path], f.path)}
                  >
                    <TrashIcon />
                  </IconButton>
                  <IconButton title="Stage" disabled={busy} onClick={() => stage([f.path])}>
                    <StageIcon />
                  </IconButton>
                </>
              )}
            />
          </Section>

          <Section
            title="Staged"
            count={staged.length}
            actions={
              staged.length > 0 && (
                <TextButton disabled={busy} onClick={() => unstage(staged.map((f) => f.path))}>
                  Unstage all
                </TextButton>
              )
            }
          >
            <FileTree
              files={staged}
              viewMode={viewMode}
              selectedPath={selected?.section === "staged" ? selected.path : null}
              onSelect={(f) => setSelected({ section: "staged", path: f.path })}
              rowHeight={rowHeight}
              iconSize={iconSize}
              onContextMenu={(f, e) =>
                openMenu(
                  e,
                  <MenuItem onClick={() => { unstage([f.path]); closeMenu(); }}>Unstage</MenuItem>,
                )
              }
              renderActions={(f) => (
                <IconButton title="Unstage" disabled={busy} onClick={() => unstage([f.path])}>
                  <UnstageIcon />
                </IconButton>
              )}
            />
          </Section>

          <div style={{ flexShrink: 0, borderTop: "1px solid var(--panel-border)", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message"
              rows={3}
              style={{ resize: "vertical", fontFamily: "inherit", fontSize: "var(--fz-md)" }}
            />
            <button className="primary" disabled={!canCommit} onClick={commit} style={{ alignSelf: "flex-start" }}>
              Commit {staged.length > 0 ? `(${staged.length})` : ""}
            </button>
          </div>
        </div>
      )}
        </div>
      )}
    </PanelContextMenuProvider>
  );
}

function Section({
  title,
  count,
  actions,
  children,
}: {
  title: string;
  count: number;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          fontSize: "var(--fz-sm)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--subtle-fg)",
          borderBottom: "1px solid var(--panel-border)",
        }}
      >
        <span>{title}</span>
        <span>{count}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, textTransform: "none", letterSpacing: 0 }}>
          {actions}
        </span>
      </div>
      {children}
    </div>
  );
}

function TextButton({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      style={{
        background: "transparent",
        border: "none",
        color: "var(--accent)",
        cursor: "pointer",
        fontSize: "var(--fz-sm)",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function IconButton({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        color: "var(--subtle-fg)",
        cursor: "pointer",
        padding: "0 3px",
        fontSize: "var(--fz-lg)",
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}

function segStyle(active: boolean, side: "left" | "right"): React.CSSProperties {
  return {
    fontSize: "var(--fz-sm)",
    padding: "2px 8px",
    border: "1px solid var(--panel-border)",
    borderRadius: side === "left" ? "3px 0 0 3px" : "0 3px 3px 0",
    marginLeft: side === "right" ? -1 : 0,
    background: active ? "var(--button-active-bg, rgba(255,255,255,0.12))" : "transparent",
    color: "var(--panel-fg)",
    cursor: "pointer",
  };
}

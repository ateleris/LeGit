import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useSettingsStore } from "../../store/settings";
import { usePanelActiveEffect, usePanelFocusEffect } from "../PanelApiContext";
import { repoCommit, repoDiscard, repoLog, repoStage, repoStatus, repoUnstage } from "../../lib/commands";
import type { Commit, DiffRequest, DiffSource, FileStatus } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { useSummonStore } from "../../store/summon";
import { FileTree } from "../shared/FileTree/FileTree";
import { useFileRowMetrics } from "../shared/FileTree/useFileRowMetrics";
import type { FileTreeEntry, ViewMode } from "../shared/FileTree/buildTree";
import { StageIcon, UnstageIcon } from "../../icons";
import { PanelContextMenuProvider, type BaselineEntry } from "../Commits/menu/PanelContextMenu";
import { MenuItem } from "../Commits/menu/primitives";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";

const toEntry = (s: FileStatus): FileTreeEntry => ({ path: s.path, change: s.state });

/** "1 file" / "3 files" for menu labels. */
const fileCountLabel = (n: number): string => `${n} ${n === 1 ? "file" : "files"}`;

/**
 * Selection follow-through when `paths` move from one section to another (e.g.
 * staging). Generalises the single-select rule to a set: if none of the
 * selection moved, leave it; if all of it moved, follow it into `to`; if only
 * some moved, keep the not-moved paths in `from` (selection lives in one list).
 */
function moveSelection(
  sel: Selection | null,
  from: Section,
  to: Section,
  paths: string[],
): Selection | null {
  if (sel?.section !== from) return sel;
  const remaining = sel.paths.filter((p) => !paths.includes(p));
  if (remaining.length === sel.paths.length) return sel;
  if (remaining.length === 0) return { section: to, paths: sel.paths };
  return { section: from, paths: remaining };
}

/** Drop discarded `paths` from an unstaged selection; empty clears it. */
function dropSelection(sel: Selection | null, paths: string[]): Selection | null {
  if (sel?.section !== "unstaged") return sel;
  const remaining = sel.paths.filter((p) => !paths.includes(p));
  return remaining.length ? { section: "unstaged", paths: remaining } : null;
}

/**
 * Which list the selection lives in, plus the set of selected paths within it.
 * A partially-staged file appears in BOTH sections under the same path, so a
 * path alone can't identify an entry — the selection is scoped to one section.
 * Multi-select (Ctrl/Shift) is confined to a single list: selecting in one
 * section replaces any selection in the other, so the two lists never highlight
 * simultaneously.
 */
type Section = "staged" | "unstaged";
interface Selection {
  section: Section;
  paths: string[];
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
  // Whether discard actions prompt first (global setting, default on).
  const confirmDiscardEnabled = useSettingsStore((s) => s.settings?.confirm_discard ?? true);
  const setViewMode = useSettingsStore((s) => s.setChangedFilesViewMode);
  const { rowHeight, iconSize } = useFileRowMetrics();

  const [message, setMessage] = useState("");
  // When set, the commit rewrites HEAD (`git commit --amend`) instead of
  // creating a new commit. Reset after each successful commit.
  const [amend, setAmend] = useState(false);
  // The selected files, scoped to one section so the two lists never highlight
  // at once (a partially-staged file shares its path across both). Drives both
  // row highlighting and the bulk context-menu actions.
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

  // The latest commit — drives amend message prefill and the "has commits"
  // guard (amend is impossible on an unborn branch). Kept fresh because
  // refresh() invalidates the [repo.id, "log"] key after each commit.
  const { data: headLog = [] } = useQuery<Commit[]>({
    queryKey: [repo?.id, "log", "head1"],
    queryFn: () => repoLog(repo!.id, 1),
    enabled: !!repo,
    staleTime: 5_000,
  });
  const head = headLog[0] ?? null;

  // Refresh whenever the panel is focused or swapped/summoned into view, so the
  // working tree is re-read after edits made while it wasn't the shown panel.
  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);
  usePanelActiveEffect(reload);

  const staged = useMemo(() => status.filter((s) => s.staged).map(toEntry), [status]);
  const unstaged = useMemo(() => status.filter((s) => !s.staged).map(toEntry), [status]);

  // The highlighted set for each list — non-empty only for the active section.
  const unstagedSelected = useMemo(
    () => new Set(selected?.section === "unstaged" ? selected.paths : []),
    [selected],
  );
  const stagedSelected = useMemo(
    () => new Set(selected?.section === "staged" ? selected.paths : []),
    [selected],
  );

  // Resolve the targets for a right-click and align the selection like Windows
  // Explorer: right-clicking inside the current selection acts on the whole set
  // and leaves it intact; right-clicking outside it selects just that row
  // (deselecting the rest), then acts on it.
  // Open a file's diff in the Diff panel; the source side depends on which
  // section the row lives in.
  const openDiff = useCallback(
    (section: Section, path: string) => {
      if (!repo) return;
      const source: DiffSource =
        section === "staged" ? { kind: "working_staged" } : { kind: "working_unstaged" };
      const change = status.find((s) => s.path === path)?.state;
      useSummonStore
        .getState()
        .summon("diff", { repoId: repo.id, path, source, change } satisfies DiffRequest);
    },
    [repo, status],
  );

  // Track the selection and, when exactly one file is selected, show its diff.
  const onSelectSection = useCallback(
    (section: Section, paths: string[]) => {
      setSelected({ section, paths });
      if (paths.length === 1) openDiff(section, paths[0]);
    },
    [openDiff],
  );

  // After a stage/unstage/discard, keep an ALREADY-OPEN diff viewer in sync with
  // the resulting selection (without forcing it open). If a single file is
  // selected after the op, show its diff in the new section (e.g. staging flips
  // it from the unstaged to the staged diff). If a previously single-selected
  // file is now gone (discarded), clear the viewer. Otherwise leave it alone.
  const syncOpenDiff = useCallback(
    (prev: Selection | null, next: Selection | null) => {
      if (!repo) return;
      const store = useSummonStore.getState();
      if (next && next.paths.length === 1) {
        const source: DiffSource =
          next.section === "staged" ? { kind: "working_staged" } : { kind: "working_unstaged" };
        const change = status.find((s) => s.path === next.paths[0])?.state;
        store.notifyIfOpen("diff", {
          repoId: repo.id,
          path: next.paths[0],
          source,
          change,
        } satisfies DiffRequest);
        return;
      }
      if (prev && prev.paths.length === 1 && !next?.paths.includes(prev.paths[0])) {
        store.notifyIfOpen("diff", null);
      }
    },
    [repo, status],
  );

  const selectForMenu = (section: Section, path: string): string[] => {
    if (selected?.section === section && selected.paths.includes(path)) return selected.paths;
    setSelected({ section, paths: [path] });
    return [path];
  };

  const refresh = useCallback(() => {
    if (!repo) return;
    // Fires immediately (instant feedback) and records the time so the
    // filesystem watcher's redundant follow-up for the same action is dropped.
    // "diff" is included so an open Diff panel re-fetches: staging/unstaging a
    // file here changes which hunks appear in its working-tree diff.
    invalidateRepoDomains(queryClient, repo.id, ["status", "log", "branches", "diff"]);
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

  // Staging/unstaging moves files between the two lists; the selection follows
  // them (see moveSelection). Discarding removes them outright, so they're
  // dropped from the selection.
  const stage = (paths: string[]) =>
    run(async () => {
      await repoStage(repo!.id, paths);
      const next = moveSelection(selected, "unstaged", "staged", paths);
      setSelected(next);
      syncOpenDiff(selected, next);
    });
  const unstage = (paths: string[]) =>
    run(async () => {
      await repoUnstage(repo!.id, paths);
      const next = moveSelection(selected, "staged", "unstaged", paths);
      setSelected(next);
      syncOpenDiff(selected, next);
    });
  const doDiscard = (paths: string[]) =>
    run(async () => {
      await repoDiscard(repo!.id, paths);
      const next = dropSelection(selected, paths);
      setSelected(next);
      syncOpenDiff(selected, next);
    });
  const commit = () =>
    run(async () => {
      await repoCommit(repo!.id, message, amend);
      setMessage("");
      setAmend(false);
    });

  // Prefill HEAD's message when turning amend on, but only if the box is empty
  // so typed-but-uncommitted text is never clobbered.
  const toggleAmend = (next: boolean) => {
    setAmend(next);
    if (next && head && message.trim().length === 0) setMessage(head.message);
  };

  // Confirm before discarding (destructive); then run it. The label defaults to
  // the lone path, or "N files" for a bulk discard. When the confirmation
  // setting is off, discard runs immediately.
  const requestDiscard = (paths: string[], label?: string) => {
    if (!confirmDiscardEnabled) {
      doDiscard(paths);
      return;
    }
    setConfirm({ paths, label: label ?? (paths.length === 1 ? paths[0] : `${paths.length} files`) });
  };
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

  // Amend allows a message-only commit (no staged files required), but needs an
  // existing HEAD to rewrite.
  const canCommit = amend
    ? !!head && message.trim().length > 0 && !busy
    : staged.length > 0 && message.trim().length > 0 && !busy;

  const baseline: BaselineEntry[] = [{ label: "Refresh", onClick: refresh, disabled: busy }];

  return (
    <PanelContextMenuProvider baseline={baseline}>
      {({ openMenu, closeMenu }) => (
        <div
          className="legit-panel"
          style={{ display: "flex", flexDirection: "column" }}
          onContextMenu={(e) => openMenu(e)}
        >
      <PanelLoadingBar active={isFetching} />
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

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {status.length === 0 ? (
          <div className="legit-panel__body">
            <span className="legit-subtle">No changes.</span>
          </div>
        ) : (
        <>
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
              selectedPath={null}
              multiSelect
              selectedPaths={unstagedSelected}
              onSelectionChange={(paths) => onSelectSection("unstaged", paths)}
              rowHeight={rowHeight}
              iconSize={iconSize}
              onContextMenu={(f, e) => {
                const targets = selectForMenu("unstaged", f.path);
                const many = targets.length > 1;
                openMenu(
                  e,
                  <>
                    <MenuItem onClick={() => { stage(targets); closeMenu(); }}>
                      {many ? `Stage ${targets.length} selected` : "Stage"}
                    </MenuItem>
                    <MenuItem
                      onClick={() => { requestDiscard(targets); closeMenu(); }}
                    >
                      {many
                        ? `Discard ${targets.length} selected`
                        : f.change === "Untracked"
                        ? "Delete file"
                        : "Discard changes"}
                    </MenuItem>
                  </>,
                );
              }}
              renderActions={(f) => (
                <IconButton title="Stage" disabled={busy} onClick={() => stage([f.path])}>
                  <StageIcon />
                </IconButton>
              )}
              renderDirActions={(paths) => (
                <IconButton title={`Stage folder (${fileCountLabel(paths.length)})`} disabled={busy} onClick={() => stage(paths)}>
                  <StageIcon />
                </IconButton>
              )}
              onDirContextMenu={(paths, dir, e) =>
                openMenu(
                  e,
                  <>
                    <MenuItem onClick={() => { stage(paths); closeMenu(); }}>
                      Stage folder ({fileCountLabel(paths.length)})
                    </MenuItem>
                    <MenuItem onClick={() => { requestDiscard(paths, dir); closeMenu(); }}>
                      Discard folder ({fileCountLabel(paths.length)})
                    </MenuItem>
                  </>,
                )
              }
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
              selectedPath={null}
              multiSelect
              selectedPaths={stagedSelected}
              onSelectionChange={(paths) => onSelectSection("staged", paths)}
              rowHeight={rowHeight}
              iconSize={iconSize}
              onContextMenu={(f, e) => {
                const targets = selectForMenu("staged", f.path);
                openMenu(
                  e,
                  <MenuItem onClick={() => { unstage(targets); closeMenu(); }}>
                    {targets.length > 1 ? `Unstage ${targets.length} selected` : "Unstage"}
                  </MenuItem>,
                );
              }}
              renderActions={(f) => (
                <IconButton title="Unstage" disabled={busy} onClick={() => unstage([f.path])}>
                  <UnstageIcon />
                </IconButton>
              )}
              renderDirActions={(paths) => (
                <IconButton title={`Unstage folder (${fileCountLabel(paths.length)})`} disabled={busy} onClick={() => unstage(paths)}>
                  <UnstageIcon />
                </IconButton>
              )}
              onDirContextMenu={(paths, _dir, e) =>
                openMenu(
                  e,
                  <MenuItem onClick={() => { unstage(paths); closeMenu(); }}>
                    Unstage folder ({fileCountLabel(paths.length)})
                  </MenuItem>,
                )
              }
            />
          </Section>
        </>
        )}

        <div style={{ flexShrink: 0, borderTop: "1px solid var(--panel-border)", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message"
            rows={3}
            style={{ resize: "vertical", fontFamily: "inherit", fontSize: "var(--fz-md)" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fz-sm)", color: "var(--subtle-fg)" }}>
              <input type="checkbox" checked={amend} disabled={!head || busy} onChange={(e) => toggleAmend(e.target.checked)} />
              Amend last commit
            </label>
            <button className="primary" disabled={!canCommit} onClick={commit} style={{ marginLeft: "auto" }}>
              {amend ? "Amend" : "Commit"} {!amend && staged.length > 0 ? `(${staged.length})` : ""}
            </button>
          </div>
        </div>
      </div>
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

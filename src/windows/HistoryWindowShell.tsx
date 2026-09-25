// Root of a file-history window (`fh-*` labels): history list left, that
// file's commit diff right, pinned to the (repo, file, rev) it was summoned
// for. Deliberately disjointed from the main window - no selection crosses
// the boundary in either direction; only watcher freshness and theme/font
// broadcasts come through.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Orientation,
  SplitviewReact,
  type ISplitviewPanelProps,
  type SplitviewReadyEvent,
} from "dockview-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/commands";
import type { FileHistoryEntry, HistoryWindowContext } from "../lib/types";
import { formatAppError } from "../lib/errors";
import { copyText } from "../lib/clipboard";
import { toAbsolutePath } from "../lib/paths";
import { onGlobalSettingsChanged } from "../lib/events";
import { useRepoChangeListener } from "../lib/useRepoChangeListener";
import { revealAndSignal } from "../lib/windowReveal";
import { useSettingsStore, UI_FONT_SIZE_DEFAULT } from "../store/settings";
import { useConfirmDestructive } from "../store/settings";
import { bootUiPrefs, refreshUiPrefs } from "./uiPrefs";
import { notify } from "../store/notifications";
import {
  FILE_HISTORY_PAGE_SIZE,
  FileHistoryList,
  restoreFileAtRevision,
  useFileHistoryQuery,
} from "../panels/FileHistory/FileHistoryList";
import { CommitFileDiff } from "../panels/Diff/CommitFileDiff";
import { nextSelection } from "./historySelection";
import { ErrorBoundary } from "../panels/ErrorBoundary";
import { ConfirmDialogHost } from "../panels/ConfirmDialogHost";
import { Toasts } from "../panels/Toasts";
import { DevRibbon } from "../panels/DevRibbon";
import { PanelLoadingBar } from "../panels/shared/PanelLoadingBar";
import {
  PanelContextMenuProvider,
  useDestructiveMenuConfirm,
} from "../panels/shared/menu/PanelContextMenu";
import { MenuItem, Separator } from "../panels/shared/menu/primitives";

const SPLIT_KEY = "legit.historyWindow.split";

interface WindowState {
  ctx: HistoryWindowContext;
  entries: FileHistoryEntry[];
  busy: boolean;
  error: unknown;
  pageCount: number;
  setPageCount: (updater: (n: number) => number) => void;
  selected: FileHistoryEntry | null;
  setSelected: (entry: FileHistoryEntry) => void;
  renderMenu: (entry: FileHistoryEntry, closeMenu: () => void) => React.ReactNode;
}

// Splitview panes render through dockview's portals, which keep React
// context, so the shell shares its state with both panes this way.
const WindowStateContext = createContext<WindowState | null>(null);

/** Show the (hidden) window once the theme has painted - main-window pattern. */
async function revealOnceThemed() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
  try {
    await revealAndSignal(getCurrentWindow());
  } catch (e) {
    console.warn("failed to show the history window", e);
  }
}

export function HistoryWindowShell() {
  const [ctx, setCtx] = useState<HistoryWindowContext | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useRepoChangeListener();

  useEffect(() => {
    (async () => {
      try {
        try {
          await bootUiPrefs();
        } finally {
          void revealOnceThemed();
        }
        setCtx(await api.historyWindowContext());
      } catch (e) {
        setFailed(formatAppError(e));
      }
    })();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onGlobalSettingsChanged(() => {
      void refreshUiPrefs();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <ErrorBoundary>
      {failed !== null ? (
        <div className="legit-panel">
          <div className="legit-panel__body">
            <span className="legit-subtle">{failed}</span>
          </div>
        </div>
      ) : ctx !== null ? (
        <HistoryWindowBody ctx={ctx} />
      ) : null}
      <ConfirmDialogHost />
      <Toasts />
      <DevRibbon />
    </ErrorBoundary>
  );
}

export function HistoryWindowBody({ ctx }: { ctx: HistoryWindowContext }) {
  const [pageCount, setPageCount] = useState(1);
  const [selected, setSelected] = useState<FileHistoryEntry | null>(null);
  const { data, isFetching, isError, error } = useFileHistoryQuery(
    ctx.repo_id,
    ctx.path,
    ctx.rev,
    pageCount,
  );
  const entries = data ?? [];

  useEffect(() => {
    setSelected((cur) => nextSelection(entries, cur));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const renderMenu = useCallback(
    (entry: FileHistoryEntry, closeMenu: () => void) => (
      <WindowRowMenu
        entry={entry}
        closeMenu={closeMenu}
        repoId={ctx.repo_id}
        repoPath={ctx.repo_path}
      />
    ),
    [ctx.repo_id, ctx.repo_path],
  );

  const base = useSettingsStore((s) => s.settings?.ui_font_size ?? UI_FONT_SIZE_DEFAULT);
  const onReady = (e: SplitviewReadyEvent) => {
    let restored = false;
    try {
      const saved = localStorage.getItem(SPLIT_KEY);
      if (saved) {
        e.api.fromJSON(JSON.parse(saved));
        restored = true;
      }
    } catch {
      // Corrupt or unavailable snapshot: fall through to the defaults.
    }
    if (!restored) {
      e.api.addPanel({
        id: "list",
        component: "list",
        size: Math.round(base * 30),
        minimumSize: Math.round(base * 14),
      });
      e.api.addPanel({ id: "diff", component: "diff", minimumSize: Math.round(base * 20) });
    }
    e.api.onDidLayoutChange(() => {
      try {
        localStorage.setItem(SPLIT_KEY, JSON.stringify(e.api.toJSON()));
      } catch {
        // Storage unavailable (private mode): the split just is not remembered.
      }
    });
  };

  const state: WindowState = {
    ctx,
    entries,
    busy: isFetching,
    error: isError ? error : null,
    pageCount,
    setPageCount: (updater) => setPageCount(updater),
    selected,
    setSelected,
    renderMenu,
  };

  return (
    <WindowStateContext.Provider value={state}>
      {/* The theme class scopes the --dv-* -> token mapping (global.css) so
          the splitview sash resolves from tokens, not vendor defaults. */}
      <div className="dockview-theme-abyss" style={{ height: "100vh", width: "100vw" }}>
        <SplitviewReact
          orientation={Orientation.HORIZONTAL}
          components={PANE_COMPONENTS}
          onReady={onReady}
        />
      </div>
    </WindowStateContext.Provider>
  );
}

function WindowRowMenu({
  entry,
  closeMenu,
  repoId,
  repoPath,
}: {
  entry: FileHistoryEntry;
  closeMenu: () => void;
  repoId: string;
  repoPath: string;
}) {
  const queryClient = useQueryClient();
  const confirmDestructive = useConfirmDestructive();
  const destructiveMenuConfirm = useDestructiveMenuConfirm();
  const sha = entry.commit_id;
  // Same feedback as the shared CopyPathMenuSection (which needs the active
  // repo and so cannot render in the pinned-repo popup).
  const copy = (text: string) => {
    closeMenu();
    copyText(text).then(
      () => notify.success(`Copied ${text}`),
      (e) => notify.error(formatAppError(e)),
    );
  };
  return (
    <>
      <MenuItem onClick={() => copy(sha)}>Copy commit SHA</MenuItem>
      <Separator />
      <MenuItem onClick={() => copy(entry.path)}>Copy relative path</MenuItem>
      <MenuItem onClick={() => copy(toAbsolutePath(repoPath, entry.path))}>
        Copy absolute path
      </MenuItem>
      <MenuItem
        onClick={() => {
          void api
            .repoRevealPath(repoId, entry.path)
            .catch((e) => notify.error(formatAppError(e)));
          closeMenu();
        }}
      >
        Open in folder
      </MenuItem>
      <MenuItem
        onClick={() => {
          void api
            .repoOpenFileInEditor(repoId, entry.path)
            .catch((e) => notify.error(formatAppError(e)));
          closeMenu();
        }}
      >
        Open file
      </MenuItem>
      <MenuItem
        onClick={() => {
          void api
            .repoOpenFileAtRevisionInEditor(repoId, sha, entry.path)
            .catch((e) => notify.error(formatAppError(e)));
          closeMenu();
        }}
      >
        Open file at this commit
      </MenuItem>
      <Separator />
      <MenuItem
        onClick={() =>
          destructiveMenuConfirm(
            `Restore ${entry.path} to its content at ${sha.slice(0, 8)}?`,
            () => {
              closeMenu();
              void restoreFileAtRevision(queryClient, repoId, entry);
            },
          )
        }
      >
        {confirmDestructive ? "Restore file to this commit…" : "Restore file to this commit"}
      </MenuItem>
    </>
  );
}

function ListPane(_props: ISplitviewPanelProps) {
  const s = useContext(WindowStateContext);
  if (!s) return null;
  return (
    <PanelContextMenuProvider baseline={[]}>
      <div className="legit-panel" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <PanelLoadingBar active={s.busy} />
        <div className="legit-panel__body" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 0 }}>
          <FileHistoryList
            entries={s.entries}
            busy={s.busy}
            error={s.error}
            maybeMore={s.entries.length === FILE_HISTORY_PAGE_SIZE * s.pageCount}
            onLoadMore={() => s.setPageCount((n) => n + 1)}
            selectedSha={s.selected?.commit_id ?? null}
            onActivate={s.setSelected}
            renderMenu={s.renderMenu}
          />
        </div>
      </div>
    </PanelContextMenuProvider>
  );
}

function DiffPane(_props: ISplitviewPanelProps) {
  const s = useContext(WindowStateContext);
  if (!s) return null;
  if (!s.selected) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">Select a commit to see the file's diff.</span>
        </div>
      </div>
    );
  }
  return <CommitFileDiff repoId={s.ctx.repo_id} entry={s.selected} />;
}

const PANE_COMPONENTS: Record<string, React.FunctionComponent<ISplitviewPanelProps>> = {
  list: ListPane,
  diff: DiffPane,
};

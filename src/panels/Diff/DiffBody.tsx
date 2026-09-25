// The diff-rendering body shared by the Diff panel and the history window's
// commit diff: text/binary/image/submodule/LFS routing over DiffEditor.

import { useCallback } from "react";
import {
  useDestructiveMenuConfirm,
  usePanelContextMenu,
} from "../shared/menu/PanelContextMenu";
import { MenuItem, Separator } from "../shared/menu/primitives";
import {
  DiffEditor,
  type DiffEditorHandle,
  type DiffViewMode,
  type HunkAction,
  type LineActionOp,
} from "./DiffEditor";
import { lineActionLabel } from "./selectionModel";
import { SubmoduleDiffView, SubmoduleDirtyNotice } from "./SubmoduleDiffView";
import { ImageDiffView } from "./ImageDiffView";
import { binarySizes, isSvgPath } from "../../lib/previewSurface";
import { formatByteSize } from "../../lib/formatBytes";
import { LfsPointerNotice } from "../shared/LfsPointerNotice";
import { lfsPointerDiffSides } from "../../lib/lfsPointer";
import type { DiffEntry, DiffRequest, TextDiff } from "../../lib/types";

const ACTION_TITLE: Record<HunkAction, string> = {
  stage: "Stage chunk",
  unstage: "Unstage chunk",
  discard: "Discard chunk",
};

export function DiffBody({
  data,
  mode,
  actions,
  onAction,
  request,
  lineActionOp,
  onLineAction,
  editable,
  dirty,
  onDirty,
  onSaveRequest,
  editorRef,
  rebuildKey,
  onExpandHunk,
  trailingExpander,
  syntaxPath,
}: {
  data: DiffEntry | undefined;
  mode: DiffViewMode;
  actions: HunkAction[];
  onAction: (hunkIndex: number, action: HunkAction) => void;
  request: DiffRequest;
  lineActionOp: LineActionOp;
  onLineAction: (hunkIndex: number, lineIndices: number[], action: HunkAction) => void;
  editable: boolean;
  dirty: boolean;
  onDirty: () => void;
  onSaveRequest: () => void;
  editorRef: React.MutableRefObject<DiffEditorHandle | null>;
  rebuildKey: number;
  onExpandHunk?: (hunkIndex: number, dir: "up" | "down") => void;
  trailingExpander?: boolean;
  syntaxPath: string | null;
}) {
  const { openMenu, closeMenu } = usePanelContextMenu();
  const destructiveMenuConfirm = useDestructiveMenuConfirm();

  // Run a menu entry's action; discard is destructive, so it takes the
  // standard inline-confirm takeover unless the global setting is off.
  const runMenuAction = useCallback(
    (action: HunkAction, question: string, run: () => void) => {
      const go = () => {
        run();
        closeMenu();
      };
      if (action === "discard") destructiveMenuConfirm(question, go);
      else go();
    },
    [destructiveMenuConfirm, closeMenu]
  );

  const onContextMenu = useCallback(
    (
      hunkIndex: number,
      lineIndex: number | null,
      event: MouseEvent,
      selectedLines: number[] | null
    ) => {
      // Line entries act on the selection when the click landed inside one,
      // else on the clicked changed line (may be neither, e.g. a bare
      // context line - then only the chunk entries show).
      const lines = selectedLines ?? (lineIndex != null ? [lineIndex] : null);
      const section = (
        <>
          {lines !== null &&
            actions.map((a) => (
              <MenuItem
                key={`line-${a}`}
                onClick={() =>
                  runMenuAction(a, `${lineActionLabel(a, lines.length)}?`, () =>
                    onLineAction(hunkIndex, lines, a)
                  )
                }
              >
                {lineActionLabel(a, lines.length)}
              </MenuItem>
            ))}
          {lines !== null && <Separator />}
          {actions.map((a) => (
            <MenuItem
              key={a}
              onClick={() =>
                runMenuAction(a, `${ACTION_TITLE[a]}?`, () => onAction(hunkIndex, a))
              }
            >
              {ACTION_TITLE[a]}
            </MenuItem>
          ))}
        </>
      );
      openMenu(event as unknown as React.MouseEvent, section);
    },
    [actions, onAction, onLineAction, openMenu, runMenuAction]
  );

  // A dirty-inside submodule has no superproject diff (unmoved pointer, and
  // untracked-only dirt yields empty diff output) - render the explanatory
  // notice from the known state instead of whatever the diff text parsed to.
  if (request.change === "SubmoduleDirty") {
    return <SubmoduleDirtyNotice repoId={request.repoId} path={request.path} />;
  }

  if (!data) return null;

  if ("Binary" in data) {
    // Image preview when at least one side decodes as an image; otherwise
    // the plain placeholder, enriched with the sizes the preview calls
    // returned (BinaryDiff itself never carries sizes).
    return (
      <ImageDiffView
        repoId={request.repoId}
        source={request.source}
        path={request.path}
        oldPath={request.oldPath ?? null}
        fallback={(o, n) => {
          const sizes = binarySizes(o, n);
          return (
            <div className="legit-panel__body">
              <span className="legit-subtle">
                Binary file{sizes ? ` (${sizes})` : ""}, no preview available.
              </span>
            </div>
          );
        }}
      />
    );
  }
  if ("Submodule" in data) {
    return <SubmoduleDiffView repoId={request.repoId} change={data.Submodule} />;
  }

  // The whole text-diff rendering, as a function so the SVG image branch
  // below can use it as its no-image fallback.
  const renderTextDiff = (text: TextDiff): React.ReactNode => {
  if (text.hunks.length === 0) {
    // A rename/copy with no content change has no hunks - say so explicitly
    // rather than the bare "No changes".
    const isRename = request.change === "Renamed" || request.change === "Copied";
    return (
      <div className="legit-panel__body">
        <span className="legit-subtle">
          {isRename
            ? `Renamed${request.oldPath ? ` from ${request.oldPath}` : ""} → ${request.path} (no content changes)`
            : "No changes."}
        </span>
      </div>
    );
  }

  // A pointer-to-pointer change (LFS file modified/added/removed) reads as
  // 3 lines of pointer noise as a text diff - render the LFS notice instead.
  // An LFS-to-text conversion deliberately keeps the normal diff (the helper
  // returns null unless every present side is a pointer).
  const lfsSides = lfsPointerDiffSides(text.hunks);
  if (lfsSides) {
    // The preview command resolves pointers to local LFS objects; when no
    // side yields an image the pointer notice renders as before.
    return (
      <ImageDiffView
        repoId={request.repoId}
        source={request.source}
        path={request.path}
        oldPath={request.oldPath ?? null}
        fallback={() => (
          <div className="legit-panel__body">
            <LfsPointerNotice oldInfo={lfsSides.oldInfo} newInfo={lfsSides.newInfo} />
          </div>
        )}
      />
    );
  }

  // Identity of the shown file/source: scroll is preserved across content
  // refetches (e.g. after staging) but reset when this changes.
  const scrollResetKey = `${request.repoId}|${request.path}|${request.source.kind}|${
    request.source.kind === "commit" ? request.source.commit_id : ""
  }`;

  return (
    <DiffEditor
      ref={editorRef}
      diff={text}
      mode={mode}
      actions={actions}
      onAction={onAction}
      onContextMenu={onContextMenu}
      lineActionOp={lineActionOp}
      onLineAction={onLineAction}
      scrollResetKey={scrollResetKey}
      editable={editable}
      dirty={dirty}
      onDirty={onDirty}
      onSaveRequest={onSaveRequest}
      rebuildKey={rebuildKey}
      onExpandHunk={onExpandHunk}
      trailingExpander={trailingExpander}
      syntaxPath={syntaxPath}
    />
  );
  };

  const renderTooLarge = (bytes: number) => (
    <div className="legit-panel__body">
      <span className="legit-subtle">
        Diff too large to display ({formatByteSize(bytes)}, cap 20 MiB).
      </span>
    </div>
  );

  // SVG is text to git, so it never classifies as Binary - route .svg paths
  // through the image panes (extension-triggered), falling back to the text
  // diff (or the too-large notice) when no side previews as an image.
  if (isSvgPath(request.path) && ("Text" in data || "TooLarge" in data)) {
    return (
      <ImageDiffView
        repoId={request.repoId}
        source={request.source}
        path={request.path}
        oldPath={request.oldPath ?? null}
        fallback={() =>
          "TooLarge" in data ? renderTooLarge(data.TooLarge.bytes) : renderTextDiff(data.Text)
        }
      />
    );
  }
  if ("TooLarge" in data) return renderTooLarge(data.TooLarge.bytes);
  return renderTextDiff(data.Text);
}

import { useEffect, useRef } from "react";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { baseTheme, readOnly } from "./DiffEditor";
import { loadLanguageForPath, syntaxColorTheme } from "./syntaxLanguages";
import {
  alignedBreakpoints,
  conflictAnchors,
  parseConflicts,
  piecewiseMap,
  type ConflictAnchors,
} from "./conflictModel";

/**
 * 3-way conflict view: ours | (base) | result | theirs. The outer panes show
 * the real index stages (`:2` / `:1` / `:3`) read-only; the centre pane is
 * the working-tree file itself (markers and all), freely editable — Ctrl+S
 * or the panel's Save writes it back.
 *
 * Scrolling is conflict-aligned, centre → sides: each conflict's start line
 * is located in every pane (`conflictAnchors`, re-derived from the centre
 * doc after edits) and the scroll position maps piecewise-linearly between
 * those anchors, so corresponding conflicts stay side by side. Panes without
 * derivable anchors (the base pane under classic markers, a deleted side)
 * fall back to proportional mapping. One-directional sync keeps the result
 * pane authoritative and avoids feedback loops.
 *
 * All panes are whole real files, so syntax highlighting (when enabled)
 * attaches the language support directly - full fidelity, no hunk-side
 * reconstruction.
 */
export function ThreeWayView({
  ours,
  theirs,
  base,
  showBase,
  content,
  rebuildKey,
  onDirty,
  onSaveRequest,
  onDocChange,
  syntaxPath,
}: {
  /** Stage 2 content; null = ours deleted the file. */
  ours: string | null;
  /** Stage 3 content; null = theirs deleted the file. */
  theirs: string | null;
  /** Stage 1 (merge base) content; null = the file did not exist there. */
  base: string | null;
  /** Show the base pane between ours and the result. */
  showBase: boolean;
  /** Current working-tree content (the editable result). */
  content: string;
  /** Bumped by the parent after save/discard to rebuild the centre doc. */
  rebuildKey: number;
  onDirty: () => void;
  onSaveRequest: () => void;
  /** Reports the centre document's current text on every change. */
  onDocChange: (text: string) => void;
  /** Path for syntax-highlighting language selection; null = off. */
  syntaxPath: string | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Stable identities for the mount effect (mirrors DiffEditor's approach).
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const onSaveRef = useRef(onSaveRequest);
  onSaveRef.current = onSaveRequest;
  const onDocChangeRef = useRef(onDocChange);
  onDocChangeRef.current = onDocChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.height = "100%";
    const labels = [
      "Ours (stage 2)",
      ...(showBase ? ["Base (stage 1)"] : []),
      "Result (working tree)",
      "Theirs (stage 3)",
    ];
    const cols: HTMLDivElement[] = [];
    for (const label of labels) {
      const col = document.createElement("div");
      col.style.flex = "1";
      col.style.minWidth = "0";
      col.style.display = "flex";
      col.style.flexDirection = "column";
      col.style.borderLeft = "1px solid var(--panel-border)";
      const head = document.createElement("div");
      head.textContent = label;
      head.style.fontSize = "var(--fz-sm)";
      head.style.color = "var(--subtle-fg)";
      head.style.padding = "2px 8px";
      head.style.borderBottom = "1px solid var(--panel-border)";
      head.style.flexShrink = "0";
      const body = document.createElement("div");
      body.style.flex = "1";
      body.style.minHeight = "0";
      col.append(head, body);
      wrap.appendChild(col);
      cols.push(body);
    }
    wrap.firstElementChild &&
      ((wrap.firstElementChild as HTMLElement).style.borderLeft = "none");
    host.appendChild(wrap);

    const sidePane = (parent: HTMLElement, text: string | null, deletedNote: string) =>
      new EditorView({
        state: EditorState.create({
          doc: text ?? deletedNote,
          extensions: [baseTheme, ...readOnly],
        }),
        parent,
      });

    const oursView = sidePane(cols[0], ours, "(no content — this side deleted the file)");
    const baseView = showBase
      ? sidePane(cols[1], base, "(no content — the file did not exist in the merge base)")
      : null;
    const centreCol = showBase ? 2 : 1;
    const theirsView = sidePane(cols[centreCol + 1], theirs, "(no content — this side deleted the file)");

    // Conflict anchors drive the scroll alignment; edits shift them, so they
    // are re-derived lazily from the centre doc on the next scroll.
    let anchors: ConflictAnchors = conflictAnchors(parseConflicts(content));
    let anchorsDirty = false;

    const centreView = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          baseTheme,
          history(),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          conflictMarkerHighlight,
          EditorView.updateListener.of((u: ViewUpdate) => {
            if (u.docChanged) {
              anchorsDirty = true;
              onDirtyRef.current();
              onDocChangeRef.current(u.state.doc.toString());
            }
          }),
        ],
      }),
      parent: cols[centreCol],
    });

    // Whole real files: attach the language support directly when it arrives.
    let disposed = false;
    if (syntaxPath) {
      void loadLanguageForPath(syntaxPath).then((support) => {
        if (disposed || !support) return;
        const views = [oursView, centreView, theirsView, ...(baseView ? [baseView] : [])];
        for (const view of views) {
          view.dispatch({ effects: StateEffect.appendConfig.of([support, syntaxColorTheme]) });
        }
      });
    }

    /** Pixel offsets (document-relative) of anchor lines in a pane. */
    const anchorTops = (view: EditorView, lines: number[]): number[] =>
      lines.map((n) => {
        const lineNo = Math.min(Math.max(n + 1, 1), view.state.doc.lines);
        return view.lineBlockAt(view.state.doc.line(lineNo).from).top;
      });

    const follow = () => {
      if (anchorsDirty) {
        anchors = conflictAnchors(parseConflicts(centreView.state.doc.toString()));
        anchorsDirty = false;
      }
      const src = centreView.scrollDOM;
      const srcMax = src.scrollHeight - src.clientHeight;
      const srcTops = anchorTops(centreView, anchors.center);
      const targets: Array<[EditorView, number[] | null]> = [
        [oursView, ours !== null ? anchors.ours : null],
        [theirsView, theirs !== null ? anchors.theirs : null],
      ];
      if (baseView) targets.push([baseView, base !== null ? anchors.base : null]);
      for (const [dstView, dstAnchors] of targets) {
        const dst = dstView.scrollDOM;
        const dstMax = dst.scrollHeight - dst.clientHeight;
        const { xs, ys } = dstAnchors
          ? alignedBreakpoints(srcTops, srcMax, anchorTops(dstView, dstAnchors), dstMax)
          : { xs: [0, Math.max(srcMax, 1)], ys: [0, Math.max(dstMax, 0)] };
        dst.scrollTop = piecewiseMap(src.scrollTop, xs, ys);
      }
    };
    centreView.scrollDOM.addEventListener("scroll", follow);

    return () => {
      disposed = true;
      centreView.scrollDOM.removeEventListener("scroll", follow);
      oursView.destroy();
      baseView?.destroy();
      centreView.destroy();
      theirsView.destroy();
      wrap.remove();
    };
    // Content is a mount dependency on purpose: the parent suppresses
    // refetches while dirty, so a content change is always a fresh baseline
    // (initial load, post-save, or discard via rebuildKey). showBase/syntaxPath
    // toggles remount too - the parent disables them while dirty.
  }, [ours, theirs, base, showBase, content, rebuildKey, syntaxPath]);

  return <div ref={hostRef} style={{ height: "100%" }} />;
}

/** Line highlight for conflict-marker lines in the centre pane. */
const markerLine = Decoration.line({ class: "cm-conflict-marker-line" });

const conflictMarkerHighlight = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildMarkerDecos(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = buildMarkerDecos(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  ),
  EditorView.theme({
    ".cm-conflict-marker-line": {
      backgroundColor: "var(--diff-hunk-header-bg)",
      color: "var(--diff-hunk-header-fg)",
    },
  }),
];

function buildMarkerDecos(view: EditorView): DecorationSet {
  const decos = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const t = line.text;
      if (
        t.startsWith("<<<<<<<") ||
        t.startsWith("=======") ||
        t.startsWith(">>>>>>>") ||
        t.startsWith("|||||||")
      ) {
        decos.push(markerLine.range(line.from));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(decos);
}

import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { baseTheme, readOnly } from "./DiffEditor";

/**
 * 3-way conflict view: ours | result | theirs. The outer panes show the real
 * index stages (`:2` / `:3`) read-only; the centre pane is the working-tree
 * file itself (markers and all), freely editable — Ctrl+S or the panel's
 * Save writes it back. Scroll is proportion-synced from the centre pane
 * (the three documents have different lengths, so line-locking would lie).
 */
export function ThreeWayView({
  ours,
  theirs,
  content,
  rebuildKey,
  onDirty,
  onSaveRequest,
  onDocChange,
}: {
  /** Stage 2 content; null = ours deleted the file. */
  ours: string | null;
  /** Stage 3 content; null = theirs deleted the file. */
  theirs: string | null;
  /** Current working-tree content (the editable result). */
  content: string;
  /** Bumped by the parent after save/discard to rebuild the centre doc. */
  rebuildKey: number;
  onDirty: () => void;
  onSaveRequest: () => void;
  /** Reports the centre document's current text on every change. */
  onDocChange: (text: string) => void;
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
    const cols: HTMLDivElement[] = [];
    const labels = ["Ours (stage 2)", "Result (working tree)", "Theirs (stage 3)"];
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

    const sidePane = (parent: HTMLElement, text: string | null) =>
      new EditorView({
        state: EditorState.create({
          doc: text ?? "(no content — this side deleted the file)",
          extensions: [baseTheme, ...readOnly],
        }),
        parent,
      });

    const oursView = sidePane(cols[0], ours);
    const theirsView = sidePane(cols[2], theirs);

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
              onDirtyRef.current();
              onDocChangeRef.current(u.state.doc.toString());
            }
          }),
        ],
      }),
      parent: cols[1],
    });

    // Proportional scroll sync, centre → sides (one-directional keeps the
    // result pane authoritative and avoids feedback loops).
    const follow = () => {
      const src = centreView.scrollDOM;
      const range = src.scrollHeight - src.clientHeight;
      const ratio = range > 0 ? src.scrollTop / range : 0;
      for (const dst of [oursView.scrollDOM, theirsView.scrollDOM]) {
        const dstRange = dst.scrollHeight - dst.clientHeight;
        dst.scrollTop = ratio * dstRange;
      }
    };
    centreView.scrollDOM.addEventListener("scroll", follow);

    return () => {
      centreView.scrollDOM.removeEventListener("scroll", follow);
      oursView.destroy();
      centreView.destroy();
      theirsView.destroy();
      wrap.remove();
    };
    // Content is a mount dependency on purpose: the parent suppresses
    // refetches while dirty, so a content change is always a fresh baseline
    // (initial load, post-save, or discard via rebuildKey).
  }, [ours, theirs, content, rebuildKey]);

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

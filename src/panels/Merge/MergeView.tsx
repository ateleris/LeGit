// The dedicated 3-way merge view: Current | (Base) | Result | Incoming.
//
// The RESULT DOCUMENT is the single source of truth. It starts as the
// marker file; the side panes are read-only stage snapshots whose gutters
// carry a block checkbox (all/none of a side) and per-line +/− toggles.
// Every toggle performs targeted surgery on the result doc: the block's
// current range is replaced with `composeBlockLines` for the new selection
// (no line selected restores the markers). Manual edits in the result are
// first-class — ranges are mapped through them, and Save writes the doc.
//
// Pane sizes are drag-resizable (fractions persisted in localStorage).
// Scrolling is conflict-aligned result → sides via the live block ranges.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { codeFolding, foldEffect, unfoldAll } from "@codemirror/language";
import { baseTheme, plusMinusIcon, readOnly } from "../Diff/DiffEditor";
import { loadLanguageForPath, syntaxColorTheme } from "../Diff/syntaxLanguages";
import {
  alignedBreakpoints,
  blockSection,
  composeBlockLines,
  foldableRanges,
  locateRegionAnchors,
  markerViewSpans,
  piecewiseMap,
  regionsFromParsed,
  sideLabel,
  type ConflictSideNames,
  type LineSelection,
  type ParsedConflicts,
} from "../Diff/conflictModel";

export interface MergeViewHandle {
  /** Re-run the block surgery for one conflict after its selection changed. */
  applyBlock(index: number): void;
  /** Centre the result view (and thus the synced sides) on a conflict. */
  scrollToBlock(index: number): void;
  /** Current result document text. */
  getText(): string | null;
}

/** Dispatched into the side panes when selections changed (gutter/dim redraw). */
const selectionRefresh = StateEffect.define<null>();
/** Dispatched into every pane when block heights changed (spacer rebuild). */
const alignRefresh = StateEffect.define<null>();

/** Invisible height filler below a conflict block, padding this pane's block
 *  to the tallest version across the panes so the rows stay aligned. */
class SpacerWidget extends WidgetType {
  constructor(readonly lines: number) {
    super();
  }
  override eq(other: SpacerWidget): boolean {
    return other.lines === this.lines;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-merge-spacer";
    el.style.height = `calc(${this.lines} * 1.5em)`;
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}
/** Explicitly sets one block's tracked range after surgery. `origin` is how
 *  many of the composed lines came from each side (in that order), or null
 *  while the block still holds its conflict markers. */
const setBlockRange = StateEffect.define<{
  index: number;
  from: number;
  to: number;
  origin: { ours: number; theirs: number } | null;
}>();

/** One tracked result block: its live range and the origin of its lines. */
interface BlockRange {
  from: number;
  to: number;
  origin: { ours: number; theirs: number } | null;
}

/** Block checkbox, vertically centred beside the whole region. */
class BlockCheckMarker extends GutterMarker {
  constructor(
    readonly state: "all" | "some" | "none",
    readonly blockLines: number,
    readonly onToggle: () => void,
  ) {
    super();
  }
  override eq(other: BlockCheckMarker): boolean {
    return other.state === this.state && other.blockLines === this.blockLines;
  }
  override toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-conflict-check cm-conflict-check-block";
    wrap.style.height = `calc(${this.blockLines} * 1.5em)`;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.state === "all";
    box.indeterminate = this.state === "some";
    box.title = "Include this side in the result";
    box.addEventListener("change", () => this.onToggle());
    // Reach lines originating from the checkbox's centre up to the block's
    // first line and down to its last, showing what the box covers.
    // Single-line blocks need no such hint.
    if (this.blockLines > 1) {
      const top = document.createElement("div");
      top.className = "cm-conflict-bracket cm-conflict-bracket-top";
      const bottom = document.createElement("div");
      bottom.className = "cm-conflict-bracket cm-conflict-bracket-bottom";
      wrap.append(top, bottom);
    }
    wrap.appendChild(box);
    return wrap;
  }
}

/** Per-line + / − toggle: adds this one line to the result block or takes
 *  it back out. Styled exactly like the diff view's per-line stage buttons
 *  (same classes + icon); an included line's − stays faintly visible since
 *  it also communicates state. */
class LineToggleMarker extends GutterMarker {
  constructor(
    readonly included: boolean,
    readonly onToggle: () => void,
  ) {
    super();
  }
  override eq(other: LineToggleMarker): boolean {
    return other.included === this.included;
  }
  override toDOM(): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = this.included
      ? "cm-diff-line-action cm-merge-line-included"
      : "cm-diff-line-action";
    btn.title = this.included
      ? "Remove this line from the result"
      : "Add this line to the result";
    btn.appendChild(plusMinusIcon(!this.included));
    btn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.onToggle();
    });
    return btn;
  }
}

/** Folding with a diff-hunk-header-style row: full-width bar stating how
 *  many lines are hidden, click to expand. */
const mergeFolding = codeFolding({
  preparePlaceholder: (state, range) => {
    return state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number + 1;
  },
  placeholderDOM: (_view, onclick, prepared) => {
    const el = document.createElement("div");
    el.className = "cm-merge-fold";
    const n = typeof prepared === "number" ? prepared : 0;
    el.textContent = `\u22ef ${n} line${n === 1 ? "" : "s"} hidden \u00b7 click to expand`;
    el.setAttribute("role", "button");
    el.title = "Expand the hidden lines";
    el.addEventListener("click", onclick);
    return el;
  },
});

const mergeTheme = EditorView.theme({
  // Every pane reserves the horizontal scrollbar unconditionally: one pane
  // having it and another not would give them different viewport heights,
  // skewing the cross-pane line alignment near the bottom of the scroll.
  ".cm-scroller": { overflowX: "scroll" },
  // Same metrics as the diff's `@@` hunk-header rows, but with the merge
  // panel's own neutral band: the bar must never read as one of the sides.
  ".cm-merge-fold": {
    display: "flex",
    alignItems: "center",
    width: "100%",
    boxSizing: "border-box",
    cursor: "pointer",
    background: "var(--merge-fold-bg)",
    color: "var(--merge-fold-fg)",
    fontStyle: "italic",
    height: "calc(var(--fz-lg) * 1.5 + 16px)",
    padding: "0 8px",
  },
  ".cm-conflict-check-block": { position: "relative" },
  ".cm-conflict-check-block input": { position: "relative", zIndex: "1" },
  // Vertical reach lines out of the checkbox's centre, with a short tick at
  // the block's first/last line.
  ".cm-conflict-bracket": {
    position: "absolute",
    left: "50%",
    width: "6px",
    marginLeft: "-1px",
    borderLeft: "1.5px solid var(--diff-gutter-fg)",
    opacity: "0.45",
  },
  ".cm-conflict-bracket-top": {
    top: "3px",
    bottom: "calc(50% + 0.75em)",
    borderTop: "1.5px solid var(--diff-gutter-fg)",
    borderTopLeftRadius: "6px",
  },
  ".cm-conflict-bracket-bottom": {
    top: "calc(50% + 0.75em)",
    bottom: "3px",
    borderBottom: "1.5px solid var(--diff-gutter-fg)",
    borderBottomLeftRadius: "6px",
  },
  // Included lines keep their − faintly visible (it carries state); the
  // hover-reveal for + comes from the shared diff action-gutter rules.
  ".cm-diff-line-action.cm-merge-line-included": { opacity: "0.5" },
  ".cm-conflict-marker-line": {
    backgroundColor: "var(--diff-hunk-header-bg)",
    color: "var(--diff-hunk-header-fg)",
  },
});

export const MergeView = forwardRef<
  MergeViewHandle,
  {
    /** Stage 2 content; null = this side deleted the file. */
    ours: string | null;
    /** Stage 3 content; null = this side deleted the file. */
    theirs: string | null;
    sideNames: ConflictSideNames | null;
    /** The marker file (result-doc baseline). */
    content: string;
    /** Parse of `content` (block spans, side anchors, marker labels). */
    parsed: ParsedConflicts;
    /** Live per-line selections (read via ref inside the mounted views). */
    selectionsRef: React.RefObject<LineSelection[]>;
    onToggleLine: (block: number, side: "ours" | "theirs", line: number) => void;
    onToggleBlock: (block: number, side: "ours" | "theirs") => void;
    onDirty: () => void;
    onSaveRequest: () => void;
    /** Bumped after save/discard: rebuild the result doc from `content`. */
    rebuildKey: number;
    /** Conflicts view: fold the common stretches (a few context lines stay). */
    foldCommon: boolean;
    syntaxPath: string | null;
  }
>(function MergeView(
  {
    ours,
    theirs,
    sideNames,
    content,
    parsed,
    selectionsRef,
    onToggleLine,
    onToggleBlock,
    onDirty,
    onSaveRequest,
    rebuildKey,
    foldCommon,
    syntaxPath,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onToggleLineRef = useRef(onToggleLine);
  onToggleLineRef.current = onToggleLine;
  const onToggleBlockRef = useRef(onToggleBlock);
  onToggleBlockRef.current = onToggleBlock;
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const onSaveRef = useRef(onSaveRequest);
  onSaveRef.current = onSaveRequest;
  const viewsRef = useRef<{
    result: EditorView;
    sides: EditorView[];
    rangesField: StateField<BlockRange[]>;
  } | null>(null);
  // Pane fractions (Current, [Base], Result, Incoming), persisted.
  const sizesKey = "legit.merge-pane-sizes";
  const applyFoldsRef = useRef<((on: boolean) => void) | null>(null);
  const foldCommonRef = useRef(foldCommon);

  // View-mode toggle applies imperatively - a remount would drop the
  // (stateful, editable) result document.
  useEffect(() => {
    if (foldCommonRef.current === foldCommon) return;
    foldCommonRef.current = foldCommon;
    applyFoldsRef.current?.(foldCommon);
  }, [foldCommon]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const regions = regionsFromParsed(parsed);
    // Side anchors are located by region CONTENT in the actual stage docs,
    // not derived from the marker file's structure: saved edits to the
    // result's common lines must not shift where the sides' blocks render.
    const sideAnchors = {
      ours: locateRegionAnchors(
        (ours ?? "").split("\n"),
        regions.map((r) => r.ours),
      ),
      theirs: locateRegionAnchors(
        (theirs ?? "").split("\n"),
        regions.map((r) => r.theirs),
      ),
    };
    const spans = markerViewSpans(parsed);
    const nBlocks = spans.length;

    // ------------------------------------------------------------------
    // Result document: guaranteed trailing newline so every block range can
    // uniformly include its trailing newline (empty block = collapsed range
    // at a line start). Save strips it again when the file had none.
    // ------------------------------------------------------------------
    const docText = content.endsWith("\n") || content === "" ? content : `${content}\n`;
    // Initial ranges from the marker-view spans (line-based → positions).
    const docLines = docText.split("\n");
    const lineStart: number[] = [0];
    for (const l of docLines) lineStart.push(lineStart[lineStart.length - 1] + l.length + 1);
    const initialRanges: BlockRange[] = spans.map((sp) => ({
      from: lineStart[sp.start],
      to: lineStart[sp.start + sp.lines],
      origin: null,
    }));

    const rangesField = StateField.define<BlockRange[]>({
      create: () => initialRanges,
      update(value, tr) {
        let next = value;
        if (tr.docChanged) {
          next = next.map((r) => ({
            ...r,
            from: tr.changes.mapPos(r.from, -1),
            to: tr.changes.mapPos(r.to, 1),
          }));
        }
        for (const e of tr.effects) {
          if (e.is(setBlockRange)) {
            next = [...next];
            next[e.value.index] = {
              from: e.value.from,
              to: e.value.to,
              origin: e.value.origin,
            };
          }
        }
        return next;
      },
    });

    // Composition tinting: lines a block took from Current keep the removed
    // tint, lines from Incoming the added tint, so the result visibly shows
    // how it was built. Unresolved blocks highlight their marker lines.
    const resultDeco = StateField.define<DecorationSet>({
      create: (state) => buildResultDeco(state),
      update: (value, tr) =>
        tr.docChanged || tr.effects.some((e) => e.is(setBlockRange))
          ? buildResultDeco(tr.state)
          : value,
      provide: (f) => EditorView.decorations.from(f),
    });
    function buildResultDeco(state: EditorState): DecorationSet {
      const ranges = [];
      const blocks = state.field(rangesField);
      for (const block of blocks) {
        const from = Math.min(block.from, state.doc.length);
        const firstLine = state.doc.lineAt(from).number;
        if (block.origin === null) {
          // Markers still present: highlight the marker lines themselves.
          const to = Math.min(block.to, state.doc.length);
          for (let n = firstLine; n <= state.doc.lines; n++) {
            const line = state.doc.line(n);
            if (line.from >= to) break;
            const t = line.text;
            if (
              t.startsWith("<<<<<<<") ||
              t.startsWith("=======") ||
              t.startsWith(">>>>>>>") ||
              t.startsWith("|||||||")
            ) {
              ranges.push(
                Decoration.line({ class: "cm-conflict-marker-line" }).range(line.from),
              );
            }
          }
          continue;
        }
        for (let l = 0; l < block.origin.ours + block.origin.theirs; l++) {
          const n = firstLine + l;
          if (n > state.doc.lines) break;
          const cls = l < block.origin.ours ? "cm-diff-removed" : "cm-diff-added";
          ranges.push(Decoration.line({ class: cls }).range(state.doc.line(n).from));
        }
      }
      return Decoration.set(ranges, true);
    }

    // ------------------------------------------------------------------
    // Panes + sashes (drag-resizable flex columns).
    // ------------------------------------------------------------------
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.height = "100%";
    const labels = [
      sideLabel("Current", sideNames?.ours ?? null),
      "Result",
      sideLabel("Incoming", sideNames?.theirs ?? null),
    ];
    let fractions: number[] = [];
    try {
      const saved = JSON.parse(localStorage.getItem(sizesKey) ?? "[]");
      if (Array.isArray(saved) && saved.length === labels.length) fractions = saved;
    } catch {
      /* corrupt pref */
    }
    if (fractions.length !== labels.length) fractions = labels.map(() => 1 / labels.length);

    const cols: HTMLDivElement[] = [];
    const colWraps: HTMLDivElement[] = [];
    labels.forEach((label, i) => {
      if (i > 0) {
        const sash = document.createElement("div");
        sash.style.width = "5px";
        sash.style.cursor = "col-resize";
        sash.style.flexShrink = "0";
        sash.style.background = "var(--panel-border)";
        const left = i - 1;
        sash.addEventListener("pointerdown", (down) => {
          down.preventDefault();
          sash.setPointerCapture(down.pointerId);
          const total = wrap.clientWidth;
          const startX = down.clientX;
          const startLeft = fractions[left];
          const startRight = fractions[i];
          const onMove = (move: PointerEvent) => {
            const delta = (move.clientX - startX) / total;
            const l = Math.min(Math.max(startLeft + delta, 0.1), startLeft + startRight - 0.1);
            fractions[left] = l;
            fractions[i] = startLeft + startRight - l;
            colWraps[left].style.flexGrow = String(fractions[left]);
            colWraps[i].style.flexGrow = String(fractions[i]);
          };
          const onUp = () => {
            sash.removeEventListener("pointermove", onMove);
            sash.removeEventListener("pointerup", onUp);
            try {
              localStorage.setItem(sizesKey, JSON.stringify(fractions));
            } catch {
              /* quota */
            }
          };
          sash.addEventListener("pointermove", onMove);
          sash.addEventListener("pointerup", onUp);
        });
        wrap.appendChild(sash);
      }
      const col = document.createElement("div");
      col.style.flexGrow = String(fractions[i]);
      col.style.flexBasis = "0";
      col.style.minWidth = "0";
      col.style.display = "flex";
      col.style.flexDirection = "column";
      const head = document.createElement("div");
      head.textContent = label;
      head.style.fontSize = "var(--fz-sm)";
      head.style.color = "var(--subtle-fg)";
      head.style.padding = "2px 8px";
      head.style.borderBottom = "1px solid var(--panel-border)";
      head.style.flexShrink = "0";
      head.style.whiteSpace = "nowrap";
      head.style.overflow = "hidden";
      head.style.textOverflow = "ellipsis";
      const body = document.createElement("div");
      body.style.flex = "1";
      body.style.minHeight = "0";
      col.append(head, body);
      wrap.appendChild(col);
      cols.push(body);
      colWraps.push(col);
    });
    host.appendChild(wrap);

    // ------------------------------------------------------------------
    // Cross-pane block alignment: every pane pads each conflict block to
    // the tallest version of that block (spacer widgets), so fold bars,
    // context and blocks sit level across the panes. Common stretches are
    // identical text everywhere, so blocks are the only drift source.
    // ------------------------------------------------------------------
    const CONTEXT = 3;
    const baseLens = parsed.sections
      .filter((sec) => sec.kind === "conflict")
      .map((sec) => ("base" in sec && sec.base ? sec.base.length : 0));
    const resultLensRef = { current: [] as number[] };
    const resultStartsRef = { current: [] as number[] };
    const slotLensRef = { current: [] as number[] };
    const offOursRef = { current: [] as number[] };
    const offTheirsRef = { current: [] as number[] };
    const zeroOffsets = () => slotLensRef.current.map(() => 0);
    const recomputeRef = { current: null as (() => void) | null };

    /** Spacer decorations for one pane: a top pad places the block at its
     *  segment offset inside the conflict slot (Current beside the result's
     *  ours-derived lines, Incoming beside the theirs-derived ones), a
     *  bottom pad fills the slot so the trailing context aligns again.
     *  `starts` are 0-based block start lines. */
    const spacerField = (
      starts: () => number[],
      ownLens: () => number[],
      offsets: () => number[],
    ) => {
      const build = (state: EditorState): DecorationSet => {
        const ranges = [];
        const st = starts();
        const own = ownLens();
        const off = offsets();
        for (let i = 0; i < st.length; i++) {
          const slot = slotLensRef.current[i] ?? 0;
          const top = off[i] ?? 0;
          const bottom = slot - top - (own[i] ?? 0);
          const firstLine = Math.min(st[i] + 1, state.doc.lines);
          if (top > 0) {
            ranges.push(
              Decoration.widget({ widget: new SpacerWidget(top), block: true, side: -1 })
                .range(state.doc.line(firstLine).from),
            );
          }
          if (bottom > 0) {
            const lastLine = Math.min(Math.max(st[i] + Math.max(own[i] ?? 0, 1), 1), state.doc.lines);
            ranges.push(
              Decoration.widget({ widget: new SpacerWidget(bottom), block: true, side: 1 })
                .range(state.doc.line(lastLine).to),
            );
          }
        }
        return Decoration.set(ranges, true);
      };
      return StateField.define<DecorationSet>({
        create: build,
        update: (value, tr) =>
          tr.effects.some((e) => e.is(alignRefresh)) || tr.docChanged
            ? build(tr.state)
            : value,
        provide: (f) => EditorView.decorations.from(f),
      });
    };

    // ------------------------------------------------------------------
    // Side panes (read-only stages) with label chips, dim, checkbox gutter
    // and the per-line +/− gutter.
    // ------------------------------------------------------------------
    const sel = () => selectionsRef.current ?? [];
    const anyInBlock = (i: number) => {
      const s = sel()[i];
      return !!s && (s.ours.some(Boolean) || s.theirs.some(Boolean));
    };

    const sideExtensions = (
      side: "ours" | "theirs",
      starts: number[],
      lens: number[],
      cls: string,
    ): Extension[] => {
      const deco = StateField.define<DecorationSet>({
        create: (state) => buildDeco(state),
        update: (value, tr) =>
          tr.effects.some((e) => e.is(selectionRefresh)) ? buildDeco(tr.state) : value,
        provide: (f) => EditorView.decorations.from(f),
      });
      // The pane header names the side; the block itself is identified by
      // its side-tinted background (dim on lines excluded from the result).
      function buildDeco(state: EditorState): DecorationSet {
        const ranges = [];
        for (let i = 0; i < nBlocks; i++) {
          const s = sel()[i];
          const flags = s?.[side] ?? [];
          const active = anyInBlock(i);
          for (let l = 0; l < lens[i]; l++) {
            const n = starts[i] + 1 + l;
            if (n > state.doc.lines) break;
            const dimmed = active && !flags[l];
            ranges.push(
              Decoration.line({
                class: dimmed ? `${cls} cm-conflict-dim` : cls,
              }).range(state.doc.line(n).from),
            );
          }
        }
        return Decoration.set(ranges, true);
      }
      const checkGutter = gutter({
        class: "cm-conflict-check-gutter",
        lineMarker(view, line) {
          const lineNo = view.state.doc.lineAt(line.from).number;
          const i = starts.indexOf(lineNo - 1);
          if (i === -1) return null;
          const flags = sel()[i]?.[side] ?? [];
          const state =
            lens[i] > 0 && flags.length === lens[i] && flags.every(Boolean)
              ? "all"
              : flags.some(Boolean)
                ? "some"
                : "none";
          return new BlockCheckMarker(state, Math.max(lens[i], 1), () =>
            onToggleBlockRef.current(i, side),
          );
        },
        lineMarkerChange: (u) =>
          u.transactions.some((tr) => tr.effects.some((e) => e.is(selectionRefresh))),
      });
      const lineGutter = gutter({
        class: "cm-diff-action-gutter",
        lineMarker(view, line) {
          const lineNo = view.state.doc.lineAt(line.from).number - 1; // 0-based
          for (let i = 0; i < nBlocks; i++) {
            if (lineNo >= starts[i] && lineNo < starts[i] + lens[i]) {
              const l = lineNo - starts[i];
              const included = sel()[i]?.[side]?.[l] ?? false;
              return new LineToggleMarker(included, () =>
                onToggleLineRef.current(i, side, l),
              );
            }
          }
          return null;
        },
        lineMarkerChange: (u) =>
          u.transactions.some((tr) => tr.effects.some((e) => e.is(selectionRefresh))),
      });
      const spacers = spacerField(
        () => starts,
        () => lens,
        () => (side === "ours" ? offOursRef.current : offTheirsRef.current),
      );
      return [baseTheme, mergeTheme, lineNumbers(), mergeFolding, deco, checkGutter, lineGutter, spacers, ...readOnly];
    };

    const sidePane = (parent: HTMLElement, text: string | null, note: string, ext?: Extension[]) =>
      new EditorView({
        state: EditorState.create({
          doc: text ?? note,
          extensions: ext ?? [baseTheme, mergeTheme, lineNumbers(), mergeFolding, ...readOnly],
        }),
        parent,
      });

    const regionLens = {
      ours: regions.map((r) => r.ours.length),
      theirs: regions.map((r) => r.theirs.length),
    };
    const oursView = sidePane(
      cols[0],
      ours,
      "(no content — this side deleted the file)",
      ours !== null
        ? sideExtensions("ours", sideAnchors.ours, regionLens.ours, "cm-diff-removed")
        : undefined,
    );
    const centreCol = 1;
    const theirsView = sidePane(
      cols[centreCol + 1],
      theirs,
      "(no content — this side deleted the file)",
      theirs !== null
        ? sideExtensions("theirs", sideAnchors.theirs, regionLens.theirs, "cm-diff-added")
        : undefined,
    );

    // ------------------------------------------------------------------
    // Result pane: editable, with the block-range field.
    // ------------------------------------------------------------------
    const followRef: { current: (() => void) | null } = { current: null };
    const resultView = new EditorView({
      state: EditorState.create({
        doc: docText,
        extensions: [
          baseTheme,
          mergeTheme,
          lineNumbers(),
          mergeFolding,
          rangesField,
          resultDeco,
          spacerField(
            () => resultStartsRef.current,
            () => resultLensRef.current,
            zeroOffsets,
          ),
          // Same explicit caret the diff's editable panes use (the inherited
          // colour does not reliably reach the native caret in the webview).
          EditorView.theme({ ".cm-content": { caretColor: "var(--panel-fg)" } }),
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
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              onDirtyRef.current();
              // Edits can change block heights (spacers) and the result's
              // geometry; re-pad, then re-align the sides once measurable.
              queueMicrotask(() => recomputeRef.current?.());
              u.view.requestMeasure({ read: () => followRef.current?.() });
            }
          }),
        ],
      }),
      parent: cols[centreCol],
    });

    let disposed = false;
    if (syntaxPath) {
      void loadLanguageForPath(syntaxPath).then((support) => {
        if (disposed || !support) return;
        for (const view of [oursView, resultView, theirsView]) {
          view.dispatch({ effects: StateEffect.appendConfig.of([support, syntaxColorTheme]) });
        }
      });
    }

    // ------------------------------------------------------------------
    // Result → sides scroll alignment from the LIVE block ranges.
    // ------------------------------------------------------------------
    const anchorTops = (view: EditorView, lines: number[]): number[] =>
      lines.map((n) => {
        const lineNo = Math.min(Math.max(n + 1, 1), view.state.doc.lines);
        return view.lineBlockAt(view.state.doc.line(lineNo).from).top;
      });
    const follow = () => {
      const ranges = resultView.state.field(rangesField);
      const centerLines = ranges.map(
        (r) => resultView.state.doc.lineAt(Math.min(r.from, resultView.state.doc.length)).number - 1,
      );
      const src = resultView.scrollDOM;
      const srcMax = src.scrollHeight - src.clientHeight;
      const srcTops = anchorTops(resultView, centerLines);
      const targets: Array<[EditorView, number[] | null]> = [
        [oursView, ours !== null ? sideAnchors.ours : null],
        [theirsView, theirs !== null ? sideAnchors.theirs : null],
      ];
      for (const [dstView, dstAnchors] of targets) {
        const dst = dstView.scrollDOM;
        const dstMax = dst.scrollHeight - dst.clientHeight;
        const { xs, ys } = dstAnchors
          ? alignedBreakpoints(srcTops, srcMax, anchorTops(dstView, dstAnchors), dstMax)
          : { xs: [0, Math.max(srcMax, 1)], ys: [0, Math.max(dstMax, 0)] };
        dst.scrollTop = piecewiseMap(src.scrollTop, xs, ys);
      }
    };
    followRef.current = follow;
    resultView.scrollDOM.addEventListener("scroll", follow);

    const recomputeAlignment = () => {
      const doc = resultView.state.doc;
      const blocks = resultView.state.field(rangesField);
      resultStartsRef.current = blocks.map(
        (b) => doc.lineAt(Math.min(b.from, doc.length)).number - 1,
      );
      resultLensRef.current = blocks.map((b, i) => {
        if (b.to <= b.from) return 0; // composed to nothing
        const endLine = doc.lineAt(Math.min(b.to - 1, doc.length)).number - 1;
        return endLine - resultStartsRef.current[i] + 1;
      });
      // Segment offsets: where each side's lines sit INSIDE the result's
      // block. Unresolved markers give exact offsets (ours after `<<<<<<<`,
      // theirs after `=======`); a composed block's come from its origin.
      offOursRef.current = blocks.map((b) => (b.origin === null ? 1 : 0));
      offTheirsRef.current = blocks.map((b, i) => {
        if (b.origin !== null) return b.origin.ours;
        const baseSeg = baseLens[i] > 0 ? 1 + baseLens[i] : 0;
        return 1 + (regionLens.ours[i] ?? 0) + baseSeg + 1;
      });
      slotLensRef.current = resultLensRef.current.map((r, i) =>
        Math.max(
          r,
          (offOursRef.current[i] ?? 0) + (regionLens.ours[i] ?? 0),
          (offTheirsRef.current[i] ?? 0) + (regionLens.theirs[i] ?? 0),
        ),
      );
      const fx = alignRefresh.of(null);
      resultView.dispatch({ effects: fx });
      oursView.dispatch({ effects: alignRefresh.of(null) });
      theirsView.dispatch({ effects: alignRefresh.of(null) });
    };
    recomputeRef.current = recomputeAlignment;
    recomputeAlignment();

    // Conflicts view: fold each pane's common stretches (3 context lines
    // stay visible around every block). Ranges are per pane; the result's
    // come from its LIVE tracked blocks so they are correct after surgery.
    const applyFolds = (on: boolean) => {
      const paneFold = (view: EditorView, starts: number[], lens: number[]) => {
        unfoldAll(view);
        if (!on) return;
        const total = view.state.doc.lines;
        const effects = foldableRanges(starts, lens, total, CONTEXT).map((r) =>
          foldEffect.of({
            from: view.state.doc.line(r.from + 1).from,
            to: view.state.doc.line(Math.min(r.to + 1, total)).to,
          }),
        );
        if (effects.length > 0) view.dispatch({ effects });
      };
      if (ours !== null) paneFold(oursView, sideAnchors.ours, regionLens.ours);
      if (theirs !== null) paneFold(theirsView, sideAnchors.theirs, regionLens.theirs);
      const blocks = resultView.state.field(rangesField);
      const starts = blocks.map(
        (b) => resultView.state.doc.lineAt(Math.min(b.from, resultView.state.doc.length)).number - 1,
      );
      const lens = blocks.map((b, i) => {
        const endLine = resultView.state.doc.lineAt(
          Math.min(Math.max(b.to - 1, b.from), resultView.state.doc.length),
        ).number;
        return Math.max(endLine - starts[i], 1);
      });
      paneFold(resultView, starts, lens);
      resultView.requestMeasure({ read: () => followRef.current?.() });
    };
    applyFoldsRef.current = applyFolds;
    if (foldCommon) applyFolds(true);

    viewsRef.current = { result: resultView, sides: [oursView, theirsView], rangesField };

    return () => {
      disposed = true;
      viewsRef.current = null;
      resultView.scrollDOM.removeEventListener("scroll", follow);
      oursView.destroy();
      resultView.destroy();
      theirsView.destroy();
      wrap.remove();
    };
    // Selections are deliberately NOT a dependency: toggles apply through the
    // imperative handle so the (stateful, editable) result doc survives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ours, theirs, content, parsed, rebuildKey, syntaxPath, sideNames]);

  useImperativeHandle(ref, () => ({
    applyBlock(index: number) {
      const mounted = viewsRef.current;
      if (!mounted) return;
      const { result, sides, rangesField } = mounted;
      const regions = regionsFromParsed(parsed);
      const region = regions[index];
      const s = (selectionsRef.current ?? [])[index];
      if (!region || !s) return;
      const lines = composeBlockLines(region, blockSection(parsed, index), s);
      const anySelected = s.ours.some(Boolean) || s.theirs.some(Boolean);
      const origin = anySelected
        ? {
            ours: s.ours.filter(Boolean).length,
            theirs: s.theirs.filter(Boolean).length,
          }
        : null;
      const range = result.state.field(rangesField)[index];
      if (!range) return;
      const insert = lines.length > 0 ? `${lines.join("\n")}\n` : "";
      result.dispatch({
        changes: { from: range.from, to: Math.min(range.to, result.state.doc.length), insert },
        effects: setBlockRange.of({
          index,
          from: range.from,
          to: range.from + insert.length,
          origin,
        }),
      });
      for (const v of sides) v.dispatch({ effects: selectionRefresh.of(null) });
    },
    scrollToBlock(index: number) {
      const mounted = viewsRef.current;
      if (!mounted) return;
      const range = mounted.result.state.field(mounted.rangesField)[index];
      if (!range) return;
      mounted.result.dispatch({
        effects: EditorView.scrollIntoView(Math.min(range.from, mounted.result.state.doc.length), {
          y: "center",
        }),
      });
    },
    getText() {
      return viewsRef.current?.result.state.doc.toString() ?? null;
    },
  }));

  return <div ref={hostRef} style={{ height: "100%", minHeight: 0, flex: 1 }} />;
});

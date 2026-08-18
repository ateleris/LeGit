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
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { codeFolding, foldEffect, unfoldAll, unfoldEffect } from "@codemirror/language";
import { EXPAND_STEP, EXPANDER_THEME, expanderPair, headerBand } from "../Diff/hunkExpanders";
import { baseTheme, NumberMarker, plusMinusIcon, readOnly } from "../Diff/DiffEditor";
import { loadLanguageForPath, syntaxColorTheme } from "../Diff/syntaxLanguages";
import { splitLines } from "../Diff/editModel";
import {
  blockOrigin,
  blockSection,
  composeBlockLines,
  foldableRanges,
  initialBlockRanges,
  locateRegionAnchors,
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

/** Fills a gutter cell with the fold bar's band so the bar runs
 *  uninterrupted across every column. */
class GutterBandMarker extends GutterMarker {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    return headerBand(false);
  }
}

/** Block checkbox, vertically centred beside the whole region. */
class BlockCheckMarker extends GutterMarker {
  constructor(
    readonly state: "all" | "some" | "none",
    readonly blockLines: number,
    /** This side contributes no lines: checking it resolves to nothing. */
    readonly empty: boolean,
    readonly onToggle: () => void,
  ) {
    super();
  }
  override eq(other: BlockCheckMarker): boolean {
    return (
      other.state === this.state &&
      other.blockLines === this.blockLines &&
      other.empty === this.empty
    );
  }
  override toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-conflict-check cm-conflict-check-block";
    wrap.style.height = `calc(${this.blockLines} * 1.5em)`;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.state === "all";
    box.indeterminate = this.state === "some";
    box.title = this.empty
      ? "This side is empty - include nothing from it (resolves the conflict to nothing)"
      : "Include this side in the result";
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


const mergeTheme = EditorView.theme({
  ...EXPANDER_THEME,

  // Every pane reserves the horizontal scrollbar unconditionally: one pane
  // having it and another not would give them different viewport heights,
  // skewing the cross-pane line alignment near the bottom of the scroll.
  ".cm-scroller": { overflowX: "scroll" },
  // The fold row IS the band, exactly like the diff's `@@` header lines:
  // full editor width, same height/padding/type, gutter cells filled by the
  // expander and band markers.
  ".cm-line:has(> .cm-merge-fold)": {
    backgroundColor: "var(--merge-fold-bg)",
    color: "var(--merge-fold-fg)",
    fontStyle: "italic",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    height: "calc(var(--fz-lg) * 1.5 + 16px)",
    padding: "0 8px",
  },
  ".cm-merge-fold": {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
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
    /** Header checkbox: select/clear this side across ALL conflict blocks. */
    onToggleSideAll: (side: "ours" | "theirs") => void;
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
    onToggleSideAll,
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
  const onToggleSideAllRef = useRef(onToggleSideAll);
  onToggleSideAllRef.current = onToggleSideAll;
  // Set during build; refreshes the header checkboxes after selection changes.
  const updateHeaderChecksRef = useRef<(() => void) | null>(null);
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
  // Result scroll carried across remounts (save/discard rebuild the doc).
  const centreScrollRef = useRef(0);
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
    // splitLines (not a raw "\n" split): the parsed regions are \r-stripped,
    // so CRLF stage content must be too or no region would ever match.
    // The preceding-context lines let empty regions (one side contributes
    // nothing) anchor AFTER their context instead of on top of it.
    const leads = regions.map((r) => r.lead);
    const sideAnchors = {
      ours: locateRegionAnchors(
        splitLines(ours ?? ""),
        regions.map((r) => r.ours),
        leads,
      ),
      theirs: locateRegionAnchors(
        splitLines(theirs ?? ""),
        regions.map((r) => r.theirs),
        leads,
      ),
    };

    // ------------------------------------------------------------------
    // Result document: guaranteed trailing newline so every block range can
    // uniformly include its trailing newline (empty block = collapsed range
    // at a line start). Save strips it again when the file had none.
    // ------------------------------------------------------------------
    const docText = content.endsWith("\n") || content === "" ? content : `${content}\n`;
    // Initial ranges from the marker-view spans, in CodeMirror positions
    // (every line break is ONE position, CRLF included).
    const initialRanges: BlockRange[] = initialBlockRanges(parsed, docText).map((r) => ({
      ...r,
      origin: null,
    }));
    const nBlocks = initialRanges.length;

    const rangesField = StateField.define<BlockRange[]>({
      create: () => initialRanges,
      update(value, tr) {
        let next = value;
        if (tr.docChanged) {
          // Boundary insertions belong to the surrounding CONTEXT, not the
          // block: text typed exactly at a block's edge (e.g. at the start
          // of the line right below it) must stay outside the range, or the
          // next block surgery replaces it along with the block.
          next = next.map((r) => {
            const from = tr.changes.mapPos(r.from, 1);
            return {
              ...r,
              from,
              to: Math.max(tr.changes.mapPos(r.to, -1), from),
            };
          });
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
    const heads: HTMLDivElement[] = [];
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
      // One vertical scrollbar for the whole view, on the rightmost pane;
      // the others scroll in lockstep via the sync.
      if (i < labels.length - 1) body.classList.add("legit-merge-novscroll");
      col.append(head, body);
      wrap.appendChild(col);
      cols.push(body);
      colWraps.push(col);
      heads.push(head);
    });
    host.appendChild(wrap);

    // ------------------------------------------------------------------
    // Cross-pane block alignment: every pane pads each conflict block to
    // the tallest version of that block (spacer widgets), so fold bars,
    // context and blocks sit level across the panes. Common stretches are
    // identical text everywhere, so blocks are the only drift source.
    // ------------------------------------------------------------------
    const CONTEXT = 3;
    const MIN_REMAINDER = 3;
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

    // Gap reveals: each gap's expander clicks are tracked once, applied to
    // EVERY pane (the hidden commons are identical text, so a shared reveal
    // keeps the panes aligned). `down` eats into the gap from its top edge,
    // `up` from its bottom edge; the leftover collapses below EXPAND_STEP.
    const gapReveals: Array<{ down: number; up: number }> = [];
    // Which fold slot a placeholder at a given position belongs to, per view.
    const foldSlotByPos = new Map<EditorView, Map<number, number>>();
    // Each pane's base (un-revealed) fold line-range per slot, for surgery.
    const foldBases = new Map<EditorView, Map<number, { from: number; to: number }>>();
    // All mounted panes, filled after construction (surgery + scroll sync).
    const paneViews: EditorView[] = [];
    // Live fold bars: their numbers are re-rendered after every expansion
    // (a reveal moves the boundary the bar ABOVE it describes).
    const foldBars = new Set<{ el: HTMLElement; view: EditorView; from: number }>();
    // Sensible directions per slot: the fold at the file start can only be
    // revealed upward, the one reaching the file end only downward (same
    // rule as the diff's first/last hunk headers). Identical in every pane.
    const slotDirs = new Map<number, "both" | "up" | "down">();

    /** The fold's current (revealed-adjusted) line range in a pane, or null
     *  when it has shrunk below the placeholder threshold. */
    const currentFoldRange = (v: EditorView, k: number) => {
      const b = foldBases.get(v)?.get(k);
      if (!b) return null;
      const r = gapReveals[k] ?? { down: 0, up: 0 };
      const f = b.from + r.down;
      const t = b.to - r.up;
      return t - f + 1 >= MIN_REMAINDER ? { f, t } : null;
    };

    /** The visible chunk (1-based start line + count) below fold `slot` in
     *  a pane, ending at the next still-active fold or the file end. */
    const chunkBelow = (
      v: EditorView,
      slot: number,
    ): { start: number; count: number } | null => {
      const bases = foldBases.get(v);
      if (!bases) return null;
      const total = v.state.doc.lines;
      const own = currentFoldRange(v, slot);
      if (!own) return null;
      const start0 = own.t + 1;
      let end0 = total - 1;
      for (let j = slot + 1; bases.has(j); j++) {
        const next = currentFoldRange(v, j);
        if (next) {
          end0 = next.f - 1;
          break;
        }
      }
      return { start: start0 + 1, count: Math.max(0, end0 - start0 + 1) };
    };

    // Reveal a few more lines of one gap in EVERY pane, surgically: only
    // the affected fold is replaced (one transaction per pane), so the
    // scroll anchor never moves — unlike a wholesale re-fold.
    const expandGap = (view: EditorView, from: number, dir: "down" | "up") => {
      const slot = foldSlotByPos.get(view)?.get(from);
      if (slot === undefined) return;
      const reveal = (gapReveals[slot] ??= { down: 0, up: 0 });
      const before = { ...reveal };
      reveal[dir] += EXPAND_STEP;
      for (const v of paneViews) {
        const base = foldBases.get(v)?.get(slot);
        if (!base) continue;
        const total = v.state.doc.lines;
        const posRange = (f: number, t: number) => ({
          from: v.state.doc.line(Math.min(f + 1, total)).from,
          to: v.state.doc.line(Math.min(t + 1, total)).to,
        });
        const effects = [];
        const slots = foldSlotByPos.get(v);
        const oldF = base.from + before.down;
        const oldT = base.to - before.up;
        if (oldT - oldF + 1 >= MIN_REMAINDER) {
          const old = posRange(oldF, oldT);
          effects.push(unfoldEffect.of(old));
          slots?.delete(old.from);
        }
        const newF = base.from + reveal.down;
        const newT = base.to - reveal.up;
        if (newT - newF + 1 >= MIN_REMAINDER) {
          const next = posRange(newF, newT);
          effects.push(foldEffect.of(next));
          slots?.set(next.from, slot);
        }
        if (effects.length > 0) v.dispatch({ effects });
      }
      refreshFoldBars();
    };

    /** Re-render every live bar's numbers (and prune detached ones). */
    const refreshFoldBars = () => {
      for (const bar of foldBars) {
        if (!bar.el.isConnected) {
          foldBars.delete(bar);
          continue;
        }
        renderFoldBarText(bar.el, bar.view, bar.from);
      }
    };

    const renderFoldBarText = (el: HTMLElement, view: EditorView, from: number) => {
      const slot = foldSlotByPos.get(view)?.get(from);
      const own = slot !== undefined ? chunkBelow(view, slot) : null;
      el.textContent =
        own && own.count > 0 ? `@@ -${own.start},${own.count} +${own.start},${own.count} @@` : "";
    };

    // Result-doc edits (block surgery, manual typing) move the folds through
    // CodeMirror's own decoration mapping; the bookkeeping keyed by absolute
    // positions must follow, or the gutter swaps the shifted folds' expanders
    // for plain line numbers and the fold bars describe stale chunks.
    const remapFoldBookkeeping = (u: ViewUpdate) => {
      const slots = foldSlotByPos.get(u.view);
      if (slots && slots.size > 0) {
        const moved = new Map<number, number>();
        for (const [pos, slot] of slots) moved.set(u.changes.mapPos(pos), slot);
        foldSlotByPos.set(u.view, moved);
      }
      const bases = foldBases.get(u.view);
      if (bases && bases.size > 0) {
        const oldDoc = u.startState.doc;
        const mapLine = (line0: number, edge: "from" | "to") => {
          const old = oldDoc.line(Math.min(line0 + 1, oldDoc.lines));
          const pos = u.changes.mapPos(edge === "from" ? old.from : old.to);
          return u.state.doc.lineAt(pos).number - 1;
        };
        for (const [slot, b] of bases) {
          bases.set(slot, { from: mapLine(b.from, "from"), to: mapLine(b.to, "to") });
        }
      }
      for (const bar of foldBars) {
        if (bar.view === u.view) bar.from = u.changes.mapPos(bar.from);
      }
      refreshFoldBars();
    };

    /** Line-number gutter that swaps in the gap expander on a fold's first
     *  visible row — same placement and behaviour as the diff's hunk
     *  headers. */
    const mergeNumberGutter = gutter({
      class: "cm-diff-gutter",
      lineMarker(view, line) {
        const slot = foldSlotByPos.get(view)?.get(line.from);
        if (slot !== undefined) {
          return new ExpanderMarkerForGap(view, line.from, slotDirs.get(slot) ?? "both");
        }
        return new NumberMarker(String(view.state.doc.lineAt(line.from).number));
      },
      lineMarkerChange: () => true,
    });

    class ExpanderMarkerForGap extends GutterMarker {
      constructor(
        readonly view: EditorView,
        readonly pos: number,
        readonly dirs: "both" | "up" | "down",
      ) {
        super();
      }
      override eq(other: ExpanderMarkerForGap): boolean {
        return other.pos === this.pos && other.view === this.view && other.dirs === this.dirs;
      }
      override toDOM(): HTMLElement {
        const el = expanderPair((dir) => expandGap(this.view, this.pos, dir), false, this.dirs);
        el.classList.add("cm-hunk-expander-fill");
        return el;
      }
    }

    const mergeFolding = codeFolding({
      preparePlaceholder: (state, range) => ({
        lines: state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number + 1,
        from: range.from,
      }),
      placeholderDOM: (view, _onclick, prepared) => {
        const p = prepared as { lines: number; from: number };
        const el = document.createElement("span");
        el.className = "cm-merge-fold";
        // Like a diff hunk header, the bar describes the visible chunk
        // BELOW it (both pairs in this pane's own numbering). A fold
        // reaching the file end has no chunk below - the bar stays an
        // empty band, like the diff's trailing expander row.
        renderFoldBarText(el, view, p.from);
        foldBars.add({ el, view, from: p.from });
        return el;
      },
    });


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
          if (foldSlotByPos.get(view)?.has(line.from)) return new GutterBandMarker();
          const lineNo = view.state.doc.lineAt(line.from).number;
          const i = starts.indexOf(lineNo - 1);
          if (i === -1) return null;
          // "all" derives from the flags, not the line count: an EMPTY side
          // has one synthetic take-nothing flag (emptySelections) and its
          // checkbox must read checked once that flag is set.
          const flags = sel()[i]?.[side] ?? [];
          const state =
            flags.length > 0 && flags.every(Boolean)
              ? "all"
              : flags.some(Boolean)
                ? "some"
                : "none";
          return new BlockCheckMarker(state, Math.max(lens[i], 1), lens[i] === 0, () =>
            onToggleBlockRef.current(i, side),
          );
        },
        // Recompute on every update: selection toggles AND fold changes
        // must both refresh these cells (band fillers on fold rows).
        lineMarkerChange: () => true,
      });
      const lineGutter = gutter({
        class: "cm-diff-action-gutter",
        lineMarker(view, line) {
          if (foldSlotByPos.get(view)?.has(line.from)) return new GutterBandMarker();
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
        // Recompute on every update: selection toggles AND fold changes
        // must both refresh these cells (band fillers on fold rows).
        lineMarkerChange: () => true,
      });
      const spacers = spacerField(
        () => starts,
        () => lens,
        () => (side === "ours" ? offOursRef.current : offTheirsRef.current),
      );
      return [baseTheme, mergeTheme, mergeNumberGutter, mergeFolding, deco, checkGutter, lineGutter, spacers, ...readOnly];
    };

    const sidePane = (parent: HTMLElement, text: string | null, note: string, ext?: Extension[]) =>
      new EditorView({
        state: EditorState.create({
          doc: text ?? note,
          extensions: ext ?? [baseTheme, mergeTheme, mergeNumberGutter, mergeFolding, ...readOnly],
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
    // Header checkboxes: select/clear a whole side across ALL blocks, the
    // bulk counterpart of the per-block gutter checkbox. Each is positioned
    // over its pane's checkbox-gutter column so header and gutter boxes
    // line up; the label moves right of it.
    // ------------------------------------------------------------------
    const headerBoxes: { box: HTMLInputElement; side: "ours" | "theirs" }[] = [];
    const attachHeaderCheck = (
      head: HTMLDivElement,
      view: EditorView,
      side: "ours" | "theirs",
    ) => {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.title = "Include this whole side in the result (all conflicts)";
      box.style.position = "absolute";
      box.style.top = "50%";
      box.style.transform = "translateY(-50%)";
      box.style.margin = "0";
      box.addEventListener("change", () => onToggleSideAllRef.current(side));
      head.style.position = "relative";
      head.appendChild(box);
      headerBoxes.push({ box, side });
      // Align with the gutter checkboxes once CodeMirror has measured them.
      requestAnimationFrame(() => {
        const gutterEl = view.dom.querySelector(".cm-conflict-check-gutter");
        if (!gutterEl || !head.isConnected) return;
        const g = gutterEl.getBoundingClientRect();
        const h = head.getBoundingClientRect();
        if (g.width === 0) return;
        const left = g.left - h.left + (g.width - box.offsetWidth) / 2;
        if (left > 0) {
          box.style.left = `${left}px`;
          head.style.paddingLeft = `${left + box.offsetWidth + 6}px`;
        }
      });
    };
    if (ours !== null) attachHeaderCheck(heads[0], oursView, "ours");
    if (theirs !== null) attachHeaderCheck(heads[centreCol + 1], theirsView, "theirs");

    const updateHeaderChecks = () => {
      for (const { box, side } of headerBoxes) {
        const flags = sel().flatMap((s) => s[side]);
        const all = flags.length > 0 && flags.every(Boolean);
        const some = flags.some(Boolean);
        box.checked = all;
        box.indeterminate = some && !all;
      }
    };
    updateHeaderChecks();
    updateHeaderChecksRef.current = updateHeaderChecks;

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
          mergeNumberGutter,
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
              remapFoldBookkeeping(u);
              onDirtyRef.current();
              // Edits can change block heights (spacers) and the result's
              // geometry; re-pad, then re-align the sides once measurable.
              // The alignRefresh dispatch also redraws the gutters with the
              // remapped fold positions.
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
    // Unified scrolling: the panes are hard-aligned (equal heights by
    // spacers/folds), so identity scrollTop sync is exact. The value guard
    // breaks the async scroll-event echo loop.
    // ------------------------------------------------------------------
    paneViews.push(oursView, resultView, theirsView);
    const syncScroll = (src: EditorView) => {
      const top = src.scrollDOM.scrollTop;
      for (const v of paneViews) {
        if (v !== src && Math.abs(v.scrollDOM.scrollTop - top) > 0.5) {
          v.scrollDOM.scrollTop = top;
        }
      }
    };
    const listeners = paneViews.map((v) => {
      const fn = () => syncScroll(v);
      v.scrollDOM.addEventListener("scroll", fn);
      return [v, fn] as const;
    });
    // The hidden-overflow panes cannot wheel-scroll or middle-button-pan
    // natively; provide both ourselves (the sync mirrors to the others).
    const wheelListeners = [oursView, resultView].map((v) => {
      const fn = (e: WheelEvent) => {
        e.preventDefault();
        const scale = e.deltaMode === 1 ? 24 : 1;
        v.scrollDOM.scrollTop += e.deltaY * scale;
        v.scrollDOM.scrollLeft += e.deltaX * scale;
      };
      v.scrollDOM.addEventListener("wheel", fn, { passive: false });
      return [v, fn] as const;
    });
    const panListeners = [oursView, resultView].map((v) => {
      const el = v.scrollDOM;
      const onDown = (e: MouseEvent) => {
        if (e.button !== 1) return;
        e.preventDefault();
        const ox = e.clientX;
        const oy = e.clientY;
        let cx = ox;
        let cy = oy;
        let raf = 0;
        const move = (m: MouseEvent) => {
          cx = m.clientX;
          cy = m.clientY;
        };
        const DEAD = 4;
        const step = () => {
          const dy = cy - oy;
          const dx = cx - ox;
          if (Math.abs(dy) > DEAD) el.scrollTop += dy * 0.15;
          if (Math.abs(dx) > DEAD) el.scrollLeft += dx * 0.15;
          raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        // Pan cursor for the whole gesture, on <body> so it survives the
        // pointer leaving the pane (the move/up listeners are on window).
        const prevCursor = document.body.style.cursor;
        document.body.style.cursor = "all-scroll";
        const end = () => {
          cancelAnimationFrame(raf);
          document.body.style.cursor = prevCursor;
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", end);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", end);
      };
      el.addEventListener("mousedown", onDown);
      return [el, onDown] as const;
    });
    followRef.current = () => syncScroll(resultView);
    resultView.scrollDOM.scrollTop = centreScrollRef.current;
    syncScroll(resultView);

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
      for (const v of paneViews) v.dispatch({ effects: alignRefresh.of(null) });
    };
    recomputeRef.current = recomputeAlignment;
    recomputeAlignment();

    // Conflicts view: fold each pane's common stretches (3 context lines
    // stay visible around every block). Ranges are per pane; the result's
    // come from its LIVE tracked blocks so they are correct after surgery.
    const applyFolds = (on: boolean) => {
      // Captured before any fold dispatch: the transient unfold state must
      // not be what we anchor to.
      const keep = resultView.scrollDOM.scrollTop;
      const paneFold = (view: EditorView, starts: number[], lens: number[]) => {
        unfoldAll(view);
        foldSlotByPos.set(view, new Map());
        foldBases.set(view, new Map());
        if (!on) return;
        const total = view.state.doc.lines;
        const slots = foldSlotByPos.get(view)!;
        const paneBases = foldBases.get(view)!;
        const effects = [];
        const bases = foldableRanges(starts, lens, total, CONTEXT);
        for (let k = 0; k < bases.length; k++) {
          paneBases.set(k, bases[k]);
          slotDirs.set(
            k,
            bases[k].from === 0 ? "up" : bases[k].to === total - 1 ? "down" : "both",
          );
          const reveal = gapReveals[k] ?? { down: 0, up: 0 };
          const from = bases[k].from + reveal.down;
          const to = bases[k].to - reveal.up;
          if (to - from + 1 < MIN_REMAINDER) continue; // fully / nearly revealed
          const pos = view.state.doc.line(Math.min(from + 1, total)).from;
          slots.set(pos, k);
          effects.push(
            foldEffect.of({
              from: pos,
              to: view.state.doc.line(Math.min(to + 1, total)).to,
            }),
          );
        }
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
      // Full re-applies (view-mode toggle) pin the scroll; expander clicks
      // go through the surgical path and never get here.
      resultView.requestMeasure({
        read: () => null,
        write: () => {
          resultView.scrollDOM.scrollTop = keep;
          followRef.current?.();
        },
      });
    };
    applyFoldsRef.current = applyFolds;
    if (foldCommon) applyFolds(true);

    viewsRef.current = { result: resultView, sides: [oursView, theirsView], rangesField };

    return () => {
      disposed = true;
      viewsRef.current = null;
      updateHeaderChecksRef.current = null;
      centreScrollRef.current = resultView.scrollDOM.scrollTop;
      for (const [v, fn] of listeners) v.scrollDOM.removeEventListener("scroll", fn);
      for (const [v, fn] of wheelListeners) v.scrollDOM.removeEventListener("wheel", fn);
      for (const [el, fn] of panListeners) el.removeEventListener("mousedown", fn);
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
      // Origin counts CONTRIBUTED lines (blockOrigin), not raw flags: an
      // empty side's synthetic flag adds no line, and a raw count would
      // tint a line that is not part of the composed block.
      const origin = anySelected ? blockOrigin(region, s) : null;
      const range = result.state.field(rangesField)[index];
      if (!range) return;
      const doc = result.state.doc;
      let from = range.from;
      let to = Math.min(range.to, doc.length);
      if (range.origin === null) {
        // Markers still present: replace only the marker span itself, so
        // manual edits that drifted INTO the tracked range (lines typed
        // below ">>>>>>>" after an Enter at its end) survive the surgery.
        let markerFrom = -1;
        let markerTo = -1;
        for (let pos = from; pos < to; ) {
          const line = doc.lineAt(pos);
          if (markerFrom === -1 && line.text.startsWith("<<<<<<<")) markerFrom = line.from;
          if (line.text.startsWith(">>>>>>>")) {
            markerTo = Math.min(line.to + 1, doc.length);
            break;
          }
          pos = line.to + 1;
        }
        if (markerFrom !== -1 && markerTo !== -1) {
          from = markerFrom;
          to = markerTo;
        }
      }
      const insert = lines.length > 0 ? `${lines.join("\n")}\n` : "";
      result.dispatch({
        changes: { from, to, insert },
        effects: setBlockRange.of({
          index,
          from,
          to: from + insert.length,
          origin,
        }),
      });
      for (const v of sides) v.dispatch({ effects: selectionRefresh.of(null) });
      updateHeaderChecksRef.current?.();
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

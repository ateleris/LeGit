// GitHub-style hunk/gap expander: a stacked pair of chevron buttons that
// reveal a few more hidden lines per click (downward from the top edge of
// the gap, upward from its bottom edge). Shared by the Diff panel's hunk
// headers and the Merge panel's fold bars so the two look and work alike.

/** Lines revealed per expander click. */
export const EXPAND_STEP = 5;

function chevron(up: boolean): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", up ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6");
  svg.appendChild(path);
  return svg;
}

/** The header band without buttons: keeps the hunk row's grey bar running
 *  across the number gutters when there is nothing left to reveal. */
export function headerBand(spanTwoColumns = false): HTMLElement {
  const el = document.createElement("div");
  el.className = spanTwoColumns
    ? "cm-hunk-expander cm-hunk-band cm-hunk-expander-span2"
    : "cm-hunk-expander cm-hunk-band";
  return el;
}

/**
 * The stacked ↓/↑ pair. `onExpand("down")` must reveal lines at the TOP of
 * the hidden region (below the content above it); `onExpand("up")` at its
 * BOTTOM (above the content below it) — GitHub's semantics.
 */
export function expanderPair(
  onExpand: (dir: "down" | "up") => void,
  /** Stretch across two number columns (the inline diff's old+new gutters). */
  spanTwoColumns = false,
  /** Which directions make sense here: a gap at the file start can only be
   *  revealed upward, the tail after the last hunk only downward. */
  dirs: "both" | "up" | "down" = "both",
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = spanTwoColumns
    ? "cm-hunk-expander cm-hunk-expander-span2"
    : "cm-hunk-expander";
  const mk = (dir: "down" | "up") => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-hunk-expander-btn";
    btn.title = dir === "down" ? "Show more lines below" : "Show more lines above";
    btn.appendChild(chevron(dir === "up"));
    btn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      onExpand(dir);
    });
    return btn;
  };
  if (dirs === "both") wrap.append(mk("down"), mk("up"));
  else wrap.append(mk(dirs));
  return wrap;
}

/** Theme rules for the expander (spread into an EditorView.theme object). */
export const EXPANDER_THEME = {
  ".cm-hunk-expander": {
    display: "flex",
    flexDirection: "column" as const,
    alignSelf: "stretch",
    justifyContent: "center" as const,
    flexShrink: "0",
    width: "100%",
    height: "100%",
  },
  // Spans BOTH number columns: absolutely positioned over the measured
  // number-gutter width, layered above the sibling gutter's background.
  ".cm-hunk-expander-span2": {
    // Positions from the cell's padding box, which (borderless) IS the
    // cell's left edge - no offset needed.
    position: "absolute" as const,
    left: "0",
    top: "0",
    width: "var(--cm-number-gutters-width, 200%)",
    height: "100%",
    boxSizing: "border-box" as const,
    zIndex: "3",
  },
  ".cm-hunk-band": {
    background: "var(--diff-hunk-header-bg)",
  },
  ".cm-hunk-expander-btn": {
    display: "flex",
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flex: "1",
    width: "100%",
    padding: "0 4px",
    border: "none",
    borderRadius: "0",
    // Same band as the hunk-header row the buttons belong to.
    background: "var(--diff-hunk-header-bg)",
    color: "var(--diff-action-fg)",
    cursor: "pointer",
  },
  ".cm-hunk-expander-btn:hover": {
    color: "var(--diff-action-hover-fg)",
    background: "color-mix(in srgb, var(--diff-hunk-header-bg) 60%, var(--panel-fg) 12%)",
  },
  ".cm-hunk-expander-btn svg": {
    display: "block",
    width: "1.1em",
    height: "1.1em",
  },
};

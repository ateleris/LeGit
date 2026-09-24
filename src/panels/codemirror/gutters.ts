// Shared gutter building blocks: the plain number marker, the +/− action
// icon, and the plugins mirroring the (font-scaled) gutter widths into CSS
// vars so sticky in-line chrome can pin just right of the gutters.

import { EditorView, GutterMarker, ViewPlugin } from "@codemirror/view";

export class NumberMarker extends GutterMarker {
  constructor(private readonly value: string) {
    super();
  }
  eq(other: NumberMarker) {
    return other.value === this.value;
  }
  toDOM() {
    return document.createTextNode(this.value);
  }
}

/** A lucide-style plus (stage) or minus (unstage) icon, stroked in currentColor
 *  so it follows the button's `diff.action.*` colour. */
export function plusMinusIcon(plus: boolean): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const horizontal = document.createElementNS(NS, "path");
  horizontal.setAttribute("d", "M5 12h14");
  svg.appendChild(horizontal);
  if (plus) {
    const vertical = document.createElementNS(NS, "path");
    vertical.setAttribute("d", "M12 5v14");
    svg.appendChild(vertical);
  }
  return svg;
}

// The gutters are sticky and overlay horizontally scrolled content, so a
// sticky-left element inside a line must pin just RIGHT of them. Their width
// is not a CSS constant (it scales with the font size and the number digit
// count), so this plugin mirrors it into `--cm-gutters-width` on the scroller.
const guttersWidthMeasure = {
  read(view: EditorView): number {
    const gutters = view.scrollDOM.querySelector(".cm-gutters");
    return gutters instanceof HTMLElement ? gutters.offsetWidth : 0;
  },
  write(width: number, view: EditorView) {
    view.scrollDOM.style.setProperty("--cm-gutters-width", `${width}px`);
  },
};

export const guttersWidthVar = ViewPlugin.define((view) => {
  view.requestMeasure(guttersWidthMeasure);
  return {
    update(update) {
      if (update.geometryChanged) update.view.requestMeasure(guttersWidthMeasure);
    },
  };
});

// Combined width of the NUMBER gutter columns only (excludes the action /
// checkbox gutters) — the hunk expander stretches across exactly these.
const numberGuttersMeasure = {
  read(view: EditorView): number {
    let width = 0;
    view.scrollDOM.querySelectorAll(".cm-gutter.cm-diff-gutter").forEach((g) => {
      if (g instanceof HTMLElement) width += g.offsetWidth;
    });
    return width;
  },
  write(width: number, view: EditorView) {
    view.scrollDOM.style.setProperty("--cm-number-gutters-width", `${width}px`);
  },
};

export const numberGuttersWidthVar = ViewPlugin.define((view) => {
  view.requestMeasure(numberGuttersMeasure);
  return {
    update(update) {
      if (update.geometryChanged) update.view.requestMeasure(numberGuttersMeasure);
    },
  };
});

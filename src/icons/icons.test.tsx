// @vitest-environment happy-dom
//
// Pins the icon-system defaults. The flex-shrink pin exists because of a real
// bug (2026-07-31): chips are inline-flex with overflow hidden, and an icon
// with default flex-shrink 1 was squeezed horizontally (12px -> 5.3px) in the
// ref-chip overflow popover when the chip text was long - the cloud rendered
// tiny. Icons render at 1em by design and must never shrink as flex items;
// jsdom does no layout, so the default itself is the testable seam.
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { RemoteIcon } from "./index";

function renderSvg(ui: React.ReactElement): SVGSVGElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  const svg = host.querySelector("svg");
  if (!svg) throw new Error("icon did not render an svg");
  return svg;
}

describe("icon defaults", () => {
  it("sizes icons at 1em", () => {
    const svg = renderSvg(<RemoteIcon />);
    expect(svg.getAttribute("width")).toBe("1em");
    expect(svg.getAttribute("height")).toBe("1em");
  });

  it("never lets an icon flex-shrink below its 1em box", () => {
    const svg = renderSvg(<RemoteIcon />);
    expect(svg.style.flexShrink).toBe("0");
  });

  it("keeps caller style overrides winning over the defaults", () => {
    const svg = renderSvg(<RemoteIcon style={{ flexShrink: 1, verticalAlign: "middle" }} />);
    expect(svg.style.flexShrink).toBe("1");
    expect(svg.style.verticalAlign).toBe("middle");
  });
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useReducedMotion } from "./useReducedMotion";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** Controllable stand-in for window.matchMedia: happy-dom's own
 *  implementation cannot flip `prefers-reduced-motion` at runtime. */
function installMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: initial,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
  };
  const queries: string[] = [];
  window.matchMedia = ((query: string) => {
    queries.push(query);
    return mql;
  }) as unknown as typeof window.matchMedia;
  return {
    queries,
    set(matches: boolean) {
      mql.matches = matches;
      for (const cb of [...listeners]) cb();
    },
  };
}

function Probe() {
  return <span id="probe">{String(useReducedMotion())}</span>;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = () => act(async () => root.render(<Probe />));
const probeText = () => host.querySelector("#probe")?.textContent;

describe("useReducedMotion", () => {
  it("reports whether the OS requests reduced motion", async () => {
    const media = installMatchMedia(true);
    await render();
    expect(probeText()).toBe("true");
    expect(media.queries).toContain("(prefers-reduced-motion: reduce)");
  });

  it("reports false when motion is allowed", async () => {
    installMatchMedia(false);
    await render();
    expect(probeText()).toBe("false");
  });

  it("tracks a live change of the preference", async () => {
    const media = installMatchMedia(false);
    await render();
    expect(probeText()).toBe("false");
    act(() => media.set(true));
    expect(probeText()).toBe("true");
  });
});

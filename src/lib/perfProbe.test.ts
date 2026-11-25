// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("./commands", () => ({ api: { frontendLog: () => Promise.resolve() } }));

import { describeLongFrame, describeTarget } from "./perfProbe";

describe("describeLongFrame", () => {
  it("names the duration, the preceding interaction and the costliest scripts", () => {
    const line = describeLongFrame(
      {
        startTime: 1200,
        duration: 1480.4,
        blockingDuration: 1430,
        scripts: [
          { duration: 20, invoker: "TimerHandler:setTimeout" },
          {
            duration: 1400,
            invoker: "BUTTON.onclick",
            sourceFunctionName: "buildMergeView",
            sourceURL: "http://localhost:1420/src/panels/Merge/MergeView.tsx?t=1",
          },
        ],
      },
      { time: 1000, what: 'pointerdown on button "Stage"' },
    );
    expect(line).toBe(
      'long frame 1480 ms, blocking 1430 ms, 200 ms after pointerdown on button "Stage", ' +
        "scripts: 1400 ms BUTTON.onclick (buildMergeView @ src/panels/Merge/MergeView.tsx); " +
        "20 ms TimerHandler:setTimeout",
    );
  });

  it("leaves out an interaction that is too old or came after the frame", () => {
    const frame = { startTime: 9000, duration: 80 };
    expect(describeLongFrame(frame, { time: 1000, what: "keydown a" })).toBe("long frame 80 ms");
    expect(describeLongFrame(frame, { time: 9500, what: "keydown a" })).toBe("long frame 80 ms");
    expect(describeLongFrame(frame, null)).toBe("long frame 80 ms");
  });
});

describe("describeTarget", () => {
  it("prefers a test id, then a title, then the text", () => {
    document.body.innerHTML =
      '<button data-testid="menu-merge"><span id="a">Merge</span></button>' +
      '<button title="Stage"><i id="b"></i></button><div id="c">plain text here</div>';
    expect(describeTarget("pointerdown", document.getElementById("a"))).toBe(
      'pointerdown on button "menu-merge"',
    );
    expect(describeTarget("pointerdown", document.getElementById("b"))).toBe(
      'pointerdown on button "Stage"',
    );
    expect(describeTarget("keydown", document.getElementById("c"), "Enter")).toBe(
      'keydown Enter on div "plain text here"',
    );
    expect(describeTarget("keydown", null, "Escape")).toBe("keydown Escape");
  });
});

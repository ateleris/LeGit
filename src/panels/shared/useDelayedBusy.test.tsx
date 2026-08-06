// @vitest-environment happy-dom
//
// Pins the delayed-busy contract (CLAUDE.md "Busy/loading feedback is
// delayed, never instant") for the shared hook every settings-form action
// runs through:
//   - the visual `busy` flag appears only after ~150ms (fast ops never
//     flicker their disabled state),
//   - re-entry is blocked IMMEDIATELY via the ref guard, before the flag
//     shows,
//   - the timer is cleared and the guard released in `finally`, so a
//     failing action still resets and errors propagate to the caller.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDelayedBusy } from "./useDelayedBusy";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let run: (fn: () => Promise<unknown> | unknown) => Promise<void>;

function Harness() {
  const hook = useDelayedBusy();
  run = hook.run;
  return <div id="busy">{hook.busy ? "busy" : "idle"}</div>;
}

/** A promise resolvable/rejectable from the test body. */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useDelayedBusy", () => {
  let container: HTMLElement;
  let root: Root;

  const busyText = () => container.querySelector("#busy")!.textContent;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never shows busy for an action faster than the delay", async () => {
    const d = deferred();
    let done: Promise<void>;
    act(() => {
      done = run(() => d.promise);
    });
    await act(async () => {
      vi.advanceTimersByTime(100); // < 150ms: still idle
    });
    expect(busyText()).toBe("idle");
    await act(async () => {
      d.resolve();
      await done;
    });
    await act(async () => {
      vi.advanceTimersByTime(200); // a cleared timer must not fire late
    });
    expect(busyText()).toBe("idle");
  });

  it("shows busy after the delay and clears it when the action settles", async () => {
    const d = deferred();
    let done: Promise<void>;
    act(() => {
      done = run(() => d.promise);
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(busyText()).toBe("busy");
    await act(async () => {
      d.resolve();
      await done;
    });
    expect(busyText()).toBe("idle");
  });

  it("blocks re-entry immediately, before the busy flag shows", async () => {
    const d = deferred();
    const second = vi.fn();
    let done: Promise<void>;
    act(() => {
      done = run(() => d.promise);
    });
    // No timer advance: busy is still visually false, yet the guard holds.
    expect(busyText()).toBe("idle");
    await act(async () => {
      await run(second);
    });
    expect(second).not.toHaveBeenCalled();
    await act(async () => {
      d.resolve();
      await done;
    });
  });

  it("resets the guard and flag when the action throws, and propagates the error", async () => {
    const boom = new Error("boom");
    let caught: unknown = null;
    await act(async () => {
      await run(() => Promise.reject(boom)).catch((e) => {
        caught = e;
      });
    });
    expect(caught).toBe(boom);
    expect(busyText()).toBe("idle");
    await act(async () => {
      vi.advanceTimersByTime(300); // cleared timer must not flip busy late
    });
    expect(busyText()).toBe("idle");
    // Guard released: the next action runs.
    const next = vi.fn();
    await act(async () => {
      await run(next);
    });
    expect(next).toHaveBeenCalledTimes(1);
  });
});

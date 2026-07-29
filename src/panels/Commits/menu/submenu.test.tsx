// @vitest-environment happy-dom
//
// Behavior tests for the Submenu primitive's open/close rules:
// - hovering a trigger opens its flyout immediately
// - at most one flyout is open per menu level: hovering a sibling submenu
//   closes the previous one at once (no grace delay, no flyout trail)
// - leaving a trigger closes its flyout only after the grace delay, so the
//   pointer can travel diagonally into the flyout across sibling entries
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MenuItem, MenuLevelProvider, Submenu } from "./primitives";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function TwoSubmenus() {
  return (
    <MenuLevelProvider>
      <Submenu testId="sub-a" label="A">
        <MenuItem testId="item-a" onClick={() => {}}>
          a-entry
        </MenuItem>
      </Submenu>
      <Submenu testId="sub-b" label="B">
        <MenuItem testId="item-b" onClick={() => {}}>
          b-entry
        </MenuItem>
      </Submenu>
    </MenuLevelProvider>
  );
}

// A branch-section shape: a submenu whose flyout holds plain entries plus a
// nested submenu (like Rename/Rebase next to the Merge variants).
function NestedSubmenus() {
  return (
    <MenuLevelProvider>
      <Submenu testId="sub-1" label="branch">
        <MenuItem testId="rename" onClick={() => {}}>
          rename
        </MenuItem>
        <Submenu testId="sub-2" label="merge">
          <MenuItem testId="merge-default" onClick={() => {}}>
            merge
          </MenuItem>
        </Submenu>
      </Submenu>
    </MenuLevelProvider>
  );
}

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`);

// React derives onMouseEnter/onMouseLeave from mouseover/mouseout pairs, so
// dispatch those (with a relatedTarget outside the element) instead of the
// non-bubbling native enter/leave events.
async function hover(el: Element) {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }),
    );
  });
}

async function unhover(el: Element) {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
    );
  });
}

// A faithful pointer move between two React-managed elements: one mouseout on
// the source with relatedTarget = destination. React synthesizes the full
// leave path (source up to the React-tree common ancestor) AND the enter path
// (down to the destination) from that single event — and it deliberately
// IGNORES a mouseover whose relatedTarget is React-managed, so dispatching
// the mouseover side would do nothing. Using relatedTarget = document.body
// instead would fire enter/leave on the ENTIRE path and mask bugs in
// intermediate levels.
async function moveMouse(from: Element, to: Element) {
  await act(async () => {
    from.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: to }));
  });
}

describe("Submenu", () => {
  it("opens its flyout on trigger hover", async () => {
    await act(async () => root.render(<TwoSubmenus />));
    expect(byTestId("item-a")).toBeNull();
    await hover(byTestId("sub-a")!);
    expect(byTestId("item-a")).not.toBeNull();
  });

  it("closes immediately when a sibling submenu opens", async () => {
    await act(async () => root.render(<TwoSubmenus />));
    await hover(byTestId("sub-a")!);
    await unhover(byTestId("sub-a")!);
    await hover(byTestId("sub-b")!);
    // No timer advance: the sibling takeover must not wait for the grace delay.
    expect(byTestId("item-a")).toBeNull();
    expect(byTestId("item-b")).not.toBeNull();
  });

  it("keeps the parent flyout open when leaving a nested trigger for a plain sibling", async () => {
    await act(async () => root.render(<NestedSubmenus />));
    await hover(byTestId("sub-1")!);
    await hover(byTestId("sub-2")!);
    expect(byTestId("merge-default")).not.toBeNull();
    // Pointer moves from the nested trigger to a plain entry in the SAME
    // parent flyout: the nested flyout closes after its grace delay, but the
    // parent flyout must survive (the pointer never left it).
    await unhover(byTestId("sub-2")!);
    await hover(byTestId("rename")!);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(byTestId("merge-default")).toBeNull();
    expect(byTestId("rename")).not.toBeNull();
  });

  it("keeps the parent flyout open when moving from a nested flyout back into it", async () => {
    await act(async () => root.render(<NestedSubmenus />));
    await hover(byTestId("sub-1")!);
    await moveMouse(byTestId("sub-1")!, byTestId("sub-2")!);
    await moveMouse(byTestId("sub-2")!, byTestId("merge-default")!);
    // Pointer returns from an entry in the nested flyout to a plain entry in
    // the parent flyout. In the React tree the nested flyout is a descendant
    // of the parent flyout, so the parent gets NO mouseenter on this move —
    // only the nested flyout's mouseleave fires. The parent must not be
    // closed by proxy (this was a real bug: a chained leave scheduled the
    // parent's close and nothing cancelled it).
    await moveMouse(byTestId("merge-default")!, byTestId("rename")!);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(byTestId("merge-default")).toBeNull();
    expect(byTestId("rename")).not.toBeNull();
  });

  it("closes every level when the pointer leaves the whole stack", async () => {
    await act(async () => root.render(<NestedSubmenus />));
    await hover(byTestId("sub-1")!);
    await moveMouse(byTestId("sub-1")!, byTestId("sub-2")!);
    await moveMouse(byTestId("sub-2")!, byTestId("merge-default")!);
    // Leaving the nested flyout for "nowhere" fires mouseleave on both
    // levels (React synthesizes the full leave path), so both close.
    await unhover(byTestId("merge-default")!);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(byTestId("merge-default")).toBeNull();
    expect(byTestId("rename")).toBeNull();
  });

  it("keeps the flyout open through the grace delay for diagonal travel", async () => {
    await act(async () => root.render(<TwoSubmenus />));
    const trigger = byTestId("sub-a")!;
    await hover(trigger);
    await unhover(trigger);
    // Still open right after leaving the trigger…
    expect(byTestId("item-a")).not.toBeNull();
    // …re-entering the flyout within the grace period keeps it open…
    await hover(byTestId("item-a")!.parentElement!);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(byTestId("item-a")).not.toBeNull();
    // …and leaving it closes it after the delay.
    await unhover(byTestId("item-a")!.parentElement!);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(byTestId("item-a")).toBeNull();
  });
});

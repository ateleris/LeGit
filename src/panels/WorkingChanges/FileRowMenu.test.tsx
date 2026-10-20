// @vitest-environment happy-dom
//
// The conflict entries of the working-changes row menu:
// - a single conflicted row gets flat branch-named Take entries
// - a multi-selection gets ONE "Resolve N conflicted" submenu acting on the
//   conflicted subset of the selection only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MenuLevelProvider } from "../shared/menu/primitives";
import { FileRowMenu } from "./FileRowMenu";
import type { ConflictKind } from "../../lib/types";
import type { Section } from "./selection";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`);

async function hover(el: Element) {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }),
    );
  });
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function menu({
  section = "unstaged" as Section,
  targets = ["a.txt"],
  conflicted = new Map<string, ConflictKind>(),
  onTakeSide = vi.fn(),
  onMarkResolved = vi.fn(),
}) {
  return (
    <MenuLevelProvider>
      <FileRowMenu
        section={section}
        file={{ path: targets[0], change: conflicted.has(targets[0]) ? "Conflicted" : "Modified" }}
        targets={targets}
        opActive={true}
        reopenable={new Set()}
        conflictKinds={conflicted}
        sideNames={{ ours: "dev", theirs: "feature/x" }}
        stashable={[]}
        onPrimary={() => {}}
        onDiscard={() => {}}
        onStash={() => {}}
        onTakeSide={onTakeSide}
        onMarkResolved={onMarkResolved}
        onReopenConflict={() => {}}
        onOpenSubmodule={() => {}}
        closeMenu={() => {}}
      />
    </MenuLevelProvider>
  );
}

describe("FileRowMenu conflict entries", () => {
  it("a single conflicted row gets the same submenu, kind-aware", async () => {
    const onTakeSide = vi.fn();
    const conflicted = new Map<string, ConflictKind>([["a.txt", "deleted_by_them"]]);
    await act(async () => root.render(menu({ conflicted, onTakeSide })));

    const trigger = byTestId("resolve-conflicted")!;
    expect(trigger.textContent).toContain("Resolve conflict");

    await hover(trigger);
    const theirs = byTestId("resolve-take-theirs")!;
    expect(theirs.textContent).toBe("Take 'feature/x' (deletes file)");
    await click(theirs);
    expect(onTakeSide).toHaveBeenCalledWith(["a.txt"], "theirs");
  });

  it("a multi-selection gets a resolve submenu acting on the conflicted subset", async () => {
    const onTakeSide = vi.fn();
    const onMarkResolved = vi.fn();
    const conflicted = new Map<string, ConflictKind>([
      ["a.txt", "both_modified"],
      ["b.txt", "deleted_by_them"],
    ]);
    await act(async () =>
      root.render(
        menu({ targets: ["a.txt", "b.txt", "clean.txt"], conflicted, onTakeSide, onMarkResolved }),
      ),
    );

    const trigger = byTestId("resolve-conflicted")!;
    expect(trigger.textContent).toContain("Resolve 2 conflicted");

    await hover(trigger);
    await click(byTestId("resolve-take-theirs")!);
    expect(onTakeSide).toHaveBeenCalledWith(["a.txt", "b.txt"], "theirs");

    await hover(trigger);
    await click(byTestId("resolve-mark-resolved")!);
    expect(onMarkResolved).toHaveBeenCalledWith(["a.txt", "b.txt"]);
  });

  it("a multi-selection without conflicts gets no resolve submenu", async () => {
    await act(async () => root.render(menu({ targets: ["a.txt", "b.txt"] })));
    expect(byTestId("resolve-conflicted")).toBeNull();
  });

  it("the staged section never offers conflict resolution", async () => {
    const conflicted = new Map<string, ConflictKind>([["a.txt", "both_modified"]]);
    await act(async () =>
      root.render(menu({ section: "staged", targets: ["a.txt", "b.txt"], conflicted })),
    );
    expect(byTestId("resolve-conflicted")).toBeNull();
  });
});

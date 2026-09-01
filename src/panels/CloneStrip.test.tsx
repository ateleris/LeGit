// @vitest-environment happy-dom
//
// Regression test for the orphaned clone: the clone dialog used to hold the
// op id in a component ref, so dismissing it left the clone running with no
// progress readout and no way to cancel it. The strip is app chrome fed by
// `useCloneStore`, so it survives the form that started the clone.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const cancelClone = vi.fn((_opId: string) => Promise.resolve(true));
vi.mock("../lib/commands", () => ({ cancelClone: (id: string) => cancelClone(id) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(() => Promise.resolve(null)) }));

import { CloneStrip } from "./CloneStrip";
import { CloneForm } from "./Repositories/forms";
import { useCloneStore } from "../store/clone";
import { useRemoteProgressStore } from "../store/remoteProgress";
import { useRepoStore } from "../store/repos";
import { useSettingsStore } from "../store/settings";

/** A clone that stays in flight until the returned resolver is called. */
function pendingClone() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => (resolve = r));
  useRepoStore.setState({ cloneRepo: vi.fn(() => promise) } as never);
  return resolve;
}

describe("CloneStrip", () => {
  let container: HTMLElement;
  let root: Root;

  const rows = () => Array.from(container.querySelectorAll('[data-testid="clone-strip-row"]'));
  const rowText = (i = 0) => rows()[i].textContent ?? "";
  const cancelButton = (i = 0) =>
    Array.from(rows()[i].querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Cancel"),
    )!;

  beforeEach(() => {
    cancelClone.mockClear();
    useCloneStore.setState({ jobs: {}, completedCount: 0 });
    useRemoteProgressStore.setState({ byOp: {} });
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("renders nothing while no clone is running", () => {
    act(() => root.render(<CloneStrip />));
    expect(container.innerHTML).toBe("");
  });

  it("shows one row per clone, with the live meter once git reports one", () => {
    pendingClone();
    act(() => root.render(<CloneStrip />));

    let opId = "";
    act(() => {
      opId = useCloneStore.getState().start({
        url: "https://example.com/legit.git",
        parentDir: "/src",
        name: "legit",
        profileId: null,
        options: {},
      });
    });

    expect(rows()).toHaveLength(1);
    // No meter yet: git has not printed its first progress line.
    expect(rowText()).toContain("Cloning legit");
    expect(rowText()).toContain("starting…");

    act(() => {
      useRemoteProgressStore.getState().report(opId, { phase: "Receiving objects", percent: 42 });
    });
    expect(rowText()).toContain("Receiving objects 42%");

    act(() => {
      useCloneStore.getState().start({
        url: "https://example.com/other.git",
        parentDir: "/src",
        name: "other",
        profileId: null,
        options: {},
      });
    });
    expect(rows()).toHaveLength(2);
  });

  it("cancels the clone and reports that it is cancelling", () => {
    pendingClone();
    act(() => root.render(<CloneStrip />));
    let opId = "";
    act(() => {
      opId = useCloneStore.getState().start({
        url: "https://example.com/legit.git",
        parentDir: "/src",
        name: "legit",
        profileId: null,
        options: {},
      });
    });

    act(() => cancelButton().click());

    expect(cancelClone).toHaveBeenCalledWith(opId);
    expect(rowText()).toContain("cancelling…");
    // The kill is not instant - a second click must not fire again.
    expect(cancelButton().disabled).toBe(true);
  });

  it("keeps the clone visible and cancellable after its dialog is dismissed", () => {
    pendingClone();
    useSettingsStore.setState({ settings: null } as never);

    // Two roots: the dismissable dialog host, and the app-chrome strip.
    const formContainer = document.createElement("div");
    document.body.appendChild(formContainer);
    const formRoot = createRoot(formContainer);

    act(() => root.render(<CloneStrip />));
    act(() =>
      formRoot.render(
        <CloneForm
          profiles={[]}
          onCancel={() => {}}
          onError={() => {}}
          onClone={(url, parentDir, name, profileId, options) => {
            useCloneStore.getState().start({ url, parentDir, name, profileId, options });
          }}
        />,
      ),
    );

    const input = (label: string) =>
      Array.from(formContainer.querySelectorAll("label")).find((l) =>
        (l.textContent ?? "").startsWith(label),
      )!.querySelector("input")!;

    const setValue = (el: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };

    act(() => setValue(input("URL"), "https://example.com/legit.git"));
    act(() => setValue(input("Into folder"), "/src"));
    expect(input("Folder name").value).toBe("legit");

    const cloneBtn = Array.from(formContainer.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Clone",
    )!;
    act(() => cloneBtn.click());

    // The user dismisses the dialog while the clone runs. Pre-fix this
    // orphaned the op id; now the strip still owns it.
    act(() => formRoot.unmount());
    formContainer.remove();

    expect(rows()).toHaveLength(1);
    expect(rowText()).toContain("Cloning legit");

    const opId = Object.keys(useCloneStore.getState().jobs)[0];
    act(() => {
      useRemoteProgressStore.getState().report(opId, { phase: "Receiving objects", percent: 8 });
    });
    expect(rowText()).toContain("Receiving objects 8%");

    act(() => cancelButton().click());
    expect(cancelClone).toHaveBeenCalledWith(opId);
  });
});

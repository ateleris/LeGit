// @vitest-environment happy-dom
//
// The "Cloning" tab: a running clone lives in the repo tab strip (fed by
// `useCloneStore`), so it survives the form that started it — the clone
// dialog used to hold the op id in a ref, and dismissing it orphaned the
// clone with no progress readout and no way to cancel. The tab's close
// button cancels the clone through the central confirm dialog.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const cancelClone = vi.fn((_opId: string) => Promise.resolve(true));
vi.mock("../lib/commands", () => ({ cancelClone: (id: string) => cancelClone(id) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(() => Promise.resolve(null)) }));

import { CloneTabs } from "./CloneTab";
import { CloneProgressView } from "./CloneProgressView";
import { CloneForm } from "./Repositories/forms";
import { useCloneStore } from "../store/clone";
import { useConfirmStore } from "../store/confirm";
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

const START = {
  url: "https://example.com/legit.git",
  parentDir: "/src",
  name: "legit",
  profileId: null,
  options: {},
};

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

describe("CloneTabs", () => {
  let container: HTMLElement;
  let root: Root;

  const tabs = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="clone-tab"]'));
  const tabText = (i = 0) => tabs()[i].textContent ?? "";
  const closeButton = (i = 0) => tabs()[i].querySelector<HTMLButtonElement>(".legit-tab__close")!;
  const setConfirm = (on: boolean) =>
    useSettingsStore.setState({ settings: { confirm_discard: on } } as never);

  beforeEach(() => {
    cancelClone.mockClear();
    useCloneStore.setState({ jobs: {}, focusedOpId: null, completedCount: 0 });
    useConfirmStore.setState({ queue: [] });
    useRemoteProgressStore.setState({ byOp: {} });
    setConfirm(true);
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("renders nothing while no clone is running", () => {
    act(() => root.render(<CloneTabs />));
    expect(container.innerHTML).toBe("");
  });

  it("shows one tab per clone, named after the repo, without the percentage", () => {
    pendingClone();
    act(() => root.render(<CloneTabs />));

    let opId = "";
    act(() => {
      opId = useCloneStore.getState().start(START);
    });

    expect(tabs()).toHaveLength(1);
    expect(tabText()).toContain("Cloning legit");

    // The meter belongs to the progress view; the tab stays a stable name.
    act(() => {
      useRemoteProgressStore.getState().report(opId, { phase: "Receiving objects", percent: 42 });
    });
    expect(tabText()).not.toContain("%");

    act(() => {
      useCloneStore.getState().start({ ...START, url: "https://example.com/other.git", name: "other" });
    });
    expect(tabs()).toHaveLength(2);
  });

  it("a new clone's tab is selected; clicking a tab selects it", () => {
    pendingClone();
    act(() => root.render(<CloneTabs />));
    let a = "";
    let b = "";
    act(() => {
      a = useCloneStore.getState().start({ ...START, name: "alpha" });
    });
    act(() => {
      b = useCloneStore.getState().start({ ...START, name: "beta" });
    });
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs()[0].getAttribute("aria-selected")).toBe("false");
    expect(useCloneStore.getState().focusedOpId).toBe(b);

    act(() => tabs()[0].click());
    expect(useCloneStore.getState().focusedOpId).toBe(a);
    expect(tabs()[0].classList.contains("is-active")).toBe(true);
  });

  it("the close button asks for confirmation, then cancels the clone", async () => {
    pendingClone();
    act(() => root.render(<CloneTabs />));
    let opId = "";
    act(() => {
      opId = useCloneStore.getState().start(START);
    });

    act(() => closeButton().click());
    await flush();

    // Nothing killed yet: the confirm dialog is up, naming the clone.
    expect(cancelClone).not.toHaveBeenCalled();
    const pending = useConfirmStore.getState().queue;
    expect(pending).toHaveLength(1);
    expect(pending[0].title).toBe("Cancel clone");
    expect(pending[0].message).toContain("legit");
    expect(pending[0].detail).toContain("/src/legit");

    act(() => useConfirmStore.getState().settle(pending[0].id, true));
    await flush();

    expect(cancelClone).toHaveBeenCalledWith(opId);
    expect(tabText()).toContain("cancelling…");
    // The kill is not instant - a second click must not fire again.
    expect(closeButton().disabled).toBe(true);
  });

  it("declining the confirmation keeps the clone running", async () => {
    pendingClone();
    act(() => root.render(<CloneTabs />));
    act(() => {
      useCloneStore.getState().start(START);
    });

    act(() => closeButton().click());
    await flush();
    const pending = useConfirmStore.getState().queue;
    act(() => useConfirmStore.getState().settle(pending[0].id, false));
    await flush();

    expect(cancelClone).not.toHaveBeenCalled();
    expect(tabText()).not.toContain("cancelling");
  });

  it("cancels at once when destructive confirmations are turned off", async () => {
    setConfirm(false);
    pendingClone();
    act(() => root.render(<CloneTabs />));
    let opId = "";
    act(() => {
      opId = useCloneStore.getState().start(START);
    });

    act(() => closeButton().click());
    await flush();

    expect(useConfirmStore.getState().queue).toHaveLength(0);
    expect(cancelClone).toHaveBeenCalledWith(opId);
  });

  it("keeps the clone visible and cancellable after its dialog is dismissed", async () => {
    pendingClone();
    setConfirm(false);

    // Two roots: the dismissable dialog host, and the tab strip.
    const formContainer = document.createElement("div");
    document.body.appendChild(formContainer);
    const formRoot = createRoot(formContainer);

    act(() => root.render(<CloneTabs />));
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
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
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
    // orphaned the op id; now the tab still owns it.
    act(() => formRoot.unmount());
    formContainer.remove();

    expect(tabs()).toHaveLength(1);
    expect(tabText()).toContain("Cloning legit");
    const opId = Object.keys(useCloneStore.getState().jobs)[0];

    act(() => closeButton().click());
    await flush();
    expect(cancelClone).toHaveBeenCalledWith(opId);
  });
});

describe("CloneProgressView", () => {
  let container: HTMLElement;
  let root: Root;
  const view = () => container.querySelector<HTMLElement>('[data-testid="clone-progress-view"]');

  beforeEach(() => {
    useCloneStore.setState({ jobs: {}, focusedOpId: null, completedCount: 0 });
    useRemoteProgressStore.setState({ byOp: {} });
    useSettingsStore.setState({ settings: { confirm_discard: true } } as never);
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("shows the selected clone's source, destination and phase, and hides with the selection", () => {
    pendingClone();
    act(() => root.render(<CloneProgressView />));
    expect(view()).toBeNull();

    let opId = "";
    act(() => {
      opId = useCloneStore.getState().start({ ...START, parentDir: "C:\\src" });
    });
    expect(view()).not.toBeNull();
    expect(view()!.textContent).toContain("Cloning legit");
    expect(view()!.textContent).toContain("https://example.com/legit.git");
    expect(view()!.textContent).toContain("C:\\src\\legit");
    expect(view()!.textContent).toContain("Starting…");

    act(() => {
      useRemoteProgressStore.getState().report(opId, { phase: "Receiving objects", percent: 42 });
    });
    expect(view()!.textContent).toContain("Receiving objects 42%");
    expect(view()!.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("42");

    // Selecting a repo tab deselects the clone: the repo's panels show again.
    act(() => useCloneStore.getState().focus(null));
    expect(view()).toBeNull();
  });
});

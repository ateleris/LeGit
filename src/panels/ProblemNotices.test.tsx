// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProblemBanner, ProblemPopup } from "./ProblemNotices";
import { notify, useNotificationsStore } from "../store/notifications";
import { useSettingsStore } from "../store/settings";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const mount = (style: "banner" | "popup", node: React.ReactNode) => {
  useSettingsStore.setState({ settings: { problem_notice_style: style } } as never);
  act(() => root.render(node));
};

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = (el: Element | null) =>
  act(() => void el?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

beforeEach(() => {
  useNotificationsStore.getState().clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  useSettingsStore.setState({ settings: null } as never);
});

describe("ProblemPopup", () => {
  it("lists every pending problem in one dialog and clears them on OK", () => {
    mount("popup", <ProblemPopup />);
    act(() => {
      notify.error("push failed");
      notify.warning("operation stopped");
    });
    const popup = byTestId("problem-popup")!;
    expect(popup.textContent).toContain("push failed");
    expect(popup.textContent).toContain("operation stopped");
    expect(document.querySelectorAll('[data-testid="problem-popup"]')).toHaveLength(1);
    click(byTestId("problem-popup-ok"));
    expect(byTestId("problem-popup")).toBeNull();
    expect(useNotificationsStore.getState().problems).toHaveLength(0);
  });

  it("takes the error accent as soon as one entry is an error", () => {
    mount("popup", <ProblemPopup />);
    act(() => void notify.warning("operation stopped"));
    expect(byTestId("problem-popup")!.dataset.kind).toBe("warning");
    act(() => void notify.error("push failed"));
    expect(byTestId("problem-popup")!.dataset.kind).toBe("error");
  });

  it("takes focus on its OK button when the user is not typing", () => {
    mount("popup", <ProblemPopup />);
    act(() => void notify.error("push failed"));
    expect(document.activeElement).toBe(byTestId("problem-popup-ok"));
  });

  it("leaves focus in a text field the user is typing in", () => {
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    mount("popup", <ProblemPopup />);
    act(() => void notify.error("push failed"));
    expect(byTestId("problem-popup")).not.toBeNull();
    expect(document.activeElement).toBe(field);
  });
});

describe("ProblemBanner", () => {
  it("shows the newest problem and walks back through the rest on dismiss", () => {
    mount("banner", <ProblemBanner />);
    act(() => {
      notify.error("first failure");
      notify.error("second failure");
    });
    const banner = () => byTestId("problem-banner")!;
    expect(banner().textContent).toContain("second failure");
    expect(banner().textContent).toContain("+1 more");
    click([...banner().querySelectorAll("button")].find((b) => b.textContent === "Dismiss")!);
    expect(banner().textContent).toContain("first failure");
    expect(banner().textContent).not.toContain("more");
    click([...banner().querySelectorAll("button")].find((b) => b.textContent === "Dismiss")!);
    expect(byTestId("problem-banner")).toBeNull();
  });

  it("without a mounted banner the notice goes to the popup instead", () => {
    mount("banner", <ProblemPopup />);
    act(() => void notify.error("push failed"));
    expect(byTestId("problem-popup")!.textContent).toContain("push failed");
  });
});

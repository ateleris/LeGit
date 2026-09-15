// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AddToGitignoreMenuItem } from "./AddToGitignoreMenuItem";
import { MenuLevelProvider } from "../Commits/menu/primitives";
import { useRepoStore } from "../../store/repos";
import { repoAddToGitignore } from "../../lib/commands";

vi.mock("../../lib/commands", () => ({
  repoAddToGitignore: vi.fn(() => Promise.resolve()),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  useRepoStore.setState({
    openRepos: [{ id: "r1", path: "/repo", name: "repo" }],
    activeRepoId: "r1",
  } as never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = async (el: React.ReactElement) =>
  act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MenuLevelProvider>{el}</MenuLevelProvider>
      </QueryClientProvider>,
    ),
  );

const items = () =>
  [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].map(
    (b) => b.textContent?.trim() ?? "",
  );
const item = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find(
    (b) => b.textContent?.trim() === label,
  );

// React derives onMouseEnter from mouseover with an outside relatedTarget.
const hover = async (el: Element) =>
  act(async () => {
    el.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }),
    );
  });

describe("AddToGitignoreMenuItem", () => {
  it("renders a flat entry for a root-level file", async () => {
    await render(<AddToGitignoreMenuItem path="a.ts" onClose={() => {}} />);
    expect(item("Add to .gitignore")).toBeDefined();
    expect(document.querySelector('[data-testid="menu-gitignore-submenu"]')).toBeNull();
  });

  it("offers the file and every folder layer for a nested file", async () => {
    await render(
      <AddToGitignoreMenuItem path="src/panels/a.ts" onClose={() => {}} />,
    );
    const trigger = document.querySelector('[data-testid="menu-gitignore-submenu"]');
    expect(trigger).not.toBeNull();
    await hover(trigger!);
    expect(items()).toContain("src/panels/a.ts");
    expect(items()).toContain("src/panels/");
    expect(items()).toContain("src/");
  });

  it("ignores a folder layer with the dir flag", async () => {
    await render(
      <AddToGitignoreMenuItem path="src/panels/a.ts" onClose={() => {}} />,
    );
    await hover(document.querySelector('[data-testid="menu-gitignore-submenu"]')!);
    await act(async () => item("src/panels/")!.click());
    expect(repoAddToGitignore).toHaveBeenCalledWith("r1", "src/panels", true);
  });

  it("ignores the file itself when the trigger is clicked", async () => {
    await render(
      <AddToGitignoreMenuItem path="src/panels/a.ts" onClose={() => {}} />,
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="menu-gitignore-submenu"]',
    );
    await act(async () => trigger!.click());
    expect(repoAddToGitignore).toHaveBeenCalledWith("r1", "src/panels/a.ts", false);
  });

  it("keeps the flat folder entry for a dir row", async () => {
    await render(<AddToGitignoreMenuItem path="src/out" isDir onClose={() => {}} />);
    expect(item("Add folder to .gitignore")).toBeDefined();
    expect(document.querySelector('[data-testid="menu-gitignore-submenu"]')).toBeNull();
  });
});

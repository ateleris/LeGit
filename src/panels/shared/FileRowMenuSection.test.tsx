// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FileRowMenuSection } from "./FileRowMenuSection";

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

const render = async (el: React.ReactElement) =>
  act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>,
    ),
  );
// Direct children only: the section renders a flat fragment (SectionLabel
// div, then menuitem buttons), so parents never concatenate child text.
const labels = () =>
  [...host.children].map((n) => n.textContent?.trim() ?? "").filter(Boolean);
const item = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find(
    (b) => b.textContent?.trim() === label,
  );

describe("FileRowMenuSection", () => {
  it("renders the canonical order for a working-tree file", async () => {
    await render(<FileRowMenuSection path="src/a.ts" onClose={() => {}} />);
    const l = labels();
    expect(l[0]).toBe("src/a.ts");
    expect(l.indexOf("File history")).toBeLessThan(l.indexOf("Blame file"));
    expect(l.indexOf("Blame file")).toBeLessThan(l.indexOf("Copy relative path"));
  });

  it("words view/blame with the rev label", async () => {
    await render(
      <FileRowMenuSection
        path="a.ts"
        view
        rev={{ value: "abc123", label: "this commit" }}
        onClose={() => {}}
      />,
    );
    expect(item("View file at this commit")).toBeDefined();
    expect(item("Blame file at this commit")).toBeDefined();
  });

  it("disables view/blame for a deleted file with the reason", async () => {
    await render(
      <FileRowMenuSection
        path="a.ts"
        view
        deleted
        deletedIn="in this range"
        rev={{ value: "v2", label: "v2" }}
        onClose={() => {}}
      />,
    );
    expect(item("View file (deleted in this range)")?.disabled).toBe(true);
    expect(item("Blame file (deleted in this range)")?.disabled).toBe(true);
  });

  it("disables history/blame for an untracked file with the reason", async () => {
    await render(
      <FileRowMenuSection path="a.ts" untracked gitignore="file" onClose={() => {}} />,
    );
    expect(item("File history (untracked)")?.disabled).toBe(true);
    expect(item("Blame (untracked)")?.disabled).toBe(true);
  });

  it("disables blame for a submodule row", async () => {
    await render(<FileRowMenuSection path="sub" submodule onClose={() => {}} />);
    expect(item("Blame (submodule)")?.disabled).toBe(true);
    expect(item("File history")?.disabled).toBe(false);
  });
});

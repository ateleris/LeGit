// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRepoStore } from "../../../store/repos";
import { useRepoWriteStore } from "../../../lib/repoWrites";
import { MenuItem } from "./primitives";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useRepoStore.setState({ activeRepoId: "r1" });
  useRepoWriteStore.setState({ running: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() =>
    root.render(
      <>
        <MenuItem writes onClick={() => {}}>Merge</MenuItem>
        <MenuItem onClick={() => {}}>Copy SHA</MenuItem>
      </>,
    ),
  );
  const [write, read] = Array.from(container.querySelectorAll("button"));
  return { write, read };
}

describe("MenuItem writes", () => {
  it("is live while nothing holds the active repository", () => {
    const { write, read } = render();
    expect(write.disabled).toBe(false);
    expect(read.disabled).toBe(false);
  });

  it("goes inert, naming the running operation, while the active repository is held", () => {
    useRepoWriteStore.setState({ running: { r1: "Merging main…" } });
    const { write, read } = render();
    expect(write.disabled).toBe(true);
    expect(write.title).toBe('Not available while "Merging main" is running');
    expect(read.disabled).toBe(false);
  });

  it("ignores an operation running on another repository", () => {
    useRepoWriteStore.setState({ running: { other: "Merging main…" } });
    expect(render().write.disabled).toBe(false);
  });
});

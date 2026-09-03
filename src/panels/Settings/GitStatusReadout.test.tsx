// @vitest-environment happy-dom
//
// The four facts of a probed git binary (Resolved path / Version / Minimum
// required / Meets minimum) are rendered by ONE component: the Windows and
// WSL settings sections had token-for-token copies that had already started
// to drift.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GitStatusReadout, formatVersionTriple } from "./GitStatusReadout";
import type { GitStatus } from "../../lib/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const status = (over: Partial<GitStatus>): GitStatus => ({
  resolved_path: "/usr/bin/git",
  version: { raw: "git version 2.44.0", major: 2, minor: 44, patch: 0 } as GitStatus["version"],
  meets_minimum: true,
  minimum_required: [2, 34, 0],
  user_override: null,
  error: null,
  ...over,
});

describe("GitStatusReadout", () => {
  it("renders path, version, minimum and verdict", () => {
    act(() => root.render(<GitStatusReadout status={status({})} />));
    expect(container.textContent).toContain("/usr/bin/git");
    expect(container.textContent).toContain("git version 2.44.0");
    expect(container.textContent).toContain("2.34.0");
    expect(container.textContent).toContain("yes");
  });

  it("shows the probe error when there is no version", () => {
    act(() =>
      root.render(
        <GitStatusReadout
          status={status({ version: null, meets_minimum: false, error: "exec format error" })}
        />,
      ),
    );
    expect(container.textContent).toContain("exec format error");
    expect(container.textContent).toContain("no");
  });
});

describe("formatVersionTriple", () => {
  it("joins with dots", () => {
    expect(formatVersionTriple([2, 34, 0])).toBe("2.34.0");
  });
});

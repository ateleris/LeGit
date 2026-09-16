// @vitest-environment happy-dom
//
// The gate is the app's only hard block, so what it lets through is a
// behaviour worth pinning: a Windows machine with no git but a WSL
// distribution is a usable setup, not a first-run wall.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GitSetupGate } from "./GitSetupGate";
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

const missing: GitStatus = {
  resolved_path: "git",
  version: null,
  meets_minimum: false,
  minimum_required: [2, 34, 0],
  user_override: null,
  error: "program not found",
};

const render = (status: GitStatus, remoteHostsAvailable: boolean) =>
  act(() =>
    root.render(
      <GitSetupGate status={status} remoteHostsAvailable={remoteHostsAvailable}>
        <div>the app</div>
      </GitSetupGate>
    )
  );

describe("GitSetupGate", () => {
  it("blocks with install guidance when no git and no remote host", () => {
    render(missing, false);
    expect(container.textContent).toContain("Git is not installed");
    expect(container.textContent).not.toContain("the app");
  });

  it("runs the app without a local git when a WSL host can provide one", () => {
    render(missing, true);
    expect(container.textContent).toContain("the app");
    expect(container.textContent).not.toContain("Git is not installed");
  });

  it("still warns about an old local git", () => {
    render(
      {
        ...missing,
        version: { raw: "git version 2.20.1", major: 2, minor: 20, patch: 1 },
        error: null,
      },
      true
    );
    expect(container.textContent).toContain("older than recommended");
  });
});

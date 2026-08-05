// @vitest-environment happy-dom
//
// Integration test for the watcher listener's focus gate: watcher events
// arriving while the window is unfocused must only mark caches stale (no
// refetch); the catch-up refetch happens when focus returns.
import { describe, test, expect, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  focusManager,
} from "@tanstack/react-query";
import { useRepoChangeListener } from "./useRepoChangeListener";
import type { RepoChangedPayload } from "./types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const events = vi.hoisted(() => ({
  handler: undefined as ((p: RepoChangedPayload) => void) | undefined,
}));

vi.mock("./events", () => ({
  onRepoChanged: (h: (p: RepoChangedPayload) => void) => {
    events.handler = h;
    return Promise.resolve(() => {
      events.handler = undefined;
    });
  },
}));

function Harness() {
  useRepoChangeListener();
  return null;
}

describe("useRepoChangeListener focus gate", () => {
  test("unfocused watcher event defers the refetch until focus returns", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: true } },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      ),
    );
    let fetches = 0;
    const observer = new QueryObserver(client, {
      queryKey: ["r-listener", "log"],
      queryFn: async () => ++fetches,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(events.handler).toBeDefined());
      // Wait until the initial fetch has fully committed, so its success
      // cannot land after (and silently undo) the invalidation below.
      await vi.waitFor(() => {
        const s = client.getQueryState(["r-listener", "log"]);
        expect(s?.status).toBe("success");
        expect(s?.fetchStatus).toBe("idle");
      });
      expect(fetches).toBe(1);

      focusManager.setFocused(false);
      events.handler!({
        repo_id: "r-listener",
        domains: ["log"],
        trigger_paths: [],
        trigger_count: 0,
      });
      await new Promise((r) => setTimeout(r, 20));
      // Stale, but not refetched while the window is unfocused.
      expect(client.getQueryState(["r-listener", "log"])?.isInvalidated).toBe(true);
      expect(fetches).toBe(1);

      focusManager.setFocused(true);
      await vi.waitFor(() => expect(fetches).toBe(2));
    } finally {
      unsubscribe();
      focusManager.setFocused(undefined);
      await act(async () => root.unmount());
      host.remove();
    }
  });

  test("focused watcher event refetches immediately", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: true } },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      ),
    );
    let fetches = 0;
    const observer = new QueryObserver(client, {
      queryKey: ["r-listener-2", "log"],
      queryFn: async () => ++fetches,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(events.handler).toBeDefined());
      await vi.waitFor(() => {
        const s = client.getQueryState(["r-listener-2", "log"]);
        expect(s?.status).toBe("success");
        expect(s?.fetchStatus).toBe("idle");
      });

      events.handler!({
        repo_id: "r-listener-2",
        domains: ["log"],
        trigger_paths: [],
        trigger_count: 0,
      });
      await vi.waitFor(() => expect(fetches).toBe(2));
    } finally {
      unsubscribe();
      focusManager.setFocused(undefined);
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

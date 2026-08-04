// Unit tests for the per-repo console store: session isolation, op routing,
// pager state, and the ring-buffer cap.
import { describe, it, expect, beforeEach } from "vitest";
import { useConsoleStore, EMPTY_CONSOLE_SESSION } from "./console";
import type { ConsoleEventPayload } from "../lib/types";

function payload(
  opId: string,
  events: ConsoleEventPayload["events"],
  paused = false,
): ConsoleEventPayload {
  return { op_id: opId, events, paused };
}

beforeEach(() => {
  useConsoleStore.setState({ sessions: {}, opRepo: {}, pendingPayloads: {} });
});

describe("console store sessions", () => {
  it("keeps scrollback and history per repository", () => {
    const s = useConsoleStore.getState();
    s.append("repoA", [{ stream: "system", text: "$ git status" }]);
    s.append("repoB", [{ stream: "system", text: "$ git log" }]);
    s.pushHistory("repoA", "status");

    const { sessions } = useConsoleStore.getState();
    expect(sessions.repoA.lines.map((l) => l.text)).toEqual(["$ git status"]);
    expect(sessions.repoB.lines.map((l) => l.text)).toEqual(["$ git log"]);
    expect(sessions.repoA.history).toEqual(["status"]);
    expect(sessions.repoB.history).toEqual([]);
  });

  it("keeps the prompt draft per repository", () => {
    const s = useConsoleStore.getState();
    s.setDraft("repoA", "log --oneline");
    s.setDraft("repoB", "status");
    expect(useConsoleStore.getState().sessions.repoA.draft).toBe("log --oneline");
    expect(useConsoleStore.getState().sessions.repoB.draft).toBe("status");
  });

  it("clear wipes only the addressed repo", () => {
    const s = useConsoleStore.getState();
    s.append("repoA", [{ stream: "stdout", text: "a" }]);
    s.append("repoB", [{ stream: "stdout", text: "b" }]);
    s.clear("repoA");
    const { sessions } = useConsoleStore.getState();
    expect(sessions.repoA.lines).toEqual([]);
    expect(sessions.repoB.lines).toHaveLength(1);
  });

  it("caps the scrollback at 5000 lines per repo", () => {
    const batch = Array.from({ length: 5100 }, (_, i) => ({
      stream: "stdout" as const,
      text: `line ${i}`,
    }));
    useConsoleStore.getState().append("repoA", batch);
    const { lines } = useConsoleStore.getState().sessions.repoA;
    expect(lines).toHaveLength(5000);
    expect(lines[0].text).toBe("line 100");
  });

  it("does not deduplicate history beyond consecutive repeats", () => {
    const s = useConsoleStore.getState();
    s.pushHistory("repoA", "status");
    s.pushHistory("repoA", "status");
    s.pushHistory("repoA", "log");
    s.pushHistory("repoA", "status");
    expect(useConsoleStore.getState().sessions.repoA.history).toEqual([
      "status",
      "log",
      "status",
    ]);
  });
});

describe("console store op routing", () => {
  it("routes batches to the owning repo even when another repo is active", () => {
    const s = useConsoleStore.getState();
    s.beginOp("repoA", "op-1");
    const result = useConsoleStore
      .getState()
      .handleBatch(payload("op-1", [{ kind: "stdout", line: "hello" }]));
    expect(result).toEqual({ repoId: "repoA", finished: false });
    expect(useConsoleStore.getState().sessions.repoA.lines[0].text).toBe("hello");
  });

  it("ignores batches for unknown ops", () => {
    const result = useConsoleStore
      .getState()
      .handleBatch(payload("ghost", [{ kind: "stdout", line: "x" }]));
    expect(result).toBeNull();
  });

  it("replays batches that arrived before the op was registered", () => {
    // Event delivery and the console_exec response both cross IPC: a fast
    // command's first output can beat the response carrying the op id.
    const s = useConsoleStore.getState();
    s.handleBatch(payload("op-1", [{ kind: "stdout", line: "early" }]));
    s.handleBatch(
      payload("op-1", [{ kind: "finished", exit_code: 0, success: true, duration_ms: 3 }]),
    );
    const replay = useConsoleStore.getState().beginOp("repoA", "op-1");
    expect(replay).toEqual({ finished: true });
    const session = useConsoleStore.getState().sessions.repoA;
    expect(session.lines.map((l) => l.text)).toEqual(["early", "[exit 0, 3 ms]"]);
    expect(session.running).toBe(false);
    expect(useConsoleStore.getState().pendingPayloads).toEqual({});
  });

  it("finished batches close the op and append the status line", () => {
    const s = useConsoleStore.getState();
    s.beginOp("repoA", "op-1");
    const result = useConsoleStore.getState().handleBatch(
      payload("op-1", [
        { kind: "stdout", line: "out" },
        { kind: "finished", exit_code: 0, success: true, duration_ms: 12 },
      ]),
    );
    expect(result).toEqual({ repoId: "repoA", finished: true });
    const session = useConsoleStore.getState().sessions.repoA;
    expect(session.running).toBe(false);
    expect(session.opId).toBeNull();
    expect(session.lines.map((l) => l.text)).toEqual(["out", "[exit 0, 12 ms]"]);
    expect(useConsoleStore.getState().opRepo).toEqual({});
  });

  it("a killed op reports [killed …]", () => {
    useConsoleStore.getState().beginOp("repoA", "op-1");
    useConsoleStore.getState().handleBatch(
      payload("op-1", [{ kind: "finished", exit_code: null, success: false, duration_ms: 5 }]),
    );
    const session = useConsoleStore.getState().sessions.repoA;
    expect(session.lines[0].text).toBe("[killed, 5 ms]");
  });

  it("tracks the pager paused state from the payload", () => {
    useConsoleStore.getState().beginOp("repoA", "op-1");
    useConsoleStore
      .getState()
      .handleBatch(payload("op-1", [{ kind: "stdout", line: "page 1" }], true));
    expect(useConsoleStore.getState().sessions.repoA.paused).toBe(true);
    // Resumed output clears it.
    useConsoleStore
      .getState()
      .handleBatch(payload("op-1", [{ kind: "stdout", line: "page 2" }], false));
    expect(useConsoleStore.getState().sessions.repoA.paused).toBe(false);
  });
});

describe("console store repo lifecycle", () => {
  it("dropRepo removes the session and its op routing", () => {
    const s = useConsoleStore.getState();
    s.beginOp("repoA", "op-1");
    s.append("repoA", [{ stream: "stdout", text: "x" }]);
    s.dropRepo("repoA");
    expect(useConsoleStore.getState().sessions.repoA).toBeUndefined();
    expect(useConsoleStore.getState().opRepo).toEqual({});
    // Late events for the dropped repo's op are ignored, not resurrected.
    expect(
      useConsoleStore.getState().handleBatch(payload("op-1", [{ kind: "stdout", line: "y" }])),
    ).toBeNull();
  });

  it("EMPTY_CONSOLE_SESSION is inert (reads for repos without a session)", () => {
    expect(EMPTY_CONSOLE_SESSION.lines).toEqual([]);
    expect(EMPTY_CONSOLE_SESSION.running).toBe(false);
  });
});

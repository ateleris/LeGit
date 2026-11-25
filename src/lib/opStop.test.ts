import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StopOutcome } from "./bindings";

const { repoStopOperation, warning } = vi.hoisted(() => ({
  repoStopOperation: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("./commands", () => ({ api: { repoStopOperation } }));
vi.mock("../store/notifications", () => ({ notify: { warning } }));

import {
  OperationStoppedError,
  requestStop,
  settleStoppable,
  stopMessage,
} from "./opStop";
import { useOpActivityStore } from "./opActivity";

const outcome = (over: Partial<StopOutcome> = {}): StopOutcome => ({
  stopped: 1,
  lock_removed: false,
  op_state: { kind: "none" },
  ...over,
});

beforeEach(() => {
  repoStopOperation.mockReset();
  warning.mockReset();
  useOpActivityStore.setState({ ops: [] });
});

describe("stopMessage", () => {
  it("points at Abort when git left the operation in progress", () => {
    const msg = stopMessage(outcome({ op_state: { kind: "merge", branch: "main", message: null } }));
    expect(msg).toMatch(/merge is still in progress/);
    expect(msg).toMatch(/Abort on the operation banner/);
  });

  it("warns about files left behind when no operation was recorded", () => {
    expect(stopMessage(outcome())).toMatch(/may be left in Working Changes/);
  });

  it("mentions a removed lock file", () => {
    expect(stopMessage(outcome({ lock_removed: true }))).toMatch(/lock file .* was removed/);
  });
});

describe("settleStoppable", () => {
  it("turns the interrupted command's failure into the recovery message", async () => {
    repoStopOperation.mockResolvedValue(outcome({ op_state: { kind: "rebase", onto: "main", head_name: null, current_step: null, total_steps: null } }));
    let fail!: (e: unknown) => void;
    const command = settleStoppable("r", () => new Promise<void>((_, reject) => (fail = reject)));
    void requestStop("r");
    fail(new Error("git exited with 143"));
    const err = await command.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OperationStoppedError);
    expect((err as Error).message).toMatch(/rebase is still in progress/);
    expect(warning).toHaveBeenCalledWith((err as Error).message);
  });

  it("passes a failure through when no stop was requested", async () => {
    await expect(
      settleStoppable("r", async () => {
        throw new Error("conflict");
      }),
    ).rejects.toThrow("conflict");
    expect(repoStopOperation).not.toHaveBeenCalled();
  });

  it("passes the real failure through when the stop interrupted nothing", async () => {
    repoStopOperation.mockResolvedValue(outcome({ stopped: 0 }));
    let fail!: (e: unknown) => void;
    const command = settleStoppable("r", () => new Promise<void>((_, reject) => (fail = reject)));
    void requestStop("r");
    fail(new Error("real failure"));
    await expect(command).rejects.toThrow("real failure");
  });

  it("lets a command that finished anyway succeed, and forgets the stop", async () => {
    repoStopOperation.mockResolvedValue(outcome({ stopped: 0 }));
    let finish!: (v: string) => void;
    const command = settleStoppable("r", () => new Promise<string>((resolve) => (finish = resolve)));
    void requestStop("r");
    finish("merged");
    await expect(command).resolves.toBe("merged");
    await expect(
      settleStoppable("r", async () => {
        throw new Error("later failure");
      }),
    ).rejects.toThrow("later failure");
  });
});

describe("requestStop", () => {
  it("marks the repo's running operations as stopping and joins a stop under way", () => {
    repoStopOperation.mockReturnValue(new Promise(() => {}));
    useOpActivityStore.setState({
      ops: [
        { id: 1, repoId: "r", label: "Merging main…", stoppable: true },
        { id: 2, repoId: "other", label: "Rebasing…", stoppable: true },
      ],
    });
    void requestStop("r");
    void requestStop("r");
    expect(repoStopOperation).toHaveBeenCalledTimes(1);
    const ops = useOpActivityStore.getState().ops;
    expect(ops.map((o) => !!o.stopping)).toEqual([true, false]);
  });
});

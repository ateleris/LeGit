// Toast behavior for `legit://remote-host-status`. The distinction that
// matters: "disconnected" means the backend reconnect loop is running (sticky
// "reconnecting…" toast), "gone" means no reconnect is coming (settings-only
// host lost, or the host was released mid-reconnect) - promising a reconnect
// there leaves a false sticky toast for the rest of the session.
import { describe, it, expect, beforeEach } from "vitest";
import { handleRemoteHostStatus } from "./useRemoteHostEvents";
import { useNotificationsStore } from "../store/notifications";

const toasts = () => useNotificationsStore.getState().toasts;

beforeEach(() => {
  // Drain per-distro toast bookkeeping from earlier tests via the handler's
  // own terminal transition, then clear the store.
  handleRemoteHostStatus({ distro: "Ubuntu", status: "gone" });
  useNotificationsStore.setState({ toasts: [] });
});

describe("handleRemoteHostStatus", () => {
  it("shows one sticky reconnect toast per distro and clears it on recovery", () => {
    handleRemoteHostStatus({ distro: "Ubuntu", status: "disconnected" });
    handleRemoteHostStatus({ distro: "Ubuntu", status: "disconnected" });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].kind).toBe("error");
    expect(toasts()[0].sticky).toBe(true);
    expect(toasts()[0].message).toContain("reconnecting");

    handleRemoteHostStatus({ distro: "Ubuntu", status: "connected" });
    expect(toasts().map((t) => t.kind)).toEqual(["success"]);
  });

  it("reports a terminal loss as a plain error, never a reconnect promise", () => {
    handleRemoteHostStatus({ distro: "Ubuntu", status: "gone" });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].kind).toBe("error");
    expect(toasts()[0].sticky).not.toBe(true);
    expect(toasts()[0].message).not.toContain("reconnecting");
  });

  it("clears a standing reconnect toast quietly when the reconnect stops", () => {
    handleRemoteHostStatus({ distro: "Ubuntu", status: "disconnected" });
    handleRemoteHostStatus({ distro: "Ubuntu", status: "gone" });
    expect(toasts()).toEqual([]);
  });

  it("connected without a standing toast stays silent (initial connects)", () => {
    handleRemoteHostStatus({ distro: "Ubuntu", status: "connected" });
    expect(toasts()).toEqual([]);
  });

  it("a failed connect attempt is silent here - its caller reports the error", () => {
    handleRemoteHostStatus({ distro: "Ubuntu", status: "connecting" });
    handleRemoteHostStatus({ distro: "Ubuntu", status: "connect_failed" });
    expect(toasts()).toEqual([]);
    // Mid-reconnect-loop failures must not disturb the standing sticky toast.
    handleRemoteHostStatus({ distro: "Ubuntu", status: "disconnected" });
    handleRemoteHostStatus({ distro: "Ubuntu", status: "connect_failed" });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].sticky).toBe(true);
  });
});

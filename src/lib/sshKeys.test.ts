import { describe, expect, it } from "vitest";
import { findRegisteredKey, identityKeyState, isKeyRegistered, keyMaterial } from "./sshKeys";
import type { SshKeyStatus } from "./types";

describe("keyMaterial", () => {
  it("is the type + blob, without the comment", () => {
    expect(keyMaterial("ssh-ed25519 AAAAC3NzaC1lZDI1 simon@home")).toBe(
      "ssh-ed25519 AAAAC3NzaC1lZDI1",
    );
    expect(keyMaterial("  ssh-ed25519   AAAAC3NzaC1lZDI1  ")).toBe(
      "ssh-ed25519 AAAAC3NzaC1lZDI1",
    );
    expect(keyMaterial("garbage")).toBeNull();
    expect(keyMaterial("")).toBeNull();
  });
});

describe("isKeyRegistered", () => {
  const registered = [
    "ssh-rsa AAAAB3NzaC1yc2E other key",
    "ssh-ed25519 AAAAC3NzaC1lZDI1 work laptop",
  ];

  it("matches regardless of the comment", () => {
    expect(isKeyRegistered("ssh-ed25519 AAAAC3NzaC1lZDI1 simon@home", registered)).toBe(true);
  });

  it("does not match a different blob or type", () => {
    expect(isKeyRegistered("ssh-ed25519 AAAAC3NzaC1OTHER x", registered)).toBe(false);
    // Same blob under a different type is a different key.
    expect(isKeyRegistered("sk-ssh-ed25519@openssh.com AAAAC3NzaC1lZDI1", registered)).toBe(false);
  });

  it("never matches unparseable input", () => {
    expect(isKeyRegistered("garbage", registered)).toBe(false);
    expect(isKeyRegistered("ssh-ed25519 AAAA", ["garbage"])).toBe(false);
  });
});

describe("findRegisteredKey", () => {
  const entries = [
    { id: "11", key: "ssh-rsa AAAAB3NzaC1yc2E other key" },
    { id: "22", key: "ssh-ed25519 AAAAC3NzaC1lZDI1 work laptop" },
  ];

  it("returns the matching entry (the revoke handle), ignoring comments", () => {
    expect(findRegisteredKey("ssh-ed25519 AAAAC3NzaC1lZDI1 simon@home", entries)?.id).toBe("22");
  });

  it("returns null for unregistered or unparseable keys", () => {
    expect(findRegisteredKey("ssh-ed25519 AAAAC3NzaC1OTHER x", entries)).toBeNull();
    expect(findRegisteredKey("garbage", entries)).toBeNull();
  });
});

describe("identityKeyState", () => {
  const status = (path: string, publicKey: string | null): SshKeyStatus => ({
    exists: publicKey !== null,
    private_key_path: path,
    public_key: publicKey,
  });
  const registered = ["ssh-ed25519 AAAAC3NzaC1lZDI1 work laptop"];

  it("offers creation when the identity has no key at all", () => {
    expect(identityKeyState([], registered)).toEqual({ kind: "create" });
  });

  it("is connected when any key is registered, regardless of comment", () => {
    const s = [
      status("/k/other", "ssh-rsa AAAAB3 x"),
      status("/k/id", "ssh-ed25519 AAAAC3NzaC1lZDI1 simon@home"),
    ];
    expect(identityKeyState(s, registered)).toEqual({ kind: "connected" });
  });

  it("offers uploading the first readable key when none is registered", () => {
    const broken = status("/k/broken", null);
    const usable = status("/k/id", "ssh-ed25519 AAAAC3NzaC1OTHER x");
    expect(identityKeyState([broken, usable], registered)).toEqual({
      kind: "upload",
      status: usable,
    });
  });

  it("reports a configured but unreadable key as missing", () => {
    expect(identityKeyState([status("/k/gone", null)], registered)).toEqual({
      kind: "missing_file",
      path: "/k/gone",
    });
  });
});

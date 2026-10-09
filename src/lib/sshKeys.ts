/** The identity of an authorized-keys line: type + base64 blob. The trailing
 *  comment differs freely between copies of the same key, so it is ignored. */
export function keyMaterial(publicKey: string): string | null {
  const fields = publicKey.trim().split(/\s+/);
  if (fields.length < 2) return null;
  return `${fields[0]} ${fields[1]}`;
}

/** Whether `publicKey` is among the account's registered keys (raw
 *  `<type> <blob> [comment]` strings, as `platform_registered_keys` returns
 *  them), compared by key material. */
export function isKeyRegistered(publicKey: string, registered: string[]): boolean {
  const target = keyMaterial(publicKey);
  if (!target) return false;
  return registered.some((k) => keyMaterial(k) === target);
}

import type { CachedPlatformKey, SshKeyStatus } from "./types";

/** The registered entry matching `publicKey` by key material - the handle
 *  for revoking that key on the platform. */
export function findRegisteredKey(
  publicKey: string,
  entries: CachedPlatformKey[],
): CachedPlatformKey | null {
  const target = keyMaterial(publicKey);
  if (!target) return null;
  return entries.find((e) => keyMaterial(e.key) === target) ?? null;
}

/** An identity's standing against one platform account's registered keys:
 *  what the Connected accounts matrix shows and which action it offers. */
export type IdentityKeyState =
  | { kind: "connected" }
  | { kind: "upload"; status: SshKeyStatus }
  | { kind: "create" }
  | { kind: "missing_file"; path: string };

/**
 * `statuses` are the identity's key files (a profile's `auth_ssh_key`, or
 * the existing default `~/.ssh` keys); none at all means a key can be
 * created. A readable public key wins over a broken one, and any registered
 * key makes the identity connected.
 */
export function identityKeyState(
  statuses: SshKeyStatus[],
  registered: string[],
): IdentityKeyState {
  if (statuses.length === 0) return { kind: "create" };
  const usable = statuses.filter((s) => s.public_key);
  if (usable.some((s) => isKeyRegistered(s.public_key!, registered))) {
    return { kind: "connected" };
  }
  if (usable.length > 0) return { kind: "upload", status: usable[0] };
  return { kind: "missing_file", path: statuses[0].private_key_path };
}

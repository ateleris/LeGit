// Gravatar avatars for the commit graph — STRICTLY opt-in (the
// `commit_avatars` setting is off by default): no request leaves the app
// unless the user enabled it, because fetching an avatar sends the hashed
// author email to gravatar.com.
//
// One probe per unique email, ever: the result (URL or "no avatar") is cached
// in a module store shared by all rows; the image bytes themselves live in
// the webview's HTTP cache.

import { useEffect } from "react";
import { create } from "zustand";

/** Requested image size (px). One fixed size keeps the HTTP cache to a
 * single entry per email; 128px stays crisp up to very large dot radii. */
const GRAVATAR_SIZE = 128;

/** SHA-256 hex of the trimmed, lowercased email — Gravatar's current
 * recommended address hash. */
export async function hashEmail(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Gravatar URL for a pre-computed email hash. `d=404` makes "no avatar"
 * an HTTP 404 (detected by the probe) instead of generated placeholder art,
 * so the graph can fall back to the plain lane-coloured dot. */
export function gravatarUrl(emailHash: string, size: number = GRAVATAR_SIZE): string {
  return `https://www.gravatar.com/avatar/${emailHash}?s=${size}&d=404`;
}

interface AvatarStore {
  /** email → avatar URL, or null when Gravatar has none (probe 404'd). */
  urls: Record<string, string | null>;
  /** Emails currently being probed (dedup guard). */
  pending: Set<string>;
  ensure: (email: string) => void;
}

const useAvatarStore = create<AvatarStore>((set, get) => ({
  urls: {},
  pending: new Set(),

  ensure(email) {
    const { urls, pending } = get();
    if (email in urls || pending.has(email)) return;
    set((s) => ({ pending: new Set(s.pending).add(email) }));
    void (async () => {
      let result: string | null = null;
      try {
        const url = gravatarUrl(await hashEmail(email));
        // Probe via an Image element: resolves the 404-vs-exists question and
        // primes the webview's HTTP cache in the same request.
        result = await new Promise<string | null>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(url);
          img.onerror = () => resolve(null);
          img.src = url;
        });
      } catch {
        result = null; // hashing/network failure — treat as "no avatar"
      }
      set((s) => {
        const nextPending = new Set(s.pending);
        nextPending.delete(email);
        return { urls: { ...s.urls, [email]: result }, pending: nextPending };
      });
    })();
  },
}));

/**
 * The avatar URL for an author email, or null while unknown / when Gravatar
 * has none. Triggers at most one probe per unique email across the app —
 * and none at all unless `enabled` (the opt-in setting) is true.
 */
export function useAvatar(email: string | null, enabled: boolean): string | null {
  const url = useAvatarStore((s) => (email ? s.urls[email] : undefined));
  // Probing mutates the store — must not run during render.
  useEffect(() => {
    if (enabled && email) useAvatarStore.getState().ensure(email);
  }, [email, enabled]);
  return enabled ? (url ?? null) : null;
}

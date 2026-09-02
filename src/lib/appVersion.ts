import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { appBuildHash } from "./commands";

/** The user-facing version string: `1.0.3+abc1234` when a build hash was
 * baked in (dev/PR builds), the clean version otherwise (releases). Null
 * while the version has not resolved. */
export function formatAppVersion(version: string | null, hash: string | null): string | null {
  if (version === null) return null;
  return hash ? `${version}+${hash}` : version;
}

// The app version from tauri.conf.json — the single source of truth (the
// package.json version is unrelated metadata). Fetched once per process;
// consumers render nothing until it resolves (fast, but async).
let cached: string | null = null;

export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(cached);
  useEffect(() => {
    if (cached !== null) return;
    let disposed = false;
    getVersion()
      .then((v) => {
        cached = v;
        if (!disposed) setVersion(v);
      })
      .catch(() => {
        /* leave null — the version line simply doesn't render */
      });
    return () => {
      disposed = true;
    };
  }, []);
  return version;
}

let cachedHash: string | null | undefined;

/** The display version for About: clean version plus the baked commit hash
 * of dev/PR builds (`1.0.3+abc1234`); releases show the clean version. The
 * updater keeps comparing against `useAppVersion` (the clean one). */
export function useAppVersionDisplay(): string | null {
  const version = useAppVersion();
  const [hash, setHash] = useState<string | null>(cachedHash ?? null);
  useEffect(() => {
    if (cachedHash !== undefined) return;
    let disposed = false;
    appBuildHash()
      .then((h) => {
        cachedHash = h;
        if (!disposed) setHash(h);
      })
      .catch(() => {
        cachedHash = null; // release build behavior: clean version
      });
    return () => {
      disposed = true;
    };
  }, []);
  return formatAppVersion(version, hash);
}

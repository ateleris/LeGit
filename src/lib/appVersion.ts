import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

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

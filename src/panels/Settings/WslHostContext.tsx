// Shared state for the `Git (WSL)` settings group: which distribution is
// selected, whether LeGit is connected to it, and the memoized per-distro
// command scope every subsection uses.
//
// It deliberately lives ABOVE the group's `SettingsGroup`, which unmounts its
// children when collapsed: "we already connected to Ubuntu this session" must
// survive a collapse, or every expand would reconnect (and restart) the distro.
//
// Nothing here connects on its own. `wslListDistros` (cheap, no connect) is the
// only call the group makes unprompted; `connect()` is the user's action, and
// it doubles as the git-binary probe because `wsl_host_git_status` connects and
// returns the version in one round trip.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { formatAppError } from "../../lib/types";
import type { GitStatus, WslDistro } from "../../lib/types";
import { wslHostGitStatus } from "../../lib/commands";
import { onRemoteHostStatus } from "../../lib/events";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { wslGitConfigScope, type GitConfigScope } from "./gitConfigHost";

export type WslHostStatus = "unknown" | "connecting" | "connected" | "disconnected";

interface WslHostCtx {
  distros: WslDistro[];
  distro: string;
  setDistro: (name: string) => void;
  /** The list's snapshot flag, OR a distro we connected to ourselves since. */
  running: boolean;
  /**
   * STICKY: a command has succeeded against this distro at some point this
   * session. Sticky on purpose — the forms gate LOADING on it, and a
   * transient `wsl --shutdown` must not blank out (and discard the drafts of)
   * an already-loaded form. Liveness is `status`.
   */
  everConnected: boolean;
  /** Live connectivity for the SELECTED distro. */
  status: WslHostStatus;
  /** Bumped on reconnect so mounted forms re-read. */
  reloadNonce: number;
  connect: () => void;
  busy: boolean;
  /** Last probe of this distro's git binary (shared with the exe section). */
  gitStatus: GitStatus | null;
  /** Record a probe result; also marks the distro connected (it answered). */
  setGitStatus: (s: GitStatus) => void;
  error: string | null;
  /** Memoized: an unstable scope would re-trigger every form's load effect. */
  scope: GitConfigScope;
}

const Ctx = createContext<WslHostCtx | null>(null);

export function useWslHost(): WslHostCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWslHost outside WslHostProvider");
  return ctx;
}

export function WslHostProvider({
  distros,
  children,
}: {
  distros: WslDistro[];
  children: ReactNode;
}) {
  const [distro, setDistro] = useState(
    () => (distros.find((d) => d.is_default) ?? distros[0]).name,
  );
  // Distros we connected to ourselves: the list's `running` flag is a snapshot
  // from mount, so without this a distro we just started reads as stopped.
  const [started, setStarted] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<Record<string, WslHostStatus>>({});
  const [gitStatuses, setGitStatuses] = useState<Record<string, GitStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reloadNonce, setReloadNonce] = useState(0);
  const { busy, run } = useDelayedBusy();

  // A probe that resolves after the user picked another distro must not paint
  // its result into the new selection.
  const selectedRef = useRef(distro);
  selectedRef.current = distro;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onRemoteHostStatus((p) => {
      const next = p.status as WslHostStatus;
      setStatuses((prev) => {
        // Only a RECOVERY re-reads: the config may have changed while the
        // host was down. Bumping on every "connected" would double-load
        // every first connect (~18 git spawns inside the distro each).
        if (next === "connected" && prev[p.distro] === "disconnected") {
          setReloadNonce((n) => n + 1);
        }
        return { ...prev, [p.distro]: next };
      });
    }).then((u) => (disposed ? u() : (unlisten = u)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const markConnected = useCallback((target: string) => {
    setStarted((prev) => (prev.includes(target) ? prev : [...prev, target]));
    setStatuses((prev) => ({ ...prev, [target]: "connected" }));
  }, []);

  const connect = useCallback(
    () =>
      void run(async () => {
        const target = selectedRef.current;
        setErrors((prev) => {
          const { [target]: _drop, ...rest } = prev;
          return rest;
        });
        try {
          const s = await wslHostGitStatus(target);
          setGitStatuses((prev) => ({ ...prev, [target]: s }));
          markConnected(target);
          // An explicit Connect/Reconnect is also "reload": without it a form
          // whose first load failed (git missing in the distro, say) would
          // keep showing that error with nothing to retry. Batched with
          // `markConnected`, so the first connect still loads exactly once.
          setReloadNonce((n) => n + 1);
        } catch (e) {
          setErrors((prev) => ({ ...prev, [target]: formatAppError(e) }));
          setStatuses((prev) => ({ ...prev, [target]: "disconnected" }));
        }
      }),
    [run, markConnected],
  );

  const setGitStatus = useCallback(
    (s: GitStatus) => {
      const target = selectedRef.current;
      setGitStatuses((prev) => ({ ...prev, [target]: s }));
      // Applying an override goes through the host too, so it connected.
      markConnected(target);
    },
    [markConnected],
  );

  const scope = useMemo(() => wslGitConfigScope(distro), [distro]);

  const listed = distros.find((d) => d.name === distro);
  const status = statuses[distro] ?? "unknown";
  const everConnected = started.includes(distro);
  const running = (listed?.running ?? false) || everConnected;

  const value = useMemo<WslHostCtx>(
    () => ({
      distros,
      distro,
      setDistro,
      running,
      everConnected,
      status,
      reloadNonce,
      connect,
      busy,
      gitStatus: gitStatuses[distro] ?? null,
      setGitStatus,
      error: errors[distro] ?? null,
      scope,
    }),
    [
      distros,
      distro,
      running,
      everConnected,
      status,
      reloadNonce,
      connect,
      busy,
      gitStatuses,
      setGitStatus,
      errors,
      scope,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

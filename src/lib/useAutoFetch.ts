import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../store/repos";
import { useSettingsStore } from "../store/settings";
import { useRemoteProgressStore } from "../store/remoteProgress";
import { repoFetch } from "./commands";
import { gitErrorKind } from "./types";
import { invalidateRepoDomains } from "./repoInvalidation";
import { useOpState } from "./useOpState";

/** How often the schedule is checked; the actual fetch cadence is the user's
 * configured interval (minutes). A coarse tick keeps the timer logic trivial
 * and an interval change simply applies from the next due time. */
const TICK_MS = 30_000;

/** Failed auto-fetches back off exponentially (2x per failure) up to this
 * multiple of the configured interval, so an offline machine or a dead remote
 * is not hammered on a timer. Any success resets the backoff. */
const MAX_BACKOFF = 8;

interface RepoSchedule {
  /** Earliest timestamp (ms) for the next auto-fetch of this repo. */
  nextAt: number;
  /** Current backoff multiplier (1 = healthy). */
  backoff: number;
  /** Auth failed once: never retry on a timer this session — re-prompting for
   * credentials from the background would be hostile. A manual fetch (and its
   * prompt) is the way back in. */
  authFailed: boolean;
}

/**
 * Periodic background auto-fetch (Global Settings, default off). Deliberately
 * conservative:
 * - fetch-only (`git fetch --all`, no prune), never a pull/merge;
 * - active repo only — background tabs refresh when activated;
 * - quiet: no toasts, no busy UI; with the watcher on, a no-op fetch causes
 *   zero UI churn (only real `refs/remotes/*` updates emit events);
 * - skipped while the app is hidden, offline, mid-operation (merge/rebase),
 *   or while any remote transfer is already running;
 * - the first fetch happens one full interval after a repo becomes active,
 *   never at app start.
 */
export function useAutoFetch() {
  const queryClient = useQueryClient();
  const repo = useActiveRepo();
  const enabled = useSettingsStore((s) => s.settings?.auto_fetch_enabled ?? false);
  const intervalMinutes = useSettingsStore(
    (s) => s.settings?.auto_fetch_interval_minutes ?? 15,
  );
  const opState = useOpState(enabled ? repo?.id : undefined);

  // Refs so the interval callback always sees current values without being
  // torn down on every render.
  const repoIdRef = useRef(repo?.id);
  repoIdRef.current = repo?.id;
  const opStateRef = useRef(opState);
  opStateRef.current = opState;

  /** Per-repo schedule, session-scoped (survives repo tab switches). */
  const scheduleRef = useRef(new Map<string, RepoSchedule>());
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const intervalMs = Math.max(1, intervalMinutes) * 60_000;

    const tick = async () => {
      const repoId = repoIdRef.current;
      if (!repoId || inFlightRef.current) return;
      // Quiet-hours guards: hidden app, offline machine, an in-progress
      // merge/rebase/…, or any running remote transfer all skip the tick.
      if (document.hidden || !navigator.onLine) return;
      const op = opStateRef.current;
      if (op && op.kind !== "none") return;
      if (Object.keys(useRemoteProgressStore.getState().byOp).length > 0) return;

      const schedule = scheduleRef.current;
      let entry = schedule.get(repoId);
      if (!entry) {
        // First sighting of this repo: due one full interval from now.
        entry = { nextAt: Date.now() + intervalMs, backoff: 1, authFailed: false };
        schedule.set(repoId, entry);
        return;
      }
      if (entry.authFailed || Date.now() < entry.nextAt) return;

      inFlightRef.current = true;
      try {
        await repoFetch(
          repoId,
          { all: true, prune: false, remote: null },
          crypto.randomUUID(),
        );
        entry.backoff = 1;
        // With the watcher on, real remote-ref updates arrive as filesystem
        // events and a no-op fetch stays invisible. Watcher off: fall back to
        // one coalesced invalidation.
        if (useSettingsStore.getState().settings?.watcher_enabled === false) {
          invalidateRepoDomains(
            queryClient,
            repoId,
            ["log", "branches", "status", "tracking"],
            { coalesce: true },
          );
        }
      } catch (e) {
        if (gitErrorKind(e) === "AuthFailed") {
          entry.authFailed = true;
        } else {
          entry.backoff = Math.min(entry.backoff * 2, MAX_BACKOFF);
        }
      } finally {
        entry.nextAt = Date.now() + intervalMs * entry.backoff;
        inFlightRef.current = false;
      }
    };

    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMinutes, queryClient]);
}

// Dev-build probe for UI-thread stalls: every frame that blocks for longer
// than the budget is reported with what ran in it and the interaction that
// led up to it, so a freeze shows up with a name instead of a guess. Uses the
// Long Animation Frames API (Chromium / WebView2), which attributes the time
// to scripts; engines without it report nothing.

import { api } from "./commands";

/** The plan's budget: no UI-thread task longer than this. */
export const LONG_FRAME_BUDGET_MS = 50;

const MAX_REPORTS_PER_MINUTE = 30;
const INTERACTION_WINDOW_MS = 5000;

export interface FrameScript {
  duration: number;
  invoker?: string;
  sourceFunctionName?: string;
  sourceURL?: string;
}

export interface LongFrame {
  startTime: number;
  duration: number;
  blockingDuration?: number;
  scripts?: readonly FrameScript[];
}

export interface Interaction {
  time: number;
  what: string;
}

const tail = (url: string) => url.replace(/^.*\/src\//, "src/").replace(/[?#].*$/, "");

/** One log line for a long frame: total and blocking time, the interaction
 * that preceded it, and its three most expensive scripts. */
export function describeLongFrame(frame: LongFrame, last: Interaction | null): string {
  const parts = [`long frame ${Math.round(frame.duration)} ms`];
  if (frame.blockingDuration != null) parts.push(`blocking ${Math.round(frame.blockingDuration)} ms`);
  if (last && frame.startTime - last.time <= INTERACTION_WINDOW_MS && frame.startTime >= last.time) {
    parts.push(`${Math.round(frame.startTime - last.time)} ms after ${last.what}`);
  }
  const scripts = [...(frame.scripts ?? [])]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 3)
    .map((s) => {
      const where = [s.sourceFunctionName, s.sourceURL && tail(s.sourceURL)].filter(Boolean).join(" @ ");
      return `${Math.round(s.duration)} ms ${s.invoker ?? "script"}${where ? ` (${where})` : ""}`;
    });
  if (scripts.length > 0) parts.push(`scripts: ${scripts.join("; ")}`);
  return parts.join(", ");
}

/** Short description of what the user touched, for the report. */
export function describeTarget(type: string, target: EventTarget | null, key?: string): string {
  const el = target instanceof Element ? target.closest("button, [role], [data-testid], a, input") ?? target : null;
  if (!el) return key ? `${type} ${key}` : type;
  const name =
    el.getAttribute("data-testid") ??
    el.getAttribute("title") ??
    el.getAttribute("aria-label") ??
    (el.textContent ?? "").trim().slice(0, 40);
  const tag = el.getAttribute("role") ?? el.tagName.toLowerCase();
  return `${type}${key ? ` ${key}` : ""} on ${tag}${name ? ` "${name}"` : ""}`;
}

/** Start reporting long frames to the console and the backend log file.
 * Call once, in dev builds only. */
export function installPerfProbe(): void {
  if (typeof PerformanceObserver === "undefined") return;
  if (!PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) return;

  let last: Interaction | null = null;
  const note = (e: Event) => {
    last = {
      time: performance.now(),
      what: describeTarget(e.type, e.target, e instanceof KeyboardEvent ? e.key : undefined),
    };
  };
  window.addEventListener("pointerdown", note, { capture: true, passive: true });
  window.addEventListener("keydown", note, { capture: true, passive: true });

  let windowStart = 0;
  let reported = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration < LONG_FRAME_BUDGET_MS) continue;
      const now = performance.now();
      if (now - windowStart > 60_000) {
        windowStart = now;
        reported = 0;
      }
      if (++reported > MAX_REPORTS_PER_MINUTE) continue;
      const line = describeLongFrame(entry as unknown as LongFrame, last);
      console.warn(`[perf] ${line}`);
      try {
        api.frontendLog("warn", `perf: ${line}`).catch(() => {});
      } catch {
        // reporting must never break the app
      }
    }
  }).observe({ type: "long-animation-frame", buffered: true });
}

import { create } from "zustand";
import { api } from "../lib/commands";
import type { ProblemNoticeStyle } from "../lib/types";
import { useSettingsStore } from "./settings";

export type NotificationKind = "error" | "warning" | "success" | "info";

export interface Notification {
  id: number;
  kind: NotificationKind;
  message: string;
  /** Keep the toast until dismissed even for success/info (errors always
   *  persist). Used e.g. by the update-available toast. */
  sticky?: boolean;
  /** Click handler for the toast body; default is opening the Git Log. */
  action?: () => void;
}

/** Optional behavior flags for `push`. */
export interface NotificationOptions {
  sticky?: boolean;
  action?: () => void;
  /** Raised by work the user did not start (sync, connection events): never interrupts. */
  background?: boolean;
}

export type ProblemSurface = "toast" | "banner" | "popup";

/** An error or warning that stays until the user dismisses it. */
export interface Problem {
  id: number;
  kind: "error" | "warning";
  message: string;
  surface: Exclude<ProblemSurface, "toast">;
}

/**
 * Where an error or warning shows under the user's setting. Background
 * notices and toasts that carry their own click action or lifetime stay
 * toasts; a window without a banner slot falls back to the popup so the
 * notice still waits for the user.
 */
export function problemSurface(
  style: ProblemNoticeStyle | null | undefined,
  opts: NotificationOptions,
  bannerAvailable: boolean,
): ProblemSurface {
  if (!style || style === "toast") return "toast";
  if (opts.background || opts.sticky || opts.action) return "toast";
  if (style === "banner" && !bannerAvailable) return "popup";
  return style;
}

let nextId = 1;

interface NotificationsStore {
  toasts: Notification[];
  push: (kind: NotificationKind, message: string, opts?: NotificationOptions) => number;
  /** Replace a live toast's message in place (progress updates). No-op when
   *  the toast was already dismissed. */
  update: (id: number, message: string) => void;
  dismiss: (id: number) => void;
  clear: () => void;
  problems: Problem[];
  /** Mounted banner slots in this window; 0 means banner notices use the popup. */
  bannerHosts: number;
  dismissProblems: (surface: Problem["surface"]) => void;
}

/** Central transient notifications (toasts). The overlay auto-dismisses
 *  everything but `sticky` toasts - errors on a long timeout, success/info
 *  on a short one. The full detail (e.g. the failing git command + stderr)
 *  lives in the Git Log panel. */
export const useNotificationsStore = create<NotificationsStore>((set) => ({
  toasts: [],
  push: (kind, message, opts) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, ...opts }] }));
    return id;
  },
  update: (id, message) =>
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, message } : t)) })),
  dismiss: (id) =>
    set((s) => ({
      toasts: s.toasts.filter((t) => t.id !== id),
      problems: s.problems.filter((p) => p.id !== id),
    })),
  clear: () => set({ toasts: [], problems: [] }),
  problems: [],
  bannerHosts: 0,
  dismissProblems: (surface) =>
    set((s) => ({ problems: s.problems.filter((p) => p.surface !== surface) })),
}));

function raiseProblem(
  kind: Problem["kind"],
  message: string,
  opts: NotificationOptions = {},
): number {
  const store = useNotificationsStore.getState();
  const style = useSettingsStore.getState().settings?.problem_notice_style;
  const surface = problemSurface(style, opts, store.bannerHosts > 0);
  if (surface === "toast") {
    const { background: _background, ...toastOpts } = opts;
    return store.push(kind, message, toastOpts);
  }
  const id = nextId++;
  useNotificationsStore.setState((s) => ({
    problems: [...s.problems, { id, kind, message, surface }],
  }));
  return id;
}

/** Convenience for non-component code (e.g. action handlers). */
export const notify = {
  error: (message: string, opts?: NotificationOptions) => {
    // A failure already reported as a warning (a stopped operation rejects
    // its command with the same text) adds nothing as an error on top.
    const { toasts, problems } = useNotificationsStore.getState();
    const shown = [...toasts, ...problems].find(
      (n) => n.kind === "warning" && message.includes(n.message),
    );
    if (shown) return shown.id;
    // Error toasts are what the user actually saw go wrong - mirror them into
    // the persistent log so a report ("it showed an error at some point")
    // can be matched to the git calls around it. Fire-and-forget; must never
    // break the toast (tests mock `api` partially, and outside Tauri the
    // invoke itself rejects).
    try {
      api.frontendLog("warn", `error toast: ${message}`).catch(() => {});
    } catch {
      // ignore: logging must never block the notification
    }
    return raiseProblem("error", message, opts);
  },
  warning: (message: string, opts?: NotificationOptions) => raiseProblem("warning", message, opts),
  success: (message: string) => useNotificationsStore.getState().push("success", message),
  info: (message: string, opts?: NotificationOptions) =>
    useNotificationsStore.getState().push("info", message, opts),
};

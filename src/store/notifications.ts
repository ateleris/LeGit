import { create } from "zustand";

export type NotificationKind = "error" | "success" | "info";

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
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** Convenience for non-component code (e.g. action handlers). */
export const notify = {
  error: (message: string) => useNotificationsStore.getState().push("error", message),
  success: (message: string) => useNotificationsStore.getState().push("success", message),
  info: (message: string, opts?: NotificationOptions) =>
    useNotificationsStore.getState().push("info", message, opts),
};

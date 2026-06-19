import { create } from "zustand";

export type NotificationKind = "error" | "success" | "info";

export interface Notification {
  id: number;
  kind: NotificationKind;
  message: string;
}

let nextId = 1;

interface NotificationsStore {
  toasts: Notification[];
  push: (kind: NotificationKind, message: string) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

/** Central transient notifications (toasts). Errors persist until dismissed;
 *  the toast overlay auto-dismisses success/info. The full detail (e.g. the
 *  failing git command + stderr) lives in the Git Log panel. */
export const useNotificationsStore = create<NotificationsStore>((set) => ({
  toasts: [],
  push: (kind, message) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** Convenience for non-component code (e.g. action handlers). */
export const notify = {
  error: (message: string) => useNotificationsStore.getState().push("error", message),
  success: (message: string) => useNotificationsStore.getState().push("success", message),
  info: (message: string) => useNotificationsStore.getState().push("info", message),
};

import { create } from "zustand";
import type { RemoteProgress } from "../lib/types";

/**
 * Latest transfer-progress update per in-flight remote operation, keyed by
 * the frontend-minted `opId` (the same id used for cancellation). Fed by the
 * `legit://remote-progress` Tauri event (wired once in AppLayout); consumers
 * (sync toolbar, clone form) read their own opId and must `clear` it when
 * the operation settles so stale meters never linger.
 */
interface RemoteProgressStore {
  byOp: Record<string, RemoteProgress>;
  report: (opId: string, progress: RemoteProgress) => void;
  clear: (opId: string) => void;
}

export const useRemoteProgressStore = create<RemoteProgressStore>((set) => ({
  byOp: {},
  report: (opId, progress) =>
    set((s) => ({ byOp: { ...s.byOp, [opId]: progress } })),
  clear: (opId) =>
    set((s) => {
      if (!(opId in s.byOp)) return s;
      const byOp = { ...s.byOp };
      delete byOp[opId];
      return { byOp };
    }),
}));

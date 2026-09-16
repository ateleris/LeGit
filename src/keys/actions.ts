import { useEffect, useRef } from "react";
import { create } from "zustand";

/**
 * Command-action registry: commands whose behaviour lives in a mounted
 * component (the sync toolbar's fetch/pull/push, the composer's commit)
 * register a handler here while mounted; the registry command's `run` calls
 * it and its `when` gates on registration, so the binding is inert exactly
 * when the owning surface is closed.
 */

interface CommandActionsStore {
  actions: Record<string, () => void>;
  register: (id: string, fn: () => void) => void;
  unregister: (id: string) => void;
}

export const useCommandActionsStore = create<CommandActionsStore>((set) => ({
  actions: {},
  register: (id, fn) => set((s) => ({ actions: { ...s.actions, [id]: fn } })),
  unregister: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.actions;
      return { actions: rest };
    }),
}));

export function hasCommandAction(id: string): boolean {
  return id in useCommandActionsStore.getState().actions;
}

export function runCommandAction(id: string): boolean {
  const fn = useCommandActionsStore.getState().actions[id];
  if (!fn) return false;
  fn();
  return true;
}

/** Register `fn` as the command's action while mounted; `null` = the action
 * is currently unavailable. Always invokes the latest `fn`. */
export function useCommandAction(id: string, fn: (() => void) | null): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const available = fn !== null;
  useEffect(() => {
    if (!available) return;
    const { register, unregister } = useCommandActionsStore.getState();
    register(id, () => fnRef.current?.());
    return () => unregister(id);
  }, [id, available]);
}

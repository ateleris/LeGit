import { create } from "zustand";

/**
 * Unsaved-changes state per panel, keyed by panel id AND by form key.
 *
 * A single boolean per panel is not enough: Global Settings hosts several
 * independent forms (the app-machine git config, its WSL twin, line endings
 * for each), and a CLEAN form writing `false` would clobber a dirty sibling's
 * `true` — silently suppressing the close-tab confirmation over unsaved edits.
 */
export type PanelDirtyMap = Record<string, Record<string, boolean>>;

interface PanelDirtyStore {
  dirty: PanelDirtyMap;
  setDirty: (panelId: string, formKey: string, isDirty: boolean) => void;
}

/** Whether ANY form on `panelId` has unsaved changes. Pure; unit-tested. */
export function isPanelDirty(dirty: PanelDirtyMap, panelId: string): boolean {
  const forms = dirty[panelId];
  return forms ? Object.values(forms).some(Boolean) : false;
}

export const usePanelDirtyStore = create<PanelDirtyStore>((set) => ({
  dirty: {},
  setDirty(panelId, formKey, isDirty) {
    set((s) => ({
      dirty: { ...s.dirty, [panelId]: { ...s.dirty[panelId], [formKey]: isDirty } },
    }));
  },
}));

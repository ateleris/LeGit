import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { DockviewPanelApi } from "dockview-react";
import { usePanelDirtyStore } from "../store/panel-dirty";

const PanelApiContext = createContext<DockviewPanelApi | null>(null);

export function PanelApiProvider({
  api,
  children,
}: {
  api: DockviewPanelApi;
  children: ReactNode;
}) {
  return <PanelApiContext.Provider value={api}>{children}</PanelApiContext.Provider>;
}

/**
 * Register this panel's dirty state so the custom close tab can show a
 * confirm dialog before closing when there are unsaved changes.
 */
export function usePanelDirty(isDirty: boolean) {
  const api = useContext(PanelApiContext);
  const setDirty = usePanelDirtyStore((s) => s.setDirty);
  useEffect(() => {
    if (!api) return;
    setDirty(api.id, isDirty);
    return () => setDirty(api.id, false);
  }, [api, isDirty, setDirty]);
}

/** Run `callback` every time this panel gains focus. */
export function usePanelFocusEffect(callback: () => void) {
  const api = useContext(PanelApiContext);
  useEffect(() => {
    if (!api) return;
    const disposable = api.onDidFocusChange((e) => {
      if (e.isFocused) callback();
    });
    return () => disposable.dispose();
    // callback identity is intentionally excluded — callers should memoize if needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
}

/**
 * Run `callback` every time this panel becomes the active panel in its group.
 * Unlike focus, this fires when a panel is swapped/summoned into a visible slot
 * without keyboard focus moving to it — so a summoned panel refreshes its data
 * as soon as it's shown, not only when explicitly clicked into.
 */
export function usePanelActiveEffect(callback: () => void) {
  const api = useContext(PanelApiContext);
  useEffect(() => {
    if (!api) return;
    const disposable = api.onDidActiveChange((e) => {
      if (e.isActive) callback();
    });
    return () => disposable.dispose();
    // callback identity is intentionally excluded — callers should memoize if needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
}

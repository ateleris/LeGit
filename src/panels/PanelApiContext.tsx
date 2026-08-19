import { createContext, useContext, useEffect, type ReactNode, type RefObject } from "react";
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

/** This panel's own dockview api (null outside a panel) - e.g. for a
 *  transient panel closing itself (`api.close()`). */
export function usePanelApi(): DockviewPanelApi | null {
  return useContext(PanelApiContext);
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

/** The subset of a `@tanstack/react-virtual` virtualizer this hook needs. */
interface ScrollRestorableVirtualizer {
  scrollOffset: number | null;
  scrollToOffset: (offset: number, options?: { align?: "start" }) => void;
}

/**
 * Fix virtualized lists rendering blank after their panel is tab-hidden and
 * re-shown. Dockview keeps the panel mounted but resets the scroll container's
 * `scrollTop` to 0 while it's hidden; the virtualizer still holds the old
 * `scrollOffset`, so on return it renders that range translated off-screen and
 * the visible (top) area is empty. On becoming active again we re-apply the
 * remembered offset to the DOM (`scrollToOffset`) — which resyncs the two and
 * restores the previous scroll position. `virtual-core` itself only does this
 * re-apply when the scroll element is (re)registered, which never happens on a
 * mere visibility toggle.
 */
export function useRestoreVirtualizerScroll(
  virtualizer: ScrollRestorableVirtualizer,
  scrollElRef: RefObject<HTMLElement | null>,
) {
  usePanelActiveEffect(() => {
    // Wait until the panel is actually laid out (dockview may still have it
    // display:none for this tick); setting scrollTop on a 0-height element is a
    // no-op, so retry next frame until it has size.
    const apply = () => {
      const el = scrollElRef.current;
      if (!el) return;
      if (el.clientHeight === 0) {
        requestAnimationFrame(apply);
        return;
      }
      virtualizer.scrollToOffset(virtualizer.scrollOffset ?? 0, { align: "start" });
    };
    requestAnimationFrame(apply);
  });
}

import type { DockviewApi } from "dockview-react";
import { useDockviewStore } from "../store/dockview";
import { useGlobalRegionStore } from "../store/globalRegion";
import { GLOBAL_PANELS } from "./descriptors";

/** Panel waiting for the global dock to mount (region was collapsed when it
 *  was summoned). Only the latest summon is kept - the last click wins. */
let pendingSummon: string | null = null;

/**
 * Open or focus a global panel, expanding the global region first if it is
 * collapsed. A collapsed region has NO mounted GlobalDock (AppLayout renders
 * it conditionally), so `globalApi` is null and a plain `openGlobalPanel`
 * would be a silent no-op - exactly what the View menu must not do. The
 * summon uncollapses (via the globalRegion store AppLayout subscribes to)
 * and the freshly mounted dock delivers the summon in readyGlobalDock.
 */
export function summonGlobalPanel(id: string) {
  useGlobalRegionStore.getState().setCollapsed(false);
  const api = useDockviewStore.getState().globalApi;
  if (api) {
    openGlobalPanel(api, id);
    return;
  }
  pendingSummon = id;
}

/** Open or focus a global panel by id. */
export function openGlobalPanel(api: DockviewApi | null, id: string) {
  if (!api) return;
  const desc = GLOBAL_PANELS.find((p) => p.id === id);
  if (!desc) return;
  const existing = api.getPanel(id);
  if (existing) {
    existing.focus();
    return;
  }
  api.addPanel({ id: desc.id, component: desc.id, title: desc.title });
}

/** Called by the global dock once it is initialized. */
export function deliverPendingGlobalSummon(api: DockviewApi) {
  // Deliver a summon that was waiting for this mount. Deliberately NOT
  // cleared here but on a microtask: in dev, React StrictMode mounts
  // DockviewReact twice back-to-back (mount, dispose, remount) within one
  // task, and only the second instance survives - a summon consumed by the
  // first mount alone never reached the dock the user sees. Every mount in
  // the current task replays it (focus is idempotent); afterwards it is
  // spent, so a later manual collapse/expand does not replay it.
  if (pendingSummon !== null) {
    const target = pendingSummon;
    queueMicrotask(() => {
      if (pendingSummon === target) pendingSummon = null;
    });
    openGlobalPanel(api, target);
  }
}

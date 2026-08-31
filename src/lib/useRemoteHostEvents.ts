// Remote-host UX wiring, mounted once near the root:
// - `legit://remote-host-status`: one sticky toast per disconnected distro
//   (auto-reconnect runs backend-side); dismissed on reconnect.
// - `legit://open-locator`: a second app invocation (the `legit .` launcher)
//   forwarded by the single-instance plugin.
// - the pending `--open` locator of a FRESH launch, consumed once on mount
//   (after the store restored tabs).

import { useEffect } from "react";
import { onOpenLocator, onRemoteHostStatus } from "./events";
import { takePendingOpen } from "./commands";
import { formatAppError } from "./types";
import { notify, useNotificationsStore } from "../store/notifications";
import { useRepoStore } from "../store/repos";

/** Live sticky-toast ids, one per disconnected distro. */
const disconnectToasts = new Map<string, number>();

export function useRemoteHostEvents() {
  const openRepo = useRepoStore((s) => s.openRepo);

  useEffect(() => {
    let disposed = false;
    const unsubs: Array<() => void> = [];

    void onRemoteHostStatus((p) => {
      const existing = disconnectToasts.get(p.distro);
      if (p.status === "disconnected") {
        if (existing == null) {
          const id = useNotificationsStore
            .getState()
            .push("error", `Connection to ${p.distro} lost — reconnecting…`, { sticky: true });
          disconnectToasts.set(p.distro, id);
        }
      } else if (p.status === "connected" && existing != null) {
        useNotificationsStore.getState().dismiss(existing);
        disconnectToasts.delete(p.distro);
        notify.success(`Reconnected to ${p.distro}`);
      }
    }).then((u) => (disposed ? u() : unsubs.push(u)));

    const doOpen = (locator: string) => {
      openRepo(locator).catch((e) => notify.error(formatAppError(e)));
    };
    void onOpenLocator(doOpen).then((u) => (disposed ? u() : unsubs.push(u)));
    takePendingOpen()
      .then((locator) => {
        if (locator) doOpen(locator);
      })
      .catch(console.warn);

    return () => {
      disposed = true;
      unsubs.forEach((u) => u());
    };
  }, [openRepo]);
}

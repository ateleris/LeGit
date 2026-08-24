import { useEffect } from "react";
import { useNotificationsStore, type Notification } from "../store/notifications";
import { useSummonStore } from "../store/summon";

const AUTO_DISMISS_MS = 4000;
/** Errors linger long enough to read and react, but no longer pile up
 *  forever - the full detail survives in the Git Command Log. */
const ERROR_AUTO_DISMISS_MS = 30_000;

/** Fixed overlay of transient notifications. Errors auto-dismiss on a long
 *  timeout, success/info on a short one, sticky toasts never. Clicking a
 *  toast opens the Git Log (where the full failing command + stderr is
 *  logged) rather than expanding inline. */
export function Toasts() {
  const toasts = useNotificationsStore((s) => s.toasts);
  const dismiss = useNotificationsStore((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className="legit-toasts">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function Toast({ toast, onDismiss }: { toast: Notification; onDismiss: () => void }) {
  useEffect(() => {
    // Sticky toasts stay until dismissed - they are the only pointer to
    // their flow (e.g. update available / install progress).
    if (toast.sticky) return;
    const ms = toast.kind === "error" ? ERROR_AUTO_DISMISS_MS : AUTO_DISMISS_MS;
    const h = setTimeout(onDismiss, ms);
    return () => clearTimeout(h);
  }, [toast.kind, toast.sticky, onDismiss]);

  return (
    <div className={`legit-toast legit-toast--${toast.kind}`} role="status">
      <button
        className="legit-toast__body"
        onClick={() => {
          if (toast.action) toast.action();
          else useSummonStore.getState().summon("git-log");
          onDismiss();
        }}
        title={toast.action ? undefined : "Open the Git Command Log for details"}
      >
        <span className="legit-toast__msg">{toast.message}</span>
      </button>
      <button className="legit-toast__close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

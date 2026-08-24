import { useEffect } from "react";
import { useNotificationsStore, type Notification } from "../store/notifications";
import { useSummonStore } from "../store/summon";

const AUTO_DISMISS_MS = 4000;

/** Fixed overlay of transient notifications. Errors persist until dismissed;
 *  success/info auto-dismiss. Clicking a toast opens the Git Log (where the
 *  full failing command + stderr is logged) rather than expanding inline. */
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
    // Errors and sticky toasts stay until dismissed.
    if (toast.kind === "error" || toast.sticky) return;
    const h = setTimeout(onDismiss, AUTO_DISMISS_MS);
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

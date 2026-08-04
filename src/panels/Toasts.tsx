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
    if (toast.kind === "error") return; // errors stay until dismissed
    const h = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(h);
  }, [toast.kind, onDismiss]);

  return (
    <div className={`legit-toast legit-toast--${toast.kind}`} role="status">
      <button
        className="legit-toast__body"
        onClick={() => {
          useSummonStore.getState().summon("git-log");
          onDismiss();
        }}
        title="Open the Git Command Log for details"
      >
        <span className="legit-toast__msg">{toast.message}</span>
      </button>
      <button className="legit-toast__close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

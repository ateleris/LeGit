import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  onCredentialRequest,
  onCredentialClosed,
  type CredentialRequestPayload,
} from "../lib/events";
import { credentialRespond, credentialCancel } from "../lib/commands";
import { Button } from "./shared/buttons";

/**
 * Global host for in-app git credential prompts. The backend's credential
 * broker emits a request whenever a git operation needs credentials no
 * configured helper could provide; this renders one centered dialog at a
 * time (further requests queue) and answers via `credential_respond` /
 * `credential_cancel`. A closed event (git cancelled / timed out) drops the
 * matching request even while its dialog is open.
 *
 * Mounted once in `AppLayout`.
 */
export function CredentialPromptHost() {
  const [queue, setQueue] = useState<CredentialRequestPayload[]>([]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    onCredentialRequest((p) => {
      setQueue((q) => [...q, p]);
    }).then((fn) => (disposed ? fn() : unlisteners.push(fn)));
    onCredentialClosed((p) => {
      setQueue((q) => q.filter((r) => r.request_id !== p.request_id));
    }).then((fn) => (disposed ? fn() : unlisteners.push(fn)));
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const active = queue[0] ?? null;
  const dismiss = useCallback((requestId: string) => {
    setQueue((q) => q.filter((r) => r.request_id !== requestId));
  }, []);

  if (!active) return null;
  return (
    <CredentialDialog
      // Remount per request so field state never leaks between prompts.
      key={active.request_id}
      request={active}
      onDone={() => dismiss(active.request_id)}
    />
  );
}

/** Last path component, for display ("C:\\work\\repo" / "/work/repo" -> "repo"). */
function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function CredentialDialog({
  request,
  onDone,
}: {
  request: CredentialRequestPayload;
  onDone: () => void;
}) {
  const [username, setUsername] = useState(request.username ?? "");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const submittedRef = useRef(false);

  const submit = async () => {
    if (submittedRef.current || !username.trim() || !password) return;
    submittedRef.current = true;
    try {
      await credentialRespond(request.request_id, username.trim(), password, remember);
    } finally {
      onDone();
    }
  };

  const cancel = useCallback(async () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    try {
      await credentialCancel(request.request_id);
    } finally {
      onDone();
    }
  }, [request.request_id, onDone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void cancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cancel]);

  const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 3 };
  const caption: React.CSSProperties = { fontSize: "var(--fz-sm)", color: "var(--subtle-fg)" };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Git credentials"
      style={{
        position: "fixed",
        top: "20%",
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(26em, calc(100vw - 32px))",
        background: "var(--panel-bg)",
        color: "var(--panel-fg)",
        border: "1px solid var(--panel-border)",
        borderRadius: 6,
        boxShadow: "0 6px 24px var(--shadow-color)",
        padding: "12px 14px",
        zIndex: 10000,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        fontSize: "var(--fz-md)",
      }}
    >
      <div
        style={{
          fontSize: "var(--fz-sm)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--subtle-fg)",
        }}
      >
        Git credentials
      </div>
      <div style={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>
        {request.protocol}://{request.host}
      </div>
      {request.repo_dir && (
        <div style={caption} title={request.repo_dir}>
          Requested by a git operation in{" "}
          <span style={{ fontFamily: "monospace" }}>{basename(request.repo_dir)}</span>. If you
          didn't start one, cancel.
        </div>
      )}
      <label style={field}>
        <span style={caption}>Username</span>
        <input
          autoFocus={!request.username}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      <label style={field}>
        <span style={caption}>Password / token</span>
        <input
          autoFocus={!!request.username}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
        />
        <span>
          Remember in the OS keychain
          <span className="legit-subtle"> (saved only after git accepts them)</span>
        </span>
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        <button onClick={() => void cancel()}>Cancel</button>
        <Button
          variant="primary"
          disabled={!username.trim() || !password}
          onClick={() => void submit()}
        >
          OK
        </Button>
      </div>
    </div>,
    document.body,
  );
}

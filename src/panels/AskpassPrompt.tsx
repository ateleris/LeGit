import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  onAskpassRequest,
  onAskpassClosed,
  type AskpassRequestPayload,
} from "../lib/events";
import { askpassRespond, askpassCancel } from "../lib/commands";
import { Button } from "./shared/buttons";

/**
 * Global host for in-app ssh askpass prompts (key passphrases, first-connect
 * host-key confirmations, anything else ssh asks). The backend's broker
 * emits a request whenever an ssh child of a git operation prompts via the
 * SSH_ASKPASS shim; this renders one dialog at a time (further requests
 * queue) and answers via `askpass_respond` / `askpass_cancel`. A closed
 * event (ssh gone / timed out) drops the matching request even while its
 * dialog is open. Mirrors `CredentialPromptHost`.
 *
 * Mounted once in `AppLayout`.
 */
export function AskpassPromptHost() {
  const [queue, setQueue] = useState<AskpassRequestPayload[]>([]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    onAskpassRequest((p) => {
      setQueue((q) => [...q, p]);
    }).then((fn) => (disposed ? fn() : unlisteners.push(fn)));
    onAskpassClosed((p) => {
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
    <AskpassDialog
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

function AskpassDialog({
  request,
  onDone,
}: {
  request: AskpassRequestPayload;
  onDone: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const submittedRef = useRef(false);

  const respond = async (value: string) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    try {
      await askpassRespond(request.request_id, value);
    } finally {
      onDone();
    }
  };

  const cancel = useCallback(async () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    try {
      await askpassCancel(request.request_id);
    } finally {
      onDone();
    }
  }, [request.request_id, onDone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Consumed: cancelling the prompt must not leak to other Escape
        // listeners (e.g. exiting a maximized panel).
        e.stopPropagation();
        void cancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cancel]);

  const caption: React.CSSProperties = { fontSize: "var(--fz-sm)", color: "var(--subtle-fg)" };
  const confirmation = request.kind === "confirmation";
  const title =
    request.kind === "passphrase"
      ? "SSH key passphrase"
      : confirmation
        ? "SSH host verification"
        : "SSH prompt";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        top: "20%",
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(30em, calc(100vw - 32px))",
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
        {title}
      </div>
      {request.kind === "passphrase" && request.key_path ? (
        <div style={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>
          {request.key_path}
        </div>
      ) : (
        // Confirmations (and unknown prompts) show ssh's text verbatim - a
        // host-key fingerprint must reach the user unaltered.
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{request.prompt}</div>
      )}
      {request.retry && (
        <div style={caption}>
          <strong>The passphrase was not accepted</strong> - try again.
        </div>
      )}
      {request.repo_dir && (
        <div style={caption} title={request.repo_dir}>
          Requested by an operation in{" "}
          <span style={{ fontFamily: "monospace" }}>{basename(request.repo_dir)}</span>. If you
          didn't start one, cancel.
        </div>
      )}
      {!confirmation && (
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={caption}>
            {request.kind === "passphrase" ? "Passphrase" : "Answer"}
            <span className="legit-subtle"> (kept in memory for this session only)</span>
          </span>
          <input
            autoFocus
            type="password"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && answer && void respond(answer)}
          />
        </label>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        {confirmation ? (
          // No autofocus on Yes: verifying a host key deserves a deliberate
          // click (the app convention starts focus away from the approving
          // button).
          <>
            <button onClick={() => void respond("no")}>No</button>
            <button onClick={() => void cancel()}>Cancel</button>
            <Button variant="primary" onClick={() => void respond("yes")}>
              Yes
            </Button>
          </>
        ) : (
          <>
            <button onClick={() => void cancel()}>Cancel</button>
            <Button variant="primary" disabled={!answer} onClick={() => void respond(answer)}>
              {request.kind === "passphrase" ? "Unlock key" : "OK"}
            </Button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

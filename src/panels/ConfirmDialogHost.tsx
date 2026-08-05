import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useConfirmStore, type PendingConfirm } from "../store/confirm";
import { placeDialogNearPointer, type Point } from "./dialogPlacement";
import { Button } from "./shared/buttons";

/**
 * Global host for confirmation/decision dialogs (`confirmDialog` in
 * `store/confirm.ts`). One dialog at a time (further requests queue),
 * portal-rendered like `CredentialPromptHost` so it can never scroll out
 * of view or reflow panel content. Mounted once in `AppLayout`.
 *
 * The dialog opens NEAR THE POINTER, context-menu style: the cursor lands
 * in the title area, keeping the button row away from the click point
 * (`dialogPlacement.ts`). Without pointer info (keyboard flows) it centers.
 *
 * Safety shape: the target is named in the body, the confirm button is
 * danger-styled, initial focus is on CANCEL (a stray Enter must not
 * confirm), and Escape or a backdrop click cancels.
 */
export function ConfirmDialogHost() {
  const active = useConfirmStore((s) => s.queue[0] ?? null);

  // Track the pointer so a dialog raised from any click (or after an async
  // step) knows where to appear. A ref write per event - negligible.
  useEffect(() => {
    const track = (e: PointerEvent) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("pointermove", track, { passive: true, capture: true });
    window.addEventListener("pointerdown", track, { passive: true, capture: true });
    return () => {
      window.removeEventListener("pointermove", track, true);
      window.removeEventListener("pointerdown", track, true);
    };
  }, []);

  if (!active) return null;
  // Remount per request so nothing leaks between dialogs.
  return <ConfirmDialog key={active.id} request={active} />;
}

/** Last known pointer position (viewport coords); null until it moves. */
let lastPointer: Point | null = null;

function ConfirmDialog({ request }: { request: PendingConfirm }) {
  const settle = useConfirmStore((s) => s.settle);
  const cancel = useCallback(() => settle(request.id, false), [settle, request.id]);
  const confirm = useCallback(() => settle(request.id, true), [settle, request.id]);

  // Pointer position captured at mount; the dialog is measured after the
  // first (hidden) render, then placed near it. No anchor -> centered.
  const anchorRef = useRef<Point | null>(lastPointer);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const el = dialogRef.current;
    if (!anchor || !el) return;
    setPos(
      placeDialogNearPointer(
        anchor,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, []);
  const anchored = anchorRef.current !== null;
  const placement: React.CSSProperties = !anchored
    ? { top: "20%", left: "50%", transform: "translateX(-50%)" }
    : pos
      ? { top: pos.top, left: pos.left }
      : // Anchored but not yet measured: keep the first render invisible so
        // the dialog never flashes at a wrong position.
        { top: 0, left: 0, visibility: "hidden" };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancel();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [cancel]);

  return createPortal(
    <>
      {/* Invisible full-screen layer: click-outside cancels. */}
      <div
        onClick={cancel}
        style={{ position: "fixed", inset: 0, zIndex: 10000, background: "transparent" }}
      />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={request.title ?? request.message}
        style={{
          position: "fixed",
          ...placement,
          width: "min(28em, calc(100vw - 2em))",
          background: "var(--panel-bg)",
          color: "var(--panel-fg)",
          border: "1px solid var(--panel-border)",
          borderRadius: 6,
          boxShadow: "0 6px 24px var(--shadow-color)",
          padding: "0.9em 1em",
          zIndex: 10001,
          display: "flex",
          flexDirection: "column",
          gap: "0.7em",
          fontSize: "var(--fz-md)",
        }}
      >
        {request.title && (
          <div
            style={{
              fontSize: "var(--fz-sm)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "var(--subtle-fg)",
            }}
          >
            {request.title}
          </div>
        )}
        <div>{request.message}</div>
        {request.detail && (
          <div style={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>
            {request.detail}
          </div>
        )}
        {request.warning && (
          <strong className="legit-error" style={{ fontSize: "var(--fz-md)" }}>
            {request.warning}
          </strong>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5em" }}>
          <button autoFocus onClick={cancel}>
            {request.cancelLabel ?? "Cancel"}
          </button>
          <Button variant={(request.danger ?? true) ? "danger" : "primary"} onClick={confirm}>
            {request.confirmLabel}
          </Button>
        </div>
      </div>
    </>,
    document.body,
  );
}

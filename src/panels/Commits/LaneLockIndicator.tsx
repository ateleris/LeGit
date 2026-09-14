// Lock indicator shown in the graph column header: a lock icon centred on the
// locked lane. Clicking (or right-clicking) it opens a small context menu to
// remove the lock.

import { useCallback, useState } from "react";
import { LockFilledIcon } from "../../icons";
import { useLaneLocksStore } from "../../store/laneLocks";
import { Popover } from "../shared/Popover";

interface LaneLockIndicatorProps {
  /** Full ref name the lock is attached to (e.g. refs/heads/main). */
  refName: string;
  /** Lane index the ref is pinned to. */
  laneIndex: number;
  /** Per-lane horizontal spacing in px — drives the icon's x position. */
  laneSpacing: number;
  /** Active repo id, for the unset-lock call. */
  repoId: string;
  /** CSS colour of the lane the lock is pinned to (the lock is tinted to match). */
  color: string;
}

const MENU_W = 220;

export function LaneLockIndicator({
  refName,
  laneIndex,
  laneSpacing,
  repoId,
  color,
}: LaneLockIndicatorProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const x = laneIndex * laneSpacing + laneSpacing / 2;
  const shortRef = refName.replace(/^refs\/heads\//, "");

  const openMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const removeLock = useCallback(() => {
    useLaneLocksStore
      .getState()
      .unsetLock(repoId, refName)
      .catch((err) => console.warn("unsetLock failed", err));
    closeMenu();
  }, [repoId, refName, closeMenu]);

  return (
    <>
      <span
        title={`${shortRef} locked to lane ${laneIndex + 1} — click to manage`}
        onClick={openMenu}
        onContextMenu={openMenu}
        // Not draggable, so it doesn't start a column-header drag.
        draggable={false}
        style={{
          position: "absolute",
          left: x,
          top: "50%",
          transform: "translate(-50%, -50%)",
          fontSize: "var(--fz-lg)",
          lineHeight: 1,
          display: "inline-flex",
          color,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <LockFilledIcon />
      </span>

      {menu && (
        <LockMenu
          x={menu.x}
          y={menu.y}
          shortRef={shortRef}
          laneIndex={laneIndex}
          onRemove={removeLock}
          onClose={closeMenu}
        />
      )}
    </>
  );
}

function LockMenu({
  x,
  y,
  shortRef,
  laneIndex,
  onRemove,
  onClose,
}: {
  x: number;
  y: number;
  shortRef: string;
  laneIndex: number;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [hover, setHover] = useState(false);

  return (
    <Popover
      x={x}
      y={y}
      onClose={onClose}
      style={{
        minWidth: MENU_W,
        background: "var(--panel-bg, #1e1e1e)",
        border: "1px solid var(--panel-border, rgba(255,255,255,0.12))",
        borderRadius: 4,
        padding: "0.333em 0",
        boxShadow: "0 4px 12px var(--shadow-color)",
        fontSize: "var(--fz-lg)",
        color: "var(--panel-fg, #ccc)",
        userSelect: "none",
      }}
    >
      <div
        style={{
          padding: "0.333em 1.167em",
          fontSize: "var(--fz-sm)",
          color: "var(--subtle-fg, #a1a1a1)",
          whiteSpace: "nowrap",
          cursor: "default",
        }}
      >
        {shortRef} → lane {laneIndex + 1}
      </div>
      <div
        onClick={onRemove}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          padding: "0.5em 1.167em",
          cursor: "pointer",
          whiteSpace: "nowrap",
          color: "var(--panel-fg, #ccc)",
          background: hover ? "var(--tab-active-bg, rgba(255,255,255,0.08))" : "",
        }}
      >
        Remove lock
      </div>
    </Popover>
  );
}

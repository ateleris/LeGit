// Contextual menu section for a branch/fused chip: lock the branch to a lane,
// or unlock it. Rendered inside the unified PanelContextMenu (which supplies
// the shell and appends the baseline entries below this section).

import { useMemo, useState } from "react";
import type { LaneLock } from "../../../lib/types";
import { useLaneLocksStore } from "../../../store/laneLocks";
import { usePanelContextMenu } from "./PanelContextMenu";
import { MenuItem } from "./primitives";
import { ordinal } from "./ordinal";

interface LaneLockSectionProps {
  /** Local branch ref to lock (e.g. refs/heads/dev). */
  refName: string;
  /** Current locks for the active repo. */
  locks: LaneLock[];
  /** Active repo id (needed for set/unsetLock calls). */
  repoId: string;
}

export function LaneLockSection({ refName, locks, repoId }: LaneLockSectionProps) {
  const { closeMenu } = usePanelContextMenu();
  const [customError, setCustomError] = useState<string | null>(null);

  const currentLockLane = useMemo(() => {
    const found = locks.find((l) => l.refName === refName);
    return found ? found.laneIndex : null;
  }, [locks, refName]);
  const isLocked = currentLockLane !== null;

  // Lanes claimed by *other* refs; this ref's own lane is "available" so the
  // user can re-lock to the same lane (a no-op visually).
  const claimedByOthers = useMemo(() => {
    const s = new Set<number>();
    for (const l of locks) {
      if (l.refName !== refName) s.add(l.laneIndex);
    }
    return s;
  }, [locks, refName]);

  // Lowest lane index not already claimed by another ref — used to prefill the
  // input so the common case (lock to the next free lane) is one click away.
  const firstFreeLane = useMemo(() => {
    let n = 0;
    while (claimedByOthers.has(n)) n++;
    return n;
  }, [claimedByOthers]);

  // Input is 1-based (user-facing); the internal lane index is value - 1.
  const [customLane, setCustomLane] = useState(() => String(firstFreeLane + 1));

  const handleLock = (laneIdx: number) => {
    useLaneLocksStore
      .getState()
      .setLock(repoId, refName, laneIdx)
      .catch((e) => console.warn("setLock failed", e));
    closeMenu();
  };

  const handleUnlock = () => {
    useLaneLocksStore
      .getState()
      .unsetLock(repoId, refName)
      .catch((e) => console.warn("unsetLock failed", e));
    closeMenu();
  };

  const handleCustomLock = () => {
    const n = parseInt(customLane, 10);
    if (!Number.isInteger(n) || n < 1 || n > 65) {
      setCustomError("Enter a number 1–65");
      return;
    }
    const laneIdx = n - 1;
    if (claimedByOthers.has(laneIdx)) {
      setCustomError(`Lane ${n} is already claimed`);
      return;
    }
    handleLock(laneIdx);
  };

  if (isLocked) {
    return (
      <MenuItem onClick={handleUnlock}>
        {`Unlock (currently ${ordinal(currentLockLane)} lane)`}
      </MenuItem>
    );
  }

  return (
    <>
      <div
        style={{
          padding: "8px 14px",
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: "var(--fz-md)", whiteSpace: "nowrap" }}>Lock branch to lane:</span>
        <input
          type="number"
          min={1}
          max={65}
          placeholder="#"
          value={customLane}
          onChange={(e) => {
            setCustomLane(e.target.value);
            setCustomError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCustomLock();
          }}
          style={{
            width: 64,
            fontSize: "var(--fz-md)",
            padding: "2px 6px",
            background: "var(--input-bg, #2a2a2a)",
            border: "1px solid var(--input-border, rgba(255,255,255,0.2))",
            borderRadius: 3,
            color: "var(--panel-fg, #ccc)",
            outline: "none",
          }}
          // Prevent the menu's outside-click handler from closing it when
          // clicking the input.
          onMouseDown={(e) => e.stopPropagation()}
        />
        <button onClick={handleCustomLock} style={{ fontSize: "var(--fz-md)", padding: "2px 8px" }}>
          Lock
        </button>
      </div>
      {customError && (
        <div
          style={{
            padding: "2px 14px 6px",
            fontSize: "var(--fz-sm)",
            color: "var(--error-fg, #e87060)",
          }}
        >
          {customError}
        </div>
      )}
    </>
  );
}

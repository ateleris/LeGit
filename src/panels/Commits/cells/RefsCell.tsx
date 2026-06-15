import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BranchIcon, RemoteIcon, TagIcon } from "../../../icons";
import type { LaneLock, RefDecoration } from "../../../lib/types";
import { usePanelContextMenu } from "../menu/PanelContextMenu";
import { LaneLockSection } from "../menu/LaneLockSection";
import { buildChips, computeVisibleCount } from "./refChips";
import type { ChipDescriptor } from "./refChips";

interface RefsCellProps {
  decorations: RefDecoration[];
  /** Current locks for the active repo. */
  locks: LaneLock[];
  /** Active repo id (needed for set/unsetLock calls). */
  repoId: string;
  /** Full local ref → full upstream ref, for fusing a branch with its remote. */
  upstreamMap: Map<string, string>;
  /** Chip font size in px (user-configurable, shared with the text columns). */
  textSize: number;
}

const CHIP_GAP = 3;

/** Renders ref decoration chips for a commit row. */
export function RefsCell({ decorations, locks, repoId, upstreamMap, textSize }: RefsCellProps) {
  const { openMenu } = usePanelContextMenu();
  const [visibleCount, setVisibleCount] = useState(Number.MAX_SAFE_INTEGER);
  const [popover, setPopover] = useState<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  // Hover lifecycle for the "+N" popover: opening cancels any pending close;
  // leaving the chip or the popover schedules a short-grace close so the
  // pointer can travel between them.
  const closeTimer = useRef<number | null>(null);

  const cancelPopoverClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const openPopoverAt = useCallback(
    (anchor: HTMLElement) => {
      cancelPopoverClose();
      const rect = anchor.getBoundingClientRect();
      setPopover({ x: rect.left, y: rect.bottom });
    },
    [cancelPopoverClose]
  );

  const schedulePopoverClose = useCallback(() => {
    cancelPopoverClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setPopover(null);
    }, 150);
  }, [cancelPopoverClose]);

  useEffect(() => cancelPopoverClose, [cancelPopoverClose]);

  // Priority-sorted chips: HEAD pair, branches (fused with their remote where
  // applicable), remotes, tags, other.
  const chips = useMemo(
    () => buildChips(decorations, upstreamMap),
    [decorations, upstreamMap],
  );

  // Measure the hidden full chip row and compute how many chips fit on the
  // single visible line; the rest collapse behind a "+N" chip.
  const remeasure = useCallback(() => {
    const measurer = measureRef.current;
    const container = containerRef.current;
    if (!measurer || !container) return;
    const widths = Array.from(
      measurer.children,
      (el) => (el as HTMLElement).offsetWidth,
    );
    // The measurer's last child is the worst-case "+99" overflow chip probe.
    const overflowWidth = widths.pop() ?? 0;
    setVisibleCount(
      computeVisibleCount(widths, container.clientWidth, CHIP_GAP, overflowWidth),
    );
  }, []);

  useLayoutEffect(() => {
    remeasure();
  }, [remeasure, chips, textSize]);

  // Re-fit when the Refs column is resized.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => remeasure());
    observer.observe(container);
    return () => observer.disconnect();
  }, [remeasure]);

  if (decorations.length === 0) return null;

  // Find HeadOf target so we can mark the matching branch chip as "checked out"
  const headOfDec = decorations.find((d) => d.type === "headOf");
  const headOfTarget = headOfDec && headOfDec.type === "headOf" ? headOfDec.value : null;

  const renderChip = (chip: ChipDescriptor, key: React.Key) => {
    // Branch and fused chips lock on the local branch ref; others don't lock.
    const refName =
      chip.kind === "branch"
        ? chip.value
        : chip.kind === "fusedBranch"
          ? chip.local
          : null;
    return (
      <Chip
        key={key}
        chip={chip}
        headOfTarget={headOfTarget}
        textSize={textSize}
        onContextMenu={(e) => {
          // Lockable chips contribute the lane-lock section; other chips open
          // the baseline-only menu (still suppresses the native menu).
          openMenu(
            e,
            refName ? <LaneLockSection refName={refName} locks={locks} repoId={repoId} /> : undefined,
          );
        }}
      />
    );
  };

  // The "+N" overflow chip tracks the configured text size like the chips it
  // collapses.
  const overflowChipStyle = { ...OVERFLOW_CHIP, fontSize: textSize };

  const visibleChips = chips.slice(0, visibleCount);
  const hiddenChips = chips.slice(visibleCount);

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        display: "flex",
        gap: CHIP_GAP,
        alignItems: "center",
        justifyContent: "flex-end",
        overflow: "hidden",
      }}
    >
      {/* Invisible measurement pass — all chips plus the overflow chip probe. */}
      <div
        ref={measureRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          display: "flex",
          gap: CHIP_GAP,
          visibility: "hidden",
          pointerEvents: "none",
        }}
      >
        {chips.map((chip, i) => renderChip(chip, i))}
        <span style={overflowChipStyle}>+99</span>
      </div>

      {visibleChips.map((dec, i) => renderChip(dec, i))}

      {hiddenChips.length > 0 && (
        <span
          style={overflowChipStyle}
          onMouseEnter={(e) => openPopoverAt(e.currentTarget)}
          onMouseLeave={schedulePopoverClose}
          onClick={(e) => openPopoverAt(e.currentTarget)}
        >
          +{hiddenChips.length}
        </span>
      )}

      {popover &&
        createPortal(
          <OverflowPopover
            x={popover.x}
            y={popover.y}
            onClose={() => setPopover(null)}
            onPointerEnter={cancelPopoverClose}
            onPointerLeave={schedulePopoverClose}
          >
            {hiddenChips.map((dec, i) => renderChip(dec, i))}
          </OverflowPopover>,
          document.body
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chip
// ---------------------------------------------------------------------------

interface ChipProps {
  chip: ChipDescriptor;
  headOfTarget: string | null;
  /** Chip font size in px. */
  textSize: number;
  /** Called on right-click; the unified menu handles preventDefault. */
  onContextMenu: (e: React.MouseEvent) => void;
}

const shortBranch = (ref: string) => ref.replace(/^refs\/heads\//, "");
const shortRemote = (ref: string) => ref.replace(/^refs\/remotes\//, "");

/**
 * The remote-tracking indicator shown on a fused chip. Inherits the chip's
 * foreground colour. Isolated so it can later render a per-remote service logo
 * instead of the generic cloud glyph.
 */
function RemoteIndicator({ remoteRef }: { remoteRef: string }) {
  return (
    <span title={shortRemote(remoteRef)} style={{ display: "inline-flex" }}>
      <RemoteIcon />
    </span>
  );
}

function Chip({ chip, headOfTarget, textSize, onContextMenu }: ChipProps) {
  const handleContextMenu = onContextMenu;

  switch (chip.kind) {
    case "head":
      return (
        <span
          onContextMenu={handleContextMenu}
          style={chipStyle({ variant: "head", textSize })}
          title="Detached HEAD"
        >
          HEAD
        </span>
      );

    case "headOf":
      // Render a HEAD → indicator; the branch chip that follows shows emphasis.
      return (
        <span
          onContextMenu={handleContextMenu}
          style={chipStyle({ variant: "head-indicator", textSize })}
          title={`HEAD → ${chip.value}`}
        >
          HEAD →
        </span>
      );

    case "branch": {
      const isCheckedOut = headOfTarget !== null && chip.value === headOfTarget;
      return (
        <span
          onContextMenu={handleContextMenu}
          style={chipStyle({ variant: "branch", isCheckedOut, textSize })}
          title={chip.value}
        >
          <BranchIcon /> {shortBranch(chip.value)}
        </span>
      );
    }

    case "fusedBranch": {
      // Local branch fused with its upstream remote (same commit): the local
      // pill plus a trailing remote indicator.
      const isCheckedOut = headOfTarget !== null && chip.local === headOfTarget;
      return (
        <span
          onContextMenu={handleContextMenu}
          style={chipStyle({ variant: "branch", isCheckedOut, textSize })}
          title={`${shortBranch(chip.local)} → ${shortRemote(chip.remote)}`}
        >
          <BranchIcon /> <RemoteIndicator remoteRef={chip.remote} /> {shortBranch(chip.local)}
        </span>
      );
    }

    case "remote":
      return (
        <span
          onContextMenu={handleContextMenu}
          style={chipStyle({ variant: "remote", textSize })}
          title={chip.value}
        >
          <RemoteIcon /> {shortRemote(chip.value)}
        </span>
      );

    case "tag":
      return (
        <span
          onContextMenu={handleContextMenu}
          style={chipStyle({ variant: "tag", textSize })}
          title={chip.value}
        >
          <TagIcon /> {chip.value.replace(/^refs\/tags\//, "")}
        </span>
      );

    case "other":
      return (
        <span
          onContextMenu={handleContextMenu}
          style={chipStyle({ variant: "other", textSize })}
          title={chip.value}
        >
          {chip.value}
        </span>
      );
  }
}

// ---------------------------------------------------------------------------
// Overflow popover (portal-rendered)
// ---------------------------------------------------------------------------

const POPOVER_W = 280;
const POPOVER_H_ESTIMATE = 120;

/** Panel listing the ref chips that didn't fit on the row's single line. */
function OverflowPopover({
  x,
  y,
  onClose,
  onPointerEnter,
  onPointerLeave,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click + Escape.
  useEffect(() => {
    const controller = new AbortController();
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && !panelRef.current?.contains(target)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouseDown, { signal: controller.signal });
    document.addEventListener("keydown", onKey, { signal: controller.signal });
    return () => controller.abort();
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - POPOVER_W - 4);
  const top = Math.min(y + 8, window.innerHeight - POPOVER_H_ESTIMATE - 4);

  return (
    <div
      ref={panelRef}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      style={{
        position: "fixed",
        left,
        top,
        maxWidth: POPOVER_W,
        background: "var(--panel-bg, #1e1e1e)",
        border: "1px solid var(--panel-border, rgba(255,255,255,0.12))",
        borderRadius: 4,
        padding: 8,
        zIndex: 9999,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        alignItems: "center",
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

// Font size is applied per-render from the configured text size (see
// chipStyle / overflowChipStyle); lineHeight is unitless so it scales with it.
const BASE_CHIP: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  lineHeight: 1.3,
  padding: "1px 5px",
  borderRadius: 10,
  whiteSpace: "nowrap",
  maxWidth: 160,
  overflow: "hidden",
  textOverflow: "ellipsis",
  cursor: "default",
  userSelect: "none",
};

/** The "+N" chip collapsing refs that don't fit on the row's single line. */
const OVERFLOW_CHIP: React.CSSProperties = {
  ...BASE_CHIP,
  background: "rgba(255, 255, 255, 0.08)",
  border: "1px solid rgba(255, 255, 255, 0.25)",
  color: "var(--subtle-fg, #aaa)",
  cursor: "pointer",
  flexShrink: 0,
};

type ChipVariant =
  | "branch"
  | "remote"
  | "tag"
  | "head"
  | "head-indicator"
  | "other";

// Chip colours are theme tokens (see src/theme/tokens.ts, group "Refs"). The
// fallbacks preserve the previous hardcoded look if a theme omits a token.
function chipStyle({
  variant,
  isCheckedOut,
  textSize,
}: {
  variant: ChipVariant;
  isCheckedOut?: boolean;
  textSize: number;
}): React.CSSProperties {
  const base: React.CSSProperties = { ...BASE_CHIP, fontSize: textSize };
  switch (variant) {
    case "branch":
      return {
        ...base,
        background: isCheckedOut
          ? "var(--ref-branch-current-bg, rgba(100, 200, 100, 0.20))"
          : "var(--ref-branch-bg, rgba(80, 160, 255, 0.15))",
        border: isCheckedOut
          ? "1.5px solid var(--ref-branch-current-border, rgba(100, 200, 100, 0.70))"
          : "1px solid var(--ref-branch-border, rgba(80, 160, 255, 0.45))",
        color: isCheckedOut
          ? "var(--ref-branch-current-fg, rgb(130, 220, 130))"
          : "var(--ref-branch-fg, rgb(120, 180, 255))",
        fontWeight: isCheckedOut ? 600 : 400,
      };

    case "remote":
      return {
        ...base,
        background: "var(--ref-remote-bg, rgba(170, 130, 255, 0.15))",
        border: "1px solid var(--ref-remote-border, rgba(170, 130, 255, 0.45))",
        color: "var(--ref-remote-fg, rgb(185, 150, 255))",
      };

    case "tag":
      return {
        ...base,
        background: "var(--ref-tag-bg, rgba(220, 170, 60, 0.15))",
        border: "1px solid var(--ref-tag-border, rgba(220, 170, 60, 0.45))",
        color: "var(--ref-tag-fg, rgb(220, 170, 60))",
        borderRadius: 3, // flag shape — slightly square
      };

    case "head":
      return {
        ...base,
        background: "var(--ref-head-bg, rgba(240, 100, 100, 0.18))",
        border: "1.5px solid var(--ref-head-border, rgba(240, 100, 100, 0.55))",
        color: "var(--ref-head-fg, rgb(240, 130, 130))",
        fontWeight: 600,
      };

    case "head-indicator":
      return {
        ...base,
        background: "transparent",
        border: "none",
        padding: "1px 2px",
        color: "var(--ref-head-fg, rgb(240, 130, 130))",
        fontWeight: 600,
      };

    case "other":
      return {
        ...base,
        background: "rgba(150, 150, 150, 0.15)",
        border: "1px solid rgba(150, 150, 150, 0.35)",
        color: "var(--subtle-fg, rgb(160, 160, 160))",
      };
  }
}

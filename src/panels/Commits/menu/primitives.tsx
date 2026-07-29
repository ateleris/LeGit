// Shared context-menu primitives. Previously duplicated in RefsCell.tsx and
// ColumnHeader.tsx; now the single source for every Commits-panel menu.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronRightIcon } from "../../../icons";
import { VIEWPORT_MARGIN, flyoutPosition } from "./flyoutPosition";

/**
 * Marker attribute carried by every floating menu surface (the MenuShell root
 * and each Submenu flyout, which portals to document.body and is therefore
 * NOT a DOM descendant of the shell). The shell's outside-mousedown dismissal
 * treats anything inside a marked layer as "inside the menu".
 */
export const MENU_LAYER_ATTR = "data-legit-menu-layer";

/**
 * Shared chrome for floating menu surfaces (root menu + submenu flyouts).
 * Clamped to the viewport height with internal scrolling so a long menu never
 * runs off screen. Inline colour fallbacks mirror the built-in Dark theme.
 */
export const menuSurfaceStyle: React.CSSProperties = {
  position: "fixed",
  minWidth: 220,
  maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
  overflowY: "auto",
  background: "var(--panel-bg, #1e1e1e)",
  border: "1px solid var(--panel-border, rgba(255,255,255,0.12))",
  borderRadius: 4,
  padding: "4px 0",
  zIndex: 9999,
  boxShadow: "0 4px 12px var(--shadow-color)",
  fontSize: "var(--fz-lg)",
  color: "var(--panel-fg, #ccc)",
  userSelect: "none",
};

export function MenuItem({
  children,
  onClick,
  disabled,
  testId,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Stable hook for the E2E suite. */
  testId?: string;
}) {
  const [hover, setHover] = useState(false);
  // A real <button> (keyboard focus + Enter activation), with the global CSS
  // button chrome (bg, border, padding) explicitly reset to menu-entry style.
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        border: "none",
        borderRadius: 0,
        padding: "6px 14px",
        cursor: disabled ? "default" : "pointer",
        whiteSpace: "nowrap",
        color: disabled ? "var(--subtle-fg, #777)" : "var(--panel-fg, #ccc)",
        background: hover && !disabled ? "var(--menu-hover-bg, rgba(255,255,255,0.08))" : "transparent",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

export function Separator() {
  return (
    <div
      style={{
        height: 1,
        margin: "4px 0",
        background: "var(--panel-border, rgba(255,255,255,0.10))",
      }}
    />
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "4px 14px",
        fontSize: "var(--fz-sm)",
        color: "var(--subtle-fg, #888)",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        cursor: "default",
      }}
    >
      {children}
    </div>
  );
}

/** Grace period before a submenu closes after the pointer leaves it, so the
 *  diagonal trigger → flyout travel doesn't slam it shut. */
const SUBMENU_CLOSE_DELAY_MS = 100;

/**
 * Sibling coordination: at most ONE submenu is open per menu surface. Each
 * surface (the MenuShell root and every flyout) provides a level; a Submenu
 * announces itself as the level's active entry when it opens, and closes
 * immediately (skipping the grace delay) when a sibling takes over. Without
 * this, sweeping the pointer across stacked submenu entries leaves a trail
 * of overlapping flyouts, each lingering its full grace period.
 */
const MenuLevel = createContext<{ activeId: string | null; setActive: (id: string) => void } | null>(null);

export function MenuLevelProvider({ children }: { children: React.ReactNode }) {
  const [activeId, setActive] = useState<string | null>(null);
  const value = useMemo(() => ({ activeId, setActive }), [activeId]);
  return <MenuLevel.Provider value={value}>{children}</MenuLevel.Provider>;
}

/**
 * A menu entry that opens a flyout with further entries (hover or click).
 * The flyout renders the same primitives as the root menu, so shared sections
 * (BranchMenuSection, …) can be used as flyout content unchanged — including
 * their `useMenuConfirm` takeovers, which replace the whole menu and unmount
 * the flyout.
 *
 * Pointer model: although the flyout portals to document.body, React
 * synthesizes mouseenter/mouseleave along the REACT tree, where the flyout
 * (and any nested submenu inside it) is a descendant of this Submenu.
 * Moving into a nested flyout therefore does NOT fire this flyout's
 * mouseleave, and leaving the whole stack fires mouseleave on every level by
 * itself — so each Submenu manages only its own open state and close timer;
 * there is deliberately no parent/child keep-alive coordination.
 */
export function Submenu({
  label,
  children,
  testId,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  /** Stable hook for the E2E suite (on the trigger entry). */
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const level = useContext(MenuLevel);
  const levelId = useId();

  const cancelClose = useCallback(() => {
    if (closeTimer.current != null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const enter = useCallback(() => {
    level?.setActive(levelId);
    cancelClose();
    setOpen(true);
  }, [level, levelId, cancelClose]);

  /** Schedule this submenu's close after the grace delay — the pointer may be
   *  travelling diagonally from the trigger into the flyout (crossing sibling
   *  entries), so leaving never closes instantly. Re-entering trigger or
   *  flyout cancels via `enter`. */
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), SUBMENU_CLOSE_DELAY_MS);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  // A sibling became the level's active submenu: close now, no grace delay.
  useEffect(() => {
    if (open && level && level.activeId !== levelId) {
      cancelClose();
      setOpen(false);
    }
  }, [open, level, levelId, cancelClose]);

  // Position after the flyout has rendered (so its real size is known); it
  // stays hidden until then to avoid a visible jump.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const trigger = triggerRef.current?.getBoundingClientRect();
    const flyout = flyoutRef.current?.getBoundingClientRect();
    if (!trigger || !flyout) return;
    setPos(
      flyoutPosition(
        trigger,
        { width: flyout.width, height: flyout.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => (open ? setOpen(false) : enter())}
        onMouseEnter={() => {
          setHover(true);
          enter();
        }}
        onMouseLeave={() => {
          setHover(false);
          scheduleClose();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1.5em",
          width: "100%",
          textAlign: "left",
          border: "none",
          borderRadius: 0,
          padding: "6px 14px",
          cursor: "pointer",
          whiteSpace: "nowrap",
          color: "var(--panel-fg, #ccc)",
          background: hover || open ? "var(--menu-hover-bg, rgba(255,255,255,0.08))" : "transparent",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5em" }}>{label}</span>
        <ChevronRightIcon style={{ color: "var(--subtle-fg, #888)" }} />
      </button>
      {open &&
        createPortal(
          <div
            ref={flyoutRef}
            {...{ [MENU_LAYER_ATTR]: "" }}
            role="menu"
            onMouseEnter={enter}
            onMouseLeave={scheduleClose}
            style={{
              ...menuSurfaceStyle,
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              visibility: pos ? "visible" : "hidden",
            }}
          >
            <MenuLevelProvider>{children}</MenuLevelProvider>
          </div>,
          document.body,
        )}
    </>
  );
}

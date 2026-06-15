// Unified context-menu system for the Commits panel.
//
// A single provider owns the menu's portal, positioning, and dismiss logic, the
// shared baseline entries (always present, e.g. Refresh), and an `openMenu` API.
// Each region of the panel builds its own *contextual* section (a React node)
// and passes it to `openMenu`; the provider renders that section on top, then a
// divider, then the baseline entries.
//
// Right-clicking anywhere calls `openMenu`, which preventDefault()s the native
// browser menu — so the panel never shows the OS "Reload / Save as / Inspect…"
// menu, only ours (at minimum the baseline).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { MenuItem, Separator } from "./primitives";

export interface BaselineEntry {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface PanelContextMenuApi {
  /**
   * Open the menu at the event's coordinates. Pass a `section` for
   * target-specific entries (rendered above the baseline); omit it for a
   * baseline-only menu. Always suppresses the native browser menu.
   */
  openMenu: (e: React.MouseEvent, section?: React.ReactNode) => void;
  closeMenu: () => void;
}

interface MenuState {
  x: number;
  y: number;
  section: React.ReactNode | null;
}

const Ctx = createContext<PanelContextMenuApi | null>(null);

export function usePanelContextMenu(): PanelContextMenuApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("usePanelContextMenu must be used within PanelContextMenuProvider");
  return api;
}

interface ProviderProps {
  baseline: BaselineEntry[];
  /**
   * Body of the panel. May be a render function receiving the menu API — handy
   * for the panel root, which wires `openMenu` directly. Deeper components
   * (chips, headers) instead reach the API via `usePanelContextMenu()`.
   */
  children: React.ReactNode | ((api: PanelContextMenuApi) => React.ReactNode);
}

export function PanelContextMenuProvider({ baseline, children }: ProviderProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const openMenu = useCallback((e: React.MouseEvent, section?: React.ReactNode) => {
    // Kill the native menu and stop the event from bubbling to an outer
    // (less-specific) handler — the innermost target wins.
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, section: section ?? null });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const api = useMemo<PanelContextMenuApi>(() => ({ openMenu, closeMenu }), [openMenu, closeMenu]);

  return (
    <Ctx.Provider value={api}>
      {typeof children === "function" ? children(api) : children}
      {menu &&
        createPortal(
          <MenuShell x={menu.x} y={menu.y} onClose={closeMenu}>
            {menu.section}
            {menu.section != null && baseline.length > 0 && <Separator />}
            {baseline.map((b, i) => (
              <MenuItem
                key={i}
                disabled={b.disabled}
                onClick={() => {
                  b.onClick();
                  closeMenu();
                }}
              >
                {b.label}
              </MenuItem>
            ))}
          </MenuShell>,
          document.body
        )}
    </Ctx.Provider>
  );
}

const MENU_MIN_W = 220;

/** Positioned, dismissable portal container shared by every panel menu. */
function MenuShell({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp into the viewport after the menu has rendered (so we know its real
  // size). useLayoutEffect runs before paint, avoiding a visible jump.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    setPos({ left, top });
  }, [x, y]);

  // Dismiss on outside mousedown + Escape.
  useEffect(() => {
    const controller = new AbortController();
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && !ref.current?.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouseDown, { signal: controller.signal });
    document.addEventListener("keydown", onKey, { signal: controller.signal });
    return () => controller.abort();
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        minWidth: MENU_MIN_W,
        background: "var(--panel-bg, #1e1e1e)",
        border: "1px solid var(--panel-border, rgba(255,255,255,0.12))",
        borderRadius: 4,
        padding: "4px 0",
        zIndex: 9999,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        fontSize: 13,
        color: "var(--fg, #ccc)",
        userSelect: "none",
      }}
    >
      {children}
    </div>
  );
}

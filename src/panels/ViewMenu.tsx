import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "../icons";
import { formatAppError } from "../lib/types";
import { confirmDialog } from "../store/confirm";
import { hasMaximizedPanel, toggleMaximizeActivePanel, useDockviewStore } from "../store/dockview";
import { useLayoutsStore } from "../store/layouts";
import { notify } from "../store/notifications";
import { useConfirmDestructive } from "../store/settings";
import { GLOBAL_PANELS, REPO_PANELS } from "./registry";
import { summonGlobalPanel } from "./GlobalDock";
import { openRepoPanel } from "./RepoDock";
import {
  MENU_LAYER_ATTR,
  MenuItem,
  MenuLevelProvider,
  SectionLabel,
  Separator,
  Submenu,
} from "./Commits/menu/primitives";

/**
 * Dropdown that lets the user re-open closed panels in either dock and switch
 * between saved layouts (managed in the Layouts panel). Lives in the repo tab
 * strip.
 */
export function ViewMenu() {
  const confirmDestructive = useConfirmDestructive();
  const globalApi = useDockviewStore((s) => s.globalApi);
  const repoApi = useDockviewStore((s) => s.repoApi);
  const layouts = useLayoutsStore((s) => s.layouts);
  const lastApplied = useLayoutsStore((s) => s.lastApplied);
  const applyLayout = useLayoutsStore((s) => s.apply);
  const saveCurrent = useLayoutsStore((s) => s.saveCurrent);
  const refreshList = useLayoutsStore((s) => s.refreshList);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current && ref.current.contains(target)) return;
      // Submenu flyouts portal to document.body — anything inside a marked
      // menu layer counts as inside this menu.
      if (target.closest?.(`[${MENU_LAYER_ATTR}]`)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // The Layouts panel (or another window) may have changed the saved set —
  // re-list every time the menu opens.
  useEffect(() => {
    if (open) refreshList().catch(() => {});
  }, [open, refreshList]);

  const onApplyLayout = async (name: string) => {
    setOpen(false);
    try {
      await applyLayout(name);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };

  const onOverrideLayout = async (name: string) => {
    setOpen(false);
    try {
      if (confirmDestructive) {
        const ok = await confirmDialog({
          title: "Override layout",
          message: "Replaces the saved layout with the current arrangement.",
          detail: name,
          confirmLabel: "Override",
        });
        if (!ok) return;
      }
      await saveCurrent(name);
      notify.success(`Layout "${name}" now holds the current arrangement.`);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };

  const checkSlot = (checked: boolean) => (
    <span style={{ display: "inline-flex", justifyContent: "center", width: "1.5em" }}>
      {checked ? <CheckIcon /> : null}
    </span>
  );

  const menuItem = (
    id: string,
    title: string,
    isOpen: boolean,
    onClick: () => void
  ) => (
    <MenuItem key={id} testId={`view-menu-${id}`} onClick={onClick}>
      {checkSlot(isOpen)}
      {title}
    </MenuItem>
  );

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button data-testid="view-menu-button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        View ▾
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 240,
            background: "var(--panel-bg)",
            color: "var(--panel-fg)",
            border: "1px solid var(--panel-border)",
            borderRadius: 4,
            boxShadow: "0 4px 10px var(--shadow-color)",
            zIndex: 1000,
            padding: 4,
          }}
        >
          <MenuLevelProvider>
            <SectionLabel>Global panels</SectionLabel>
            {GLOBAL_PANELS.map((p) =>
              menuItem(p.id, p.title, !!globalApi?.getPanel(p.id), () => {
                // Summon (not a plain open): expands the global region first if
                // it is collapsed, where globalApi would be null.
                summonGlobalPanel(p.id);
                setOpen(false);
              })
            )}
            <Separator />
            <SectionLabel>Repo panels</SectionLabel>
            {/* summonOnly panels (interactive-rebase) are transient: they exist
                only while their operation does, so they get no re-open entry. */}
            {REPO_PANELS.filter((p) => !p.summonOnly).map((p) =>
              menuItem(p.id, p.title, !!repoApi?.getPanel(p.id), () => {
                openRepoPanel(repoApi, p.id);
                setOpen(false);
              })
            )}
            {layouts.length > 0 && (
              <>
                <Separator />
                <SectionLabel>Layouts</SectionLabel>
                {layouts.map((l) => (
                  <Submenu
                    key={l.name}
                    testId={`view-menu-layout-${l.name}`}
                    label={
                      <>
                        {checkSlot(lastApplied === l.name)}
                        {l.name}
                      </>
                    }
                    onClickActivate={() => void onApplyLayout(l.name)}
                  >
                    <MenuItem
                      testId={`view-menu-layout-override-${l.name}`}
                      onClick={() => void onOverrideLayout(l.name)}
                    >
                      Override with current layout
                    </MenuItem>
                  </Submenu>
                ))}
              </>
            )}
            <Separator />
            {/* Focus mode: maximize the active panel's group over its dock
                region; exiting restores the previous arrangement. The label is
                computed when the menu opens (a fresh render), so it always
                reflects the current state. */}
            <MenuItem testId="view-menu-maximize" onClick={() => { toggleMaximizeActivePanel(); setOpen(false); }}>
              <span style={{ display: "flex", justifyContent: "space-between", gap: "2em" }}>
                <span>{hasMaximizedPanel() ? "Exit maximized panel" : "Maximize panel"}</span>
                <span style={{ color: "var(--subtle-fg)" }}>Ctrl+Shift+M</span>
              </span>
            </MenuItem>
          </MenuLevelProvider>
        </div>
      )}
    </div>
  );
}

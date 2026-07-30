import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "../icons";
import { useDockviewStore } from "../store/dockview";
import { notify } from "../store/notifications";
import { GLOBAL_PANELS, REPO_PANELS } from "./registry";
import { buildDefaultGlobalLayout, openGlobalPanel } from "./GlobalDock";
import { buildDefaultRepoLayout, openRepoPanel } from "./RepoDock";
import {
  applyBakedGlobalLayout,
  applyBakedRepoLayout,
  applySavedGlobalLayout,
  applySavedRepoLayout,
  saveLayoutAsDefault,
} from "./layoutSnapshot";
import { MenuItem, SectionLabel, Separator } from "./Commits/menu/primitives";

/**
 * Dropdown that lets the user re-open closed panels in either dock.
 * Lives in the repo tab strip.
 */
export function ViewMenu() {
  const globalApi = useDockviewStore((s) => s.globalApi);
  const repoApi = useDockviewStore((s) => s.repoApi);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Snapshot the current arrangement of both docks; "Reset to default layout"
  // restores it from now on.
  const saveAsDefault = () => {
    saveLayoutAsDefault(globalApi, repoApi);
    notify.info("Saved the current layout as the default.");
    setOpen(false);
  };

  // Restore the saved default layout; without one, the baked-in default
  // (defaultLayouts.ts); if even that fails, the programmatic builders.
  const resetLayouts = () => {
    if (globalApi && !applySavedGlobalLayout(globalApi)) {
      globalApi.clear();
      if (!applyBakedGlobalLayout(globalApi)) {
        globalApi.clear();
        buildDefaultGlobalLayout(globalApi);
      }
    }
    if (repoApi && !applySavedRepoLayout(repoApi)) {
      repoApi.clear();
      if (!applyBakedRepoLayout(repoApi)) {
        repoApi.clear();
        buildDefaultRepoLayout(repoApi);
      }
    }
    setOpen(false);
  };

  const menuItem = (
    id: string,
    title: string,
    isOpen: boolean,
    onClick: () => void
  ) => (
    <MenuItem key={id} testId={`view-menu-${id}`} onClick={onClick}>
      <span style={{ display: "inline-flex", justifyContent: "center", width: "1.5em" }}>
        {isOpen ? <CheckIcon /> : null}
      </span>
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
          <SectionLabel>Global panels</SectionLabel>
          {GLOBAL_PANELS.map((p) =>
            menuItem(p.id, p.title, !!globalApi?.getPanel(p.id), () => {
              openGlobalPanel(globalApi, p.id);
              setOpen(false);
            })
          )}
          <Separator />
          <SectionLabel>Repo panels</SectionLabel>
          {REPO_PANELS.map((p) =>
            menuItem(p.id, p.title, !!repoApi?.getPanel(p.id), () => {
              openRepoPanel(repoApi, p.id);
              setOpen(false);
            })
          )}
          <Separator />
          <MenuItem onClick={saveAsDefault}>Save as default layout</MenuItem>
          <MenuItem onClick={resetLayouts}>Reset to default layout</MenuItem>
        </div>
      )}
    </div>
  );
}

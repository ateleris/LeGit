import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "../icons";
import { useDockviewStore } from "../store/dockview";
import { GLOBAL_PANELS, REPO_PANELS } from "./registry";
import { openGlobalPanel } from "./GlobalDock";
import { openRepoPanel } from "./RepoDock";
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

  const resetLayouts = () => {
    if (globalApi) {
      for (const panel of globalApi.panels) globalApi.removePanel(panel);
      for (const p of GLOBAL_PANELS)
        globalApi.addPanel({ id: p.id, component: p.id, title: p.title });
    }
    if (repoApi) {
      for (const panel of repoApi.panels) repoApi.removePanel(panel);
      for (const p of REPO_PANELS)
        repoApi.addPanel({ id: p.id, component: p.id, title: p.title });
    }
    setOpen(false);
  };

  const menuItem = (
    id: string,
    title: string,
    isOpen: boolean,
    onClick: () => void
  ) => (
    <MenuItem key={id} onClick={onClick}>
      <span style={{ display: "inline-flex", justifyContent: "center", width: "1.5em" }}>
        {isOpen ? <CheckIcon /> : null}
      </span>
      {title}
    </MenuItem>
  );

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
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
          <MenuItem onClick={resetLayouts}>Reset to default layout</MenuItem>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useDockviewStore } from "../store/dockview";
import { PANELS } from "./registry";

/**
 * Dropdown that lets the user re-open closed panels and reset the layout.
 * Lives in the top bar; reads the live `DockviewApi` from the store.
 */
export function ViewMenu() {
  const api = useDockviewStore((s) => s.api);
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

  const openOrFocus = (id: string, title: string) => {
    if (!api) return;
    const existing = api.getPanel(id);
    if (existing) {
      existing.focus();
    } else {
      api.addPanel({ id, component: id, title });
    }
    setOpen(false);
  };

  const resetLayout = () => {
    if (!api) return;
    for (const panel of api.panels) {
      api.removePanel(panel);
    }
    for (const p of PANELS) {
      api.addPanel({ id: p.id, component: p.id, title: p.title });
    }
    setOpen(false);
  };

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
            minWidth: 220,
            background: "var(--panel-bg)",
            color: "var(--panel-fg)",
            border: "1px solid var(--panel-border)",
            borderRadius: 4,
            boxShadow: "0 4px 10px rgba(0,0,0,0.25)",
            zIndex: 1000,
            padding: 4,
          }}
        >
          <div style={{ padding: "4px 8px", color: "var(--subtle-fg)", fontSize: 11 }}>
            Panels
          </div>
          {PANELS.map((p) => {
            const isOpen = !!api?.getPanel(p.id);
            return (
              <button
                key={p.id}
                role="menuitem"
                onClick={() => openOrFocus(p.id, p.title)}
                disabled={!api}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  padding: "4px 8px",
                  color: "inherit",
                  borderRadius: 3,
                }}
              >
                <span style={{ display: "inline-block", width: 18 }}>
                  {isOpen ? "✓" : "  "}
                </span>
                {p.title}
              </button>
            );
          })}
          <div
            style={{
              borderTop: "1px solid var(--panel-border)",
              margin: "4px 0",
            }}
          />
          <button
            role="menuitem"
            onClick={resetLayout}
            disabled={!api}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              background: "transparent",
              border: "none",
              padding: "4px 8px",
              color: "inherit",
              borderRadius: 3,
            }}
          >
            Reset to default layout
          </button>
        </div>
      )}
    </div>
  );
}

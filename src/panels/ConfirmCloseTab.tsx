import type { IDockviewPanelHeaderProps } from "dockview-react";
import { usePanelDirtyStore } from "../store/panel-dirty";

/**
 * Custom dockview tab that shows a confirm dialog before closing when the
 * panel has unsaved changes. Register as tabComponent "confirm-close" in
 * GlobalDock and RepoDock.
 */
export function ConfirmCloseTab({ api }: IDockviewPanelHeaderProps) {
  const isDirty = usePanelDirtyStore((s) => s.dirty[api.id] ?? false);

  const handleClose = () => {
    if (isDirty) {
      const ok = window.confirm("Discard unsaved changes and close this panel?");
      if (!ok) return;
    }
    api.close();
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: "100%",
        padding: "0 8px",
        gap: 6,
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ fontSize: 12 }}>
        {api.title}
        {isDirty && (
          <span style={{ color: "var(--subtle-fg)", marginLeft: 4 }}>●</span>
        )}
      </span>
      <button
        onClick={handleClose}
        style={{
          background: "transparent",
          border: "none",
          padding: "0 2px",
          cursor: "pointer",
          fontSize: 11,
          lineHeight: 1,
          color: "inherit",
          opacity: 0.6,
        }}
        title="Close"
        aria-label="Close panel"
      >
        ✕
      </button>
    </div>
  );
}

import type { IDockviewPanelHeaderProps } from "dockview-react";
import { usePanelDirtyStore } from "../store/panel-dirty";

/**
 * Custom dockview tab that shows a confirm dialog before closing when the
 * panel has unsaved changes. Register as tabComponent "confirm-close" in
 * GlobalDock and RepoDock.
 *
 * Uses dockview's exact DOM structure (dv-default-tab / dv-default-tab-content /
 * dv-default-tab-action + SVG) so it looks identical to the default tab.
 */
export function ConfirmCloseTab({ api }: IDockviewPanelHeaderProps) {
  const isDirty = usePanelDirtyStore((s) => s.dirty[api.id] ?? false);

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDirty) {
      const ok = window.confirm("Discard unsaved changes and close this panel?");
      if (!ok) return;
    }
    api.close();
  };

  return (
    <div className="dv-default-tab">
      <div className="dv-default-tab-content">
        {api.title}
        {isDirty && <span style={{ color: "var(--subtle-fg)", marginLeft: 4 }}>●</span>}
      </div>
      <div className="dv-default-tab-action" onClick={handleClose} role="button" aria-label="Close panel" title="Close">
        <svg className="dv-svg" width="11" height="11" viewBox="0 0 28 28" aria-hidden="true">
          <path d="M2.1 27.3L0 25.2L11.55 13.65L0 2.1L2.1 0L13.65 11.55L25.2 0L27.3 2.1L15.75 13.65L27.3 25.2L25.2 27.3L13.65 15.75L2.1 27.3Z" />
        </svg>
      </div>
    </div>
  );
}

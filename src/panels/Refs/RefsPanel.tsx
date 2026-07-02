// Combined "Refs" panel: Branches, Remotes, and Stashes stacked as a vertical
// accordion (dockview's Paneview — the VS-Code-sidebar-style component). Each
// pane header expands/collapses its section; panes are drag-reorderable and
// the expanded sections share the vertical space. Expansion state, order, and
// sizes persist to localStorage like the dock layouts do.

import { useCallback, useEffect, useState } from "react";
import type { FunctionComponent } from "react";
import {
  PaneviewReact,
  type IPaneviewPanelProps,
  type PaneviewReadyEvent,
} from "dockview-react";
import { ChevronDownIcon } from "../../icons";
import { useSettingsStore, UI_FONT_SIZE_DEFAULT } from "../../store/settings";
import { BranchesSection } from "../Branches/BranchesPanel";
import { RemotesSection } from "../Remotes/RemotesPanel";
import { StashesSection } from "../Stashes/StashesPanel";

const LAYOUT_KEY = "legit.refs-paneview";
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persistLayout(data: unknown) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(data)); } catch { /* quota */ }
  }, 300);
}

/** Default pane order + expansion for a first launch (no saved layout). */
const DEFAULT_PANES = [
  { id: "branches", title: "Branches", isExpanded: true },
  { id: "remotes", title: "Remotes", isExpanded: false },
  { id: "stashes", title: "Stashes", isExpanded: true },
] as const;

const PANE_COMPONENTS: Record<string, FunctionComponent<IPaneviewPanelProps>> = {
  branches: () => <BranchesSection />,
  remotes: () => <RemotesSection />,
  stashes: () => <StashesSection />,
};

/**
 * Accordion section header: title + expansion chevron, styled with LeGit
 * theme tokens (`pane.header.*`) instead of dockview's built-in theme, per
 * the "no literal colours / no foreign theming" convention. Clicking toggles
 * the pane; drag-to-reorder is handled by the paneview wrapper around it.
 */
function PaneHeader({ api, title }: IPaneviewPanelProps) {
  const [expanded, setExpanded] = useState(api.isExpanded);
  useEffect(() => {
    const disposable = api.onDidExpansionChange((e) => setExpanded(e.isExpanded));
    return () => disposable.dispose();
  }, [api]);
  return (
    <div
      onClick={() => api.setExpanded(!api.isExpanded)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: "100%",
        padding: "0 8px",
        boxSizing: "border-box",
        cursor: "pointer",
        userSelect: "none",
        background: "var(--pane-header-bg)",
        color: "var(--pane-header-fg)",
        borderBottom: "1px solid var(--pane-header-border)",
        fontSize: "var(--fz-sm)",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          transform: expanded ? undefined : "rotate(-90deg)",
          transition: "transform 120ms",
        }}
      >
        <ChevronDownIcon />
      </span>
      {title}
    </div>
  );
}

const HEADER_COMPONENTS: Record<string, FunctionComponent<IPaneviewPanelProps>> = {
  default: PaneHeader,
};

export function RefsPanel() {
  // Pane header height scales with the global UI font size (CLAUDE.md:
  // everything scales with `--ui-font-size`). Paneview takes the header size
  // as a JS pixel number applied as inline styles and used in its layout
  // math, so CSS can't drive it — instead the paneview is re-created (via
  // `key`) when the font size changes, and the saved layout's per-pane
  // headerSize is patched on restore.
  const uiFontSize = useSettingsStore(
    (s) => s.settings?.ui_font_size ?? UI_FONT_SIZE_DEFAULT,
  );
  const headerSize = Math.round(uiFontSize * 1.8);

  const onReady = useCallback((event: PaneviewReadyEvent) => {
    const api = event.api;

    let restored = false;
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      try {
        // The serialized layout carries each pane's headerSize (from when it
        // was saved) and headerComponent reference — override both with the
        // current values, so the font-derived height applies and layouts
        // saved before the custom header existed don't resurrect dockview's
        // default header (fixed-size arrow, no theme tokens).
        const json = JSON.parse(raw);
        if (Array.isArray(json?.views)) {
          for (const view of json.views) {
            view.headerSize = headerSize;
            if (view?.data) view.data.headerComponent = "default";
          }
        }
        api.fromJSON(json);
        restored = api.panels.length > 0;
      } catch (e) {
        console.warn("could not restore refs paneview layout, using default", e);
      }
    }
    if (!restored) {
      for (const p of DEFAULT_PANES) {
        api.addPanel({
          id: p.id,
          component: p.id,
          headerComponent: "default",
          title: p.title,
          isExpanded: p.isExpanded,
          headerSize,
        });
      }
    }

    api.onDidLayoutChange(() => {
      try { persistLayout(api.toJSON()); } catch { /* ignore */ }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerSize]);

  return (
    // The theme class only supplies dockview's structural defaults (sash
    // hit-areas etc.); the visible header chrome comes from PaneHeader's
    // theme tokens.
    <div className="legit-panel dockview-theme-abyss" style={{ height: "100%" }}>
      <PaneviewReact
        // Re-created when the UI font size changes so the JS-number header
        // size (see above) tracks it; the layout restores from localStorage.
        key={headerSize}
        components={PANE_COMPONENTS}
        headerComponents={HEADER_COMPONENTS}
        onReady={onReady}
      />
    </div>
  );
}

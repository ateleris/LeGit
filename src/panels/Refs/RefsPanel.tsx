// Combined "Refs" panel: Branches, Remotes, and Stashes stacked as a vertical
// accordion (dockview's Paneview — the VS-Code-sidebar-style component). Each
// pane header expands/collapses its section; panes are drag-reorderable and
// the expanded sections share the vertical space. Expansion state, order, and
// sizes persist to localStorage like the dock layouts do.

import { useCallback, useEffect, useRef, useState } from "react";
import type { FunctionComponent } from "react";
import {
  PaneviewReact,
  type IPaneviewPanelProps,
  type PaneviewApi,
  type PaneviewReadyEvent,
} from "dockview-react";
import { ChevronDownIcon } from "../../icons";
import { useSettingsStore, UI_FONT_SIZE_DEFAULT } from "../../store/settings";
import { BranchesSection } from "../Branches/BranchesPanel";
import { RemotesSection } from "../Remotes/RemotesPanel";
import { StashesSection } from "../Stashes/StashesPanel";
import { SubmodulesSection } from "../Submodules/SubmodulesSection";
import { TagsSection } from "../Tags/TagsSection";
import { ReflogSection } from "../Reflog/ReflogSection";
import { defaultPaneSizes, sanitizePaneviewLayout } from "./refsLayout";

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
  { id: "tags", title: "Tags", isExpanded: false },
  { id: "stashes", title: "Stashes", isExpanded: true },
  { id: "submodules", title: "Submodules", isExpanded: false },
  { id: "reflog", title: "Reflog", isExpanded: false },
] as const;

const PANE_COMPONENTS: Record<string, FunctionComponent<IPaneviewPanelProps>> = {
  branches: () => <BranchesSection />,
  remotes: () => <RemotesSection />,
  tags: () => <TagsSection />,
  stashes: () => <StashesSection />,
  submodules: () => <SubmodulesSection />,
  reflog: () => <ReflogSection />,
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

  // PaneviewReact measures its element exactly ONCE, at mount, right before
  // onReady - it has no ResizeObserver (unlike DockviewReact). When the
  // mount happens before the dock group is sized (observed on WebKitGTK in
  // the e2e harness), that one measure reads 0x0 and the paneview stays
  // zero-height forever; it also means a later container resize never
  // reaches the paneview. Track the container ourselves and forward its
  // size (the RO also fires once on observe, which delivers the first real
  // measurement).
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<PaneviewApi | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect && rect.height > 0) apiRef.current?.layout(rect.width, rect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onReady = useCallback((event: PaneviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;

    let restored = false;
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      try {
        // Sanitized before fromJSON: views whose pane component no longer
        // exists are dropped (they make fromJSON throw halfway, leaving
        // zombie panes the default set would then stack on top of - every
        // pane appeared twice), ids are deduplicated, and each view's
        // headerSize/headerComponent is patched to the current values (the
        // font-derived height must apply, and layouts saved before the
        // custom header existed must not resurrect dockview's default one).
        const json = sanitizePaneviewLayout(
          JSON.parse(raw),
          (name) => name in PANE_COMPONENTS,
          headerSize,
        );
        if (json) {
          api.fromJSON(json as Parameters<typeof api.fromJSON>[0]);
          restored = api.panels.length > 0;
        }
      } catch (e) {
        console.warn("could not restore refs paneview layout, using default", e);
        // A restore that threw mid-flight leaves partially-built zombie
        // panes behind; remove them so the default panes below don't stack
        // on top of them, and drop the poisoned layout so the next launch
        // starts clean instead of failing the same way forever.
        try {
          for (const panel of [...api.panels]) api.removePanel(panel);
        } catch (cleanupError) {
          console.warn("could not clear partially restored panes", cleanupError);
        }
        try { localStorage.removeItem(LAYOUT_KEY); } catch { /* quota */ }
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
      // The panes above were added while the container is typically still
      // unmeasured (onReady runs before the ResizeObserver's first tick), so
      // each entered at size 0 and the first real layout hands ALL the
      // height to the last expanded pane - Branches rendered zero-height,
      // its rows overflowing under Stashes (found via the branch/conflict
      // e2e specs, which always start from a fresh profile). Distribute the
      // measured height explicitly; the sizes are only a starting point,
      // user drags persist via the layout snapshot as before.
      //
      // Bounded poll, NOT api.onDidLayoutChange: dockview does not emit
      // layout-change for the initial programmatic layout()/measure (that is
      // also why a never-touched paneview persists no snapshot), so an
      // event-based fixup never runs. Polling the height is the reliable
      // "container is measured now" signal; it self-terminates.
      const applyDefaultSizes = () => {
        const sizes = defaultPaneSizes(
          api.height,
          headerSize,
          api.panels.map((p) => ({ id: p.id, expanded: p.api.isExpanded })),
        );
        for (const [id, size] of sizes) api.getPanel(id)?.api.setSize({ size });
        return sizes.size > 0;
      };
      if (!applyDefaultSizes()) {
        const started = Date.now();
        const poll = setInterval(() => {
          if (applyDefaultSizes() || Date.now() - started > 5000) clearInterval(poll);
        }, 50);
      }
    } else {
      // Layouts saved before a section existed (e.g. Tags) restore without
      // it — append any missing default panes so new sections always appear.
      for (const p of DEFAULT_PANES) {
        if (!api.getPanel(p.id)) {
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
    <div
      ref={containerRef}
      className="legit-panel dockview-theme-abyss"
      style={{ height: "100%" }}
    >
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

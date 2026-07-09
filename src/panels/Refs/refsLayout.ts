// Pure helpers for the Refs paneview's persisted layout. Extracted from
// RefsPanel so the sanitizing rules are unit-testable without dockview
// (see refsLayout.test.ts; project convention: encode third-party behaviour
// assumptions in tests, not comments).

/** Minimal shape of dockview's SerializedPaneview that we persist/restore. */
export interface SerializedPaneviewView {
  size?: number;
  expanded?: boolean;
  headerSize?: number;
  data?: {
    id?: unknown;
    component?: unknown;
    headerComponent?: unknown;
    title?: unknown;
  };
}
export interface SerializedPaneviewLike {
  views: SerializedPaneviewView[];
  size?: number;
}

/**
 * Sanitize a persisted paneview layout before handing it to dockview's
 * `fromJSON`.
 *
 * A layout saved by an older build can reference a pane component that no
 * longer exists (a section renamed or removed from PANE_COMPONENTS). Dockview
 * builds the DOM for every restored view first and only then initialises
 * them, so an unknown component makes `fromJSON` throw halfway and leaves
 * uninitialised zombie panes in the DOM - the caller's fallback then stacks
 * the default panes on top of them (every pane appears twice). Dropping such
 * views up front keeps the restore on the happy path.
 *
 * Also deduplicates views by id (a corrupt layout must not yield duplicate
 * panes) and patches each surviving view's `headerSize` (font-size derived,
 * so the value saved under another font size must not win) and
 * `headerComponent` (layouts saved before the custom header existed must not
 * resurrect dockview's default header).
 *
 * Returns null when nothing usable survives - the caller falls back to the
 * default pane set.
 */
export function sanitizePaneviewLayout(
  raw: unknown,
  isKnownComponent: (name: string) => boolean,
  headerSize: number,
): SerializedPaneviewLike | null {
  if (typeof raw !== "object" || raw === null) return null;
  const layout = raw as { views?: unknown; size?: unknown };
  if (!Array.isArray(layout.views)) return null;

  const seen = new Set<string>();
  const views: SerializedPaneviewView[] = [];
  for (const entry of layout.views) {
    if (typeof entry !== "object" || entry === null) continue;
    const view = entry as SerializedPaneviewView;
    const id = view.data?.id;
    const component = view.data?.component;
    if (typeof id !== "string" || typeof component !== "string") continue;
    if (!isKnownComponent(component)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    view.headerSize = headerSize;
    view.data!.headerComponent = "default";
    views.push(view);
  }
  if (views.length === 0) return null;

  const size = typeof layout.size === "number" ? layout.size : undefined;
  return size === undefined ? { views } : { views, size };
}

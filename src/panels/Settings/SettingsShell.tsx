// The shared frame of the Global and Repo settings panels: a search field that
// filters the manifest-declared sections, a category nav with scroll-spy (on
// wide panels), and the scrollable group/section content.

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useSettingsStore, UI_FONT_SIZE_DEFAULT } from "../../store/settings";
import { SettingsGroup } from "./primitives";
import {
  filterSettingsGroups,
  pickActiveGroup,
  type SearchableGroup,
  type SearchableSection,
} from "./settingsSearch";

export interface SettingsSectionDef extends SearchableSection {
  render: () => ReactNode;
}

export type SettingsGroupDef = SearchableGroup<SettingsSectionDef>;

/** Below this panel width (in UI-font ems) the category nav is dropped and the
 * shell falls back to the plain single-column layout. */
const NAV_MIN_PANEL_EM = 44;

export function SettingsShell({
  groups,
  toolbarLead,
  legend,
}: {
  groups: readonly SettingsGroupDef[];
  /** Leading toolbar content before the search field (e.g. the repo name). */
  toolbarLead?: ReactNode;
  /** Trailing toolbar content (e.g. the Git-config pill legend). */
  legend?: ReactNode;
}) {
  const uiFontSize = useSettingsStore((s) => s.settings?.ui_font_size ?? UI_FONT_SIZE_DEFAULT);
  const [query, setQuery] = useState("");
  const filtered = filterSettingsGroups(groups, query);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const groupEls = useRef(new Map<string, HTMLDivElement>());
  const [activeGroup, setActiveGroup] = useState<string | null>(null);

  const [navVisible, setNavVisible] = useState(false);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => setNavVisible(el.clientWidth >= uiFontSize * NAV_MIN_PANEL_EM);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [uiFontSize]);

  const updateActive = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const tops: { id: string; top: number }[] = [];
    for (const [id, el] of groupEls.current) {
      if (el.isConnected) tops.push({ id, top: el.offsetTop });
    }
    // Small slack so a group scrolled exactly to the top counts as reached.
    setActiveGroup(pickActiveGroup(tops, scroller.scrollTop + uiFontSize));
  }, [uiFontSize]);

  // Re-evaluate when the visible groups change (filtering, WSL probe).
  const visibleIds = filtered.map((g) => g.id).join("\u0000");
  useLayoutEffect(() => {
    updateActive();
  }, [visibleIds, updateActive]);

  const scrollPending = useRef(false);
  const onScroll = () => {
    if (scrollPending.current) return;
    scrollPending.current = true;
    requestAnimationFrame(() => {
      scrollPending.current = false;
      updateActive();
    });
  };

  const jumpTo = (id: string) => {
    setActiveGroup(id);
    const scroller = scrollerRef.current;
    const el = groupEls.current.get(id);
    if (scroller && el) scroller.scrollTo({ top: el.offsetTop });
  };

  const registerGroup = (id: string) => (el: HTMLDivElement | null) => {
    if (el) groupEls.current.set(id, el);
    else groupEls.current.delete(id);
  };

  return (
    <div className="legit-panel" ref={rootRef}>
      <div className="legit-panel__toolbar" style={{ flexWrap: "wrap" }}>
        {toolbarLead}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
          placeholder="Search settings"
          aria-label="Search settings"
          style={{ flex: 1, minWidth: "9em", maxWidth: "24em" }}
        />
        {legend && (
          <span
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5em",
              fontSize: "var(--fz-sm)",
              color: "var(--subtle-fg)",
            }}
          >
            {legend}
          </span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {navVisible && (
          <nav
            aria-label="Settings categories"
            style={{
              width: "11em",
              flexShrink: 0,
              overflowY: "auto",
              borderRight: "1px solid var(--panel-border)",
              padding: "0.667em 0",
            }}
          >
            {filtered.map((g) => {
              const active = g.id === activeGroup;
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => jumpTo(g.id)}
                  aria-current={active ? "true" : undefined}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    borderLeft: `2px solid ${active ? "var(--accent)" : "transparent"}`,
                    borderRadius: 0,
                    color: active ? "var(--panel-fg)" : "var(--subtle-fg)",
                    fontWeight: active ? 600 : 400,
                    fontSize: "var(--fz-md)",
                    padding: "0.333em 0.833em",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {g.title}
                </button>
              );
            })}
          </nav>
        )}
        <div
          ref={scrollerRef}
          className="legit-panel__body"
          onScroll={onScroll}
          // No top padding on the scroller itself: sticky group headers pin
          // flush against the top edge, with no strip above them where the
          // scrolled content would stay visible. The spacing moves into the
          // scrolled content below.
          style={{ position: "relative", paddingTop: 0 }}
        >
          <div style={{ paddingTop: "calc(var(--ui-font-size) * 0.667)" }}>
            {filtered.length === 0 && (
              <span className="legit-subtle">No settings match "{query.trim()}".</span>
            )}
            {filtered.map((g) => (
              <div key={g.id} ref={registerGroup(g.id)}>
                <SettingsGroup id={g.id} title={g.title} caption={g.caption} collapsible={false}>
                  {g.sections.map((s) => (
                    <div key={s.id}>{s.render()}</div>
                  ))}
                </SettingsGroup>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

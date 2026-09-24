import { useMemo, useState } from "react";
import { contrastRatio, wcagBadge, type WcagBadge } from "../../theme/contrast";
import { DEFAULT_THEME } from "../../theme/defaults";
import { CONTRAST_PAIRS, type ContrastPair } from "../../theme/tokens";
import { resolveBindingColor } from "../../theme/filters";
import { effectiveBinding } from "../../theme/draftOps";
import type { ThemeDocument } from "../../lib/types";
import { ChevronDownIcon } from "../../icons";
import { SettingsGroup } from "../Settings/primitives";

/** A pair's base surface stack as an array (nearest-first; empty for an opaque bg). */
function baseTokens(pair: ContrastPair): readonly string[] {
  return pair.base === undefined ? [] : typeof pair.base === "string" ? [pair.base] : pair.base;
}

/**
 * The WCAG contrast section. Ratios are computed against what actually
 * renders: effective bindings resolved over the merged palette, with
 * translucent backgrounds composited over their `base` surface. Failing pairs
 * sort first within their group, and the header caption summarises the result
 * so the (collapsed-by-default) section is informative without expanding it.
 */
export function ContrastSection({ working }: { working: ThemeDocument }) {
  const rows = useMemo(() => {
    const mergedPalette = { ...DEFAULT_THEME.palette, ...working.palette };
    const resolve = (token: string) => {
      const b = effectiveBinding(working, token);
      return b ? resolveBindingColor(b, mergedPalette) : undefined;
    };
    return CONTRAST_PAIRS.map((pair) => {
      const fg = resolve(pair.fg);
      const bg = resolve(pair.bg);
      const base = baseTokens(pair).map(resolve);
      const ratio =
        fg && bg && base.every((c) => c !== undefined)
          ? contrastRatio(fg, bg, base as string[])
          : null;
      // Below the pair's own floor (AA by default) — distinct from the badge,
      // which always names the absolute WCAG tier. Advisory pairs have no
      // floor: informational only.
      const below = !pair.advisory && ratio !== null && ratio < (pair.minRatio ?? 4.5);
      return { pair, ratio, badge: wcagBadge(ratio), below };
    });
  }, [working]);

  const failing = rows.filter((r) => r.below).length;
  const enforced = rows.filter((r) => !r.pair.advisory).length;
  const caption =
    failing > 0
      ? `${failing} of ${enforced} pairs below target`
      : `all ${enforced} pairs meet their target`;

  const grouped = useMemo(() => {
    const map = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = map.get(row.pair.group) ?? [];
      list.push(row);
      map.set(row.pair.group, list);
    }
    // Below-target pairs first within each group (stable otherwise).
    for (const list of map.values()) {
      list.sort((a, b) => Number(b.below) - Number(a.below));
    }
    return Array.from(map.entries());
  }, [rows]);

  const badgeClass = (below: boolean, badge: WcagBadge, advisory: boolean | undefined) =>
    below ? "legit-error" : advisory || badge === "n/a" ? "legit-subtle" : "legit-success";
  const cssVar = (token: string) => `var(--${token.replace(/\./g, "-")})`;

  return (
    <SettingsGroup id="theme-editor.contrast" title="Contrast (WCAG)" caption={caption} defaultOpen={false}>
      {grouped.map(([group, list]) => {
        const groupBelow = list.filter((r) => r.below).length;
        return (
        <ContrastGroup
          key={group}
          id={group}
          title={group}
          caption={groupBelow > 0 ? `${groupBelow} below target` : undefined}
          // Syntax highlighting is opt-in in the diff viewer, so its (large)
          // group starts collapsed.
          defaultOpen={group !== "Syntax highlighting"}
        >
          {list.map(({ pair, ratio, badge, below }) => (
            <div
              key={pair.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.833em",
                padding: "0.167em 0",
              }}
            >
              {/* The sample nests inside the pair's base surface(s), deepest
                  outermost, so translucent backgrounds preview as they
                  composite in the real UI. */}
              <span style={{ borderRadius: 3, minWidth: 100, textAlign: "center" }}>
                {baseTokens(pair).reduceRight(
                  (child, baseToken) => (
                    <span
                      style={{ display: "block", background: cssVar(baseToken), borderRadius: 3 }}
                    >
                      {child}
                    </span>
                  ),
                  <span
                    style={{
                      display: "block",
                      background: cssVar(pair.bg),
                      color: cssVar(pair.fg),
                      padding: "0.167em 0.667em",
                      borderRadius: 3,
                    }}
                  >
                    Sample
                  </span>,
                )}
              </span>
              <span style={{ flex: 1 }}>{pair.label}</span>
              <span className="legit-subtle">{ratio ? ratio.toFixed(2) : "—"}</span>
              <span
                className={badgeClass(below, badge, pair.advisory)}
                title={
                  pair.advisory
                    ? "advisory: no required floor (word highlights are character-level emphasis)"
                    : `target: at least ${pair.minRatio ?? 4.5}:1`
                }
              >
                {badge}
              </span>
            </div>
          ))}
        </ContrastGroup>
        );
      })}
    </SettingsGroup>
  );
}

/**
 * A collapsible group inside the Contrast section. Same persistence pattern
 * as `SettingsGroup`, but styled as the section's inner group headings so the
 * two-level hierarchy stays readable.
 */
function ContrastGroup({
  id,
  title,
  caption,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  caption?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const key = `legit.theme-editor.contrast-group.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored === "collapsed") return false;
      if (stored === "expanded") return true;
      return defaultOpen;
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () =>
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(key, next ? "expanded" : "collapsed");
      } catch {
        /* private mode / quota — the toggle still works for the session */
      }
      return next;
    });

  return (
    <div style={{ marginBottom: "1em" }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5em",
          background: "transparent",
          border: "none",
          padding: "0.167em 0",
          cursor: "pointer",
          color: "var(--panel-fg)",
          fontWeight: 600,
        }}
      >
        <ChevronDownIcon
          size="1em"
          style={{
            flexShrink: 0,
            transform: open ? "none" : "rotate(-90deg)",
            transition: "transform 0.12s",
          }}
        />
        <span>{title}</span>
        {caption && (
          <span className="legit-error" style={{ fontWeight: 400 }}>
            {caption}
          </span>
        )}
      </button>
      {open && <div style={{ marginTop: "0.333em" }}>{children}</div>}
    </div>
  );
}

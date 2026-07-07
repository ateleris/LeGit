import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { repoBranches, repoTags } from "../../lib/commands";
import type { Branch, TagInfo } from "../../lib/types";

/** Per-group cap so a giant repo can't turn the dropdown into a wall. */
const GROUP_LIMIT = 50;

interface OptionGroup {
  label: string | null;
  items: string[];
}

/**
 * Filter the completion candidates by a case-insensitive substring and flatten
 * the kept groups. Pure so the grouping/filtering rules are unit-testable.
 * An empty filter keeps everything (browsing mode); the filter text itself is
 * always a valid free-text rev, so filtering never blocks manual input.
 */
export function buildRevOptions(
  filter: string,
  locals: string[],
  remotes: string[],
  tags: string[],
): OptionGroup[] {
  const needle = filter.trim().toLowerCase();
  const keep = (items: string[]) =>
    (needle ? items.filter((i) => i.toLowerCase().includes(needle)) : items).slice(0, GROUP_LIMIT);

  const groups: OptionGroup[] = [
    { label: null, items: keep(["HEAD"]) },
    { label: "Branches", items: keep(locals) },
    { label: "Remote branches", items: keep(remotes) },
    { label: "Tags", items: keep(tags) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/**
 * Rev input with completion: a free-text field (any sha / `HEAD~n` stays
 * valid) with a grouped dropdown of the repo's branches and tags, filtered
 * as you type. Arrow keys move the highlight, Enter picks the highlighted
 * entry (or, with the dropdown closed, submits via `onEnter`), Esc closes.
 * Reuses the panels' standard branches/tags queries, so it costs nothing
 * extra where those are already loaded.
 */
export function RevPicker({
  repoId,
  value,
  onChange,
  onEnter,
  placeholder,
  style,
}: {
  repoId: string | undefined;
  value: string;
  onChange: (v: string) => void;
  /** Fired on Enter with the dropdown closed - typically submits the form. */
  onEnter?: () => void;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: [repoId, "branches"],
    queryFn: () => repoBranches(repoId!),
    enabled: !!repoId,
    staleTime: 5_000,
  });
  const { data: tags = [] } = useQuery<TagInfo[]>({
    queryKey: [repoId, "tags"],
    queryFn: () => repoTags(repoId!),
    enabled: !!repoId,
    staleTime: 5_000,
  });

  const groups = useMemo(
    () =>
      buildRevOptions(
        value,
        branches.filter((b) => !b.is_remote).map((b) => b.name),
        branches.filter((b) => b.is_remote).map((b) => b.name),
        tags.map((t) => t.name),
      ),
    [value, branches, tags],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // Clamp the highlight when the filtered list shrinks.
  useEffect(() => {
    if (active >= flat.length) setActive(0);
  }, [flat.length, active]);

  const openDropdown = useCallback(() => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ left: rect.left, top: rect.bottom + 2, width: rect.width });
    setActive(0);
    setOpen(true);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const pick = (name: string) => {
    onChange(name);
    close();
    inputRef.current?.focus();
  };

  // Dismiss on outside mousedown; the dropdown itself uses onMouseDown so
  // picking wins over this (and over the input losing focus). Capture phase:
  // a stopPropagation in another panel must not keep the dropdown open.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && (inputRef.current?.contains(t) || listRef.current?.contains(t))) return;
      close();
    };
    document.addEventListener("mousedown", onMouseDown, { capture: true, signal: controller.signal });
    window.addEventListener("resize", close, { signal: controller.signal });
    return () => controller.abort();
  }, [open, close]);

  // Keep the highlighted row in view while arrowing through the list.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-rev-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openDropdown();
        return;
      }
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (flat.length === 0 ? 0 : (a + delta + flat.length) % flat.length));
    } else if (e.key === "Enter") {
      if (open && flat[active] !== undefined) {
        e.preventDefault();
        pick(flat[active]);
      } else {
        close();
        onEnter?.();
      }
    } else if (e.key === "Escape") {
      if (open) {
        // Only swallow the Esc that closes the dropdown.
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    }
  };

  let flatIndex = -1;
  return (
    <>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (!open) openDropdown();
          else setActive(0);
        }}
        onFocus={openDropdown}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        style={{ fontSize: "var(--fz-md)", fontFamily: "monospace", ...style }}
      />
      {open && anchor && flat.length > 0 &&
        createPortal(
          <div
            ref={listRef}
            style={{
              position: "fixed",
              left: anchor.left,
              top: anchor.top,
              width: anchor.width,
              minWidth: "16em",
              maxHeight: "40vh",
              overflowY: "auto",
              background: "var(--panel-bg)",
              color: "var(--panel-fg)",
              border: "1px solid var(--panel-border)",
              borderRadius: 4,
              boxShadow: "0 4px 12px var(--shadow-color)",
              padding: "3px 0",
              zIndex: 9999,
              fontSize: "var(--fz-md)",
              userSelect: "none",
            }}
          >
            {groups.map((group) => (
              <div key={group.label ?? "top"}>
                {group.label && (
                  <div
                    style={{
                      padding: "3px 8px 1px",
                      fontSize: "var(--fz-sm)",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      color: "var(--subtle-fg)",
                    }}
                  >
                    {group.label}
                  </div>
                )}
                {group.items.map((item) => {
                  flatIndex += 1;
                  const index = flatIndex;
                  return (
                    <div
                      key={item}
                      data-rev-index={index}
                      // mousedown, not click: fires before the input's blur.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(item);
                      }}
                      onMouseEnter={() => setActive(index)}
                      style={{
                        padding: "2px 8px",
                        fontFamily: "monospace",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        cursor: "pointer",
                        background: index === active ? "var(--button-hover-bg)" : "transparent",
                      }}
                      title={item}
                    >
                      {item}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

import { useSettingsStore } from "../../store/settings";
import { coerceRefsSortMode, resolveTagsSortMode, type RefsSortMode } from "../../lib/refSort";

// Filter-and-sort row for the Refs panel sections. The filter is ephemeral
// per-section state; the sort select persists per section (tags inherit the
// branches mode until set independently).
export function RefFilterRow({
  query,
  onQueryChange,
  sortScope,
  label,
}: {
  query: string;
  onQueryChange: (next: string) => void;
  /** Which section's sort setting the select controls; omit for no select. */
  sortScope?: "branches" | "tags";
  /** Section name for accessible labels/titles, e.g. "branches". */
  label: string;
}) {
  return (
    <div className="legit-compact-controls" style={{ display: "flex", gap: 6 }}>
      <input
        type="search"
        value={query}
        placeholder="Filter"
        aria-label={`Filter ${label}`}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.stopPropagation();
            onQueryChange("");
          }
        }}
        style={{ flex: 1, minWidth: 0 }}
      />
      {sortScope && <RefsSortSelect scope={sortScope} />}
    </div>
  );
}

function RefsSortSelect({ scope }: { scope: "branches" | "tags" }) {
  const mode = useSettingsStore((s) =>
    scope === "tags"
      ? resolveTagsSortMode(s.settings?.tags_sort_mode, s.settings?.refs_sort_mode)
      : coerceRefsSortMode(s.settings?.refs_sort_mode),
  );
  const setMode = useSettingsStore((s) =>
    scope === "tags" ? s.setTagsSortMode : s.setRefsSortMode,
  );
  return (
    <select
      value={mode}
      title={`Sort ${scope} (applies to all repos)`}
      aria-label={`Sort ${scope}`}
      onChange={(e) => void setMode(e.target.value as RefsSortMode)}
      style={{ flexShrink: 0 }}
    >
      <option value="alphabetical">Name</option>
      <option value="date">Newest first</option>
      <option value="date_reversed">Oldest first</option>
    </select>
  );
}

// Pure search/filter and scroll-spy logic for the settings shell, kept free of
// React so the matching semantics are unit-testable.

export interface SearchableSection {
  id: string;
  title: string;
  keywords?: readonly string[];
}

export interface SearchableGroup<S extends SearchableSection = SearchableSection> {
  id: string;
  title: string;
  caption?: string;
  sections: readonly S[];
}

/**
 * Narrow `groups` to what matches `query`. Every whitespace-separated term
 * must match a section (its title, keywords, or its group's title/caption);
 * groups left without sections are dropped. An empty query keeps everything.
 */
export function filterSettingsGroups<G extends SearchableGroup>(
  groups: readonly G[],
  query: string,
): G[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...groups];

  const result: G[] = [];
  for (const group of groups) {
    const groupFields = [group.title, group.caption ?? ""].map((f) => f.toLowerCase());
    const sections = group.sections.filter((section) => {
      const fields = [
        ...groupFields,
        section.title.toLowerCase(),
        ...(section.keywords ?? []).map((k) => k.toLowerCase()),
      ];
      return terms.every((term) => fields.some((field) => field.includes(term)));
    });
    if (sections.length > 0) result.push({ ...group, sections });
  }
  return result;
}

/** The group whose header was scrolled past last (the "current" group). */
export function pickActiveGroup(
  tops: readonly { id: string; top: number }[],
  scrollTop: number,
): string | null {
  if (tops.length === 0) return null;
  const sorted = [...tops].sort((a, b) => a.top - b.top);
  let active = sorted[0].id;
  for (const { id, top } of sorted) {
    if (top <= scrollTop) active = id;
  }
  return active;
}

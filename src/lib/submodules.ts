import type { SubmoduleInfo } from "./types";

/** Display badge for a submodule row, by severity precedence (spec
 * 2026-07-08: conflict > drift > orphan > pointer-moved > dirty >
 * uninitialized > detached > clean). Colors are existing theme tokens only. */
export function submoduleBadge(
  info: SubmoduleInfo,
): { label: string; color: string } | null {
  const s = info.state;
  if (s.conflicted) return { label: "conflict", color: "var(--status-conflicted)" };
  if (s.config_drift) return { label: "config drift", color: "var(--status-conflicted)" };
  if (s.orphan_gitlink) return { label: "orphan", color: "var(--status-conflicted)" };
  if (s.pointer_moved) return { label: "pointer moved", color: "var(--status-modified)" };
  if (s.dirty_tracked || s.dirty_untracked)
    return { label: "dirty", color: "var(--status-modified)" };
  if (!s.initialized || !s.populated)
    return { label: "uninitialized", color: "var(--subtle-fg)" };
  if (info.head_branch === null) return { label: "detached", color: "var(--subtle-fg)" };
  return null;
}

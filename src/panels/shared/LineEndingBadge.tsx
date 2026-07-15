// Small indicator of a file's line-ending style, shown in the Diff, File View,
// Blame, and Merge panels. Detection is backend-side (repo_line_ending_kind)
// because the blame/diff parsers strip newlines, so the frontend lacks the raw
// bytes.
//
// For a single-file view pass just `rev` (null = working tree). For a diff pass
// `oldRev` too: when the two sides differ (e.g. a CRLF→LF conversion) the badge
// shows "CRLF→LF".
//
// `LineEndingBadge` is the passive chip. `RevertableLineEndingBadge` is the
// Diff panel's variant for the unstaged diff: when the two sides differ, the
// chip opens a menu whose action rewrites the working file's endings back to
// the old side's kind (content edits untouched). It must be rendered inside a
// `PanelContextMenuProvider`.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { repoLineEndingKind, repoRevertLineEndings } from "../../lib/commands";
import { formatAppError, type LineEndingKind } from "../../lib/types";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { notify } from "../../store/notifications";
import { useConfirmDestructive } from "../../store/settings";
import { useMenuConfirm, usePanelContextMenu } from "../Commits/menu/PanelContextMenu";
import { MenuItem, SectionLabel } from "../Commits/menu/primitives";

/** Display label, or null for styles that shouldn't show a badge. */
function labelFor(kind: LineEndingKind | undefined): string | null {
  switch (kind) {
    case "lf":
      return "LF";
    case "crlf":
      return "CRLF";
    case "cr":
      return "CR";
    case "mixed":
      return "Mixed";
    default:
      // "none" (no line breaks) / "binary" / not-yet-loaded → no badge.
      return null;
  }
}

/** Only a concrete uniform kind can be a conversion target. */
function isConcrete(kind: LineEndingKind | undefined): kind is "lf" | "crlf" | "cr" {
  return kind === "lf" || kind === "crlf" || kind === "cr";
}

interface BadgeProps {
  repoId: string;
  path: string;
  /** null = working tree, ":" = index, else a rev spec. */
  rev?: string | null;
  /** The diff's other side; omit for single-file views. */
  oldRev?: string | null;
}

/** Both sides' kinds plus the derived chip content (null = no chip). */
function useLineEndingChip({ repoId, path, rev, oldRev }: BadgeProps) {
  const newRev = rev ?? null;
  const { data: newKind } = useQuery<LineEndingKind>({
    queryKey: [repoId, newRev === null ? "status" : "log", "line-ending", path, newRev],
    queryFn: () => repoLineEndingKind(repoId, path, newRev),
    staleTime: 10_000,
  });

  const hasOld = oldRev !== undefined;
  const oldSide = oldRev ?? null;
  const { data: oldKind } = useQuery<LineEndingKind>({
    queryKey: [repoId, oldSide === null ? "status" : "log", "line-ending-old", path, oldSide],
    queryFn: () => repoLineEndingKind(repoId, path, oldSide),
    enabled: hasOld,
    staleTime: 10_000,
  });

  const newLabel = labelFor(newKind);
  if (!newLabel) return null;

  const oldLabel = hasOld ? labelFor(oldKind) : null;
  const showArrow = !!oldLabel && oldLabel !== newLabel;
  return {
    newKind,
    oldKind,
    oldLabel,
    text: showArrow ? `${oldLabel}→${newLabel}` : newLabel,
    title: `Line endings: ${showArrow ? `${oldLabel} → ${newLabel}` : newLabel}`,
    attention: newKind === "mixed" || showArrow,
    showArrow,
  };
}

function chipStyle(attention: boolean): React.CSSProperties {
  return {
    flexShrink: 0,
    fontSize: "var(--fz-xs)",
    fontFamily: "monospace",
    letterSpacing: "0.02em",
    padding: "0 6px",
    borderRadius: 999,
    lineHeight: 1.7,
    whiteSpace: "nowrap",
    color: attention ? "var(--status-modified)" : "var(--subtle-fg)",
    border: `1px solid ${attention ? "var(--status-modified)" : "var(--panel-border)"}`,
  };
}

export function LineEndingBadge(props: BadgeProps) {
  const chip = useLineEndingChip(props);
  if (!chip) return null;
  return (
    <span title={chip.title} style={chipStyle(chip.attention)}>
      {chip.text}
    </span>
  );
}

/**
 * The unstaged diff's chip: when the working tree's endings differ from the
 * index side's concrete kind, clicking opens a menu with "Revert line endings
 * to <old>". The revert is destructive (rewrites the file), so it confirms
 * inline per the global destructive-confirmation setting. `disabled` while the
 * diff editor has unsaved edits — the rewrite would race them.
 */
export function RevertableLineEndingBadge(props: BadgeProps & { disabled?: boolean }) {
  const chip = useLineEndingChip(props);
  const { openMenu, closeMenu } = usePanelContextMenu();
  const menuConfirm = useMenuConfirm();
  const confirmDestructive = useConfirmDestructive();
  const queryClient = useQueryClient();

  if (!chip) return null;
  const revertable = chip.showArrow && isConcrete(chip.oldKind);
  if (!revertable) {
    return (
      <span title={chip.title} style={chipStyle(chip.attention)}>
        {chip.text}
      </span>
    );
  }

  const target = chip.oldKind as "lf" | "crlf" | "cr";
  const doRevert = async () => {
    closeMenu();
    try {
      await repoRevertLineEndings(props.repoId, props.path, target);
      invalidateRepoDomains(queryClient, props.repoId, ["status", "diff"]);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };
  const requestRevert = () => {
    if (!confirmDestructive) {
      void doRevert();
      return;
    }
    menuConfirm(`Rewrite ${props.path} with ${chip.oldLabel} line endings?`, () => void doRevert());
  };

  const section = (
    <>
      <SectionLabel>{chip.title}</SectionLabel>
      <MenuItem disabled={props.disabled} onClick={requestRevert}>
        {confirmDestructive
          ? `Revert line endings to ${chip.oldLabel}…`
          : `Revert line endings to ${chip.oldLabel}`}
      </MenuItem>
    </>
  );

  return (
    <button
      type="button"
      title={`${chip.title} — click to revert`}
      onClick={(e) => openMenu(e, section)}
      onContextMenu={(e) => openMenu(e, section)}
      style={{ ...chipStyle(chip.attention), background: "transparent", cursor: "pointer" }}
    >
      {chip.text}
    </button>
  );
}

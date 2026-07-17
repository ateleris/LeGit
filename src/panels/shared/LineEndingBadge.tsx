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
//
// The working-vs-index pair (rev=null, oldRev=":") is POLICY-AWARE: it reads
// the batch summary (`useLineEndingStatusMap`), so a conversion that git's
// own clean filter would perform (autocrlf / .gitattributes) shows no arrow.
// `LineEndingRowBadge` is the Working Changes rows' chip, fed from the same
// summary (attention-only).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { repoLineEndingKind, repoRevertLineEndings } from "../../lib/commands";
import { formatAppError, type LineEndingKind, type LineEndingStatusEntry } from "../../lib/types";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { notify } from "../../store/notifications";
import { useConfirmDestructive } from "../../store/settings";
import { useMenuConfirm, usePanelContextMenu } from "../Commits/menu/PanelContextMenu";
import { MenuItem, SectionLabel } from "../Commits/menu/primitives";
import { eolLabel, rowChipContent, useLineEndingStatusMap } from "./lineEndingStatus";

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
  // The working-vs-index pair (Diff unstaged header, Merge panel) reads the
  // batch summary: policy-aware (an autocrlf conversion is not an arrow) and
  // shared with the Working Changes chips, so list and diff always agree.
  // Every other pair compares git blobs, where policy is irrelevant - those
  // keep the per-file queries.
  const workingVsIndex = newRev === null && oldRev === ":";
  const summary = useLineEndingStatusMap(repoId, workingVsIndex);

  const { data: newKind } = useQuery<LineEndingKind>({
    queryKey: [repoId, newRev === null ? "status" : "log", "line-ending", path, newRev],
    queryFn: () => repoLineEndingKind(repoId, path, newRev),
    staleTime: 10_000,
    enabled: !workingVsIndex,
  });

  const hasOld = oldRev !== undefined;
  const oldSide = oldRev ?? null;
  const { data: oldKind } = useQuery<LineEndingKind>({
    queryKey: [repoId, oldSide === null ? "status" : "log", "line-ending-old", path, oldSide],
    queryFn: () => repoLineEndingKind(repoId, path, oldSide),
    enabled: hasOld && !workingVsIndex,
    staleTime: 10_000,
  });

  if (workingVsIndex) {
    const entry = summary.get(path);
    if (!entry) return null;
    const t = entry.unstaged;
    const fromLabel = t ? eolLabel(t.from) : null;
    const toLabel = t ? eolLabel(t.to) : null;
    if (t && fromLabel && toLabel) {
      // A real (policy-aware) transition: the arrow shows what a commit of
      // this file would do to the blob.
      return {
        newKind: entry.working_raw ?? undefined,
        oldKind: t.from as LineEndingKind | undefined,
        oldLabel: fromLabel,
        text: `${fromLabel}→${toLabel}`,
        title: `Line endings: ${fromLabel} → ${toLabel}`,
        attention: true,
        showArrow: true,
      };
    }
    // No transition: a passive label with the raw on-disk kind (the chip
    // never lies about disk state - on an autocrlf repo this shows CRLF
    // with no arrow).
    const rawLabel = eolLabel(entry.working_raw);
    if (!rawLabel) return null;
    return {
      newKind: entry.working_raw ?? undefined,
      oldKind: undefined as LineEndingKind | undefined,
      oldLabel: null,
      text: rawLabel,
      title: `Line endings: ${rawLabel}`,
      attention: entry.working_raw === "mixed",
      showArrow: false,
    };
  }

  const newLabel = eolLabel(newKind);
  if (!newLabel) return null;

  const oldLabel = hasOld ? eolLabel(oldKind) : null;
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
    // Box metrics match the Commits panel's ref chips (BASE_CHIP in
    // RefsCell.tsx): text at the base ui font size (--fz-md = ui_font_size,
    // which the ref chips use), 1px/5px padding, radius 10, 1.3 line height.
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    fontSize: "var(--fz-md)",
    fontFamily: "monospace",
    letterSpacing: "0.02em",
    lineHeight: 1.3,
    padding: "1px 5px",
    borderRadius: 10,
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
 * The clickable revert chip: opens a menu whose action rewrites the working
 * file's endings to `target` (content edits untouched). Destructive, so it
 * inline-confirms per the global setting. Must be rendered inside a
 * `PanelContextMenuProvider`. Shared by the Diff panel's unstaged badge and
 * the Working Changes row chips so the action cannot drift out of parity.
 */
export function RevertChipButton({
  repoId,
  path,
  target,
  text,
  title,
  disabled,
}: {
  repoId: string;
  path: string;
  target: "lf" | "crlf" | "cr";
  text: string;
  title: string;
  disabled?: boolean;
}) {
  const { openMenu, closeMenu } = usePanelContextMenu();
  const menuConfirm = useMenuConfirm();
  const confirmDestructive = useConfirmDestructive();
  const queryClient = useQueryClient();

  const targetLabel = target.toUpperCase();
  const doRevert = async () => {
    closeMenu();
    try {
      await repoRevertLineEndings(repoId, path, target);
      invalidateRepoDomains(queryClient, repoId, ["status", "diff"]);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };
  const requestRevert = () => {
    if (!confirmDestructive) {
      void doRevert();
      return;
    }
    menuConfirm(`Rewrite ${path} with ${targetLabel} line endings?`, () => void doRevert());
  };

  const section = (
    <>
      <SectionLabel>{title}</SectionLabel>
      <MenuItem disabled={disabled} onClick={requestRevert}>
        {confirmDestructive
          ? `Revert line endings to ${targetLabel}…`
          : `Revert line endings to ${targetLabel}`}
      </MenuItem>
    </>
  );

  return (
    <button
      type="button"
      className="legit-eol-chip"
      title={`${title} — click to revert`}
      onClick={(e) => openMenu(e, section)}
      onContextMenu={(e) => openMenu(e, section)}
      style={{ ...chipStyle(true), cursor: "pointer" }}
    >
      {text}
    </button>
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
  if (!chip) return null;
  const revertable = chip.showArrow && isConcrete(chip.oldKind);
  if (!revertable) {
    return (
      <span title={chip.title} style={chipStyle(chip.attention)}>
        {chip.text}
      </span>
    );
  }
  return (
    <RevertChipButton
      repoId={props.repoId}
      path={props.path}
      target={chip.oldKind as "lf" | "crlf" | "cr"}
      text={chip.text}
      title={chip.title}
      disabled={props.disabled}
    />
  );
}

/**
 * Working Changes row chip, fed from the batch summary entry (no queries -
 * the panel owns the map). Attention-only via `rowChipContent`; unstaged
 * transitions from a concrete kind are clickable (same revert menu as the
 * Diff chip), everything else is passive.
 */
export function LineEndingRowBadge({
  repoId,
  entry,
  side,
  disabled,
}: {
  repoId: string;
  entry: LineEndingStatusEntry;
  side: "unstaged" | "staged";
  disabled?: boolean;
}) {
  const chip = rowChipContent(entry, side);
  if (!chip) return null;
  if (chip.revertTarget) {
    return (
      <RevertChipButton
        repoId={repoId}
        path={entry.path}
        target={chip.revertTarget}
        text={chip.text}
        title={chip.title}
        disabled={disabled}
      />
    );
  }
  return (
    <span title={chip.title} style={chipStyle(true)}>
      {chip.text}
    </span>
  );
}

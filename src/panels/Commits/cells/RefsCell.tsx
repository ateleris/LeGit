import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BranchIcon, RemoteIcon, TagIcon } from "../../../icons";
import type { LaneLock, MergeOptions, RefDecoration } from "../../../lib/types";
import { usePanelContextMenu } from "../menu/PanelContextMenu";
import { LaneLockSection } from "../menu/LaneLockSection";
import { Separator } from "../menu/primitives";
import { BranchMenuSection, RemoteBranchMenuSection } from "../menu/BranchMenuSection";
import { TagMenuSection } from "../menu/TagMenuSection";
import { InlineRenameInput } from "./InlineRenameInput";
import { buildChips, computeVisibleCount } from "./refChips";
import type { ChipDescriptor } from "./refChips";

interface RefsCellProps {
  decorations: RefDecoration[];
  /** Current locks for the active repo. */
  locks: LaneLock[];
  /** Active repo id (needed for set/unsetLock calls). */
  repoId: string;
  /** Full local ref → full upstream ref, for fusing a branch with its remote. */
  upstreamMap: Map<string, string>;
  /** Chip font size in px (user-configurable, shared with the text columns). */
  textSize: number;
  /**
   * Short name of the branch being renamed in place — its chip renders as an
   * input (Enter approves, Esc discards). Branch names are unique, so at most
   * one chip matches.
   */
  renamingBranch?: string | null;
  onBranchRenameSave?: (oldName: string, newName: string) => void;
  onBranchRenameCancel?: () => void;
  /**
   * Show an empty branch-name input (create-new mode, from the toolbar's
   * New-branch button). Only the HEAD row's cell receives `true`. The branch
   * is created on Enter — Esc discards without creating anything.
   */
  creatingBranch?: boolean;
  onCreateBranchSave?: (name: string) => void;
  onCreateBranchCancel?: () => void;
  /** Same as `creatingBranch`, but for a (lightweight) tag on this row's commit. */
  creatingTag?: boolean;
  onCreateTagSave?: (name: string) => void;
  onCreateTagCancel?: () => void;
  /** Tag names that exist on the remote with the same target — their chips
   *  carry the remote indicator, like fused branch chips do. */
  pushedTags?: ReadonlySet<string>;
  /** Tag names whose target commit is on the remote; pushing the others is
   *  disabled (it would upload commits no remote branch references). */
  tagTargetsOnRemote?: ReadonlySet<string>;
  /** Remote tags are pushed to (chip menu label), or null when none exists. */
  tagRemote?: string | null;
  onTagPush?: (name: string) => void;
  onTagDelete?: (name: string) => void;
  /** Deletes the tag on the remote only (offered while pushed). */
  onTagDeleteRemote?: (name: string) => void;
  onBranchCheckout?: (name: string) => void;
  onBranchRename?: (name: string) => void;
  onBranchDelete?: (name: string, force: boolean) => void;
  /** Called when checking out a remote-tracking branch (passes the full remote ref, e.g. `origin/feature-x`). */
  onRemoteCheckout?: (remoteRef: string) => void;
  /** Current branch (merge/rebase menu labels); null when HEAD is detached. */
  currentBranch?: string | null;
  /** Hide merge/rebase entries while a merge/rebase is already running. */
  opInProgress?: boolean;
  /** Merge `target` (local name or remote ref) into the current branch. */
  onBranchMerge?: (target: string, options: MergeOptions) => void;
  /** Rebase the current branch onto `target`. */
  onBranchRebaseOnto?: (target: string) => void;
}

const CHIP_GAP = 3;

/** Renders ref decoration chips for a commit row. */
export function RefsCell({ decorations, locks, repoId, upstreamMap, textSize, renamingBranch, onBranchRenameSave, onBranchRenameCancel, creatingBranch, onCreateBranchSave, onCreateBranchCancel, creatingTag, onCreateTagSave, onCreateTagCancel, pushedTags, tagTargetsOnRemote, tagRemote, onTagPush, onTagDelete, onTagDeleteRemote, onBranchCheckout, onBranchRename, onBranchDelete, onRemoteCheckout, currentBranch, opInProgress, onBranchMerge, onBranchRebaseOnto }: RefsCellProps) {
  const { openMenu, closeMenu } = usePanelContextMenu();
  const [visibleCount, setVisibleCount] = useState(Number.MAX_SAFE_INTEGER);
  const [popover, setPopover] = useState<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  // Hover lifecycle for the "+N" popover: opening cancels any pending close;
  // leaving the chip or the popover schedules a short-grace close so the
  // pointer can travel between them.
  const closeTimer = useRef<number | null>(null);

  const cancelPopoverClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const openPopoverAt = useCallback(
    (anchor: HTMLElement) => {
      cancelPopoverClose();
      const rect = anchor.getBoundingClientRect();
      setPopover({ x: rect.left, y: rect.bottom });
    },
    [cancelPopoverClose]
  );

  const schedulePopoverClose = useCallback(() => {
    cancelPopoverClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setPopover(null);
    }, 150);
  }, [cancelPopoverClose]);

  useEffect(() => cancelPopoverClose, [cancelPopoverClose]);

  // Priority-sorted chips: HEAD pair, branches (fused with their remote where
  // applicable), remotes, tags, other.
  const chips = useMemo(
    () => buildChips(decorations, upstreamMap),
    [decorations, upstreamMap],
  );

  // Measure the hidden full chip row and compute how many chips fit on the
  // single visible line; the rest collapse behind a "+N" chip.
  const remeasure = useCallback(() => {
    const measurer = measureRef.current;
    const container = containerRef.current;
    if (!measurer || !container) return;
    const widths = Array.from(
      measurer.children,
      (el) => (el as HTMLElement).offsetWidth,
    );
    // The measurer's last child is the worst-case "+99" overflow chip probe.
    const overflowWidth = widths.pop() ?? 0;
    setVisibleCount(
      computeVisibleCount(widths, container.clientWidth, CHIP_GAP, overflowWidth),
    );
  }, []);

  useLayoutEffect(() => {
    remeasure();
  }, [remeasure, chips, textSize]);

  // Re-fit when the Refs column is resized.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => remeasure());
    observer.observe(container);
    return () => observer.disconnect();
  }, [remeasure]);

  if (decorations.length === 0 && !creatingBranch && !creatingTag) return null;

  // Find HeadOf target so we can mark the matching branch chip as "checked out"
  const headOfDec = decorations.find((d) => d.type === "headOf");
  const headOfTarget = headOfDec && headOfDec.type === "headOf" ? headOfDec.value : null;

  // `forMeasure` renders the plain chip even mid-rename: the invisible
  // measurement pass must never mount the editing input (a second autoFocus
  // would steal focus from the real one).
  const renderChip = (chip: ChipDescriptor, key: React.Key, forMeasure = false) => {
    const refName =
      chip.kind === "branch"
        ? chip.value
        : chip.kind === "fusedBranch"
          ? chip.local
          : null;

    // In-place branch rename: the matching chip becomes an input.
    if (!forMeasure && renamingBranch != null && refName !== null) {
      const name = shortBranch(refName);
      if (name === renamingBranch) {
        return (
          <InlineRenameInput
            key={key}
            initialValue={name}
            onSave={(value) => onBranchRenameSave?.(name, value)}
            onCancel={() => onBranchRenameCancel?.()}
            title="Enter to save · Esc to cancel"
            style={{
              fontSize: textSize,
              padding: "1px 5px",
              borderRadius: 10,
              width: `${Math.min(Math.max(name.length + 4, 12), 28)}ch`,
              flexShrink: 0,
            }}
          />
        );
      }
    }

    const buildBranchSection = (): React.ReactNode => {
      if (chip.kind === "branch" || chip.kind === "fusedBranch") {
        const localRef =
          chip.kind === "fusedBranch"
            ? chip.local
            : chip.value;
        const localName = localRef.replace(/^refs\/heads\//, "");
        const isCurrent = headOfTarget === localRef;

        return (
          <BranchMenuSection
            name={localName}
            isCurrent={isCurrent}
            currentBranch={currentBranch ?? null}
            opInProgress={opInProgress ?? false}
            onCheckout={() => { closeMenu(); onBranchCheckout?.(localName); }}
            onRename={() => { closeMenu(); onBranchRename?.(localName); }}
            onDelete={(force) => { closeMenu(); onBranchDelete?.(localName, force); }}
            onMerge={(options) => { closeMenu(); onBranchMerge?.(localName, options); }}
            onRebaseOnto={() => { closeMenu(); onBranchRebaseOnto?.(localName); }}
          />
        );
      }
      if (chip.kind === "remote") {
        const remoteName = chip.value.replace(/^refs\/remotes\//, "");
        return (
          <RemoteBranchMenuSection
            remoteName={remoteName}
            currentBranch={currentBranch ?? null}
            opInProgress={opInProgress ?? false}
            onCheckout={() => { closeMenu(); onRemoteCheckout?.(remoteName); }}
            onMerge={(options) => { closeMenu(); onBranchMerge?.(remoteName, options); }}
            onRebaseOnto={() => { closeMenu(); onBranchRebaseOnto?.(remoteName); }}
          />
        );
      }
      if (chip.kind === "tag") {
        const tagName = chip.value.replace(/^refs\/tags\//, "");
        return (
          <TagMenuSection
            name={tagName}
            pushed={pushedTags?.has(tagName) ?? false}
            targetOnRemote={tagTargetsOnRemote?.has(tagName) ?? true}
            remote={tagRemote ?? null}
            onPush={() => { closeMenu(); onTagPush?.(tagName); }}
            onDelete={() => { closeMenu(); onTagDelete?.(tagName); }}
            onDeleteRemote={() => { closeMenu(); onTagDeleteRemote?.(tagName); }}
          />
        );
      }
      return undefined;
    };

    const branchSection = buildBranchSection();
    const lockSection = refName
      ? <LaneLockSection refName={refName} locks={locks} repoId={repoId} />
      : undefined;

    const menuSection =
      branchSection || lockSection ? (
        <>
          {branchSection}
          {branchSection && lockSection && <Separator />}
          {lockSection}
        </>
      ) : undefined;

    // Double-click on a branch label checks it out (no-op on the current
    // branch); on a remote label it checks out its local tracking branch.
    const buildDoubleClickCheckout = (): (() => void) | undefined => {
      if (chip.kind === "branch" || chip.kind === "fusedBranch") {
        const localRef = chip.kind === "fusedBranch" ? chip.local : chip.value;
        if (headOfTarget === localRef) return undefined; // already checked out
        const localName = localRef.replace(/^refs\/heads\//, "");
        return onBranchCheckout && (() => onBranchCheckout(localName));
      }
      if (chip.kind === "remote") {
        const remoteName = chip.value.replace(/^refs\/remotes\//, "");
        return onRemoteCheckout && (() => onRemoteCheckout(remoteName));
      }
      return undefined;
    };

    const tagPushed =
      chip.kind === "tag" &&
      (pushedTags?.has(chip.value.replace(/^refs\/tags\//, "")) ?? false);

    return (
      <Chip
        key={key}
        chip={chip}
        headOfTarget={headOfTarget}
        textSize={textSize}
        tagPushed={tagPushed}
        tagRemote={tagRemote ?? null}
        onContextMenu={(e) => openMenu(e, menuSection)}
        onDoubleClickAction={buildDoubleClickCheckout()}
      />
    );
  };

  // The "+N" overflow chip tracks the configured text size like the chips it
  // collapses.
  const overflowChipStyle = { ...OVERFLOW_CHIP, fontSize: textSize };

  const visibleChips = chips.slice(0, visibleCount);
  const hiddenChips = chips.slice(visibleCount);

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        display: "flex",
        gap: CHIP_GAP,
        alignItems: "center",
        justifyContent: "flex-end",
        overflow: "hidden",
      }}
    >
      {/* Invisible measurement pass — all chips plus the overflow chip probe. */}
      <div
        ref={measureRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          display: "flex",
          gap: CHIP_GAP,
          visibility: "hidden",
          pointerEvents: "none",
        }}
      >
        {chips.map((chip, i) => renderChip(chip, i, true))}
        <span style={overflowChipStyle}>+99</span>
      </div>

      {/* Create-new-branch input (toolbar's New-branch button): an empty
          chip-styled input; the branch only exists once a name is confirmed. */}
      {creatingBranch && (
        <InlineRenameInput
          initialValue=""
          placeholder="branch name…"
          title="Enter to create · Esc to cancel"
          onSave={(name) => onCreateBranchSave?.(name)}
          onCancel={() => onCreateBranchCancel?.()}
          style={{
            fontSize: textSize,
            padding: "1px 5px",
            borderRadius: 10,
            width: "16ch",
            flexShrink: 0,
          }}
        />
      )}

      {/* Create-new-tag input (row context menu): same pattern, tag-shaped. */}
      {creatingTag && (
        <InlineRenameInput
          initialValue=""
          placeholder="tag name…"
          title="Enter to create · Esc to cancel"
          onSave={(name) => onCreateTagSave?.(name)}
          onCancel={() => onCreateTagCancel?.()}
          style={{
            fontSize: textSize,
            padding: "1px 5px",
            borderRadius: 3, // tag chips are squarer than branch chips
            width: "16ch",
            flexShrink: 0,
          }}
        />
      )}

      {visibleChips.map((dec, i) => renderChip(dec, i))}

      {hiddenChips.length > 0 && (
        <span
          style={overflowChipStyle}
          onMouseEnter={(e) => openPopoverAt(e.currentTarget)}
          onMouseLeave={schedulePopoverClose}
          onClick={(e) => openPopoverAt(e.currentTarget)}
        >
          +{hiddenChips.length}
        </span>
      )}

      {popover &&
        createPortal(
          <OverflowPopover
            x={popover.x}
            y={popover.y}
            onClose={() => setPopover(null)}
            onPointerEnter={cancelPopoverClose}
            onPointerLeave={schedulePopoverClose}
          >
            {hiddenChips.map((dec, i) => renderChip(dec, i))}
          </OverflowPopover>,
          document.body
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chip
// ---------------------------------------------------------------------------

interface ChipProps {
  chip: ChipDescriptor;
  headOfTarget: string | null;
  /** Chip font size in px. */
  textSize: number;
  /** Tag chips: the tag exists on the remote with the same target. */
  tagPushed?: boolean;
  /** Remote the pushed indicator refers to (tooltip). */
  tagRemote?: string | null;
  /** Called on right-click; the unified menu handles preventDefault. */
  onContextMenu: (e: React.MouseEvent) => void;
  /**
   * Checkout action fired on double-click (branch / fused / remote chips).
   * Absent for chip kinds that have nothing to check out — and for the
   * currently checked-out branch, where it would be a no-op.
   */
  onDoubleClickAction?: () => void;
}

const shortBranch = (ref: string) => ref.replace(/^refs\/heads\//, "");
const shortRemote = (ref: string) => ref.replace(/^refs\/remotes\//, "");

/**
 * The checked-out marker: a filled dot at the left edge of the current
 * branch's chip (the common convention in git GUIs). Inherits the chip's
 * foreground colour; sized in em so it tracks the configured text size.
 */
function CurrentDot() {
  return (
    <span
      aria-hidden="true"
      style={{
        // Same box as the icons next to it (they render at 1em) so the
        // checked-out marker is unmissable.
        width: "1em",
        height: "1em",
        borderRadius: "50%",
        background: "currentColor",
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

/**
 * The remote-tracking indicator shown on a fused chip. Inherits the chip's
 * foreground colour. Isolated so it can later render a per-remote service logo
 * instead of the generic cloud glyph.
 */
function RemoteIndicator({ remoteRef }: { remoteRef: string }) {
  return (
    <span title={shortRemote(remoteRef)} style={{ display: "inline-flex" }}>
      <RemoteIcon />
    </span>
  );
}

function Chip({ chip, headOfTarget, textSize, tagPushed = false, tagRemote = null, onContextMenu, onDoubleClickAction }: ChipProps) {
  const handleContextMenu = onContextMenu;
  const handleDoubleClick = onDoubleClickAction
    ? (e: React.MouseEvent) => {
        // Don't let the double-click bubble as row clicks (selection / details
        // already happened on the first click; a future row dblclick handler
        // must not also fire).
        e.stopPropagation();
        onDoubleClickAction();
      }
    : undefined;
  const checkoutHint = onDoubleClickAction ? " — double-click to checkout" : "";

  switch (chip.kind) {
    case "head":
      // Detached HEAD is what's checked out — it carries the same dot marker
      // as the checked-out branch chip.
      return (
        <span
          onContextMenu={handleContextMenu}
          style={chipStyle({ variant: "head", textSize })}
          title="Detached HEAD — checked out"
        >
          <CurrentDot />
          HEAD
        </span>
      );

    case "branch": {
      const isCheckedOut = headOfTarget !== null && chip.value === headOfTarget;
      return (
        <span
          onContextMenu={handleContextMenu}
          onDoubleClick={handleDoubleClick}
          style={chipStyle({ variant: "branch", isCheckedOut, textSize })}
          title={`${chip.value}${isCheckedOut ? " — checked out" : ""}${checkoutHint}`}
        >
          {isCheckedOut && <CurrentDot />}
          <BranchIcon /> {shortBranch(chip.value)}
        </span>
      );
    }

    case "fusedBranch": {
      // Local branch fused with its upstream remote (same commit): the local
      // pill plus a trailing remote indicator.
      const isCheckedOut = headOfTarget !== null && chip.local === headOfTarget;
      return (
        <span
          onContextMenu={handleContextMenu}
          onDoubleClick={handleDoubleClick}
          style={chipStyle({ variant: "branch", isCheckedOut, textSize })}
          title={`${shortBranch(chip.local)} → ${shortRemote(chip.remote)}${isCheckedOut ? " — checked out" : ""}${checkoutHint}`}
        >
          {isCheckedOut && <CurrentDot />}
          <BranchIcon /> <RemoteIndicator remoteRef={chip.remote} /> {shortBranch(chip.local)}
        </span>
      );
    }

    case "remote":
      return (
        <span
          onContextMenu={handleContextMenu}
          onDoubleClick={handleDoubleClick}
          style={chipStyle({ variant: "remote", textSize })}
          title={`${chip.value}${checkoutHint}`}
        >
          <RemoteIcon /> {shortRemote(chip.value)}
        </span>
      );

    case "tag":
      // A pushed tag (exists on the remote with the same target) carries the
      // remote indicator, mirroring fused branch chips.
      return (
        <span
          onContextMenu={handleContextMenu}
          style={chipStyle({ variant: "tag", textSize })}
          title={`${chip.value}${tagPushed ? ` — pushed to ${tagRemote ?? "remote"}` : ""}`}
        >
          <TagIcon />{" "}
          {tagPushed && (
            <span style={{ display: "inline-flex" }}>
              <RemoteIcon />
            </span>
          )}{" "}
          {chip.value.replace(/^refs\/tags\//, "")}
        </span>
      );

    case "other":
      return (
        <span
          onContextMenu={handleContextMenu}
          style={chipStyle({ variant: "other", textSize })}
          title={chip.value}
        >
          {chip.value}
        </span>
      );
  }
}

// ---------------------------------------------------------------------------
// Overflow popover (portal-rendered)
// ---------------------------------------------------------------------------

const POPOVER_W = 280;
const POPOVER_H_ESTIMATE = 120;

/** Panel listing the ref chips that didn't fit on the row's single line. */
function OverflowPopover({
  x,
  y,
  onClose,
  onPointerEnter,
  onPointerLeave,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click + Escape.
  useEffect(() => {
    const controller = new AbortController();
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && !panelRef.current?.contains(target)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouseDown, { signal: controller.signal });
    document.addEventListener("keydown", onKey, { signal: controller.signal });
    return () => controller.abort();
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - POPOVER_W - 4);
  const top = Math.min(y + 8, window.innerHeight - POPOVER_H_ESTIMATE - 4);

  return (
    <div
      ref={panelRef}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      style={{
        position: "fixed",
        left,
        top,
        maxWidth: POPOVER_W,
        background: "var(--panel-bg, #1e1e1e)",
        border: "1px solid var(--panel-border, rgba(255,255,255,0.12))",
        borderRadius: 4,
        padding: 8,
        zIndex: 9999,
        boxShadow: "0 4px 12px var(--shadow-color)",
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        alignItems: "center",
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

// Font size is applied per-render from the configured text size (see
// chipStyle / overflowChipStyle); lineHeight is unitless so it scales with it.
const BASE_CHIP: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  lineHeight: 1.3,
  padding: "1px 5px",
  borderRadius: 10,
  whiteSpace: "nowrap",
  maxWidth: 160,
  overflow: "hidden",
  textOverflow: "ellipsis",
  cursor: "default",
  userSelect: "none",
};

/** The "+N" chip collapsing refs that don't fit on the row's single line. */
const OVERFLOW_CHIP: React.CSSProperties = {
  ...BASE_CHIP,
  background: "var(--ref-overflow-bg, rgba(255, 255, 255, 0.08))",
  border: "1px solid var(--ref-overflow-border, rgba(255, 255, 255, 0.25))",
  color: "var(--ref-overflow-fg, #aaa)",
  cursor: "pointer",
  flexShrink: 0,
};

type ChipVariant =
  | "branch"
  | "remote"
  | "tag"
  | "head"
  | "other";

// Chip colours are theme tokens (see src/theme/tokens.ts, group "Refs"). The
// fallbacks preserve the previous hardcoded look if a theme omits a token.
function chipStyle({
  variant,
  isCheckedOut,
  textSize,
}: {
  variant: ChipVariant;
  isCheckedOut?: boolean;
  textSize: number;
}): React.CSSProperties {
  const base: React.CSSProperties = { ...BASE_CHIP, fontSize: textSize };
  switch (variant) {
    case "branch":
      return {
        ...base,
        background: isCheckedOut
          ? "var(--ref-branch-current-bg, rgba(100, 200, 100, 0.20))"
          : "var(--ref-branch-bg, rgba(80, 160, 255, 0.15))",
        border: isCheckedOut
          ? "1.5px solid var(--ref-branch-current-border, rgba(100, 200, 100, 0.70))"
          : "1px solid var(--ref-branch-border, rgba(80, 160, 255, 0.45))",
        color: isCheckedOut
          ? "var(--ref-branch-current-fg, rgb(130, 220, 130))"
          : "var(--ref-branch-fg, rgb(120, 180, 255))",
        fontWeight: isCheckedOut ? 600 : 400,
      };

    case "remote":
      return {
        ...base,
        background: "var(--ref-remote-bg, rgba(170, 130, 255, 0.15))",
        border: "1px solid var(--ref-remote-border, rgba(170, 130, 255, 0.45))",
        color: "var(--ref-remote-fg, rgb(185, 150, 255))",
      };

    case "tag":
      return {
        ...base,
        background: "var(--ref-tag-bg, rgba(220, 170, 60, 0.15))",
        border: "1px solid var(--ref-tag-border, rgba(220, 170, 60, 0.45))",
        color: "var(--ref-tag-fg, rgb(220, 170, 60))",
        borderRadius: 3, // flag shape — slightly square
      };

    case "head":
      return {
        ...base,
        background: "var(--ref-head-bg, rgba(240, 100, 100, 0.18))",
        border: "1.5px solid var(--ref-head-border, rgba(240, 100, 100, 0.55))",
        color: "var(--ref-head-fg, rgb(240, 130, 130))",
        fontWeight: 600,
      };

    case "other":
      return {
        ...base,
        background: "var(--ref-other-bg, rgba(150, 150, 150, 0.15))",
        border: "1px solid var(--ref-other-border, rgba(150, 150, 150, 0.35))",
        color: "var(--ref-other-fg, rgb(160, 160, 160))",
      };
  }
}

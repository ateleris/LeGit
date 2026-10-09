// Central icon module.
//
// Every SVG icon used in the UI is re-exported here as a semantic component, so
// call sites never import an icon library directly. Swapping or extending the
// icon set (e.g. adding Octicons for git-specific glyphs) stays a single-file
// change rather than a find-and-replace across the app.
//
// Icons default to `size="1em"` and inherit `currentColor`, so they scale with
// the surrounding font size and follow the active theme's text colour with no
// per-call-site styling. Pass `size`, `color`, `strokeWidth`, `style`, etc. to
// override; pass `aria-label` (and `aria-hidden={false}`) for meaningful icons.

import { forwardRef, type SVGProps } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  CornerLeftUp,
  EyeOff,
  Folder,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  Globe,
  GripVertical,
  KeyRound,
  Link2,
  Lock,
  Unlink2,
  Minus,
  Plus,
  Archive,
  RefreshCw,
  RotateCcw,
  Server,
  SquarePen,
  Tag,
  Trash2,
  TriangleAlert,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

export type IconProps = LucideProps;

/**
 * Wrap a lucide icon with LeGit's defaults: em-relative sizing, inherited
 * colour, and baseline-friendly vertical alignment for inline use next to text.
 * Caller props win over the defaults.
 */
function withDefaults(Base: LucideIcon, displayName: string) {
  const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(props, ref) {
    return (
      <Base
        ref={ref}
        size="1em"
        aria-hidden
        {...props}
        // flexShrink 0: an icon inside an inline-flex row (ref chips, menu
        // labels) must keep its 1em box under width pressure - the default
        // shrink squeezed the glyph horizontally (chip overflow popover bug,
        // 2026-07-31, pinned in icons.test.tsx).
        style={{ verticalAlign: "-0.125em", flexShrink: 0, ...props.style }}
      />
    );
  });
  Icon.displayName = displayName;
  return Icon;
}

export const BranchIcon = withDefaults(GitBranch, "BranchIcon");
export const BranchPlusIcon = withDefaults(GitBranchPlus, "BranchPlusIcon");
export const RemoteIcon = withDefaults(Cloud, "RemoteIcon");
export const WslHostIcon = withDefaults(Server, "WslHostIcon");
export const WorktreeIcon = withDefaults(FolderGit2, "WorktreeIcon");
export const WatchOffIcon = withDefaults(EyeOff, "WatchOffIcon");
export const SuperprojectIcon = withDefaults(CornerLeftUp, "SuperprojectIcon");
export const TagIcon = withDefaults(Tag, "TagIcon");
export const StashIcon = withDefaults(Archive, "StashIcon");
export const LinkIcon = withDefaults(Link2, "LinkIcon");
export const UnlinkIcon = withDefaults(Unlink2, "UnlinkIcon");
export const CheckIcon = withDefaults(Check, "CheckIcon");
export const SignedIcon = withDefaults(KeyRound, "SignedIcon");
export const WarningIcon = withDefaults(TriangleAlert, "WarningIcon");
// Working Changes row actions.
export const StageIcon = withDefaults(Plus, "StageIcon");
export const UnstageIcon = withDefaults(Minus, "UnstageIcon");
// Remote sync (Commits panel toolbar).
export const ExternalEditorIcon = withDefaults(SquarePen, "ExternalEditorIcon");
/** The "open in editor" action when NO editor is configured (opens the repo
 *  folder instead) - the icon must not promise an editor. */
export const FolderIcon = withDefaults(Folder, "FolderIcon");
export const RemotePageIcon = withDefaults(Globe, "RemotePageIcon");
/** Repo tab bar "add repository" trigger (open / clone / init). */
export const AddRepoIcon = withDefaults(Plus, "AddRepoIcon");
export const FetchIcon = withDefaults(RefreshCw, "FetchIcon");
export const PullIcon = withDefaults(ArrowDownToLine, "PullIcon");
export const PushIcon = withDefaults(ArrowUpToLine, "PushIcon");
export const ChevronDownIcon = withDefaults(ChevronDown, "ChevronDownIcon");
export const ChevronRightIcon = withDefaults(ChevronRight, "ChevronRightIcon");
// Layouts panel row actions.
export const RenameIcon = withDefaults(SquarePen, "RenameIcon");
export const DeleteIcon = withDefaults(Trash2, "DeleteIcon");
export const DragHandleIcon = withDefaults(GripVertical, "DragHandleIcon");

// Custom (non-lucide) icons follow the same conventions: `size` defaults to
// `1em`, the glyph fills with `currentColor`, and the keyhole is punched out
// (fill-rule: evenodd) so it stays transparent against whatever sits behind it.

export interface CustomIconProps extends Omit<SVGProps<SVGSVGElement>, "color"> {
  size?: number | string;
}

/**
 * A solid (filled) padlock — lucide ships outline-only, so this is hand-rolled.
 * Used for the locked-lane marker in the graph header, where a filled glyph
 * tinted to the lane colour reads as "this lane is pinned".
 */
export const LockFilledIcon = forwardRef<SVGSVGElement, CustomIconProps>(
  function LockFilledIcon({ size = "1em", style, ...rest }, ref) {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden
        style={{ verticalAlign: "-0.125em", ...style }}
        {...rest}
      >
        {/* Shackle (the arch); stroked so it stays open. */}
        <path
          d="M8 11V7a4 4 0 0 1 8 0v4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        />
        {/* Body with a punched-out keyhole. */}
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M6 10h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zm6 4a1.6 1.6 0 0 0-.8 2.99V18a.8.8 0 0 0 1.6 0v-1.01A1.6 1.6 0 0 0 12 14z"
        />
      </svg>
    );
  }
);

/** One-path brand glyph filled with `currentColor` (this lucide version
 *  ships no brand icons). Monochrome on purpose: platform marks tint like
 *  every other icon, so themes stay in control of every colour. */
function brandIcon(name: string, viewBox: string, d: string) {
  const Icon = forwardRef<SVGSVGElement, CustomIconProps>(function BrandIcon(
    { size = "1em", style, ...rest },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox={viewBox}
        fill="currentColor"
        aria-hidden
        style={{ verticalAlign: "-0.125em", flexShrink: 0, ...style }}
        {...rest}
      >
        <path d={d} />
      </svg>
    );
  });
  Icon.displayName = name;
  return Icon;
}

export const GitHubIcon = brandIcon(
  "GitHubIcon",
  "0 0 16 16",
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z",
);

export const GitLabIcon = brandIcon(
  "GitLabIcon",
  "0 0 24 24",
  "m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z",
);

export const AzureDevOpsIcon = brandIcon(
  "AzureDevOpsIcon",
  "0 0 24 24",
  "M0 8.877 2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z",
);

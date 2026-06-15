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
  Check,
  Cloud,
  GitBranch,
  Lock,
  Tag,
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
        style={{ verticalAlign: "-0.125em", ...props.style }}
      />
    );
  });
  Icon.displayName = displayName;
  return Icon;
}

export const BranchIcon = withDefaults(GitBranch, "BranchIcon");
export const RemoteIcon = withDefaults(Cloud, "RemoteIcon");
export const TagIcon = withDefaults(Tag, "TagIcon");
export const LockIcon = withDefaults(Lock, "LockIcon");
export const CheckIcon = withDefaults(Check, "CheckIcon");
export const WarningIcon = withDefaults(TriangleAlert, "WarningIcon");

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

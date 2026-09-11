import type { CSSProperties, ReactNode } from "react";

// Path-aware truncation: the prefix's huge flex-shrink factor makes it give
// way first, so the row reads "start/of/path…leafname" when space is tight
// and only then ellipsizes the leaf. Must live in a flex row with minWidth 0.
export function ShrinkingPathText({
  prefix,
  leaf,
  className,
  prefixClassName,
  leafTestId,
  style,
  title,
  children,
}: {
  prefix: string;
  leaf: string;
  className?: string;
  prefixClassName?: string;
  leafTestId?: string;
  /** Applied to the wrapping span (font, flex sizing, colors). */
  style?: CSSProperties;
  title?: string;
  /** Rendered before the prefix, never shrunk (e.g. a current-branch dot). */
  children?: ReactNode;
}) {
  return (
    <span
      className={className}
      title={title}
      style={{ display: "flex", alignItems: "baseline", minWidth: 0, whiteSpace: "nowrap", ...style }}
    >
      {children}
      {prefix && (
        <span
          className={prefixClassName}
          style={{
            flexShrink: 9999,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {prefix}
        </span>
      )}
      <span
        data-testid={leafTestId}
        style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {leaf}
      </span>
    </span>
  );
}

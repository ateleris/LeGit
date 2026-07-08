/**
 * Diagonal "DEV" ribbon pinned to the bottom-right corner of the window so a
 * dev build is never mistaken for a release. Rendered only when Vite serves
 * the app in dev mode (`tauri dev`); production bundles compile it away.
 *
 * Deliberately an exception to the theme-token rule (user decision): the
 * ribbon is dev-only chrome that must look identical in every theme, so its
 * colours are literals and the file is allowlisted in noLiteralColors.test.ts.
 * It is purely informational: clicks pass through, and it scales with the
 * global UI font size via em units.
 */
export function DevRibbon() {
  if (!import.meta.env.DEV) return null;
  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        right: 0,
        bottom: 0,
        width: "7em",
        height: "7em",
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 9999,
        fontSize: "var(--fz-sm)",
      }}
    >
      <div
        style={{
          position: "absolute",
          right: "-2.5em",
          bottom: "1.5em",
          width: "10em",
          transform: "rotate(-45deg)",
          background: "#e08807",
          color: "#1a1a1a",
          textAlign: "center",
          fontWeight: 700,
          letterSpacing: "0.25em",
          // Left padding matches the trailing letter-spacing gap after the
          // last glyph, keeping the text optically centered.
          padding: "0.3em 0 0.3em 0.25em",
          boxShadow: "0 0 0.5em rgba(0, 0, 0, 0.4)",
        }}
      >
        DEV
      </div>
    </div>
  );
}

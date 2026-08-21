// Overlay shown over the repo dock when NO repository is open: every panel
// only shows its own "No repository open." placeholder then, and nothing
// tells a first-time user that the "+" button in the repo tab bar (open /
// clone / init) is the way to get started. Not the dockview watermark -
// panels ARE open, there is just no repo - so it is a conditional overlay
// keyed on the repo store. `pointerEvents: none` keeps the dock beneath
// fully interactive (panels can still be arranged); `initialized` gates the
// startup restore so the hint never flashes before the open repos load.

import { useRepoStore } from "../store/repos";

export function NoRepoHint() {
  const show = useRepoStore((s) => s.initialized && s.openRepos.length === 0);
  if (!show) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
        zIndex: 10,
      }}
    >
      <span
        className="legit-subtle"
        style={{
          fontSize: "var(--fz-lg)",
          textAlign: "center",
          background: "var(--panel-bg)",
          border: "1px solid var(--panel-border)",
          borderRadius: 4,
          padding: "0.75em 1.25em",
          boxShadow: "0 4px 12px var(--shadow-color)",
        }}
      >
        No repository open - use the <strong>+</strong> button in the tab bar
        above to open, clone, or create one.
      </span>
    </div>
  );
}

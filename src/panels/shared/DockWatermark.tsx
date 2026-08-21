// Watermark dockview renders whenever a dock has no panels to display (the
// `noPanelsOverlay` default). Without it, closing every panel leaves a blank
// surface with no visible way back - this points the user at the View menu,
// which reopens both global and repo panels. Shared by RepoDock and
// GlobalDock so the wording cannot drift.

export function DockWatermark() {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1em",
      }}
    >
      <span
        className="legit-subtle"
        style={{ fontSize: "var(--fz-md)", textAlign: "center" }}
      >
        All panels are closed - reopen them from the <strong>View</strong> menu
        in the top-right corner.
      </span>
    </div>
  );
}

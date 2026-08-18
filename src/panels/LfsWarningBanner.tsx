import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRepoStore } from "../store/repos";
import { useLfsWarningStore } from "../store/lfsWarning";
import { repoLfsStatus } from "../lib/commands";
import type { LfsStatus } from "../lib/types";
import {
  lfsWarningKind,
  lfsWarningMessage,
  shouldShowLfsWarning,
} from "../lib/lfsWarning";
import { ToolbarButton } from "./shared/ToolbarButton";

// Ghost buttons sit on banner-warning-bg, not a panel surface, so their
// text and border must follow the banner's own foreground token (same
// rationale as OpStateStrip's BANNER_BUTTON_STYLE).
const BANNER_BUTTON_STYLE: React.CSSProperties = {
  color: "var(--banner-warning-fg)",
  borderColor: "var(--banner-warning-fg)",
};

/**
 * App-chrome warning below the repo tabs: the active repo declares Git LFS
 * (`filter=lfs` in tracked .gitattributes) but git-lfs is missing or not
 * set up, so checkouts leave pointer stubs and commits can store real
 * content in place of pointers. Dismiss hides for the session; "Don't warn
 * for this repo" persists (re-arm in Repo Settings). Auto-hides once a
 * re-check finds the condition resolved. Renders nothing otherwise.
 */
export function LfsWarningBanner() {
  const activeRepoId = useRepoStore((s) => s.activeRepoId);
  const suppressSetting = useRepoStore((s) =>
    activeRepoId ? s.repoSettings[activeRepoId]?.suppress_lfs_warning : null,
  );
  const updateRepoSetting = useRepoStore((s) => s.updateRepoSetting);
  const sessionDismissed = useLfsWarningStore((s) =>
    activeRepoId ? !!s.dismissed[activeRepoId] : false,
  );
  const dismiss = useLfsWarningStore((s) => s.dismiss);
  const queryClient = useQueryClient();

  // Rare-change data (.gitattributes edits, LFS installs): long staleTime,
  // deliberately not watcher-invalidated - Re-check and repo activation
  // cover the gaps. Key shared with the Files panel's probe.
  const { data: status } = useQuery<LfsStatus>({
    queryKey: [activeRepoId, "lfs"],
    queryFn: () => repoLfsStatus(activeRepoId!),
    enabled: !!activeRepoId,
    staleTime: 300_000,
  });

  if (
    !activeRepoId ||
    !shouldShowLfsWarning(status, sessionDismissed, suppressSetting)
  ) {
    return null;
  }
  const kind = lfsWarningKind(status);
  if (!kind) return null;

  return (
    <div
      data-testid="lfs-warning-banner"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        background: "var(--banner-warning-bg)",
        color: "var(--banner-warning-fg)",
        fontSize: "var(--fz-sm)",
        // Hairline: separates the banner stack from the repo region (and
        // from OpStateStrip above when both are visible, via its own
        // borderBottom).
        borderBottom: "1px solid var(--panel-border)",
      }}
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {lfsWarningMessage(kind)}
      </span>
      <span style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
        <ToolbarButton
          label="Re-check"
          title="Probe git-lfs again"
          onClick={() =>
            queryClient.invalidateQueries({ queryKey: [activeRepoId, "lfs"] })
          }
          style={BANNER_BUTTON_STYLE}
        />
        <ToolbarButton
          label="Don't warn for this repo"
          title="Never warn for this repository (re-arm in Repo Settings)"
          onClick={() =>
            void updateRepoSetting(activeRepoId, "suppress_lfs_warning", true)
          }
          style={BANNER_BUTTON_STYLE}
        />
        <ToolbarButton
          label="Dismiss"
          title="Hide until the next app launch"
          onClick={() => dismiss(activeRepoId)}
          style={BANNER_BUTTON_STYLE}
        />
      </span>
    </div>
  );
}

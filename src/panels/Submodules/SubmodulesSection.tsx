import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import { repoSubmodules } from "../../lib/commands";
import { submoduleBadge } from "../../lib/submodules";
import type { SubmoduleInfo } from "../../lib/types";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";

/**
 * Submodules section - read-only tier-1 view (spec 2026-07-08): one row per
 * submodule with path, branch or "(detached)", and a state badge. Rendered
 * as a pane inside the combined Refs panel, which supplies the header.
 * Operations (init/update/open-as-tab) arrive with tier 2.
 */
export function SubmodulesSection() {
  const repo = useActiveRepo();
  const { data: subs = [], isFetching, refetch } = useQuery<SubmoduleInfo[]>({
    queryKey: [repo?.id, "submodules"],
    queryFn: () => repoSubmodules(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });
  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);

  if (!repo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">No repository open.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div
        className="legit-panel__body"
        style={{ display: "flex", flexDirection: "column", gap: 6 }}
      >
        {subs.length === 0 ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No submodules.
          </span>
        ) : (
          subs.map((s) => <SubmoduleRow key={s.name} info={s} />)
        )}
      </div>
    </div>
  );
}

function SubmoduleRow({ info }: { info: SubmoduleInfo }) {
  const badge = submoduleBadge(info);
  const sha = info.checked_out_sha ?? info.recorded_sha;
  return (
    <div
      style={{
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        padding: "6px 10px",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
      title={info.url ?? info.gitmodules_url ?? undefined}
    >
      <span
        style={{
          fontSize: "var(--fz-md)",
          fontFamily: "monospace",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={info.path}
      >
        {info.path}
      </span>
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
        {info.state.populated ? info.head_branch ?? "(detached)" : ""}
      </span>
      {badge && (
        <span
          style={{
            fontSize: "var(--fz-sm)",
            color: badge.color,
            border: "1px solid currentColor",
            borderRadius: "0.75em",
            padding: "0 0.5em",
            flexShrink: 0,
          }}
        >
          {badge.label}
        </span>
      )}
      {sha && (
        <span
          className="legit-subtle"
          style={{
            fontSize: "var(--fz-sm)",
            fontFamily: "monospace",
            marginLeft: "auto",
            flexShrink: 0,
          }}
          title={sha}
        >
          {sha.slice(0, 8)}
        </span>
      )}
    </div>
  );
}

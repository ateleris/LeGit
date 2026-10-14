import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveRepo, useRepoStore } from "../../store/repos";
import { useSummonTarget } from "../../store/summon";
import type { SettingsJumpRequest } from "../../lib/types";
import { GitConfigPill } from "./primitives";
import { SettingsShell, type SettingsGroupDef } from "./SettingsShell";
import { REPO_SETTINGS_GROUPS, type RepoSettingsCtx } from "./repoSettingsManifest";

/**
 * Repo Settings panel — edits repo-scope settings for the active repo.
 * Scope and scope target are explicit per DESIGN-v0.2.md §F.6.
 */
export function RepoSettingsPanel() {
  const activeRepo = useActiveRepo();
  const repoSettings = useRepoStore((s) =>
    activeRepo ? s.repoSettings[activeRepo.id] : null
  );
  const loadRepoSettings = useRepoStore((s) => s.loadRepoSettings);

  useEffect(() => {
    if (activeRepo && !repoSettings) {
      loadRepoSettings(activeRepo.id);
    }
  }, [activeRepo?.id, repoSettings, loadRepoSettings]);

  // Scroll-to-group requests arriving via summon (e.g. the commit composer's
  // identity line targets the Git group).
  const [jump, setJump] = useState<{ group: string; nonce: number } | null>(null);
  useSummonTarget<SettingsJumpRequest>(
    "repo-settings",
    useCallback((payload) => {
      if (payload && typeof payload.group === "string") {
        setJump((prev) => ({ group: payload.group, nonce: (prev?.nonce ?? 0) + 1 }));
      }
    }, []),
  );

  // Bind the manifest's renders to the active repo. Referentially stable per
  // repo/settings so the shell doesn't re-filter on unrelated renders.
  const groups = useMemo<SettingsGroupDef[]>(() => {
    if (!activeRepo) return [];
    const ctx: RepoSettingsCtx = { repo: activeRepo, repoSettings: repoSettings ?? null };
    return REPO_SETTINGS_GROUPS.map((group) => ({
      ...group,
      sections: group.sections.map((section) => ({
        ...section,
        render: () => section.render(ctx),
      })),
    }));
  }, [activeRepo, repoSettings]);

  if (!activeRepo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__toolbar">
          <strong>Repo Settings</strong>
        </div>
        <div className="legit-panel__body">
          <span className="legit-subtle">No repository open.</span>
        </div>
      </div>
    );
  }

  return (
    // Keyed by repo: switching repos remounts the sections, so drafts typed
    // for one repository can never be committed into another.
    <SettingsShell
      key={activeRepo.id}
      groups={groups}
      jump={jump}
      toolbarLead={
        <>
          <strong style={{ whiteSpace: "nowrap" }}>Repo Settings — {activeRepo.name}</strong>
          <span
            className="legit-subtle"
            title={activeRepo.path}
            style={{ fontSize: "var(--fz-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "18em" }}
          >
            {activeRepo.path}
          </span>
        </>
      }
      legend={
        <>
          <GitConfigPill /> items change this repo's Git configuration.
        </>
      }
    />
  );
}

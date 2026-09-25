// Declares every Repo Settings group and section for the settings shell,
// mirroring the global taxonomy so a setting sits under the same category in
// both panels. Renders take the active-repo context; the panel binds it.

import type { ReactNode } from "react";
import type { RepoSettings, RepoSummary } from "../../lib/types";
import type { SearchableGroup, SearchableSection } from "./settingsSearch";
import { supportsRepoGitOverride } from "../../lib/locator";
import { RepoIdentitySection } from "./RepoIdentitySection";
import {
  AutoPushTagsRepoSection,
  CommitTreeRepoSection,
  ExternalEditorRepoSection,
  LfsWarningRepoSection,
  LineEndingChangesRepoSection,
  LineEndingsRepoSection,
  RemoteRepoGitSection,
  RepoGitExecutableSection,
  SubmoduleAutoUpdateSection,
} from "./RepoSections";

export interface RepoSettingsCtx {
  repo: RepoSummary;
  repoSettings: RepoSettings | null;
}

export interface RepoSectionDef extends SearchableSection {
  render: (ctx: RepoSettingsCtx) => ReactNode;
}

export type RepoGroupDef = SearchableGroup<RepoSectionDef>;

export const REPO_SETTINGS_GROUPS: readonly RepoGroupDef[] = [
  {
    id: "repo-appearance",
    title: "Appearance",
    caption: "In this repo",
    sections: [
      {
        id: "repo-commit-tree",
        title: "Commit tree",
        keywords: ["remote branches", "graph", "tree"],
        render: ({ repo, repoSettings }) => (
          <CommitTreeRepoSection repoId={repo.id} repoSettings={repoSettings} />
        ),
      },
    ],
  },
  {
    id: "repo-remotes-sync",
    title: "Remotes & sync",
    sections: [
      {
        id: "repo-auto-push-tags",
        title: "Auto-push tags",
        keywords: ["push", "tags", "release", "inherit"],
        render: ({ repo, repoSettings }) => (
          <AutoPushTagsRepoSection repoId={repo.id} repoSettings={repoSettings} />
        ),
      },
    ],
  },
  {
    id: "repo-submodules",
    title: "Submodules",
    sections: [
      {
        id: "repo-submodule-auto-update",
        title: "Submodules",
        keywords: ["auto-update", "switch", "pull"],
        render: ({ repo, repoSettings }) => (
          <SubmoduleAutoUpdateSection repoId={repo.id} repoSettings={repoSettings} />
        ),
      },
    ],
  },
  {
    id: "repo-working-tree",
    title: "Working tree",
    sections: [
      {
        id: "repo-line-ending-changes",
        title: "Line ending changes",
        keywords: ["eol", "crlf", "chips", "warn", "inherit"],
        render: ({ repo, repoSettings }) => (
          <LineEndingChangesRepoSection repoId={repo.id} repoSettings={repoSettings} />
        ),
      },
    ],
  },
  {
    id: "repo-application",
    title: "Application",
    caption: "How LeGit acts in this repo",
    sections: [
      {
        id: "repo-external-editor",
        title: "External editor",
        keywords: ["editor", "command", "override"],
        render: ({ repo, repoSettings }) => (
          <ExternalEditorRepoSection repoId={repo.id} repoSettings={repoSettings} />
        ),
      },
    ],
  },
  {
    id: "repo-git",
    title: "Git",
    caption: "Integration & configuration",
    sections: [
      {
        id: "repo-git-executable",
        title: "Git executable",
        keywords: ["binary", "path", "override", "wsl"],
        render: ({ repo, repoSettings }) =>
          repo.host && !supportsRepoGitOverride(repo.host) ? (
            <RemoteRepoGitSection distro={repo.host.distro} />
          ) : (
            <RepoGitExecutableSection repoId={repo.id} repoSettings={repoSettings} />
          ),
      },
      {
        id: "repo-identity",
        title: "Identity & signing",
        keywords: ["user.name", "user.email", "gpg", "ssh", "signing", "profile"],
        render: ({ repo }) => <RepoIdentitySection repoId={repo.id} repoName={repo.name} />,
      },
      {
        id: "repo-line-endings",
        title: "Line endings",
        keywords: ["autocrlf", "eol", "crlf", "gitattributes", "normalize"],
        render: ({ repo }) => <LineEndingsRepoSection repoId={repo.id} />,
      },
      {
        id: "repo-lfs",
        title: "Git LFS",
        keywords: ["lfs", "large files", "track", "patterns"],
        render: ({ repo, repoSettings }) => (
          <LfsWarningRepoSection repoId={repo.id} repoSettings={repoSettings} />
        ),
      },
    ],
  },
];

// Declares every Global Settings group and section for the settings shell:
// the taxonomy, the nav labels, and the search keywords live here in one
// place. Section headings are still rendered by the section components; the
// titles here are what the nav and the search filter match against.

import type { SettingsGroupDef } from "./SettingsShell";
import { GeneralSection } from "./GeneralSection";
import { CommitsGraphSection } from "./CommitsGraphSection";
import { DiffViewerSection, WorkingChangesLayoutSection } from "./AppearanceSections";
import {
  AutoFetchSection,
  AutoOpenPanelsSection,
  AutoPushTagsSection,
  AutoRefreshSection,
  BranchCreationSection,
  BranchSwitchingSection,
  CheckoutRemoteFastForwardSection,
  ConfirmDiscardSection,
  DetectCaseRenamesSection,
  ExternalEditorSection,
  LineEndingChangesSection,
  PushGuardSection,
  SubmoduleAttachSection,
} from "./BehaviorSections";
import { GitExecutableSection } from "./GitExecutableSection";
import { ConnectedAccountsSection } from "./ConnectedAccountsSection";
import { GlobalGitConfigSection } from "./GlobalGitConfigSection";
import { LineEndingsGlobalSection } from "./LineEndingsGlobalSection";
import { GlobalProfilesSection } from "./GlobalProfilesSection";
import { localGitConfigScope } from "./gitConfigHost";
import {
  WslConfigSection,
  WslConnectionSection,
  WslEolSection,
  WslGitExecutableSection,
} from "./WslGitGroup";
import { AboutSection } from "./AboutSection";

export function buildGlobalSettingsGroups(hasWsl: boolean): SettingsGroupDef[] {
  const groups: SettingsGroupDef[] = [
    {
      id: "appearance",
      title: "Appearance",
      caption: "How LeGit looks",
      sections: [
        {
          id: "general",
          title: "General",
          keywords: ["font", "size", "zoom", "layout", "orientation", "spacing", "corner", "radius", "border"],
          render: () => <GeneralSection />,
        },
        {
          id: "commits-graph",
          title: "Commits graph",
          keywords: ["lane", "row", "date", "avatar", "graph", "chips", "tree"],
          render: () => <CommitsGraphSection />,
        },
        {
          id: "diff-viewer",
          title: "Diff viewer",
          keywords: ["syntax", "highlight", "colour", "color"],
          render: () => <DiffViewerSection />,
        },
        {
          id: "working-changes-layout",
          title: "Working Changes layout",
          keywords: ["staged", "unstaged", "order", "commit box"],
          render: () => <WorkingChangesLayoutSection />,
        },
      ],
    },
    {
      id: "branches",
      title: "Branches",
      sections: [
        {
          id: "branch-creation",
          title: "Branch creation",
          keywords: ["checkout", "create"],
          render: () => <BranchCreationSection />,
        },
        {
          id: "branch-switching",
          title: "Branch switching",
          keywords: ["stash", "dirty", "switch", "checkout"],
          render: () => <BranchSwitchingSection />,
        },
        {
          id: "remote-branch-checkout",
          title: "Remote branch checkout",
          keywords: ["fast-forward", "checkout"],
          render: () => <CheckoutRemoteFastForwardSection />,
        },
      ],
    },
    {
      id: "remotes-sync",
      title: "Remotes & sync",
      sections: [
        {
          id: "auto-fetch",
          title: "Background auto-fetch",
          keywords: ["fetch", "interval", "periodic"],
          render: () => <AutoFetchSection />,
        },
        {
          id: "auto-push-tags",
          title: "Auto-push tags",
          keywords: ["push", "tags", "release"],
          render: () => <AutoPushTagsSection />,
        },
      ],
    },
    {
      id: "submodules",
      title: "Submodules",
      sections: [
        {
          id: "submodule-push-guard",
          title: "Submodule push guard",
          keywords: ["push", "recurse", "check"],
          render: () => <PushGuardSection />,
        },
        {
          id: "submodule-attach",
          title: "Submodule branch attach",
          keywords: ["detached", "head", "update"],
          render: () => <SubmoduleAttachSection />,
        },
      ],
    },
    {
      id: "working-tree",
      title: "Working tree",
      sections: [
        {
          id: "line-ending-changes",
          title: "Line ending changes",
          keywords: ["eol", "crlf", "chips", "warn", "commit"],
          render: () => <LineEndingChangesSection />,
        },
        {
          id: "case-renames",
          title: "Case-only renames",
          keywords: ["rename", "case", "windows", "stage"],
          render: () => <DetectCaseRenamesSection />,
        },
      ],
    },
    {
      id: "application",
      title: "Application",
      caption: "How LeGit acts",
      sections: [
        {
          id: "auto-open-panels",
          title: "Auto-open panels",
          keywords: ["summon", "detail", "focus", "panel"],
          render: () => <AutoOpenPanelsSection />,
        },
        {
          id: "auto-refresh",
          title: "Auto-refresh",
          keywords: ["watcher", "filesystem", "refresh"],
          render: () => <AutoRefreshSection />,
        },
        {
          id: "confirm-discard",
          title: "Destructive action confirmation",
          keywords: ["confirm", "discard", "delete", "prompt"],
          render: () => <ConfirmDiscardSection />,
        },
        {
          id: "external-editor",
          title: "External editor",
          keywords: ["editor", "command", "open in editor"],
          render: () => <ExternalEditorSection />,
        },
      ],
    },
    {
      id: "git",
      title: "Git",
      caption: "Integration & configuration",
      sections: [
        {
          id: "git-executable",
          title: "Git executable",
          keywords: ["binary", "path", "version"],
          render: () => <GitExecutableSection />,
        },
        {
          id: "connected-accounts",
          title: "Connected accounts",
          keywords: ["account", "auth", "credentials", "sign in"],
          render: () => <ConnectedAccountsSection />,
        },
        {
          id: "git-config",
          title: "Identity, signing & credentials",
          keywords: ["gpg", "ssh", "signing", "user.name", "user.email", "credential", "helper"],
          render: () => <GlobalGitConfigSection scope={localGitConfigScope} />,
        },
        {
          id: "line-endings-global",
          title: "Line endings",
          keywords: ["autocrlf", "eol", "crlf"],
          render: () => <LineEndingsGlobalSection scope={localGitConfigScope} />,
        },
        {
          id: "profiles",
          title: "Git identity profiles",
          keywords: ["profile", "identity", "ssh key", "email"],
          render: () => <GlobalProfilesSection />,
        },
      ],
    },
  ];

  if (hasWsl) {
    groups.push({
      id: "git-wsl",
      title: "Git (WSL)",
      caption: "Integration & configuration",
      sections: [
        {
          id: "wsl-connection",
          title: "Distribution",
          keywords: ["wsl", "distro", "connect"],
          render: () => <WslConnectionSection />,
        },
        {
          id: "wsl-git-executable",
          title: "Git executable (WSL)",
          keywords: ["binary", "path", "version"],
          render: () => <WslGitExecutableSection />,
        },
        {
          id: "wsl-git-config",
          title: "Identity, signing & credentials (WSL)",
          keywords: ["gpg", "ssh", "signing", "credential", "helper"],
          render: () => <WslConfigSection />,
        },
        {
          id: "wsl-line-endings",
          title: "Line endings (WSL)",
          keywords: ["autocrlf", "eol", "crlf"],
          render: () => <WslEolSection />,
        },
      ],
    });
  }

  groups.push({
    id: "about",
    title: "About",
    sections: [
      {
        id: "about",
        title: "About",
        keywords: ["version", "changelog", "release", "license"],
        render: () => <AboutSection />,
      },
    ],
  });

  return groups;
}

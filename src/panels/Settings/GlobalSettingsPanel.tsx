import { GlobalProfilesSection } from "./GlobalProfilesSection";
import { GlobalGitConfigSection } from "./GlobalGitConfigSection";
import { GitExecutableSection } from "./GitExecutableSection";
import { LineEndingsGlobalSection } from "./LineEndingsGlobalSection";
import { WslGitGroup } from "./WslGitGroup";
import { localGitConfigScope } from "./gitConfigHost";
import { ConnectedAccountsSection } from "./ConnectedAccountsSection";
import { SettingsGroup, GitConfigPill } from "./primitives";
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
import { AboutSection } from "./AboutSection";

/** Global Settings panel — edits global-scope settings (DESIGN-v0.2.md §F.6). */
export function GlobalSettingsPanel() {
  return (
    <div className="legit-panel">
      <div className="legit-panel__body">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.5em 1.167em",
            alignItems: "center",
            fontSize: "var(--fz-sm)",
            color: "var(--subtle-fg)",
            marginBottom: "1.5em",
          }}
        >
          <span>Most settings apply instantly.</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5em" }}>
            <GitConfigPill /> items change your Git configuration.
          </span>
        </div>

        <SettingsGroup id="appearance" title="Appearance" caption="How LeGit looks">
          <GeneralSection />
          <CommitsGraphSection />
          <DiffViewerSection />
          <WorkingChangesLayoutSection />
        </SettingsGroup>

        <SettingsGroup id="behavior" title="Behavior" caption="How LeGit acts">
          <AutoOpenPanelsSection />
          <ConfirmDiscardSection />
          <BranchCreationSection />
          <BranchSwitchingSection />
          <CheckoutRemoteFastForwardSection />
          <PushGuardSection />
          <AutoPushTagsSection />
          <SubmoduleAttachSection />
          <AutoRefreshSection />
          <AutoFetchSection />
          <ExternalEditorSection />
          <LineEndingChangesSection />
          <DetectCaseRenamesSection />
        </SettingsGroup>

        <SettingsGroup id="git" title="Git" caption="Integration & configuration">
          <GitExecutableSection />
          <ConnectedAccountsSection />
          <GlobalGitConfigSection scope={localGitConfigScope} />
          <LineEndingsGlobalSection scope={localGitConfigScope} />
          <GlobalProfilesSection />
        </SettingsGroup>

        {/* Owns its own SettingsGroup: renders nothing at all when the machine
            has no WSL distributions. */}
        <WslGitGroup />

        <SettingsGroup id="about" title="About">
          <AboutSection />
        </SettingsGroup>
      </div>
    </div>
  );
}

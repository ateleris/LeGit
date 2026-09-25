import { useMemo } from "react";
import { GitConfigPill } from "./primitives";
import { SettingsShell } from "./SettingsShell";
import { buildGlobalSettingsGroups } from "./globalSettingsManifest";
import { useWslDistros } from "./WslGitGroup";
import { WslHostProvider } from "./WslHostContext";

/** Global Settings panel — edits global-scope settings (DESIGN-v0.2.md §F.6). */
export function GlobalSettingsPanel() {
  const distros = useWslDistros();
  const groups = useMemo(() => buildGlobalSettingsGroups(distros.length > 0), [distros]);

  const shell = (
    <SettingsShell
      groups={groups}
      legend={
        <>
          <GitConfigPill /> items change your Git configuration.
        </>
      }
    />
  );

  // The provider sits OUTSIDE the shell: sections unmount when a search
  // filters them away, and the WSL "already connected" memory must not be
  // lost there — otherwise every re-mount would restart the distro.
  return distros.length > 0 ? <WslHostProvider distros={distros}>{shell}</WslHostProvider> : shell;
}

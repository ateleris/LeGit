// The host seam for the git-configuration forms.
//
// Global Settings has two completely separate git surfaces: the app machine's
// configuration ("Git") and, per WSL distribution, that distro's own
// ("Git (WSL)"). Both are rendered by the SAME form components — everything
// that differs between them lives in a `GitConfigScope`, so the forms cannot
// drift apart, and everything that must NOT be shared (which commands run,
// which affordances exist) is decided here, once.
//
// The command tables are two flat name maps with identical key sets: a WSL
// form can only ever reach a `wsl_*` command, and that is pinned by a test
// (`gitConfigHost.test.ts`) rather than by review. The maps live in
// lib/commands.ts, where the wrapper functions below are defined FROM them —
// so the tested names and the invoked names cannot diverge.

import type { ReactNode } from "react";
import {
  GLOBAL_GIT_CONFIG_COMMANDS,
  WSL_GIT_CONFIG_COMMANDS,
  globalCredentialHelperView,
  globalIdentityView,
  globalLineEndingsView,
  globalSigningConfig,
  globalWriteCredentialHelper,
  globalWriteIdentity,
  globalWriteLineEndings,
  globalWriteSigning,
  listAvailableCredentialHelpers,
  wslAvailableCredentialHelpers,
  wslCredentialHelperView,
  wslIdentityView,
  wslLineEndingsView,
  wslSigningConfig,
  wslWriteCredentialHelper,
  wslWriteIdentity,
  wslWriteLineEndings,
  wslWriteSigning,
} from "../../lib/commands";
import type {
  AvailableHelper,
  CredentialHelperView,
  HostRef,
  IdentityView,
  LineEndingsView,
  SigningView,
} from "../../lib/types";

/** The host-specific half of the git-config commands. */
export interface GitConfigHostApi {
  identityView(): Promise<IdentityView>;
  writeIdentity(name: string | null, email: string | null): Promise<IdentityView>;
  signingConfig(): Promise<SigningView>;
  writeSigning(
    gpgsign: string | null,
    format: string | null,
    signingKey: string | null,
    allowedSigners: string | null
  ): Promise<SigningView>;
  credentialHelperView(): Promise<CredentialHelperView>;
  writeCredentialHelper(helper: string | null): Promise<CredentialHelperView>;
  availableHelpers(): Promise<AvailableHelper[]>;
  lineEndingsView(): Promise<LineEndingsView>;
  writeLineEndings(autocrlf: string | null, eol: string | null): Promise<LineEndingsView>;
}

/** Everything the shared forms must vary by host. */
export interface GitConfigScope {
  /** `null` for the app machine. */
  host: HostRef | null;
  /**
   * Stable id: the radio-group `name=` prefix, localStorage section keys, and
   * the `usePanelDirty` form key. Two forms sharing it would share their
   * radio groups (one selection clearing the other) — hence the test.
   */
  id: string;
  /** Appended to section titles: "(global)" / "(Ubuntu)". */
  titleSuffix: string;
  /** Named in `writes to:` notes and save confirmations. */
  configFileLabel: string;
  /** Where the config applies, as a sentence fragment: "on this machine". */
  hostWhere: string;
  /** The "these changes affect …" paragraph of the save confirmation. */
  confirmBlurb: ReactNode;
  /** The app machine's `~/.ssh` tools — local only (distro keys: BACKLOG). */
  showSshKeys: boolean;
  /** `openDialog` browses the WINDOWS filesystem — local only. */
  showBrowse: boolean;
  /** Extra note under the credential-helper field. */
  credentialHelperNote?: ReactNode;
  api: GitConfigHostApi;
}

/** Exported for the contract test only. */
export const GIT_CONFIG_COMMANDS = {
  local: GLOBAL_GIT_CONFIG_COMMANDS,
  wsl: WSL_GIT_CONFIG_COMMANDS,
};

/** The app machine's api: the `global_*` wrappers, verbatim. */
const LOCAL_API: GitConfigHostApi = {
  identityView: globalIdentityView,
  writeIdentity: globalWriteIdentity,
  signingConfig: globalSigningConfig,
  writeSigning: globalWriteSigning,
  credentialHelperView: globalCredentialHelperView,
  writeCredentialHelper: globalWriteCredentialHelper,
  availableHelpers: listAvailableCredentialHelpers,
  lineEndingsView: globalLineEndingsView,
  writeLineEndings: globalWriteLineEndings,
};

/** A distribution's api: the `wsl_*` wrappers with the distro bound. */
function wslApi(distro: string): GitConfigHostApi {
  return {
    identityView: () => wslIdentityView(distro),
    writeIdentity: (name, email) => wslWriteIdentity(distro, name, email),
    signingConfig: () => wslSigningConfig(distro),
    writeSigning: (gpgsign, format, signingKey, allowedSigners) =>
      wslWriteSigning(distro, gpgsign, format, signingKey, allowedSigners),
    credentialHelperView: () => wslCredentialHelperView(distro),
    writeCredentialHelper: (helper) => wslWriteCredentialHelper(distro, helper),
    availableHelpers: () => wslAvailableCredentialHelpers(distro),
    lineEndingsView: () => wslLineEndingsView(distro),
    writeLineEndings: (autocrlf, eol) => wslWriteLineEndings(distro, autocrlf, eol),
  };
}

export const localGitConfigScope: GitConfigScope = {
  host: null,
  id: "global",
  titleSuffix: "(global)",
  configFileLabel: "~/.gitconfig",
  hostWhere: "on this machine",
  confirmBlurb: (
    <>
      These changes affect every repository on this machine that doesn&apos;t override them (in
      LeGit: by applying a profile in Repo Settings), and every tool that reads your global Git
      config. Repositories inside WSL are not affected — they have their own configuration under
      Git (WSL).
    </>
  ),
  showSshKeys: true,
  showBrowse: true,
  api: LOCAL_API,
};

/**
 * A WSL distribution's scope. `configFileLabel` deliberately does not promise
 * `~/.gitconfig`: the distro's login shell decides, and git writes to
 * `$XDG_CONFIG_HOME/git/config` when that exists.
 */
export function wslGitConfigScope(distro: string): GitConfigScope {
  return {
    host: { kind: "wsl", distro },
    id: `wsl-${distro}`,
    titleSuffix: `(${distro})`,
    configFileLabel: `${distro}'s global Git config`,
    hostWhere: `in ${distro}`,
    confirmBlurb: (
      <>
        These changes affect every repository inside <strong>{distro}</strong> that doesn&apos;t
        override them, and every tool that reads Git&apos;s config in that distribution — including
        git in the WSL terminal. Repositories on this machine are not affected.
      </>
    ),
    showSshKeys: false,
    showBrowse: false,
    credentialHelperNote: (
      <>
        LeGit always adds its own helper to the git commands it runs in {distro}, so HTTPS prompts
        and saved credentials keep working without a helper here. Helpers accumulate: one set here
        is tried <em>before</em> LeGit&apos;s. It must name a helper installed inside the
        distribution.
      </>
    ),
    api: wslApi(distro),
  };
}

import type { ConfigScope } from "../../lib/types";

/**
 * Warning for a set-but-EMPTY `gpg.ssh.program`: it overrides git's bundled
 * ssh-keygen fallback with "", so every signed commit fails with
 * "cannot spawn : No such file or directory". `fixable` = the entry lives in
 * global config, where saving the signing form removes it; a system-scope
 * entry can only be fixed outside LeGit.
 */
export function sshProgramWarning(
  broken: ConfigScope | null
): { text: string; fixable: boolean } | null {
  if (broken === "global") {
    return {
      text:
        "gpg.ssh.program is set to an empty value in the global git config - " +
        'every signed commit fails with "cannot spawn".',
      fixable: true,
    };
  }
  if (broken === "system") {
    return {
      text:
        "gpg.ssh.program is set to an empty value in the system git config - " +
        'every signed commit fails with "cannot spawn". LeGit cannot edit ' +
        "system config; remove the entry there.",
      fixable: false,
    };
  }
  return null;
}

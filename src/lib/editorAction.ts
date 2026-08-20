import { useSettingsStore } from "../store/settings";
import { useRepoStore } from "../store/repos";

/** The program token of an editor command template (first word, or the first
 * double-quoted string so quoted paths with spaces read whole). */
export function templateProgram(template: string): string {
  const t = template.trim();
  if (!t) return "";
  if (t.startsWith('"')) {
    const end = t.indexOf('"', 1);
    return end > 1 ? t.slice(1, end) : t.slice(1);
  }
  return t.split(/\s+/)[0] ?? "";
}

/** Label for the "open in editor" action given the effective template. */
export function editorActionLabel(template: string | null | undefined): string {
  const program = templateProgram(template ?? "");
  return program ? `Open in ${program}` : "Open folder (no editor configured)";
}

/** Label for the FILE-row variant of the action (`repoOpenFileInEditor`):
 * its no-editor fallback reveals the file in the OS file manager, so the
 * fallback wording differs from the repo action's "Open folder". */
export function editorFileActionLabel(template: string | null | undefined): string {
  const program = templateProgram(template ?? "");
  return program ? `Open in ${program}` : "Reveal in file manager (no editor configured)";
}

/** True when the action will open the repo FOLDER (no editor configured) -
 * the icon must follow the same rule as the label's folder wording. */
export function editorOpensFolder(template: string | null | undefined): boolean {
  return templateProgram(template ?? "") === "";
}

/** The template the action will use: repo override when non-blank, else the
 * global one — mirrors the backend's resolution. */
export function effectiveEditorTemplate(
  repoTemplate: string | null | undefined,
  globalTemplate: string | null | undefined,
): string {
  if (repoTemplate && repoTemplate.trim() !== "") return repoTemplate;
  return globalTemplate ?? "";
}

/**
 * Tooltip/label and icon choice for the "open in editor" action of a repo:
 * the repo-scope override wins over the global template (Global Settings →
 * Behavior → External editor). Repo settings load lazily; until they have
 * been loaded, label AND icon fall back to the global template together (so
 * they can never disagree) — the action itself always resolves the override
 * on the backend.
 */
export function useEditorAction(
  repoId?: string,
): { label: string; fileLabel: string; opensFolder: boolean } {
  const globalTemplate = useSettingsStore((s) => s.settings?.external_editor_command ?? "");
  const repoTemplate = useRepoStore((s) =>
    repoId ? s.repoSettings[repoId]?.external_editor_command : null,
  );
  const template = effectiveEditorTemplate(repoTemplate, globalTemplate);
  return {
    label: editorActionLabel(template),
    fileLabel: editorFileActionLabel(template),
    opensFolder: editorOpensFolder(template),
  };
}

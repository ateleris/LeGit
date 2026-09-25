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

/** Label for the repo-level "open in editor" action. Empty when no editor is
 * configured: the repo-level buttons/entries are HIDDEN then (the dedicated
 * open-folder action stands on its own). */
export function editorActionLabel(template: string | null | undefined): string {
  const program = templateProgram(template ?? "");
  return program ? `Open in ${program}` : "";
}

/** True when an editor program is configured; the repo-level editor
 * button/entries render only then. */
export function editorConfigured(template: string | null | undefined): boolean {
  return templateProgram(template ?? "") !== "";
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
): { label: string; configured: boolean } {
  const globalTemplate = useSettingsStore((s) => s.settings?.external_editor_command ?? "");
  const repoTemplate = useRepoStore((s) =>
    repoId ? s.repoSettings[repoId]?.external_editor_command : null,
  );
  const template = effectiveEditorTemplate(repoTemplate, globalTemplate);
  return {
    label: editorActionLabel(template),
    configured: editorConfigured(template),
  };
}

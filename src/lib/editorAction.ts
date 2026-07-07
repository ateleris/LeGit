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
 * Tooltip/label for the "open in editor" action of a repo: the repo-scope
 * override wins over the global template (Global Settings → Behavior →
 * External editor). Repo settings load lazily; until they have been loaded
 * the label falls back to the global template — the action itself always
 * resolves the override on the backend.
 */
export function useEditorActionLabel(repoId?: string): string {
  const globalTemplate = useSettingsStore((s) => s.settings?.external_editor_command ?? "");
  const repoTemplate = useRepoStore((s) =>
    repoId ? s.repoSettings[repoId]?.external_editor_command : null,
  );
  return editorActionLabel(effectiveEditorTemplate(repoTemplate, globalTemplate));
}

import { confirmDestructiveAction } from "../../store/confirm";

/** Gate an action that would drop unsaved in-editor edits: resolves true at
 *  once when the editor is pristine, otherwise asks through the central
 *  dialog (honouring the destructive-confirmation setting). Unsaved edits
 *  exist nowhere else, so dropping them is destructive even though no
 *  repository state changes. */
export function confirmDropUnsavedEdits(dirty: boolean, path: string): Promise<boolean> {
  if (!dirty) return Promise.resolve(true);
  return confirmDestructiveAction({
    title: "Unsaved edits",
    message: "Your unsaved edits in this file will be lost.",
    detail: path,
    confirmLabel: "Discard edits",
  });
}

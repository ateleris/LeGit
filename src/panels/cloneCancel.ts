import { confirmDialog } from "../store/confirm";
import { cloneTargetPath, useCloneStore } from "../store/clone";
import type { CloneJob } from "../store/clone";

/**
 * Cancel a running clone from the UI (the "Cloning" tab's close button, the
 * progress view's button). Cancelling removes the partial files, so it goes
 * through the central confirm dialog — gated, like every destructive
 * confirmation, by the global "confirm destructive actions" setting
 * (`confirm` = its current value). Shared so both surfaces ask identically.
 */
export async function cancelCloneWithConfirm(job: CloneJob, confirm: boolean): Promise<void> {
  if (job.cancelling) return;
  if (confirm) {
    const ok = await confirmDialog({
      title: "Cancel clone",
      message: `Stops cloning ${job.name} and removes the files downloaded so far.`,
      detail: `${job.url} → ${cloneTargetPath(job)}`,
      confirmLabel: "Cancel clone",
      cancelLabel: "Keep cloning",
    });
    if (!ok) return;
  }
  // The clone may have finished while the dialog was open: `cancel` is a
  // no-op for a settled job.
  useCloneStore.getState().cancel(job.opId);
}

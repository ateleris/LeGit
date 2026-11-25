// Stopping a running repository operation from the activity bar. The stop
// itself is one backend call; this module turns its outcome into what the
// user is told, and replaces the interrupted command's raw failure (git
// killed mid-run) with that message.

import { api } from "./commands";
import type { StopOutcome } from "./bindings";
import { useOpActivityStore } from "./opActivity";
import { notify } from "../store/notifications";

const OP_NOUN = {
  merge: "merge",
  rebase: "rebase",
  cherry_pick: "cherry-pick",
  revert: "revert",
} as const;

/** Rejection of a command the user stopped; its message is the whole story,
 * so the call site's usual error toast shows it as is. */
export class OperationStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationStoppedError";
  }
}

/** What the repository is left in after a stop, and what to do about it. */
export function stopMessage(outcome: StopOutcome): string {
  const state =
    outcome.op_state.kind === "none"
      ? "The operation was stopped before git recorded it. Files it had already changed may be left in Working Changes."
      : `Stopped. The ${OP_NOUN[outcome.op_state.kind]} is still in progress: continue it, or use Abort on the operation banner to return to where you started.`;
  return outcome.lock_removed ? `${state} A git lock file left behind by the interrupted process was removed.` : state;
}

const pending = new Map<string, Promise<StopOutcome>>();

/** Ask the backend to stop what is running on `repoId`. Safe to call twice:
 * a stop already under way is joined. */
export function requestStop(repoId: string): Promise<StopOutcome> {
  const running = pending.get(repoId);
  if (running) return running;
  useOpActivityStore.setState((s) => ({
    ops: s.ops.map((o) => (o.repoId === repoId ? { ...o, stopping: true } : o)),
  }));
  const stop = api.repoStopOperation(repoId);
  pending.set(repoId, stop);
  return stop;
}

/** Run a stoppable command. When it fails after the user asked to stop it,
 * the user gets a warning toast saying what state the repository is in and
 * the failure becomes an `OperationStoppedError` with the same text; any
 * other outcome passes through untouched. */
export async function settleStoppable<T>(repoId: string, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (e) {
    const stop = pending.get(repoId);
    if (!stop) throw e;
    let outcome: StopOutcome;
    try {
      outcome = await stop;
    } catch {
      throw e;
    }
    // Nothing was interrupted: the command failed on its own.
    if (outcome.stopped === 0) throw e;
    const message = stopMessage(outcome);
    notify.warning(message);
    throw new OperationStoppedError(message);
  } finally {
    pending.delete(repoId);
  }
}

// Auto-push tags with their commit (BACKLOG "Auto-push tags"): one rule at
// two trigger points - the invariant "a tag whose commit is public is
// public", maintained going forward only. After a push, exactly the tags
// whose target commit BECAME public through that push ride along; a tag
// created on an already-public commit is pushed immediately. Never a
// repo-wide sweep (tags predating the setting stay local), never a clobber
// of a same-named remote tag.

import type { QueryClient } from "@tanstack/react-query";
import type { GlobalSettings, PushOptions, RemoteTag, RepoSettings, TagInfo } from "./types";
import {
  repoListRemotes,
  repoPush,
  repoPushTag,
  repoRemoteTags,
  repoTags,
} from "./commands";
import { pickTagRemote } from "./tags";
import { invalidateRepoDomains } from "./repoInvalidation";
import { notify } from "../store/notifications";
import { useSettingsStore } from "../store/settings";
import { useRepoStore } from "../store/repos";

/** The effective setting: repo override when set, else global, else off. */
export function effectiveAutoPushTags(
  repoSettings: Pick<RepoSettings, "auto_push_tags"> | null | undefined,
  settings: Pick<GlobalSettings, "auto_push_tags"> | null | undefined,
): boolean {
  return repoSettings?.auto_push_tags ?? settings?.auto_push_tags ?? false;
}

/** Store-reading convenience for action handlers (non-reactive). */
export function autoPushTagsEnabled(repoId: string): boolean {
  return effectiveAutoPushTags(
    useRepoStore.getState().repoSettings[repoId],
    useSettingsStore.getState().settings,
  );
}

/**
 * Decide which tags to auto-push by diffing the tag list around the
 * operation: a candidate is a tag whose `target_on_remote` flipped to true
 * (or that is new since `before` - the create-time trigger passes the list
 * minus the created tag). Candidates already on the remote with the same
 * target are dropped silently; a same-named remote tag with a DIFFERENT
 * target is returned as `skipped` (warn, never force-push).
 */
export function resolveAutoPushTags(
  before: TagInfo[],
  after: TagInfo[],
  remoteTags: RemoteTag[],
): { push: string[]; skipped: string[] } {
  const publicBefore = new Set(
    before.filter((t) => t.target_on_remote).map((t) => t.name),
  );
  const remoteByName = new Map(remoteTags.map((t) => [t.name, t.target_sha]));

  const push: string[] = [];
  const skipped: string[] = [];
  for (const tag of after) {
    if (!tag.target_on_remote || publicBefore.has(tag.name)) continue;
    const remoteTarget = remoteByName.get(tag.name);
    if (remoteTarget === undefined) push.push(tag.name);
    else if (remoteTarget !== tag.target_sha) skipped.push(tag.name);
    // else: already on the remote with the same target - nothing to do.
  }
  return { push, skipped };
}

/**
 * Push the resolved tags to `remote` and surface the outcomes. Failure
 * isolation: this never throws - the primary operation (branch push / tag
 * creation) already succeeded, so problems here are their own toasts.
 */
async function runAutoPush(
  qc: QueryClient,
  repoId: string,
  remote: string,
  tagsBefore: TagInfo[],
): Promise<void> {
  const tagsAfter = await repoTags(repoId);
  const remoteTags = await repoRemoteTags(repoId, remote, crypto.randomUUID());
  const { push, skipped } = resolveAutoPushTags(tagsBefore, tagsAfter, remoteTags);

  for (const name of skipped) {
    notify.error(
      `Tag '${name}' exists on ${remote} with a different target — not auto-pushed.`,
    );
  }

  const pushed: string[] = [];
  for (const name of push) {
    try {
      await repoPushTag(repoId, remote, name, crypto.randomUUID());
      pushed.push(name);
    } catch (e) {
      notify.error(`Auto-push of tag '${name}' to ${remote} failed.`);
      console.warn(`auto-push tag '${name}' failed`, e);
    }
  }
  if (pushed.length > 0) {
    notify.success(
      pushed.length === 1
        ? `Auto-pushed tag '${pushed[0]}' to ${remote}`
        : `Auto-pushed ${pushed.length} tags to ${remote}`,
    );
    invalidateRepoDomains(qc, repoId, ["remote-tags", "tags"]);
  }
}

/**
 * Push-time trigger: `repoPush` plus the tag follow-up when the setting is
 * on. Drop-in for `repoPush` at every branch-push call site - the push's own
 * success/error handling is untouched (a follow-up failure never rejects).
 */
export async function pushWithTagFollowUp(
  qc: QueryClient,
  repoId: string,
  opts: PushOptions,
  opId: string,
): Promise<void> {
  const tagsBefore = autoPushTagsEnabled(repoId) ? await repoTags(repoId) : null;
  await repoPush(repoId, opts, opId);
  if (tagsBefore) {
    try {
      await runAutoPush(qc, repoId, opts.remote, tagsBefore);
    } catch (e) {
      console.warn("auto-push tags follow-up failed", e);
    }
  }
}

/**
 * Create-time trigger: after `name` was created, push it if its target is
 * already public. Targets the default tag remote (`pickTagRemote`), matching
 * the tag menu's push semantics. Fire-and-forget: never throws.
 */
export async function autoPushTagAfterCreate(
  qc: QueryClient,
  repoId: string,
  name: string,
): Promise<void> {
  if (!autoPushTagsEnabled(repoId)) return;
  try {
    const remote = pickTagRemote(await repoListRemotes(repoId));
    if (!remote) return;
    const tags = await repoTags(repoId);
    // `before` = the list minus the new tag: exactly it becomes the candidate.
    await runAutoPush(qc, repoId, remote, tags.filter((t) => t.name !== name));
  } catch (e) {
    console.warn("auto-push created tag failed", e);
  }
}

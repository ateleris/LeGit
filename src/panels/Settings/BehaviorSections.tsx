// The Behavior group's sections. Most are a single global toggle
// (ToggleSection); the radio-list and free-form ones keep their own layout.

import { useEffect, useState } from "react";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { useSettingsStore } from "../../store/settings";
import { ALL_PANELS, SUPPRESSIBLE_SUMMON_PANELS } from "../registry";
import type { PushRecurseMode, SwitchDirtyBehavior } from "../../lib/types";
import {
  FieldNote,
  Section,
  SettingCheckbox,
  SettingRadio,
  ToggleSection,
  WritesTo,
} from "./primitives";

/** Stable empty default so the store selector doesn't return a fresh array. */
const EMPTY_PANELS: string[] = [];

export function AutoOpenPanelsSection() {
  const suppressed = useSettingsStore(
    (s) => s.settings?.suppressed_auto_open_panels ?? EMPTY_PANELS,
  );
  const setSuppressed = useSettingsStore((s) => s.setSuppressedAutoOpenPanels);
  const { busy: saving, run } = useDelayedBusy();

  const titleFor = (id: string) => ALL_PANELS.find((p) => p.id === id)?.title ?? id;

  const toggle = (id: string, autoOpen: boolean) => {
    // autoOpen = keep it in the auto-open set (not suppressed).
    const next = autoOpen
      ? suppressed.filter((p) => p !== id)
      : suppressed.includes(id)
        ? suppressed
        : [...suppressed, id];
    return run(() => setSuppressed(next));
  };

  return (
    <Section title="Auto-open panels">
      <WritesTo note="applies to all repos" />
      <FieldNote>
        When you click a commit, file, or hunk, LeGit opens the matching detail
        panel. Uncheck one to stop it popping open; it still updates live when
        you already have it open.
      </FieldNote>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.333em", marginTop: "0.667em" }}>
        {SUPPRESSIBLE_SUMMON_PANELS.map((id) => {
          const autoOpen = !suppressed.includes(id);
          return (
            <label
              key={id}
              style={{ display: "flex", alignItems: "center", gap: "0.5em", fontSize: "var(--fz-lg)", cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={autoOpen}
                disabled={saving}
                onChange={() => toggle(id, !autoOpen)}
              />
              {titleFor(id)}
            </label>
          );
        })}
      </div>
    </Section>
  );
}

export function AutoRefreshSection() {
  const enabled = useSettingsStore((s) => s.settings?.watcher_enabled ?? true);
  const setWatcherEnabled = useSettingsStore((s) => s.setWatcherEnabled);
  const { busy: saving, run } = useDelayedBusy();

  return (
    <ToggleSection
      title="Auto-refresh"
      writesNote="applies to all open repos immediately"
      id="global-watcher-enabled"
      label="Watch the filesystem and refresh automatically on changes"
      checked={enabled}
      disabled={saving}
      onToggle={() => void run(() => setWatcherEnabled(!enabled))}
    >
      <FieldNote>
        When off, the UI refreshes only when a panel or the window regains focus.
      </FieldNote>
    </ToggleSection>
  );
}

export function AutoFetchSection() {
  const enabled = useSettingsStore((s) => s.settings?.auto_fetch_enabled ?? false);
  const minutes = useSettingsStore((s) => s.settings?.auto_fetch_interval_minutes ?? 15);
  const setAutoFetchEnabled = useSettingsStore((s) => s.setAutoFetchEnabled);
  const setAutoFetchIntervalMinutes = useSettingsStore((s) => s.setAutoFetchIntervalMinutes);
  const { busy: saving, run } = useDelayedBusy();
  const [draft, setDraft] = useState(String(minutes));

  // Follow external changes to the stored value (e.g. settings re-init).
  useEffect(() => setDraft(String(minutes)), [minutes]);

  const toggle = () => run(() => setAutoFetchEnabled(!enabled));

  const commitMinutes = () => {
    const parsed = Math.round(Number(draft));
    if (!Number.isFinite(parsed) || parsed < 1) {
      setDraft(String(minutes));
      return;
    }
    if (parsed === minutes) {
      setDraft(String(parsed));
      return;
    }
    return run(() => setAutoFetchIntervalMinutes(parsed));
  };

  return (
    <Section title="Background auto-fetch">
      <WritesTo note="fetch-only, never pulls or merges" />
      <SettingCheckbox
        id="global-auto-fetch"
        label="Periodically fetch the active repository's remotes"
        checked={enabled}
        onChange={toggle}
        disabled={saving}
      />
      <div style={{ display: "flex", alignItems: "center", gap: "0.667em", marginTop: "0.667em" }}>
        <label htmlFor="global-auto-fetch-interval" style={{ fontSize: "var(--fz-lg)" }}>
          Interval (minutes)
        </label>
        <input
          type="number"
          id="global-auto-fetch-interval"
          min={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitMinutes}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitMinutes();
          }}
          disabled={!enabled || saving}
          style={{ width: "5em" }}
        />
      </div>
      <FieldNote>
        Runs quietly in the background: no popups, and the view only refreshes
        when something actually changed. Skipped while the app is hidden,
        offline, or an operation is in progress; paused for the session after
        an authentication failure.
      </FieldNote>
    </Section>
  );
}

export function ExternalEditorSection() {
  const stored = useSettingsStore((s) => s.settings?.external_editor_command ?? "");
  const setExternalEditorCommand = useSettingsStore((s) => s.setExternalEditorCommand);
  const [draft, setDraft] = useState(stored ?? "");
  const { busy: saving, run } = useDelayedBusy();

  // Follow external changes to the stored value (e.g. settings re-init).
  useEffect(() => setDraft(stored ?? ""), [stored]);

  const commit = () => {
    const normalized = draft.trim();
    if (normalized === (stored ?? "").trim()) return;
    return run(() => setExternalEditorCommand(normalized === "" ? null : draft));
  };

  const placeholder =
    navigator.platform.toLowerCase().includes("mac")
      ? 'e.g. code "$ROOT"  or  /Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'
      : 'e.g. code "$ROOT"';

  return (
    <Section title="External editor">
      <WritesTo />
      <div style={{ display: "flex", gap: "0.5em", marginTop: "0.667em" }}>
        <input
          style={{ flex: 1 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          placeholder={placeholder}
          disabled={saving}
        />
      </div>
      <FieldNote>
        Command used by "Open in editor" on a repository or a file.{" "}
        <code>$ROOT</code> is replaced by the repository path and{" "}
        <code>$FILE</code> by the file path (appended if the template doesn't
        mention them); quote them against spaces. Leave blank to use the
        system file manager instead.
      </FieldNote>
    </Section>
  );
}

export function BranchCreationSection() {
  const enabled = useSettingsStore((s) => s.settings?.checkout_new_branch ?? true);
  const setCheckoutNewBranch = useSettingsStore((s) => s.setCheckoutNewBranch);
  const { busy: saving, run } = useDelayedBusy();

  return (
    <ToggleSection
      title="Branch creation"
      writesNote="applies to all repos"
      id="global-checkout-new-branch"
      label="Check out a newly created branch immediately"
      checked={enabled}
      disabled={saving}
      onToggle={() => void run(() => setCheckoutNewBranch(!enabled))}
    >
      <FieldNote>
        Applies to the Commits panel's inline create and the Branches
        section's form. When the new branch starts at another commit, the
        checkout follows the "Branch switching" behavior below for uncommitted
        changes. "Branch from stash" always checks out.
      </FieldNote>
    </ToggleSection>
  );
}

export function ConfirmDiscardSection() {
  const confirm = useSettingsStore((s) => s.settings?.confirm_discard ?? true);
  const setConfirmDiscard = useSettingsStore((s) => s.setConfirmDiscard);
  const { busy: saving, run } = useDelayedBusy();

  return (
    <ToggleSection
      title="Destructive action confirmation"
      writesNote="applies to all repos"
      id="global-confirm-discard"
      label="Ask for confirmation before destructive actions"
      checked={confirm}
      disabled={saving}
      onToggle={() => void run(() => setConfirmDiscard(!confirm))}
    >
      <FieldNote>
        Covers discarding changes, deleting branches, dropping stashes, and
        removing remotes or themes. When off, these run immediately without a
        prompt.
      </FieldNote>
    </ToggleSection>
  );
}

export function DetectCaseRenamesSection() {
  const enabled = useSettingsStore((s) => s.settings?.detect_case_renames ?? true);
  const setDetectCaseRenames = useSettingsStore((s) => s.setDetectCaseRenames);
  const { busy: saving, run } = useDelayedBusy();

  return (
    <ToggleSection
      title="Case-only renames"
      writesNote="applies to all repos"
      id="global-detect-case-renames"
      label="Detect case-only renames"
      checked={enabled}
      disabled={saving}
      onToggle={() => void run(() => setDetectCaseRenames(!enabled))}
    >
      <FieldNote>
        On case-insensitive filesystems (Windows, macOS) renaming a file only
        by letter case is invisible to git status. When on, Working Changes
        shows such renames with a one-click "Stage rename" fix. Repos on
        case-sensitive filesystems are never scanned.
      </FieldNote>
    </ToggleSection>
  );
}

export function CheckoutRemoteFastForwardSection() {
  const enabled = useSettingsStore((s) => s.settings?.checkout_remote_fast_forward ?? true);
  const setCheckoutRemoteFastForward = useSettingsStore((s) => s.setCheckoutRemoteFastForward);
  const { busy: saving, run } = useDelayedBusy();

  return (
    <ToggleSection
      title="Remote branch checkout"
      writesNote="applies to all repos"
      id="global-checkout-remote-ff"
      label="Fast-forward the local branch when checking out a remote branch"
      checked={enabled}
      disabled={saving}
      onToggle={() => void run(() => setCheckoutRemoteFastForward(!enabled))}
    >
      <FieldNote>
        Checking out a remote branch (double-clicking its chip, or the context
        menu) switches to the local branch and moves it up to date with the
        remote tip. Purely local (fast-forward only, no network): if local and
        remote have diverged, the branch is left as-is and a toast says so.
        When off, checkout leaves a stale local branch where it was.
      </FieldNote>
    </ToggleSection>
  );
}

export function SubmoduleAttachSection() {
  const enabled = useSettingsStore((s) => s.settings?.submodule_attach_branch ?? false);
  const setSubmoduleAttachBranch = useSettingsStore((s) => s.setSubmoduleAttachBranch);
  const { busy: saving, run } = useDelayedBusy();

  return (
    <ToggleSection
      title="Submodule branch attach"
      writesNote="applies to all repos"
      id="global-submodule-attach"
      label="Attach submodule HEAD to its branch after updates"
      checked={enabled}
      disabled={saving}
      onToggle={() => void run(() => setSubmoduleAttachBranch(!enabled))}
    >
      <FieldNote>
        When a submodule update lands on a commit that a branch already points
        at (the tracked branch, or a single matching local branch), check out
        that branch instead of leaving a detached HEAD. The submodule then
        follows the branch, so its recorded pointer shows as changed when the
        branch moves.
      </FieldNote>
    </ToggleSection>
  );
}

export function AutoPushTagsSection() {
  const enabled = useSettingsStore((s) => s.settings?.auto_push_tags ?? false);
  const setAutoPushTags = useSettingsStore((s) => s.setAutoPushTags);
  const { busy: saving, run } = useDelayedBusy();

  return (
    <ToggleSection
      title="Auto-push tags"
      writesNote="applies to all repos, repo-overridable"
      id="global-auto-push-tags"
      label="Push tags with their commit automatically"
      checked={enabled}
      disabled={saving}
      onToggle={() => void run(() => setAutoPushTags(!enabled))}
    >
      <FieldNote>
        Pushing a branch also pushes the tags whose commits became public
        through that push, and a tag created on an already-pushed commit is
        pushed immediately. Off by default: tag pushes commonly trigger CI
        release pipelines, and removing a published tag is a separate,
        deliberate action. Tags never overwrite a same-named tag on the
        remote; older local-only tags are never swept along.
      </FieldNote>
    </ToggleSection>
  );
}

export function PushGuardSection() {
  const mode = useSettingsStore((s) => s.settings?.push_recurse_submodules ?? null);
  const setPushRecurseSubmodules = useSettingsStore((s) => s.setPushRecurseSubmodules);
  const { busy: saving, run } = useDelayedBusy();

  const select = (m: PushRecurseMode | null) => {
    if (m === mode) return;
    return run(() => setPushRecurseSubmodules(m));
  };

  return (
    <Section title="Submodule push guard">
      <WritesTo note="applies to all repos" />
      <div style={{ display: "flex", flexDirection: "column", gap: "0.667em", marginTop: "0.667em" }}>
        <SettingRadio
          checked={mode === null}
          onSelect={() => void select(null)}
          disabled={saving}
          label="Off"
          detail="pushes never look at submodules (git default)"
        />
        <SettingRadio
          checked={mode === "check"}
          onSelect={() => void select("check")}
          disabled={saving}
          label="Check"
          detail="block the push when it references submodule commits that exist on no remote"
        />
        <SettingRadio
          checked={mode === "on_demand"}
          onSelect={() => void select("on_demand")}
          disabled={saving}
          label="On demand"
          detail="push the needed submodule branches first, then the superproject"
        />
      </div>
    </Section>
  );
}

export function BranchSwitchingSection() {
  const behavior = useSettingsStore(
    (s) => s.settings?.switch_dirty_behavior ?? "try_directly",
  );
  const setSwitchDirtyBehavior = useSettingsStore((s) => s.setSwitchDirtyBehavior);
  const { busy: saving, run } = useDelayedBusy();

  const select = (b: SwitchDirtyBehavior) => {
    if (b === behavior) return;
    return run(() => setSwitchDirtyBehavior(b));
  };

  return (
    <Section title="Branch switching">
      <WritesTo note="applies to all repos" />
      <div style={{ display: "flex", flexDirection: "column", gap: "0.667em", marginTop: "0.667em" }}>
        <SettingRadio
          checked={behavior === "try_directly"}
          onSelect={() => void select("try_directly")}
          disabled={saving}
          label="Try switching directly"
          detail="git decides; fails with an error if the working tree conflicts"
        />
        <SettingRadio
          checked={behavior === "auto_stash"}
          onSelect={() => void select("auto_stash")}
          disabled={saving}
          label="Auto-stash, then switch"
          detail="stashes changes, switches branch, then pops the stash (changes travel along)"
        />
        <SettingRadio
          checked={behavior === "stash_and_keep"}
          onSelect={() => void select("stash_and_keep")}
          disabled={saving}
          label="Auto-stash and keep stashed"
          detail="stashes changes and leaves them parked; the new branch starts clean"
        />
      </div>
    </Section>
  );
}

export function LineEndingChangesSection() {
  const chips = useSettingsStore((s) => s.settings?.line_ending_chips_in_changes ?? true);
  const warn = useSettingsStore((s) => s.settings?.warn_on_line_ending_commit ?? true);
  const { busy: saving, run } = useDelayedBusy();

  const toggle = (key: "chips" | "warn") =>
    run(async () => {
      const store = useSettingsStore.getState();
      if (key === "chips") {
        await store.setLineEndingChipsInChanges(!chips);
      } else {
        await store.setWarnOnLineEndingCommit(!warn);
      }
    });

  return (
    <Section title="Line ending changes">
      <WritesTo note="default for all repos" />
      <SettingCheckbox
        id="global-eol-chips"
        label="Show line-ending change chips on Working Changes files"
        checked={chips}
        onChange={() => void toggle("chips")}
        disabled={saving}
      />
      <SettingCheckbox
        id="global-eol-warn"
        label="Warn when committing files whose line endings change"
        checked={warn}
        onChange={() => void toggle("warn")}
        disabled={saving}
      />
    </Section>
  );
}

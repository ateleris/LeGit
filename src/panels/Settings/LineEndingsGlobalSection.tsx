// `core.autocrlf` / `core.eol` at GLOBAL scope, for whichever host the scope
// names: the app machine's config, or a WSL distribution's own. One form, two
// hosts — see `gitConfigHost.tsx` for what varies and why.

import { useCallback, useEffect, useState } from "react";
import { usePanelFocusEffect, usePanelDirty } from "../PanelApiContext";
import { WarningIcon } from "../../icons";
import { formatAppError } from "../../lib/types";
import type { ConfigScope, LineEndingsView } from "../../lib/types";
import { Button } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { useDelayedFlag } from "../shared/useDelayedFlag";
import { Section, FieldNote } from "./primitives";
import { ConfigRow, RadioGroup } from "./SigningSettings";
import { AUTOCRLF_OPTIONS, EOL_OPTIONS, getChangedValues } from "./lineEndingOptions";
import type { GitConfigScope } from "./gitConfigHost";

/**
 * `enabled` gates loading: a WSL form must not connect to (and thereby start)
 * a distro on mount — the group's Connect action does that. Local scopes pass
 * `true`. `reloadNonce` re-reads after a reconnect.
 */
export function LineEndingsGlobalSection({
  scope,
  enabled = true,
  reloadNonce = 0,
  disabled = false,
}: {
  scope: GitConfigScope;
  enabled?: boolean;
  reloadNonce?: number;
  disabled?: boolean;
}) {
  const [view, setView] = useState<LineEndingsView | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [draftAutocrlf, setDraftAutocrlf] = useState<string | null>(null);
  const [draftEol, setDraftEol] = useState<string | null>(null);
  const { busy: saving, run } = useDelayedBusy();
  const [error, setError] = useState<string | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  // Debounced loading indicator: fast loads never flash "Loading…".
  const showLoading = useDelayedFlag(loading);

  const title = `Line endings ${scope.titleSuffix}`;

  const load = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    scope.api
      .lineEndingsView()
      .then((v) => {
        setView(v);
        setDraftAutocrlf(v.autocrlf_global.value ?? null);
        setDraftEol(v.eol_global.value ?? null);
      })
      .catch((e) => setError(formatAppError(e)))
      .finally(() => setLoading(false));
  }, [enabled, scope]);

  useEffect(() => { load(); }, [load, reloadNonce]);
  // `usePanelFocusEffect` never re-subscribes, so the callback must read
  // `enabled` through the ref-stable `load` rather than close over it.
  usePanelFocusEffect(load);

  const dirty = view !== null && (
    draftAutocrlf !== (view.autocrlf_global.value ?? null) ||
    draftEol !== (view.eol_global.value ?? null)
  );

  usePanelDirty(dirty, `line-endings-${scope.id}`);

  if (!enabled) {
    return (
      <Section title={title} scope="git">
        <span className="legit-subtle">Not loaded yet.</span>
      </Section>
    );
  }

  if (loading) {
    return (
      <Section title={title} scope="git">
        {showLoading && <span className="legit-subtle">Loading…</span>}
      </Section>
    );
  }
  if (!view) {
    return (
      <Section title={title} scope="git">
        {error ? (
          <pre className="legit-error">{error}</pre>
        ) : (
          showLoading && <span className="legit-subtle">Loading…</span>
        )}
      </Section>
    );
  }

  const changes = getChangedValues(
    { autocrlf: view.autocrlf_global.value, eol: view.eol_global.value },
    { autocrlf: draftAutocrlf, eol: draftEol }
  );

  const handleSave = () => setConfirmPending(true);

  const handleConfirm = () =>
    run(async () => {
      setConfirmPending(false);
      setError(null);
      try {
        const updated = await scope.api.writeLineEndings(draftAutocrlf, draftEol);
        setView(updated);
        setDraftAutocrlf(updated.autocrlf_global.value ?? null);
        setDraftEol(updated.eol_global.value ?? null);
      } catch (e) {
        setError(formatAppError(e));
      }
    });

  const handleCancel = () => {
    setDraftAutocrlf(view.autocrlf_global.value ?? null);
    setDraftEol(view.eol_global.value ?? null);
  };

  const busy = saving || disabled;

  return (
    <Section title={title} scope="git">
      <FieldNote>
        writes to: {scope.configFileLabel} — affects all repos that don&apos;t override these values
      </FieldNote>

      <div style={{ marginTop: 10 }}>
        <ConfigRow label="core.autocrlf">
          <RadioGroup
            name={`${scope.id}-autocrlf`}
            value={draftAutocrlf}
            options={AUTOCRLF_OPTIONS}
            onChange={setDraftAutocrlf}
            disabled={busy}
          />
          <ScopeBadge label="system" value={view.autocrlf_system.value} source={view.autocrlf_system.source} />
          <ScopeBadge label="resolved" value={view.autocrlf_resolved.value} source={view.autocrlf_resolved.source} isResolved />
        </ConfigRow>

        <ConfigRow label="core.eol">
          <RadioGroup
            name={`${scope.id}-eol`}
            value={draftEol}
            options={EOL_OPTIONS}
            onChange={setDraftEol}
            disabled={busy}
          />
          <ScopeBadge label="system" value={view.eol_system.value} source={view.eol_system.source} />
          <ScopeBadge label="resolved" value={view.eol_resolved.value} source={view.eol_resolved.source} isResolved />
        </ConfigRow>
      </div>

      {confirmPending && (
        <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--button-hover-bg)", border: "1px solid var(--panel-border)", borderRadius: 4 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--error-fg)", display: "flex", alignItems: "center", gap: 6 }}>
            <WarningIcon /> Save line-ending changes to {scope.configFileLabel}?
          </div>
          <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
            {changes.map((c) => (
              <div key={c.key} style={{ fontFamily: "monospace" }}>
                <code>{c.key}</code>: <code>{c.before ?? "unset"}</code> → <code>{c.after ?? "unset"}</code>
              </div>
            ))}
          </div>
          <div style={{ fontSize: "var(--fz-md)", color: "var(--subtle-fg)", marginBottom: 10 }}>
            {scope.confirmBlurb} If you only want this for one repo, cancel and edit that
            repo&apos;s settings instead.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button variant="primary" onClick={handleConfirm} disabled={busy}>Save</Button>
            <button onClick={() => setConfirmPending(false)}>Cancel</button>
          </div>
        </div>
      )}

      {!confirmPending && (
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <Button variant="primary" disabled={!dirty || busy} onClick={handleSave}>
            Save
          </Button>
          <button disabled={!dirty || busy} onClick={handleCancel}>
            Cancel
          </button>
        </div>
      )}

      {error && <pre className="legit-error">{error}</pre>}
    </Section>
  );
}

/**
 * The line-endings badges annotate BOTH the system and the resolved value with
 * their source scope (`SigningSettings`' `ResolvedBadge` annotates only the
 * resolved one) — kept as-is so this form renders exactly as before.
 */
function ScopeBadge({
  label,
  value,
  source,
  isResolved,
}: {
  label: string;
  value: string | null;
  source: ConfigScope;
  isResolved?: boolean;
}) {
  if (!value) return null;
  const fromLabel = source !== "unset" ? ` (from ${source})` : "";
  return (
    <div style={{ marginTop: 4, fontSize: "var(--fz-sm)", color: isResolved ? "var(--success-fg)" : "var(--subtle-fg)" }}>
      {label}: <code>{value}</code>{fromLabel}
    </div>
  );
}

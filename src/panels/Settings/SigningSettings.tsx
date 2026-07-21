// Shared signing-form primitives (rows, badges, radio groups) used by the
// global git-config form (GlobalGitConfigSection) and the repo custom editor
// (CustomConfigEditor). The standalone signing sections were folded into
// those combined forms: global by the 2026-07-13 global-identity work, repo
// by the 2026-07-21 repo-identity-modes work.

import type { ConfigScope } from "../../lib/types";

export const GPGSIGN_OPTIONS: { label: string; value: string | null }[] = [
  { label: "On", value: "true" },
  { label: "Off", value: "false" },
  { label: "Inherit", value: null },
];

export const FORMAT_OPTIONS: { label: string; value: string | null }[] = [
  { label: "ssh", value: "ssh" },
  { label: "openpgp (GPG)", value: "openpgp" },
  { label: "x509", value: "x509" },
  { label: "Inherit", value: null },
];

function scopeLabel(scope: ConfigScope): string {
  switch (scope) {
    case "local": return "local";
    case "global": return "global";
    case "system": return "system";
    default: return "";
  }
}

export function RadioGroup({
  name,
  value,
  options,
  onChange,
  disabled,
}: {
  name: string;
  value: string | null;
  options: { label: string; value: string | null }[];
  onChange: (v: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {options.map((opt) => (
        <label key={opt.label} style={{ display: "flex", alignItems: "center", gap: 4, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}>
          <input
            type="radio"
            name={name}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
            disabled={disabled}
          />
          <code style={{ fontSize: "var(--fz-md)" }}>{opt.label}</code>
        </label>
      ))}
    </div>
  );
}

export function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: "var(--fz-md)", fontFamily: "monospace", color: "var(--subtle-fg)", marginBottom: 4 }}>{label}</div>
      <div style={{ paddingLeft: 8 }}>{children}</div>
    </div>
  );
}

export function ResolvedBadge({
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
  const sl = scopeLabel(source);
  const fromLabel = sl ? ` (from ${sl})` : "";
  return (
    <div style={{ marginTop: 4, fontSize: "var(--fz-sm)", color: isResolved ? "var(--success-fg)" : "var(--subtle-fg)" }}>
      {label}: <code>{value}</code>{isResolved ? fromLabel : ""}
    </div>
  );
}

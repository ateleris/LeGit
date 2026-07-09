import { Button } from "./buttons";

export function InlineEditor({
  label,
  disabled,
  onSave,
  onCancel,
  children,
}: {
  label: string;
  disabled: boolean;
  onSave: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: "var(--fz-sm)", color: "var(--subtle-fg)" }}>{label}</span>
      {children}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button variant="primary" disabled={disabled} onClick={onSave}>
          Save
        </Button>
        <button disabled={disabled} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

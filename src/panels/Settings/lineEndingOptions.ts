// The `core.autocrlf` / `core.eol` value tables and the change diff shown in
// the save confirmation — shared by every line-endings form (the app machine's,
// each WSL distro's, and the repo one) so the offered values and the confirm
// list cannot drift apart between them.

export const AUTOCRLF_OPTIONS: { label: string; value: string | null }[] = [
  { label: "true", value: "true" },
  { label: "input", value: "input" },
  { label: "false", value: "false" },
  { label: "Inherit", value: null },
];

export const EOL_OPTIONS: { label: string; value: string | null }[] = [
  { label: "lf", value: "lf" },
  { label: "crlf", value: "crlf" },
  { label: "native", value: "native" },
  { label: "Inherit", value: null },
];

export interface ChangeItem {
  key: string;
  before: string | null;
  after: string | null;
}

interface LineEndingValues {
  autocrlf: string | null;
  eol: string | null;
}

/** The keys whose value actually changes, for the save confirmation. Pure. */
export function getChangedValues(
  before: LineEndingValues,
  after: LineEndingValues
): ChangeItem[] {
  const result: ChangeItem[] = [];
  if (before.autocrlf !== after.autocrlf) {
    result.push({ key: "core.autocrlf", before: before.autocrlf, after: after.autocrlf });
  }
  if (before.eol !== after.eol) {
    result.push({ key: "core.eol", before: before.eol, after: after.eol });
  }
  return result;
}

// Native-tooltip (`title`) texts for the commit list. Kept pure so the
// "when does a hover show anything" decisions are unit-tested.

/**
 * Tooltip for the subject cell: the full commit message, but only when it
 * holds more than the cell shows — the subject is visually clipped
 * (`subjectClipped`, measured by the caller) or a body follows the subject
 * line. "" = no tooltip.
 */
export function subjectHoverTitle(message: string, subjectClipped: boolean): string {
  const full = message.trim();
  const subject = (message.split("\n")[0] ?? "").trim();
  return subjectClipped || full !== subject ? full : "";
}

/**
 * Tooltip for the commit dot: the author in git's signature form
 * (`Name <email>`), degrading to whichever part exists. "" = no tooltip.
 */
export function dotHoverTitle(name: string, email: string): string {
  const n = name.trim();
  const e = email.trim();
  if (!e) return n;
  return n ? `${n} <${e}>` : `<${e}>`;
}

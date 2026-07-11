// Shared error block for a panel's query/action failure: ONE place for the
// legit-error styling (so margins/font cannot drift between panels) and one
// place that guarantees the message renders via formatAppError - git's own
// message, never a JSON envelope or "[object Object]".

import { formatAppError } from "../../lib/types";

export function PanelError({
  error,
  margin = "8px 12px",
}: {
  /** The raw error value (AppError envelope, Error, or string). */
  error: unknown;
  /** CSS margin; panels embedded in tight layouts pass 0. */
  margin?: string | number;
}) {
  return (
    <pre className="legit-error" style={{ margin, fontSize: "var(--fz-md)" }}>
      {formatAppError(error)}
    </pre>
  );
}

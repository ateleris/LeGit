import type { SignatureVerification } from "../../../lib/types";
import { signaturePresentation } from "../../../lib/signature";

/**
 * Compact signature indicator for a commit row. Renders nothing for unsigned
 * commits (`signature` null or `NoSignature`). The status comes from `%G?` in
 * the log (see legit-core log parser); full detail is in the Commit Details panel.
 */
export function SignatureBadge({
  signature,
  size,
}: {
  signature: SignatureVerification | null;
  /** Glyph font size in px (matches the row text size). */
  size: number;
}) {
  if (!signature || signature.status === "NoSignature") return null;
  const { color, symbol, title } = signaturePresentation(signature.status);
  if (!symbol) return null;
  return (
    <span
      title={title}
      style={{
        color,
        fontSize: size,
        fontWeight: 700,
        flexShrink: 0,
        lineHeight: 1,
      }}
    >
      {symbol}
    </span>
  );
}

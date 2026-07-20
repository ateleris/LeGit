import type { SignatureVerification } from "../../../lib/types";
import { signaturePresentation } from "../../../lib/signature";
import { SignedIcon } from "../../../icons";

/**
 * Compact signature indicator for a commit row. Two-tier by design
 * (BACKLOG "presence-only chips"): the list only knows signature PRESENCE
 * (a batched raw-header scan - the bulk log never verifies), rendered as a
 * neutral key glyph; when a verification result exists (the Commit Details
 * panel verifies the selected commit on demand), it upgrades the glyph to
 * the coloured verdict. Renders nothing for unsigned commits.
 */
export function SignatureBadge({
  signature,
  hasSignature,
  size,
}: {
  /** Verification verdict, when one exists (selected row via details). */
  signature: SignatureVerification | null;
  /** Presence flag from the commit list. */
  hasSignature: boolean;
  /** Glyph font size in px (matches the row text size). */
  size: number;
}) {
  if (signature && signature.status !== "NoSignature") {
    const { color, symbol, title } = signaturePresentation(signature.status);
    if (symbol) {
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
  }
  if (!hasSignature) return null;
  return (
    <span
      title="Signed (select the commit to verify)"
      style={{
        color: "var(--subtle-fg)",
        fontSize: size,
        flexShrink: 0,
        lineHeight: 0,
      }}
    >
      <SignedIcon aria-label="Signed" />
    </span>
  );
}

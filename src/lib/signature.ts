// Shared presentation for commit signature status — used by the Commit Details
// panel and the inline badge in the Commits log. Colours are theme tokens
// (success.fg / warning.fg / error.fg / subtle.fg); no hardcoded hex.

import type { SignatureStatus } from "./types";

export interface SignaturePresentation {
  /** CSS colour (theme token var). */
  color: string;
  /** Short human label (e.g. for the details panel). */
  label: string;
  /** Compact glyph for the inline log badge. */
  symbol: string;
  /** Tooltip text. */
  title: string;
}

export function signaturePresentation(status: SignatureStatus): SignaturePresentation {
  switch (status) {
    case "Good":
      return { color: "var(--success-fg)", label: "Good", symbol: "✓", title: "Good signature" };
    case "Untrusted":
      return {
        color: "var(--warning-fg)",
        label: "Unverified",
        symbol: "?",
        title: "Valid signature, but the signer's validity is unknown (no allowed-signers entry / not trusted)",
      };
    case "Expired":
      return { color: "var(--warning-fg)", label: "Expired", symbol: "!", title: "Signature or signing key expired" };
    case "UnknownKey":
      return {
        color: "var(--warning-fg)",
        label: "Unknown key",
        symbol: "?",
        title: "Cannot verify — signing key is not available",
      };
    case "BadSignature":
      return { color: "var(--error-fg)", label: "Bad", symbol: "✗", title: "Bad signature" };
    case "Revoked":
      return { color: "var(--error-fg)", label: "Revoked", symbol: "✗", title: "Signing key was revoked" };
    case "NoSignature":
      return { color: "var(--subtle-fg)", label: "Unsigned", symbol: "", title: "No signature" };
  }
}

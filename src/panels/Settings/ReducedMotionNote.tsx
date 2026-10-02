import { useReducedMotion } from "../shared/useReducedMotion";
import { FieldNote } from "./primitives";

/** Shown only while the OS requests reduced motion, so users learn why
 *  animations (e.g. the attention pulse on inline inputs) are not playing. */
export function ReducedMotionNote() {
  const reduced = useReducedMotion();
  if (!reduced) return null;
  return (
    <FieldNote>
      Your system requests reduced motion, so animations such as the attention
      pulse around inline inputs are disabled. To re-enable them on Windows:
      Settings &gt; Accessibility &gt; Visual effects &gt; Animation effects.
    </FieldNote>
  );
}

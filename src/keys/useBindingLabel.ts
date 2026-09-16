import { formatChord } from "./chord";
import { useKeymapStore } from "./keymap";

/** The command's primary binding, formatted for the platform, reactively (a
 * rebind in the Shortcuts panel re-renders every tooltip using it). Null when
 * unbound. Use for tooltips/menu entries: `title={withBinding("Fetch", label)}`. */
export function useBindingLabel(commandId: string): string | null {
  const chords = useKeymapStore((s) => s.effective[commandId]);
  return chords && chords.length > 0 ? formatChord(chords[0]) : null;
}

export function withBinding(text: string, binding: string | null): string {
  return binding ? `${text} (${binding})` : text;
}

/**
 * Chord parsing, normalization and formatting
 * (design/2026-08-24-keyboard-shortcuts-system.md §2).
 *
 * Canonical chord string: modifiers in Mod, Ctrl, Alt, Shift order, then one
 * key, joined by "+" ("Mod+Shift+M"). "Mod" is the platform-primary modifier:
 * Ctrl on Windows/Linux, Cmd on macOS - decided here and nowhere else.
 * Matching uses `KeyboardEvent.key` (layout-aware); single characters are
 * stored uppercase, " " is named "Space" and "+" is named "Plus" so the
 * separator stays unambiguous.
 */

export interface ParsedChord {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export interface Platform {
  isMac: boolean;
}

export const PLATFORM: Platform = {
  isMac: typeof navigator !== "undefined" && /mac/i.test(navigator.platform),
};

const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift", "Meta"] as const;

const NAMED_KEYS = new Set([
  "Enter",
  "Space",
  "Tab",
  "Escape",
  "Delete",
  "Backspace",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Plus",
  "Minus",
  "ContextMenu",
  ...Array.from({ length: 19 }, (_, i) => `F${i + 1}`),
]);

/** Case-insensitive lookup for named keys and modifiers. */
const NAMED_LOOKUP = new Map(
  [...NAMED_KEYS, ...MODIFIERS].map((k) => [k.toLowerCase(), k] as const),
);

function canonicalKey(raw: string): string | null {
  if (raw.length === 1) {
    if (raw === " ") return "Space";
    if (raw === "+") return "Plus";
    return raw.toUpperCase();
  }
  const named = NAMED_LOOKUP.get(raw.toLowerCase());
  return named && NAMED_KEYS.has(named) ? named : null;
}

export function parseChord(chord: string): ParsedChord | null {
  const parts = chord.split("+");
  // "Mod+Plus" arrives as ["Mod", "Plus"]; a literal trailing "+" ("Mod+")
  // arrives as ["Mod", ""] and is rejected below.
  const parsed: ParsedChord = { mod: false, ctrl: false, alt: false, shift: false, key: "" };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const named = NAMED_LOOKUP.get(part.toLowerCase());
    const isLast = i === parts.length - 1;
    if (!isLast) {
      switch (named) {
        case "Mod":
          parsed.mod = true;
          break;
        case "Ctrl":
          parsed.ctrl = true;
          break;
        case "Alt":
          parsed.alt = true;
          break;
        case "Shift":
          parsed.shift = true;
          break;
        default:
          // Includes "Meta": only eventToChord ever emits it (Windows key
          // chords), so a stored binding can never match one.
          return null;
      }
    } else {
      if (part === "") return null;
      if (named && (MODIFIERS as readonly string[]).includes(named)) return null;
      const key = canonicalKey(part);
      if (!key) return null;
      parsed.key = key;
    }
  }
  return parsed.key ? parsed : null;
}

/** Canonical form of a chord string, or null if unparseable. */
export function normalizeChord(chord: string): string | null {
  const p = parseChord(chord);
  if (!p) return null;
  return chordString(p);
}

function chordString(p: ParsedChord): string {
  const parts: string[] = [];
  if (p.mod) parts.push("Mod");
  if (p.ctrl) parts.push("Ctrl");
  if (p.alt) parts.push("Alt");
  if (p.shift) parts.push("Shift");
  parts.push(p.key);
  return parts.join("+");
}

/** Human-readable rendering; the single place "Mod" becomes Ctrl or Cmd. */
export function formatChord(chord: string, platform: Platform = PLATFORM): string {
  const p = parseChord(chord);
  if (!p) return chord;
  const parts: string[] = [];
  if (p.mod) parts.push(platform.isMac ? "Cmd" : "Ctrl");
  if (p.ctrl) parts.push("Ctrl");
  if (p.alt) parts.push("Alt");
  if (p.shift) parts.push("Shift");
  parts.push(p.key);
  return parts.join("+");
}

type ChordEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/**
 * The chord a keydown represents, in canonical form, or null for a
 * modifier-only press. On Windows/Linux a metaKey chord is prefixed "Meta" so
 * it can never false-match a "Mod" binding.
 */
export function eventToChord(e: ChordEvent, platform: Platform = PLATFORM): string | null {
  if (["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(e.key)) return null;
  const key = canonicalKey(e.key);
  if (!key) return null;
  const parts: string[] = [];
  if (platform.isMac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (platform.isMac ? e.ctrlKey : false) parts.push("Ctrl");
  if (!platform.isMac && e.metaKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/**
 * Every stored spelling this chord matches. On Windows/Linux the physical
 * Ctrl key IS Mod, so an event chord "Mod+X" must also match a binding
 * stored as "Ctrl+X" (the spelling used when a default must stay on the
 * physical Ctrl key on macOS too, e.g. Ctrl+Tab - Cmd+Tab belongs to the
 * OS). On macOS Cmd and Ctrl are distinct keys, so no folding happens.
 */
export function chordMatchCandidates(chord: string, platform: Platform = PLATFORM): string[] {
  const p = parseChord(chord);
  if (!p || platform.isMac || !p.mod || p.ctrl) return [chord];
  return [chord, chordString({ ...p, mod: false, ctrl: true })];
}

/**
 * Every stored spelling a keydown may match, in match order: the event's own
 * chord plus chordMatchCandidates' Mod/Ctrl folding. Deliberately NO
 * layout-composition guessing (deriving digits/letters from `code` when the
 * key composed, e.g. Shift+1 = "!"/"+"): capture records the composed
 * spelling the user actually produced, so matching that same spelling is
 * always right, while physical-key inference fires bindings the panel never
 * showed as colliding. Shipped defaults simply avoid composing chords.
 */
export function eventChordCandidates(
  e: ChordEvent,
  platform: Platform = PLATFORM,
): string[] {
  const base = eventToChord(e, platform);
  return base ? chordMatchCandidates(base, platform) : [];
}

export interface CaptureEvent extends ChordEvent {
  code: string;
  isComposing: boolean;
  getModifierState(mod: string): boolean;
}

export type CaptureResult =
  | { kind: "chord"; chord: string }
  | { kind: "pending"; preview: string }
  | { kind: "cancel" }
  | { kind: "rejected"; reason: string };

/**
 * Normalize a keydown recorded by the Keyboard Shortcuts panel's key capture.
 * MUST emit byte-identical output to what the matcher (eventToChord)
 * compares. Modifier-only presses are a live preview; dead keys, IME
 * composition, AltGr chords (ambiguous with Ctrl+Alt on Windows) and
 * Windows-key chords are rejected with a visible reason; a non-ASCII
 * character falls back to its physical letter/digit key.
 */
export function captureChord(e: CaptureEvent, platform: Platform = PLATFORM): CaptureResult {
  if (e.key === "Escape") return { kind: "cancel" };
  if (["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(e.key)) {
    const parts: string[] = [];
    if (platform.isMac ? e.metaKey : e.ctrlKey) parts.push(platform.isMac ? "Cmd" : "Ctrl");
    if (platform.isMac && e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    return { kind: "pending", preview: [...parts, "..."].join("+") };
  }
  if (e.isComposing) {
    return { kind: "rejected", reason: "Keys composed via an IME cannot be bound" };
  }
  if (e.key === "Dead") {
    return { kind: "rejected", reason: "Dead keys cannot be bound" };
  }
  if (e.getModifierState("AltGraph")) {
    return { kind: "rejected", reason: "AltGr chords are ambiguous with Ctrl+Alt" };
  }
  if (!platform.isMac && e.metaKey) {
    return { kind: "rejected", reason: "Windows-key chords are reserved by the OS" };
  }

  let event: ChordEvent = e;
  if (e.key.length === 1 && e.key.charCodeAt(0) > 126) {
    const physical = /^Key([A-Z])$/.exec(e.code) ?? /^Digit([0-9])$/.exec(e.code);
    if (!physical) {
      return { kind: "rejected", reason: `"${e.key}" cannot be represented as a binding` };
    }
    // Explicit copy - a real KeyboardEvent's fields don't survive a spread.
    event = {
      key: physical[1],
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
    };
  }
  const chord = eventToChord(event, platform);
  if (!chord) {
    return { kind: "rejected", reason: `"${e.key}" cannot be bound` };
  }
  return { kind: "chord", chord };
}

/**
 * Whether keyboard focus sits in a text-editing surface: inputs, textareas,
 * selects, contenteditable, or a CodeMirror editor. Only `allowInInput`
 * bindings may resolve there (§4 input guard).
 */
export function isEditableTarget(target: unknown): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest(".cm-content") !== null;
}

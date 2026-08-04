// ANSI SGR parsing for the Git Console: pure `line -> spans`, so git's
// colour output (`-c color.ui=always`, injected by `console_exec`) renders
// through theme tokens instead of being shown as escape garbage.
//
// Colours resolve to the `console.ansi.*` theme tokens - never literal
// values - so user themes control the console palette like everything else.
// 24-bit (`38;2;r;g;b`) and non-basic 256-colour codes are deliberately
// dropped (kept as the stream default): arbitrary RGB can't be themed.
// Unknown CSI/OSC sequences are stripped.

export interface AnsiSpan {
  text: string;
  /** CSS colour (a var() reference to a console.ansi token); undefined = stream default. */
  color?: string;
  /** CSS background colour; undefined = transparent. */
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Swap foreground/background (SGR 7) - git uses it for whitespace errors. */
  inverse?: boolean;
}

// Indexed by the basic colour number (0-7). Literal `var()` strings on
// purpose: the theme contract test scans the source for consumption.
const ANSI_FG: readonly string[] = [
  "var(--console-ansi-black)",
  "var(--console-ansi-red)",
  "var(--console-ansi-green)",
  "var(--console-ansi-yellow)",
  "var(--console-ansi-blue)",
  "var(--console-ansi-magenta)",
  "var(--console-ansi-cyan)",
  "var(--console-ansi-white)",
];
const ANSI_BRIGHT_FG: readonly string[] = [
  "var(--console-ansi-bright-black)",
  "var(--console-ansi-bright-red)",
  "var(--console-ansi-bright-green)",
  "var(--console-ansi-bright-yellow)",
  "var(--console-ansi-bright-blue)",
  "var(--console-ansi-bright-magenta)",
  "var(--console-ansi-bright-cyan)",
  "var(--console-ansi-bright-white)",
];

interface SgrState {
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

/** Apply one SGR parameter list (the `…` of `ESC[…m`) to the state. */
function applySgr(state: SgrState, params: string): void {
  // "ESC[m" is shorthand for a full reset.
  const codes = (params === "" ? "0" : params).split(";").map((c) => (c === "" ? 0 : Number(c)));
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (Number.isNaN(code)) continue;
    if (code === 0) {
      delete state.color;
      delete state.background;
      state.bold = state.dim = state.italic = state.underline = state.inverse = false;
    } else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 22) state.bold = state.dim = false;
    else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code >= 30 && code <= 37) state.color = ANSI_FG[code - 30];
    else if (code === 39) delete state.color;
    else if (code >= 40 && code <= 47) state.background = ANSI_FG[code - 40];
    else if (code === 49) delete state.background;
    else if (code >= 90 && code <= 97) state.color = ANSI_BRIGHT_FG[code - 90];
    else if (code >= 100 && code <= 107) state.background = ANSI_BRIGHT_FG[code - 100];
    else if (code === 38 || code === 48) {
      // Extended colour: 38;5;<n> (256) or 38;2;<r>;<g>;<b> (24-bit).
      const isFg = code === 38;
      const mode = codes[i + 1];
      if (mode === 5) {
        const n = codes[i + 2];
        i += 2;
        const mapped =
          n >= 0 && n <= 7 ? ANSI_FG[n] : n >= 8 && n <= 15 ? ANSI_BRIGHT_FG[n - 8] : undefined;
        if (mapped !== undefined) {
          if (isFg) state.color = mapped;
          else state.background = mapped;
        }
        // Non-basic 256 colours: consume the params, keep the current colour.
      } else if (mode === 2) {
        i += 4; // consume r;g;b - unthemable, dropped
      }
    }
    // Everything else (blink, fonts, …): ignore.
  }
}

function pushSpan(spans: AnsiSpan[], text: string, state: SgrState): void {
  if (text === "") return;
  const span: AnsiSpan = { text };
  if (state.color !== undefined) span.color = state.color;
  if (state.background !== undefined) span.background = state.background;
  if (state.bold) span.bold = true;
  if (state.dim) span.dim = true;
  if (state.italic) span.italic = true;
  if (state.underline) span.underline = true;
  if (state.inverse) span.inverse = true;
  spans.push(span);
}

// ESC[…<letter> (CSI, incl. SGR when the letter is `m`), ESC]…BEL/ST (OSC),
// or a lone ESC+char. Anything matched that isn't SGR is stripped.
const ANSI_SEQUENCE = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;

/**
 * Parse one output line into styled spans. A line with no escape codes
 * returns a single unstyled span. Progress lines that rewrite themselves
 * with `\r` collapse to their final segment (a scrollback can't re-render
 * in place, so only the last state is shown).
 */
export function parseAnsiLine(line: string): AnsiSpan[] {
  const effective = line.includes("\r") ? lastCarriageSegment(line) : line;
  if (!effective.includes("\x1b")) return effective === "" ? [] : [{ text: effective }];

  const spans: AnsiSpan[] = [];
  const state: SgrState = {};
  let lastIndex = 0;
  ANSI_SEQUENCE.lastIndex = 0;
  for (let m = ANSI_SEQUENCE.exec(effective); m !== null; m = ANSI_SEQUENCE.exec(effective)) {
    pushSpan(spans, effective.slice(lastIndex, m.index), state);
    if (m[1] !== undefined) applySgr(state, m[1]);
    lastIndex = m.index + m[0].length;
  }
  pushSpan(spans, effective.slice(lastIndex), state);
  return spans;
}

/** The last non-empty `\r`-separated segment (progress lines overwrite
 *  themselves; the final state is what the user would have seen last). */
function lastCarriageSegment(line: string): string {
  const segments = line.split("\r");
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] !== "") return segments[i];
  }
  return "";
}

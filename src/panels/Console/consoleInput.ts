// Input classification for the Git Console's terminal-style prompt.
// Everything the user types is a git command, except a tiny set of control
// verbs (git bash muscle memory): `clear`/`cls` wipe the scrollback, and
// `q`/`:q` cancel the running command the way they'd quit a pager. Pure so
// the decision table is unit-tested.

export type ConsoleAction =
  /** Run `git <command>` (any leading `git ` has been stripped). */
  | { kind: "git"; command: string }
  | { kind: "clear" }
  | { kind: "cancel" }
  /** Nothing to do (empty input). */
  | { kind: "noop" }
  /** Print `message` as a system line instead of running anything. */
  | { kind: "hint"; message: string };

/** First tokens that give away a shell habit - worth a pointer instead of
 *  git's confusing "not a git command" error. */
const SHELL_COMMANDS = new Set(["ls", "cd", "pwd", "cat", "echo", "dir", "sh", "bash", "exit"]);

const CANCEL_VERBS = new Set(["q", ":q"]);

export function classifyConsoleInput(raw: string, running: boolean): ConsoleAction {
  const text = raw.trim();
  if (text === "") return { kind: "noop" };
  const lower = text.toLowerCase();

  if (running) {
    // While a command runs the prompt is a control channel only - like a
    // terminal, where typed input doesn't start a second command.
    if (CANCEL_VERBS.has(lower)) return { kind: "cancel" };
    return {
      kind: "hint",
      message: "a command is running — q, :q, or Ctrl+C cancels it",
    };
  }

  if (lower === "clear" || lower === "cls") return { kind: "clear" };
  if (CANCEL_VERBS.has(lower)) return { kind: "hint", message: "nothing to quit" };

  const firstToken = lower.split(/\s+/, 1)[0];
  if (SHELL_COMMANDS.has(firstToken)) {
    return {
      kind: "hint",
      message: `'${firstToken}' is not available — the console only runs git commands (try \`status\`)`,
    };
  }

  // The `git` prefix is implied; typing it anyway is fine.
  const command = text.startsWith("git ") ? text.slice(4).trim() : text;
  return { kind: "git", command };
}

/**
 * What the Space KEY does on the console prompt. While a command runs, the
 * empty prompt is a control channel (like less's `:` mode - it takes
 * commands, never arbitrary text): Space pages when the pager holds and is
 * swallowed otherwise. Swallowing matters for HELD space: a feed clears the
 * paused flag optimistically, and the key repeats that land before the next
 * pause announcement would otherwise type literal spaces into the input -
 * which then blocked all further paging until deleted.
 */
export function spaceKeyAction(
  running: boolean,
  paused: boolean,
  input: string,
): "feed" | "swallow" | "type" {
  if (!running || input !== "") return "type";
  return paused ? "feed" : "swallow";
}

/**
 * Whether a scroll position still counts as "at the bottom" (auto-follow
 * stays on). The tolerance is a text line, NOT a couple of pixels: with
 * display scaling (Windows 125%/150%) `scrollTop` is fractional while
 * `scrollHeight`/`clientHeight` are rounded, so the residual at the true
 * bottom can be a few pixels - a too-tight epsilon silently un-pins the
 * view and output lands below the fold, looking like a hung command.
 */
export function isScrolledToBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  lineHeightPx: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight < Math.max(2, lineHeightPx);
}

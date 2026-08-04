import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { consoleCancel, consoleExec, consoleFeed } from "../../lib/commands";
import { formatAppError } from "../../lib/types";
import { useActiveRepo } from "../../store/repos";
import { EMPTY_CONSOLE_SESSION, useConsoleStore, type ConsoleLine } from "../../store/console";
import { parseAnsiLine, type AnsiSpan } from "./ansi";
import { classifyConsoleInput, isScrolledToBottom, spaceKeyAction } from "./consoleInput";

/** Delay before the how-to-cancel affordance appears, so fast commands
 *  never flicker it (busy-feedback convention). */
const CANCEL_HINT_DELAY_MS = 150;

/**
 * Git Console panel (DESIGN.md §7.4), terminal-style: a scrollback with the
 * `$ git` prompt pinned below it, no buttons. Enter runs; `clear` wipes the
 * scrollback; `q` / `:q` / Ctrl+C cancel the running command
 * (`consoleInput.ts` holds the decision table). Output is PAGED like a
 * pager: commands get one screenful of stdout credit and then hold
 * (`-- More --`), git itself blocked on the pipe, until Space/Enter feeds
 * the next page or `q` quits.
 *
 * Sessions are per repository (`store/console.ts`): scrollback, history,
 * and the in-flight op follow the repo, not the panel. Output events are
 * routed into the store by AppLayout, so background repos keep receiving.
 */
export function ConsolePanel() {
  const activeRepo = useActiveRepo();
  const repoId = activeRepo?.id ?? null;
  const queryClient = useQueryClient();
  const session = useConsoleStore((s) =>
    repoId ? (s.sessions[repoId] ?? EMPTY_CONSOLE_SESSION) : EMPTY_CONSOLE_SESSION,
  );
  const { lines, history, running, paused, opId, draft: input } = session;

  // The prompt draft lives in the per-repo session (a half-typed command
  // must not follow the user to another repo tab).
  const setInput = useCallback(
    (value: string) => {
      if (repoId) useConsoleStore.getState().setDraft(repoId, value);
    },
    [repoId],
  );
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [showCancelHint, setShowCancelHint] = useState(false);
  const scrollArea = useRef<HTMLDivElement | null>(null);
  /** Terminal scroll rule: new output only follows to the bottom while the
   *  view IS at the bottom. Scrolling up to read (a long `git log`, …) must
   *  never be yanked away by arriving batches. */
  const pinnedToBottom = useRef(true);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The cancel affordance is delayed busy feedback: only commands that
  // actually take a moment surface it.
  useEffect(() => {
    if (!running) {
      setShowCancelHint(false);
      return;
    }
    const h = setTimeout(() => setShowCancelHint(true), CANCEL_HINT_DELAY_MS);
    return () => clearTimeout(h);
  }, [running]);

  // Scroll the scroll area itself - NOT scrollIntoView on a sentinel, which
  // may also scroll ancestor containers (the dock) as a side effect.
  const scrollToBottom = useCallback(() => {
    const el = scrollArea.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Layout effect: the follow-scroll lands before paint, so arriving
  // batches never flash at the old position.
  useLayoutEffect(() => {
    if (pinnedToBottom.current) scrollToBottom();
  }, [lines, paused, scrollToBottom]);

  // Switching repos swaps in that repo's session: land at its prompt.
  useLayoutEffect(() => {
    setHistoryIndex(null);
    pinnedToBottom.current = true;
    scrollToBottom();
  }, [repoId, scrollToBottom]);

  const onScroll = () => {
    const el = scrollArea.current;
    if (!el) return;
    const lineHeight = parseFloat(getComputedStyle(el).fontSize) * 1.3 || 16;
    pinnedToBottom.current = isScrolledToBottom(
      el.scrollHeight,
      el.scrollTop,
      el.clientHeight,
      lineHeight,
    );
  };

  /** Lines of output that fit the current viewport - the pager's page. */
  const pageSize = () => {
    const el = scrollArea.current;
    if (!el) return 40;
    const fontPx = parseFloat(getComputedStyle(el).fontSize) || 12;
    // Approximate rendered line height for the monospace rows.
    return Math.max(10, Math.floor(el.clientHeight / (fontPx * 1.3)) - 1);
  };

  const feedNextPage = useCallback(() => {
    if (!repoId || !opId) return;
    // Optimistic: the backend confirms by either sending more output or
    // re-announcing the pause.
    useConsoleStore.getState().setPaused(repoId, false);
    consoleFeed(opId, pageSize()).catch(() => {
      /* op already gone - its Finished event settles the UI */
    });
  }, [repoId, opId]);

  const cancelRunning = useCallback(async () => {
    if (!repoId || !opId) return;
    // Echo ^C immediately, before the round trip - the terminal-instant
    // acknowledgment. The authoritative [killed …] line follows with the
    // Finished event once the process is reaped.
    useConsoleStore.getState().append(repoId, [{ stream: "system", text: "^C" }]);
    try {
      const accepted = await consoleCancel(repoId, opId);
      // An accepted cancel reports itself via the Finished event.
      if (!accepted) {
        useConsoleStore
          .getState()
          .append(repoId, [
            { stream: "system", text: "nothing to cancel — the command already finished" },
          ]);
      }
    } catch (e) {
      useConsoleStore
        .getState()
        .append(repoId, [{ stream: "system", text: `cancel error: ${formatAppError(e)}` }]);
    }
  }, [repoId, opId]);

  const submit = async () => {
    if (!repoId) return;
    const store = useConsoleStore.getState();
    const action = classifyConsoleInput(input, running);
    setInput("");
    setHistoryIndex(null);
    // Enter always jumps back to the prompt, like a terminal.
    pinnedToBottom.current = true;
    scrollToBottom();
    if (action.kind === "noop") {
      // Bare Enter while the pager holds = next page (less behaviour).
      if (paused) feedNextPage();
      return;
    }
    if (action.kind === "clear") {
      store.clear(repoId);
      return;
    }
    if (action.kind === "cancel") {
      await cancelRunning();
      return;
    }
    if (action.kind === "hint") {
      store.append(repoId, [{ stream: "system", text: action.message }]);
      return;
    }
    const text = action.command;
    store.pushHistory(repoId, text);
    store.append(repoId, [{ stream: "system", text: `$ git ${text}` }]);
    try {
      const handle = await consoleExec(repoId, text, pageSize());
      const replay = store.beginOp(repoId, handle.op_id);
      if (replay?.finished) queryClient.invalidateQueries({ queryKey: [repoId] });
    } catch (e) {
      store.append(repoId, [{ stream: "system", text: `error: ${formatAppError(e)}` }]);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === " ") {
      // Space is a pager key while a command runs (see spaceKeyAction):
      // "feed" pages, "swallow" keeps held-space repeats from typing
      // literal spaces between pages, "type" is normal text entry.
      const action = spaceKeyAction(running, paused, input);
      if (action !== "type") {
        e.preventDefault();
        if (action === "feed") feedNextPage();
      }
    } else if (e.key === "c" && e.ctrlKey && !e.altKey && !e.metaKey) {
      // Terminal muscle memory: Ctrl+C cancels — but copy still wins while
      // text is selected.
      if (running && !window.getSelection()?.toString()) {
        e.preventDefault();
        cancelRunning();
      }
    } else if (e.key === "ArrowUp") {
      if (history.length === 0) return;
      e.preventDefault();
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setInput(history[next]);
    } else if (e.key === "ArrowDown") {
      if (historyIndex === null) return;
      e.preventDefault();
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(null);
        setInput("");
      } else {
        setHistoryIndex(next);
        setInput(history[next]);
      }
    }
  };

  // No idle suggestion: a terminal prompt sits empty. The placeholder only
  // carries state the user can't see otherwise (no repo / how to cancel).
  const placeholder = !activeRepo
    ? "open a repository first"
    : running && showCancelHint && !paused
      ? "q or Ctrl+C to cancel"
      : "";

  const focusUnlessSelecting = () => {
    if (!window.getSelection()?.toString()) inputRef.current?.focus();
  };

  return (
    <div
      className="legit-panel"
      style={{
        background: "var(--console-bg)",
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", monospace',
        fontSize: "var(--fz-md)",
        color: "var(--console-fg)",
      }}
    >
      <div
        className="legit-panel__body"
        ref={scrollArea}
        onScroll={onScroll}
        onClick={focusUnlessSelecting}
      >
        {lines.map((line) => (
          <ConsoleLineRow key={line.id} line={line} />
        ))}
        {paused && (
          <div style={{ color: "var(--subtle-fg)" }}>
            -- More --  (Space: next page · q: quit)
          </div>
        )}
      </div>
      {/* The prompt is pinned below the scrollback, like a terminal's input
          line: always visible, never scrolled away. Padding mirrors the
          body's so the columns align. */}
      <div
        onClick={focusUnlessSelecting}
        style={{ display: "flex", alignItems: "baseline", gap: "0.5em", padding: "0 8px 8px" }}
      >
        <span style={{ color: running ? "var(--subtle-fg)" : "var(--console-prompt-fg)" }}>
          $ git
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={!activeRepo}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            padding: 0,
            color: "inherit",
            font: "inherit",
            caretColor: "var(--console-prompt-fg)",
          }}
          autoFocus
        />
      </div>
    </div>
  );
}

/** One scrollback line. Memoized so appending output only ANSI-parses the
 *  new lines, not the whole (up to 5000-line) history on every batch. */
const ConsoleLineRow = memo(function ConsoleLineRow({ line }: { line: ConsoleLine }) {
  if (line.stream === "system") {
    return (
      <div style={{ whiteSpace: "pre-wrap", color: "var(--subtle-fg)" }}>{line.text}</div>
    );
  }
  const defaultFg =
    line.stream === "stderr" ? "var(--console-stderr-fg)" : "var(--console-stdout-fg)";
  const spans = parseAnsiLine(line.text);
  return (
    <div style={{ whiteSpace: "pre-wrap", color: defaultFg }}>
      {spans.length === 0
        ? // Preserve empty output lines as vertical space.
          " "
        : spans.map((span, i) => (
            <span key={i} style={spanStyle(span, defaultFg)}>
              {span.text}
            </span>
          ))}
    </div>
  );
});

function spanStyle(span: AnsiSpan, defaultFg: string): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (span.inverse) {
    // SGR 7: swap foreground and background (git's whitespace-error marker).
    style.color = span.background ?? "var(--console-bg)";
    style.backgroundColor = span.color ?? defaultFg;
  } else {
    if (span.color !== undefined) style.color = span.color;
    if (span.background !== undefined) style.backgroundColor = span.background;
  }
  if (span.bold) style.fontWeight = 600;
  if (span.dim) style.opacity = 0.7;
  if (span.italic) style.fontStyle = "italic";
  if (span.underline) style.textDecoration = "underline";
  return style;
}

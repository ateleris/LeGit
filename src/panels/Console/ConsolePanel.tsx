import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { consoleCancel, consoleExec } from "../../lib/commands";
import { onConsoleOutput } from "../../lib/events";
import { formatAppError } from "../../lib/types";
import { useActiveRepo } from "../../store/repos";

interface LogLine {
  id: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

/**
 * v0.1 Git Console panel (DESIGN.md §7.4). Drives the runner directly via
 * `console_exec` and listens for streaming output events. On completion,
 * invalidates the active repo's React Query cache (coarse invalidation per
 * §5.3 / §7.4).
 */
export function ConsolePanel() {
  const activeRepo = useActiveRepo();
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [currentOpId, setCurrentOpId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const linesEnd = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const nextId = useRef(0);

  const append = useCallback((stream: LogLine["stream"], text: string) => {
    setLines((prev) => {
      const id = ++nextId.current;
      const next = [...prev, { id, stream, text }];
      if (next.length > 5000) next.splice(0, next.length - 5000);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancel: undefined | (() => void);
    onConsoleOutput((payload) => {
      // Only display output from our current op. Other panels (if any) may
      // run concurrent ops in v1; in v0.1 the console is the only producer
      // but the filter keeps the contract clean.
      if (payload.op_id !== currentOpId) return;
      if (payload.event.kind === "stdout") append("stdout", payload.event.line);
      else if (payload.event.kind === "stderr") append("stderr", payload.event.line);
      else if (payload.event.kind === "finished") {
        const status =
          payload.event.exit_code === null
            ? "killed"
            : `exit ${payload.event.exit_code}`;
        append(
          "system",
          `[${status}, ${payload.event.duration_ms} ms]`
        );
        setRunning(false);
        setCurrentOpId(null);
        if (activeRepo) {
          // §5.3: invalidate everything for the active repo after a Console
          // command completes. Coarse but correct.
          queryClient.invalidateQueries({ queryKey: [activeRepo.id] });
        }
      }
    }).then((unlisten) => {
      cancel = unlisten;
    });
    return () => {
      cancel?.();
    };
  }, [append, activeRepo, queryClient, currentOpId]);

  useEffect(() => {
    linesEnd.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  const submit = async () => {
    const raw = input.trim();
    const text = raw.startsWith("git ") ? raw.slice(4) : raw;
    if (!text) return;
    if (!activeRepo) {
      append("system", "No active repository. Open one with the + button first.");
      return;
    }
    if (running) {
      append("system", "A command is already running. Cancel it first.");
      return;
    }
    setInput("");
    setHistory((h) => (h[h.length - 1] === text ? h : [...h, text]));
    setHistoryIndex(null);
    append("system", `$ git ${text}`);
    try {
      setRunning(true);
      const handle = await consoleExec(activeRepo.id, text);
      setCurrentOpId(handle.op_id);
    } catch (e) {
      append("system", `error: ${formatAppError(e)}`);
      setRunning(false);
      setCurrentOpId(null);
    }
  };

  const cancel = async () => {
    if (!activeRepo || !currentOpId) return;
    try {
      await consoleCancel(activeRepo.id, currentOpId);
      append("system", "Sent cancellation…");
    } catch (e) {
      append("system", `cancel error: ${formatAppError(e)}`);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
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

  return (
    <div className="legit-panel" style={{ background: "var(--console-bg)" }}>
      <div
        className="legit-panel__body"
        onClick={() => {
          if (!window.getSelection()?.toString()) inputRef.current?.focus();
        }}
        style={{
          fontFamily:
            'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", monospace',
          fontSize: 12,
          color: "var(--console-fg)",
        }}
      >
        {lines.map((line) => (
          <div
            key={line.id}
            style={{
              whiteSpace: "pre-wrap",
              color:
                line.stream === "stderr"
                  ? "var(--console-stderr-fg)"
                  : line.stream === "system"
                  ? "var(--subtle-fg)"
                  : "var(--console-stdout-fg)",
            }}
          >
            {line.text}
          </div>
        ))}
        <div ref={linesEnd} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: 8,
          borderTop: "1px solid var(--panel-border)",
        }}
      >
        <span style={{ color: "var(--console-prompt-fg)" }}>$ git</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={activeRepo ? "status --short" : "open a repository first"}
          disabled={!activeRepo}
          style={{ flex: 1 }}
          autoFocus
        />
        <button type="submit" className="primary" disabled={!activeRepo || running}>
          Run
        </button>
        <button type="button" onClick={() => setLines([])}>Clear</button>
        {running && (
          <button type="button" className="danger" onClick={cancel}>
            Cancel
          </button>
        )}
      </form>
    </div>
  );
}

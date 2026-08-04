import { create } from "zustand";
import type { ConsoleEventPayload } from "../lib/types";

/** One scrollback line in a repo's console session. */
export interface ConsoleLine {
  id: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

/** A repo's console: scrollback, history, and the in-flight op. Sessions
 *  are PER REPOSITORY (like `RepoSession` in the backend): switching repo
 *  tabs must never show another repo's output, and a command that is
 *  running or pager-paused in a background repo keeps receiving output and
 *  is intact when the user switches back. */
export interface ConsoleSession {
  lines: ConsoleLine[];
  history: string[];
  /** Typed-but-not-submitted prompt text. Per repo like everything else:
   *  half-typed commands must not follow the user across repo tabs. */
  draft: string;
  /** The running op's id, or null when idle. */
  opId: string | null;
  running: boolean;
  /** Pager state: the op is holding output, waiting for a feed. */
  paused: boolean;
}

const MAX_LINES = 5000; // ring buffer per repo
let nextLineId = 1;

export const EMPTY_CONSOLE_SESSION: ConsoleSession = {
  lines: [],
  history: [],
  draft: "",
  opId: null,
  running: false,
  paused: false,
};

/** How many not-yet-registered ops may hold stashed payloads (see
 *  `handleBatch`); the oldest is dropped beyond this. */
const MAX_STASHED_OPS = 4;

interface ConsoleStore {
  sessions: Record<string, ConsoleSession>;
  /** op id -> repo id, so batched output events route to the right session
   *  regardless of which repo is active when they arrive. */
  opRepo: Record<string, string>;
  /** Payloads that arrived before their op was registered: event delivery
   *  and the `console_exec` response both cross IPC, so a fast command's
   *  first batch can beat the exec response that carries the op id.
   *  `beginOp` replays these. */
  pendingPayloads: Record<string, ConsoleEventPayload[]>;
  append: (repoId: string, batch: { stream: ConsoleLine["stream"]; text: string }[]) => void;
  clear: (repoId: string) => void;
  setDraft: (repoId: string, draft: string) => void;
  pushHistory: (repoId: string, command: string) => void;
  /** Record a just-started op for the repo, replaying any stashed payloads.
   *  Returns the replay outcome when a stashed batch already finished the
   *  op (the caller invalidates caches then), else null. */
  beginOp: (repoId: string, opId: string) => { finished: boolean } | null;
  /** Mark the repo's op finished (Finished arrived or exec failed). */
  endOp: (repoId: string) => void;
  setPaused: (repoId: string, paused: boolean) => void;
  /** Route one batched output payload into the owning session. Returns the
   *  repo id it belonged to (for cache invalidation on finish), or null for
   *  an unknown/stale op. */
  handleBatch: (payload: ConsoleEventPayload) => { repoId: string; finished: boolean } | null;
  /** Drop a closed repo's session so it cannot leak or resurrect. */
  dropRepo: (repoId: string) => void;
}

function capped(lines: ConsoleLine[]): ConsoleLine[] {
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  return lines;
}

function withSession(
  sessions: Record<string, ConsoleSession>,
  repoId: string,
  update: (s: ConsoleSession) => Partial<ConsoleSession>,
): Record<string, ConsoleSession> {
  const session = sessions[repoId] ?? EMPTY_CONSOLE_SESSION;
  return { ...sessions, [repoId]: { ...session, ...update(session) } };
}

export const useConsoleStore = create<ConsoleStore>((set, get) => ({
  sessions: {},
  opRepo: {},
  pendingPayloads: {},

  append: (repoId, batch) => {
    if (batch.length === 0) return;
    set((s) => ({
      sessions: withSession(s.sessions, repoId, (session) => ({
        lines: capped([
          ...session.lines,
          ...batch.map((b) => ({ id: nextLineId++, ...b })),
        ]),
      })),
    }));
  },

  clear: (repoId) =>
    set((s) => ({
      sessions: withSession(s.sessions, repoId, () => ({ lines: [] })),
    })),

  setDraft: (repoId, draft) =>
    set((s) => ({
      sessions: withSession(s.sessions, repoId, () => ({ draft })),
    })),

  pushHistory: (repoId, command) =>
    set((s) => ({
      sessions: withSession(s.sessions, repoId, (session) => ({
        history:
          session.history[session.history.length - 1] === command
            ? session.history
            : [...session.history, command],
      })),
    })),

  beginOp: (repoId, opId) => {
    let stashed: ConsoleEventPayload[] = [];
    set((s) => {
      stashed = s.pendingPayloads[opId] ?? [];
      const pendingPayloads = { ...s.pendingPayloads };
      delete pendingPayloads[opId];
      return {
        sessions: withSession(s.sessions, repoId, () => ({
          opId,
          running: true,
          paused: false,
        })),
        opRepo: { ...s.opRepo, [opId]: repoId },
        pendingPayloads,
      };
    });
    let finished = false;
    for (const payload of stashed) {
      if (get().handleBatch(payload)?.finished) finished = true;
    }
    return stashed.length > 0 ? { finished } : null;
  },

  endOp: (repoId) =>
    set((s) => {
      const opId = s.sessions[repoId]?.opId;
      const opRepo = { ...s.opRepo };
      if (opId) delete opRepo[opId];
      return {
        sessions: withSession(s.sessions, repoId, () => ({
          opId: null,
          running: false,
          paused: false,
        })),
        opRepo,
      };
    }),

  setPaused: (repoId, paused) =>
    set((s) => ({
      sessions: withSession(s.sessions, repoId, () => ({ paused })),
    })),

  handleBatch: (payload) => {
    const { opRepo } = get();
    const repoId = opRepo[payload.op_id];
    if (repoId === undefined) {
      // Unknown op: stash for a `beginOp` that may still be in flight.
      set((s) => {
        const pendingPayloads = { ...s.pendingPayloads };
        pendingPayloads[payload.op_id] = [...(pendingPayloads[payload.op_id] ?? []), payload];
        const keys = Object.keys(pendingPayloads);
        if (keys.length > MAX_STASHED_OPS) delete pendingPayloads[keys[0]];
        return { pendingPayloads };
      });
      return null;
    }

    const batch: { stream: ConsoleLine["stream"]; text: string }[] = [];
    let finished: { exit_code: number | null; duration_ms: number } | null = null;
    for (const event of payload.events) {
      if (event.kind === "stdout") batch.push({ stream: "stdout", text: event.line });
      else if (event.kind === "stderr") batch.push({ stream: "stderr", text: event.line });
      else finished = event;
    }
    if (finished) {
      const status = finished.exit_code === null ? "killed" : `exit ${finished.exit_code}`;
      batch.push({ stream: "system", text: `[${status}, ${finished.duration_ms} ms]` });
    }

    get().append(repoId, batch);
    if (finished) get().endOp(repoId);
    else get().setPaused(repoId, payload.paused);
    return { repoId, finished: finished !== null };
  },

  dropRepo: (repoId) =>
    set((s) => {
      if (!(repoId in s.sessions)) return s;
      const sessions = { ...s.sessions };
      delete sessions[repoId];
      const opRepo = Object.fromEntries(
        Object.entries(s.opRepo).filter(([, r]) => r !== repoId),
      );
      return { sessions, opRepo };
    }),
}));

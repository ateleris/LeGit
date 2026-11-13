// Root of the Work Log window (`wl-main`): per-day overview of the user's
// commits, stashes and uncommitted changes across all open repos. Day list
// left, per-repo drilldown middle, read-only diff right. A pure reporting
// surface - nothing here mutates a repo.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Orientation,
  SplitviewReact,
  type ISplitviewPanelProps,
  type SplitviewReadyEvent,
} from "dockview-react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/commands";
import type {
  CommitFileChange,
  DiffRequest,
  FileState,
  StashEntry,
  WorkLogCommit,
} from "../lib/types";
import { formatAppError } from "../lib/errors";
import { onGlobalSettingsChanged } from "../lib/events";
import { useRepoChangeListener } from "../lib/useRepoChangeListener";
import { revealAndSignal } from "../lib/windowReveal";
import { STALE } from "../lib/queryTiming";
import { useSettingsStore, UI_FONT_SIZE_DEFAULT } from "../store/settings";
import { bootUiPrefs, refreshUiPrefs } from "./uiPrefs";
import { ErrorBoundary } from "../panels/ErrorBoundary";
import { Toasts } from "../panels/Toasts";
import { DevRibbon } from "../panels/DevRibbon";
import { PanelLoadingBar } from "../panels/shared/PanelLoadingBar";
import { ReadOnlyFileDiff } from "../panels/Diff/CommitFileDiff";
import {
  buildWorkLog,
  collectSweepErrors,
  groupRepoTabs,
  shortRef,
  timeOfInOffset,
  type OlderBucket,
  type RepoBlock,
  type UncommittedRow,
  type WorkLogDay,
  type WorkLogView,
} from "./workLog";

const SPLIT_KEY = "legit.workLogWindow.split";
const RANGE_KEY = "legit.workLogWindow.rangeDays";
const RANGE_OPTIONS = [7, 14, 30];
const DAY_SECS = 86400;

type DiffSelection =
  | { kind: "commit"; repoId: string; sha: string; path: string; oldPath: string | null }
  | { kind: "working"; repoId: string; path: string; oldPath: string | null };

function selectionKey(sel: DiffSelection): string {
  return sel.kind === "commit"
    ? `c:${sel.repoId}:${sel.sha}:${sel.path}`
    : `w:${sel.repoId}:${sel.path}`;
}

function loadRange(): number {
  try {
    const n = Number(localStorage.getItem(RANGE_KEY));
    return RANGE_OPTIONS.includes(n) ? n : 14;
  } catch {
    return 14;
  }
}

function timeOf(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dateOf(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const STATE_LETTER: Record<FileState, string> = {
  Modified: "M",
  Added: "A",
  Deleted: "D",
  Renamed: "R",
  Copied: "C",
  Untracked: "A",
  Ignored: "I",
  Conflicted: "!",
  SubmoduleChanged: "S",
  SubmoduleDirty: "S",
};

async function revealOnceThemed() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
  try {
    await revealAndSignal(getCurrentWindow());
  } catch (e) {
    console.warn("failed to show the work log window", e);
  }
}

export function WorkLogWindowShell() {
  const [booted, setBooted] = useState(false);

  useRepoChangeListener();

  useEffect(() => {
    (async () => {
      try {
        await bootUiPrefs();
      } finally {
        void revealOnceThemed();
        setBooted(true);
      }
    })();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onGlobalSettingsChanged(() => {
      void refreshUiPrefs();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <ErrorBoundary>
      {booted ? <WorkLogWindowBody /> : null}
      <Toasts />
      <DevRibbon />
    </ErrorBoundary>
  );
}

interface WindowState {
  view: WorkLogView;
  busy: boolean;
  sweepErrors: { name: string; message: string }[];
  selectedDay: string;
  setSelectedDay: (key: string) => void;
  selection: DiffSelection | null;
  setSelection: (sel: DiffSelection | null) => void;
}

const WindowStateContext = createContext<WindowState | null>(null);

export function WorkLogWindowBody() {
  const queryClient = useQueryClient();
  const [rangeDays, setRangeDays] = useState(loadRange);
  const [identityFilter, setIdentityFilter] = useState<string | null>(null);
  const [nowUnix, setNowUnix] = useState(() => Math.floor(Date.now() / 1000));
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selection, setSelection] = useState<DiffSelection | null>(null);

  // Cutoff: start of the oldest requested day, one extra day of slack for
  // timezone skew; the precise cut happens in buildWorkLog's bucketing.
  const sinceUnix = nowUnix - (rangeDays + 1) * DAY_SECS;

  const reposQ = useQuery({
    queryKey: ["global", "work-log-repos"],
    queryFn: () => api.listRepos(),
    staleTime: STALE.live,
  });
  const repos = useMemo(() => reposQ.data ?? [], [reposQ.data]);

  const workLogQs = useQueries({
    queries: repos.map((r) => ({
      queryKey: [r.id, "log", "work-log", sinceUnix],
      queryFn: () => api.repoWorkLog(r.id, sinceUnix),
      staleTime: STALE.live,
    })),
  });
  const stashQs = useQueries({
    queries: repos.map((r) => ({
      queryKey: [r.id, "stashes", "work-log"],
      queryFn: () => api.repoStashes(r.id),
      staleTime: STALE.live,
    })),
  });
  const uncommittedQs = useQueries({
    queries: repos.map((r) => ({
      queryKey: [r.id, "status", "work-log"],
      queryFn: () => api.repoWorkLogUncommitted(r.id),
      staleTime: STALE.live,
    })),
  });
  const identityQs = useQueries({
    queries: repos.map((r) => ({
      queryKey: [r.id, "identity", "work-log"],
      queryFn: () => api.repoResolvedIdentity(r.id),
      staleTime: STALE.stable,
    })),
  });
  const profilesQ = useQuery({
    queryKey: ["global", "profiles"],
    queryFn: () => api.listGitProfiles(),
    staleTime: STALE.stable,
  });

  const view = useMemo(() => {
    const groups = groupRepoTabs(
      repos.map((r, i) => ({
        repoId: r.id,
        name: r.name,
        // Until the sweep answers, each tab is its own group (no wrong merge).
        commonDir: workLogQs[i]?.data?.common_dir ?? `pending:${r.id}`,
      }))
    );
    const commitsByRepo: Record<string, WorkLogView["days"][number]["repoBlocks"][number]["commits"]> = {};
    const stashesByRepo: Record<string, StashEntry[]> = {};
    const uncommittedByRepo: Record<string, UncommittedRow[]> = {};
    repos.forEach((r, i) => {
      commitsByRepo[r.id] = workLogQs[i]?.data?.commits ?? [];
      stashesByRepo[r.id] = stashQs[i]?.data ?? [];
      uncommittedByRepo[r.id] = (uncommittedQs[i]?.data ?? []).map((u) => ({
        repoId: r.id,
        repoName: r.name,
        path: u.path,
        oldPath: u.old_path,
        state: u.state,
        staged: u.staged,
        mtimeUnix: u.mtime_unix,
      }));
    });
    const allowedEmails = [
      ...(profilesQ.data ?? []).flatMap((p) => (p.userEmail ? [p.userEmail] : [])),
      ...identityQs.flatMap((q) => (q.data?.user_email ? [q.data.user_email] : [])),
    ];
    return buildWorkLog({
      groups,
      commitsByRepo,
      stashesByRepo,
      uncommittedByRepo,
      allowedEmails,
      identityFilter,
      rangeDays,
      nowUnix,
      localTzOffsetMinutes: -new Date().getTimezoneOffset(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, workLogQs, stashQs, uncommittedQs, identityQs, profilesQ.data, identityFilter, rangeDays, nowUnix]);

  const sweepErrors = collectSweepErrors(
    repos,
    [
      { label: "sweep", queries: workLogQs },
      { label: "stashes", queries: stashQs },
      { label: "uncommitted", queries: uncommittedQs },
    ],
    formatAppError
  );
  const busy =
    reposQ.isFetching ||
    workLogQs.some((q) => q.isFetching) ||
    stashQs.some((q) => q.isFetching) ||
    uncommittedQs.some((q) => q.isFetching);

  const chooseRange = (n: number) => {
    setRangeDays(n);
    try {
      localStorage.setItem(RANGE_KEY, String(n));
    } catch {
      // Storage unavailable: the range just is not remembered.
    }
  };
  const refresh = () => {
    setNowUnix(Math.floor(Date.now() / 1000));
    void queryClient.invalidateQueries();
  };

  const base = useSettingsStore((s) => s.settings?.ui_font_size ?? UI_FONT_SIZE_DEFAULT);
  const onReady = (e: SplitviewReadyEvent) => {
    let restored = false;
    try {
      const saved = localStorage.getItem(SPLIT_KEY);
      if (saved) {
        e.api.fromJSON(JSON.parse(saved));
        restored = true;
      }
    } catch {
      // Corrupt or unavailable snapshot: fall through to the defaults.
    }
    if (!restored) {
      e.api.addPanel({
        id: "days",
        component: "days",
        size: Math.round(base * 16),
        minimumSize: Math.round(base * 11),
      });
      e.api.addPanel({
        id: "detail",
        component: "detail",
        size: Math.round(base * 30),
        minimumSize: Math.round(base * 18),
      });
      e.api.addPanel({ id: "diff", component: "diff", minimumSize: Math.round(base * 16) });
    }
    e.api.onDidLayoutChange(() => {
      try {
        localStorage.setItem(SPLIT_KEY, JSON.stringify(e.api.toJSON()));
      } catch {
        // Storage unavailable (private mode): the split just is not remembered.
      }
    });
  };

  const state: WindowState = {
    view,
    busy,
    sweepErrors,
    selectedDay: selectedDay ?? view.days[0]?.key ?? "",
    setSelectedDay: (key) => {
      setSelectedDay(key);
      setSelection(null);
    },
    selection,
    setSelection,
  };

  if (reposQ.data !== undefined && repos.length === 0) {
    return (
      <div
        className="legit-panel"
        style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}
      >
        <span className="legit-subtle">Open a repository to see your work log.</span>
      </div>
    );
  }

  return (
    <WindowStateContext.Provider value={state}>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100vw" }}>
        <PanelLoadingBar active={busy} />
        <div
          className="legit-panel__toolbar"
          style={{ display: "flex", gap: "0.5em", alignItems: "center", flex: "none" }}
        >
          <select
            value={rangeDays}
            onChange={(e) => chooseRange(Number(e.target.value))}
            title="How many days the work log sweeps"
          >
            {RANGE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                Last {n} days
              </option>
            ))}
          </select>
          <select
            value={identityFilter ?? ""}
            onChange={(e) => setIdentityFilter(e.target.value || null)}
            title="Only commits authored under this email"
          >
            <option value="">All identities</option>
            {view.emails.map((email) => (
              <option key={email.toLowerCase()} value={email}>
                {email}
              </option>
            ))}
          </select>
          <button onClick={refresh}>Refresh</button>
        </div>
        {/* The theme class scopes the --dv-* -> token mapping (global.css). */}
        <div className="dockview-theme-abyss" style={{ flex: 1, minHeight: 0 }}>
          <SplitviewReact
            orientation={Orientation.HORIZONTAL}
            components={PANE_COMPONENTS}
            onReady={onReady}
          />
        </div>
      </div>
    </WindowStateContext.Provider>
  );
}

export function WorkLogDayList({
  days,
  olderCount,
  selected,
  onSelect,
}: {
  days: WorkLogDay[];
  olderCount: number;
  selected: string;
  onSelect: (key: string) => void;
}) {
  const row = (key: string, title: string, sub: string, dim: boolean) => (
    <div
      key={key}
      data-testid={`wl-day-${key}`}
      onClick={() => onSelect(key)}
      style={{
        padding: "0.4em 0.75em",
        cursor: "pointer",
        borderBottom: "1px solid var(--panel-border)",
        background: selected === key ? "var(--graph-row-selected-bg)" : undefined,
      }}
    >
      <div style={{ fontWeight: dim ? 400 : 600, opacity: dim ? 0.6 : 1 }}>{title}</div>
      <div className="legit-subtle" style={{ fontSize: "var(--fz-sm)", opacity: dim ? 0.6 : 1 }}>
        {sub}
      </div>
    </div>
  );
  return (
    <div className="legit-panel" style={{ height: "100%", overflow: "auto" }}>
      {days.map((d) =>
        row(
          d.key,
          d.label,
          d.counts.commits > 0 || d.repoBlocks.length > 0
            ? `${d.counts.commits} commit${d.counts.commits === 1 ? "" : "s"}, ${d.counts.repos} repo${d.counts.repos === 1 ? "" : "s"}`
            : "no activity",
          d.counts.commits === 0 && d.repoBlocks.length === 0
        )
      )}
      {olderCount > 0 &&
        row("older", "Older", `${olderCount} uncommitted file${olderCount === 1 ? "" : "s"}`, true)}
    </div>
  );
}

export function WorkLogDayDetail({
  day,
  older,
  sweepErrors,
  selection,
  onSelect,
}: {
  day: WorkLogDay | null;
  older: OlderBucket | null;
  sweepErrors: { name: string; message: string }[];
  selection: DiffSelection | null;
  onSelect: (sel: DiffSelection) => void;
}) {
  return (
    <div className="legit-panel" style={{ height: "100%", overflow: "auto" }}>
      <div className="legit-panel__body" style={{ padding: "0.5em 0.9em" }}>
        {sweepErrors.map((e) => (
          <div key={e.name} style={{ color: "var(--error-fg)", fontSize: "var(--fz-sm)" }}>
            {e.name}: {e.message}
          </div>
        ))}
        {older !== null ? (
          <OlderDetail older={older} selection={selection} onSelect={onSelect} />
        ) : day === null ? (
          <span className="legit-subtle">Select a day.</span>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "0.2em 0 0.5em" }}>
              <b style={{ fontSize: "var(--fz-lg)" }}>{day.label}</b>
              <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
                {day.counts.commits} commit{day.counts.commits === 1 ? "" : "s"} in {day.counts.repos} repo
                {day.counts.repos === 1 ? "" : "s"}
              </span>
            </div>
            {day.repoBlocks.length === 0 && <span className="legit-subtle">No activity.</span>}
            {day.repoBlocks.map((block) => (
              <RepoBlockView
                key={block.group.key}
                block={block}
                selection={selection}
                onSelect={onSelect}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function RepoBlockView({
  block,
  selection,
  onSelect,
}: {
  block: RepoBlock;
  selection: DiffSelection | null;
  onSelect: (sel: DiffSelection) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (sha: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });

  const multiTab = block.group.repoIds.length > 1;
  // Newest first already; the span label speaks each endpoint's own clock.
  const newest = block.commits[0];
  const oldest = block.commits[block.commits.length - 1];
  const spanLabel =
    newest === undefined
      ? ""
      : newest === oldest
        ? timeOfInOffset(newest.author.timestamp, newest.author.tz_offset_minutes)
        : `${timeOfInOffset(oldest.author.timestamp, oldest.author.tz_offset_minutes)} - ${timeOfInOffset(newest.author.timestamp, newest.author.tz_offset_minutes)}`;

  // Stashes interleave chronologically with the commits (spec), newest first.
  const timeline: { time: number; key: string; node: React.ReactNode }[] = [
    ...block.stashes.map((s) => ({
      time: s.timestamp,
      key: `s:${s.stash_sha}`,
      node: (
        <StashRow key={`s:${s.stash_sha}`} stash={s} repoId={block.group.primaryRepoId}
          expanded={expanded.has(s.stash_sha)} onToggle={() => toggle(s.stash_sha)}
          selection={selection} onSelect={onSelect} />
      ),
    })),
    ...block.commits.map((c) => ({
      time: c.author.timestamp,
      key: `c:${c.id}`,
      node: (
        <CommitTimelineRow key={`c:${c.id}`} commit={c} repoId={block.group.primaryRepoId}
          expanded={expanded.has(c.id)} onToggle={() => toggle(c.id)}
          selection={selection} onSelect={onSelect} />
      ),
    })),
  ].sort((a, b) => b.time - a.time);

  return (
    <div style={{ marginBottom: "0.8em" }}>
      <RepoBlockHeader
        name={block.group.name}
        right={
          block.commits.length > 0
            ? `${block.commits.length} commit${block.commits.length === 1 ? "" : "s"}, ${spanLabel}`
            : ""
        }
      />

      {block.uncommitted.length > 0 && (
        <UncommittedTimelineRow
          rows={block.uncommitted}
          multiTab={multiTab}
          labelOf={timeOf}
          selection={selection}
          onSelect={onSelect}
        />
      )}

      {timeline.map((row) => row.node)}
    </div>
  );
}

function RepoBlockHeader({ name, right }: { name: string; right: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "0.25em 0.6em",
        background: "var(--pane-header-bg)",
        borderRadius: "0.3em",
        fontWeight: 600,
      }}
    >
      <span>{name}</span>
      <span className="legit-subtle" style={{ fontWeight: 400, fontSize: "var(--fz-sm)" }}>
        {right}
      </span>
    </div>
  );
}

function CommitTimelineRow({
  commit: c,
  repoId,
  expanded,
  onToggle,
  selection,
  onSelect,
}: {
  commit: WorkLogCommit;
  repoId: string;
  expanded: boolean;
  onToggle: () => void;
  selection: DiffSelection | null;
  onSelect: (sel: DiffSelection) => void;
}) {
  return (
    <div>
      <div
        className="legit-commit-row"
        onClick={onToggle}
        style={{ display: "flex", gap: "0.6em", alignItems: "baseline", padding: "0.15em 0.6em", cursor: "pointer" }}
        title={c.subject}
      >
        <span className="legit-subtle" style={{ flex: "none", fontVariantNumeric: "tabular-nums" }}>
          {timeOfInOffset(c.author.timestamp, c.author.tz_offset_minutes)}
        </span>
        {c.source_ref && (
          <span style={{ flex: "none", color: "var(--ref-branch-fg)", fontSize: "var(--fz-sm)" }}>
            {shortRef(c.source_ref)}
          </span>
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.subject}
        </span>
        <span className="legit-subtle" style={{ flex: "none" }}>
          {expanded ? "▾" : "▸"}
        </span>
      </div>
      {expanded && (
        <CommitFileRows repoId={repoId} sha={c.id} selection={selection} onSelect={onSelect} />
      )}
    </div>
  );
}

function UncommittedTimelineRow({
  rows,
  multiTab,
  labelOf,
  selection,
  onSelect,
}: {
  rows: UncommittedRow[];
  multiTab: boolean;
  /** Formats a row's last-touch instant (time within a day, date in Older). */
  labelOf: (unixSecs: number) => string;
  selection: DiffSelection | null;
  onSelect: (sel: DiffSelection) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const newest = rows.find((r) => r.mtimeUnix != null)?.mtimeUnix ?? null;
  return (
    <div>
      <div
        className="legit-commit-row"
        data-testid="wl-uncommitted-toggle"
        onClick={() => setExpanded((e) => !e)}
        style={{ display: "flex", gap: "0.6em", alignItems: "baseline", padding: "0.15em 0.6em", cursor: "pointer" }}
        title="Uncommitted changes in the working tree"
      >
        <span className="legit-subtle" style={{ flex: "none", fontVariantNumeric: "tabular-nums" }}>
          {newest != null ? labelOf(newest) : ""}
        </span>
        <span style={{ flex: "none", color: "var(--warning-fg)", fontSize: "var(--fz-sm)" }}>
          uncommitted
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {rows.length} file{rows.length === 1 ? "" : "s"}
        </span>
        <span className="legit-subtle" style={{ flex: "none" }}>{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && (
        <div style={{ padding: "0 0 0.2em 2.6em" }}>
          {rows.map((u) => {
            const sel: DiffSelection = { kind: "working", repoId: u.repoId, path: u.path, oldPath: u.oldPath };
            const active = selection !== null && selectionKey(selection) === selectionKey(sel);
            return (
              <div
                key={`${u.repoId}:${u.path}`}
                className={`legit-commit-row${active ? " legit-commit-row--selected" : ""}`}
                onClick={() => onSelect(sel)}
                style={{
                  display: "flex",
                  gap: "0.6em",
                  padding: "0.1em 0.4em",
                  cursor: "pointer",
                  fontSize: "var(--fz-sm)",
                }}
              >
                <span style={{ flex: "none", color: "var(--warning-fg)" }}>{STATE_LETTER[u.state]}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {u.path}
                  {multiTab ? ` (${u.repoName})` : ""}
                </span>
                <span className="legit-subtle" style={{ marginLeft: "auto", flex: "none", fontVariantNumeric: "tabular-nums" }}>
                  {u.mtimeUnix != null ? labelOf(u.mtimeUnix) : u.state === "Deleted" ? "deleted" : "unknown"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StashRow({
  stash,
  repoId,
  expanded,
  onToggle,
  selection,
  onSelect,
}: {
  stash: StashEntry;
  repoId: string;
  expanded: boolean;
  onToggle: () => void;
  selection: DiffSelection | null;
  onSelect: (sel: DiffSelection) => void;
}) {
  return (
    <div>
      <div
        className="legit-commit-row"
        onClick={onToggle}
        style={{ display: "flex", gap: "0.6em", alignItems: "baseline", padding: "0.15em 0.6em", cursor: "pointer" }}
        title={stash.message}
      >
        <span className="legit-subtle" style={{ flex: "none", fontVariantNumeric: "tabular-nums" }}>
          {timeOfInOffset(stash.timestamp, stash.author.tz_offset_minutes)}
        </span>
        <span style={{ flex: "none", color: "var(--ref-stash-fg)", fontSize: "var(--fz-sm)" }}>stash</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {stash.message}
        </span>
        <span className="legit-subtle" style={{ flex: "none" }}>{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && (
        <CommitFileRows repoId={repoId} sha={stash.stash_sha} selection={selection} onSelect={onSelect} />
      )}
    </div>
  );
}

function CommitFileRows({
  repoId,
  sha,
  selection,
  onSelect,
}: {
  repoId: string;
  sha: string;
  selection: DiffSelection | null;
  onSelect: (sel: DiffSelection) => void;
}) {
  const { data, isError, error } = useQuery<CommitFileChange[]>({
    queryKey: [repoId, "log", "work-log-files", sha],
    queryFn: () => api.repoCommitFiles(repoId, sha),
    staleTime: STALE.stable,
  });
  if (isError) {
    return (
      <div className="legit-subtle" style={{ padding: "0 2.6em", fontSize: "var(--fz-sm)" }}>
        {formatAppError(error)}
      </div>
    );
  }
  return (
    <div style={{ padding: "0 0 0.2em 2.6em" }}>
      {(data ?? []).map((f) => {
        const sel: DiffSelection = {
          kind: "commit",
          repoId,
          sha,
          path: f.path,
          oldPath: f.old_path,
        };
        const active = selection !== null && selectionKey(selection) === selectionKey(sel);
        return (
          <div
            key={f.path}
            className={`legit-commit-row${active ? " legit-commit-row--selected" : ""}`}
            onClick={() => onSelect(sel)}
            style={{
              display: "flex",
              gap: "0.6em",
              padding: "0.1em 0.4em",
              cursor: "pointer",
              fontSize: "var(--fz-sm)",
            }}
          >
            <span className="legit-subtle" style={{ flex: "none" }}>{STATE_LETTER[f.change]}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {f.path}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function OlderDetail({
  older,
  selection,
  onSelect,
}: {
  older: OlderBucket;
  selection: DiffSelection | null;
  onSelect: (sel: DiffSelection) => void;
}) {
  return (
    <>
      <div style={{ margin: "0.2em 0 0.5em" }}>
        <b style={{ fontSize: "var(--fz-lg)" }}>Older uncommitted changes</b>
        <div className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
          Last touched before the selected range, or with no readable date. File times are the
          LAST touch - they do not prove when the work happened.
        </div>
      </div>
      {older.blocks.map((block) => (
        <div key={block.group.key} style={{ marginBottom: "0.8em" }}>
          <RepoBlockHeader
            name={block.group.name}
            right={`${block.rows.length} file${block.rows.length === 1 ? "" : "s"}`}
          />
          <UncommittedTimelineRow
            rows={block.rows}
            multiTab={block.group.repoIds.length > 1}
            labelOf={dateOf}
            selection={selection}
            onSelect={onSelect}
          />
        </div>
      ))}
    </>
  );
}

function DaysPane(_props: ISplitviewPanelProps) {
  const s = useContext(WindowStateContext);
  if (!s) return null;
  return (
    <WorkLogDayList
      days={s.view.days}
      olderCount={s.view.older.blocks.reduce((n, b) => n + b.rows.length, 0)}
      selected={s.selectedDay}
      onSelect={s.setSelectedDay}
    />
  );
}

function DetailPane(_props: ISplitviewPanelProps) {
  const s = useContext(WindowStateContext);
  if (!s) return null;
  const older = s.selectedDay === "older" ? s.view.older : null;
  const day = older ? null : (s.view.days.find((d) => d.key === s.selectedDay) ?? null);
  return (
    <WorkLogDayDetail
      day={day}
      older={older}
      sweepErrors={s.sweepErrors}
      selection={s.selection}
      onSelect={s.setSelection}
    />
  );
}

function DiffPane(_props: ISplitviewPanelProps) {
  const s = useContext(WindowStateContext);
  if (!s) return null;
  if (!s.selection) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">Select a file to see its diff.</span>
        </div>
      </div>
    );
  }
  const sel = s.selection;
  const request: DiffRequest =
    sel.kind === "commit"
      ? {
          repoId: sel.repoId,
          path: sel.path,
          oldPath: sel.oldPath,
          source: { kind: "commit", commit_id: sel.sha },
        }
      : {
          repoId: sel.repoId,
          path: sel.path,
          oldPath: sel.oldPath,
          source: { kind: "working_tree" },
        };
  const label =
    sel.kind === "commit" ? `${sel.sha.slice(0, 8)} - ${sel.path}` : `uncommitted - ${sel.path}`;
  return <ReadOnlyFileDiff repoId={sel.repoId} request={request} label={label} />;
}

const PANE_COMPONENTS: Record<string, React.FunctionComponent<ISplitviewPanelProps>> = {
  days: DaysPane,
  detail: DetailPane,
  diff: DiffPane,
};

import { useRepoStore } from "../store/repos";

/**
 * Firefox-style most-recently-used repo tab switching (GitHub issue request):
 * a quick Ctrl+Tab jumps to the previously selected tab; while the modifier
 * stays held, further presses walk deeper through the recent order, which is
 * FROZEN for the duration of the hold. Releasing the modifier (or leaving the
 * window) commits the visit, promoting the landed-on tab to the front.
 */

export interface CycleState {
  /** Recent order captured when the cycle started; head = the then-active tab. */
  snapshot: readonly string[];
  index: number;
}

export function promote(mru: readonly string[], id: string): string[] {
  return [id, ...mru.filter((x) => x !== id)];
}

/** The recent order to cycle through: visited tabs most-recent-first (pruned
 * to open ones), then never-visited tabs in tab order, active forced to head. */
export function cycleOrder(
  mru: readonly string[],
  openIds: readonly string[],
  activeId: string | null,
): string[] {
  const openSet = new Set(openIds);
  const visited = mru.filter((id) => openSet.has(id));
  const rest = openIds.filter((id) => !visited.includes(id));
  const order = [...visited, ...rest];
  if (activeId && order.includes(activeId) && order[0] !== activeId) {
    return [activeId, ...order.filter((id) => id !== activeId)];
  }
  return order;
}

export function stepCycle(
  state: CycleState | null,
  order: readonly string[],
  step: 1 | -1,
): CycleState {
  const snapshot = state?.snapshot ?? order;
  const len = snapshot.length;
  const index = state === null ? (step + len) % len : (state.index + step + len) % len;
  return { snapshot, index };
}

// --- runtime (module singleton wired by KeyDispatcher) ---

let mru: string[] = [];
let cycle: CycleState | null = null;
let disarm: (() => void) | null = null;

/** Feed activations that did NOT come from the cycler (clicks, summons). */
export function noteRepoActivated(id: string | null): void {
  if (cycle || !id) return;
  mru = promote(mru, id);
}

/** The command entry point: one Ctrl+Tab / Ctrl+Shift+Tab press. */
export function stepRepoTab(step: 1 | -1): void {
  const { openRepos, activeRepoId, setActive } = useRepoStore.getState();
  if (openRepos.length < 2) return;
  const order =
    cycle?.snapshot ??
    cycleOrder(
      mru,
      openRepos.map((r) => r.id),
      activeRepoId,
    );
  cycle = stepCycle(cycle, order, step);
  const target = cycle.snapshot[cycle.index];
  if (target && target !== activeRepoId) setActive(target);
  armCommit();
}

/** Commit on modifier release or window blur: the landed-on tab becomes the
 * most recent, and the next cycle starts fresh from the live order. */
function commitCycle(): void {
  cycle = null;
  disarm?.();
  disarm = null;
  noteRepoActivated(useRepoStore.getState().activeRepoId);
}

function armCommit(): void {
  if (disarm) return;
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta" || (!e.ctrlKey && !e.metaKey)) commitCycle();
  };
  const onBlur = () => commitCycle();
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  disarm = () => {
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onBlur);
  };
}

/** Track activations for the MRU order; mounted once by KeyDispatcher. */
export function trackRepoActivations(): () => void {
  let prev = useRepoStore.getState().activeRepoId;
  noteRepoActivated(prev);
  return useRepoStore.subscribe((s) => {
    if (s.activeRepoId !== prev) {
      prev = s.activeRepoId;
      noteRepoActivated(s.activeRepoId);
    }
  });
}

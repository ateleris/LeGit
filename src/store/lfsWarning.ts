import { create } from "zustand";

/** Session-scoped dismissals of the missing-git-lfs banner. Deliberately
 * NOT persisted: while the condition holds, the warning returns on the next
 * app launch (the persistent opt-out lives in RepoSettings instead). */
interface LfsWarningState {
  dismissed: Record<string, true>;
  dismiss: (repoId: string) => void;
}

export const useLfsWarningStore = create<LfsWarningState>((set) => ({
  dismissed: {},
  dismiss: (repoId) =>
    set((s) => ({ dismissed: { ...s.dismissed, [repoId]: true } })),
}));

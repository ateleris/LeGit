// Session cache of signature VERIFICATION results, keyed per repo + commit.
//
// Verification runs on demand in the Commit Details panel (`verify-commit`,
// one commit at a time - the bulk log never verifies). Recording each result
// here lets the Commits list keep showing the verified verdict chip on every
// commit the user has inspected, not just the currently selected row. Results
// are immutable per SHA for the session (a signature never changes; trust
// config changes are rare enough that a restart is acceptable), so entries
// are never invalidated.

import { create } from "zustand";
import type { SignatureVerification } from "../lib/types";

interface SignatureStore {
  /** repoId -> commit sha -> verification result. */
  byRepo: Record<string, Record<string, SignatureVerification>>;
  record: (repoId: string, sha: string, verification: SignatureVerification) => void;
}

export const useSignatureStore = create<SignatureStore>((set) => ({
  byRepo: {},
  record: (repoId, sha, verification) =>
    set((s) => {
      // Skip the update when the same result is already recorded, so the
      // details panel re-rendering doesn't churn Commits-list subscribers.
      if (s.byRepo[repoId]?.[sha]?.status === verification.status) return s;
      return {
        byRepo: {
          ...s.byRepo,
          [repoId]: { ...s.byRepo[repoId], [sha]: verification },
        },
      };
    }),
}));

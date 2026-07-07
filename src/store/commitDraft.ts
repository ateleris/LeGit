import { create } from "zustand";

interface CommitDraftStore {
  /** repoId -> draft commit message. */
  drafts: Record<string, string>;
  setDraft: (repoId: string, message: string) => void;
  clearDraft: (repoId: string) => void;
}

/**
 * Per-repo draft commit message. The Working Changes panel shares a dock slot
 * with other panels and unmounts whenever the user opens e.g. a commit, so the
 * draft must outlive the component. In-session only by design: an unfinished
 * message is scratch state, not something to resurrect days later.
 */
export const useCommitDraftStore = create<CommitDraftStore>((set) => ({
  drafts: {},
  setDraft: (repoId, message) =>
    set((s) => ({ drafts: { ...s.drafts, [repoId]: message } })),
  clearDraft: (repoId) =>
    set((s) => {
      if (!(repoId in s.drafts)) return s;
      const drafts = { ...s.drafts };
      delete drafts[repoId];
      return { drafts };
    }),
}));

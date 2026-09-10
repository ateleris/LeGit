import { create } from "zustand";

/**
 * Central confirmation/decision dialogs (rendered by `ConfirmDialogHost`).
 *
 * Used for destructive actions triggered by BUTTONS (not context menus -
 * menus keep their inline confirm sections, which are anchored to the click
 * and float above the layout) and for workflow prompts (decisions that
 * appear after an async step, e.g. "delete the retained submodule gitdir?").
 * A fixed overlay can never scroll out of view or reflow panel content -
 * the failure modes of the old panel-embedded banners.
 *
 * `confirmDialog(...)` resolves true on confirm, false on cancel/Escape.
 * Requests queue; one dialog shows at a time.
 */
export interface ConfirmRequest {
  /** Small uppercase heading. Omit when `message` is a self-contained
   *  question (the menu confirmations). */
  title?: string;
  /** Plain explanatory sentence(s). */
  message: string;
  /** Monospace-rendered target (path, branch name, …), on its own line. */
  detail?: string;
  /** Longer preformatted text (e.g. release notes) rendered as a scrollable
   *  block between message and buttons. */
  notes?: string;
  /** Emphasised data-loss warning line, when one applies. */
  warning?: string;
  confirmLabel: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** Danger-styled confirm button. Default true - most callers confirm a
   *  destructive action; pass false for neutral decisions. */
  danger?: boolean;
  /** Prompt variant: a multi-line text input between message and buttons.
   *  Confirm resolves the edited value (see `promptDialog`); a blank value
   *  disables the confirm button unless `allowEmpty` (optional inputs like
   *  a lock reason). */
  input?: { initialValue: string; allowEmpty?: boolean };
}

export interface PendingConfirm extends ConfirmRequest {
  id: number;
  resolve: (confirmed: boolean, value?: string) => void;
}

let nextId = 1;

interface ConfirmStore {
  queue: PendingConfirm[];
  request: (req: ConfirmRequest) => Promise<boolean>;
  /** Queue a request with a raw resolver (the prompt variant needs the
   *  edited value, not just the boolean). */
  requestRaw: (req: ConfirmRequest, resolve: PendingConfirm["resolve"]) => void;
  /** Resolve the dialog with the given id (host calls this). */
  settle: (id: number, confirmed: boolean, value?: string) => void;
}

export const useConfirmStore = create<ConfirmStore>((set, get) => ({
  queue: [],

  request: (req) =>
    new Promise<boolean>((resolve) => {
      get().requestRaw(req, (confirmed) => resolve(confirmed));
    }),

  requestRaw: (req, resolve) => {
    const pending: PendingConfirm = { ...req, id: nextId++, resolve };
    set((s) => ({ queue: [...s.queue, pending] }));
  },

  settle: (id, confirmed, value) => {
    const pending = get().queue.find((p) => p.id === id);
    if (!pending) return;
    set((s) => ({ queue: s.queue.filter((p) => p.id !== id) }));
    pending.resolve(confirmed, value);
  },
}));

/** Ask the user to confirm. Resolves true on confirm, false on cancel. */
export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
  return useConfirmStore.getState().request(req);
}

/** Ask for a text value (multi-line). Resolves the edited value on confirm,
 *  null on cancel/Escape. */
export function promptDialog(
  req: ConfirmRequest & { input: { initialValue: string; allowEmpty?: boolean } },
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    useConfirmStore
      .getState()
      .requestRaw(req, (confirmed, value) => resolve(confirmed ? value ?? "" : null));
  });
}

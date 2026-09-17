import { UserAttentionType, type Window } from "@tauri-apps/api/window";

type MainWindow = Pick<
  Window,
  "show" | "setFocus" | "isFocused" | "requestUserAttention"
>;

/**
 * Show the (initially hidden) main window and bring it to the front. The OS
 * denies the focus request while the user is working in another window; in
 * that case flash the taskbar button instead, so a startup that lost the
 * race for the foreground is never silent.
 */
export async function revealAndSignal(win: MainWindow): Promise<void> {
  await win.show();
  await win.setFocus();
  if (!(await win.isFocused())) {
    await win.requestUserAttention(UserAttentionType.Informational);
  }
}

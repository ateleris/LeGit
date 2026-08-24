import { notify } from "../store/notifications";

/**
 * Copies text to the system clipboard. Prefers the async Clipboard API and
 * falls back to a hidden-textarea `execCommand("copy")` for webviews where
 * the API is unavailable or blocked. Resolves when the text is on the
 * clipboard; rejects when both mechanisms fail.
 */
/**
 * `copyText` with user feedback: a brief success toast ("<label> copied"),
 * an error toast when both clipboard mechanisms fail. For fire-and-forget
 * copy actions (menu entries, click-to-copy affordances).
 */
export async function copyAndNotify(text: string, label: string): Promise<void> {
  try {
    await copyText(text);
    notify.success(`${label} copied`);
  } catch {
    notify.error(`Could not copy ${label.toLowerCase()} to the clipboard`);
  }
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through to the legacy path
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    if (!document.execCommand("copy")) {
      throw new Error("Copying to the clipboard failed");
    }
  } finally {
    textarea.remove();
  }
}

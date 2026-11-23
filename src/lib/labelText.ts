const WORD = /^(?:[A-Z][a-z]+|OK)(?:…|\.\.\.)?$/;

export type LabelLead = (word: string) => string;

export function withLead(text: string, lead: LabelLead): string | null {
  const word = text.trim();
  return WORD.test(word) ? text.replace(word, lead(word) + word) : null;
}

const rewritten = new WeakMap<Text, { from: string; to: string }>();
let active: { observer: MutationObserver; lead: LabelLead } | null = null;

function soleTextNode(button: Element): Text | null {
  const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
  let found: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue?.trim()) continue;
    if (found) return null;
    found = n as Text;
  }
  return found;
}

function apply(button: Element) {
  const node = soleTextNode(button);
  if (!node || !active || rewritten.get(node)?.to === node.data) return;
  const to = withLead(node.data, active.lead);
  if (to === null) return;
  rewritten.set(node, { from: node.data, to });
  node.data = to;
}

function restore(button: Element) {
  const node = soleTextNode(button);
  const entry = node && rewritten.get(node);
  if (!node || !entry) return;
  if (node.data === entry.to) node.data = entry.from;
  rewritten.delete(node);
}

function sweep(root: Node, fn: (button: Element) => void) {
  if (!(root instanceof Element)) return;
  if (root.matches("button")) fn(root);
  root.querySelectorAll("button").forEach(fn);
}

function onMutations(records: MutationRecord[]) {
  for (const r of records) {
    const host = r.target instanceof Element ? r.target : r.target.parentElement;
    const button = host?.closest("button");
    if (button) apply(button);
    r.addedNodes.forEach((n) => sweep(n, apply));
  }
}

export function toggleLabelText(lead: LabelLead, root: HTMLElement = document.body): boolean {
  if (active) {
    active.observer.disconnect();
    active = null;
    sweep(root, restore);
    return false;
  }
  const observer = new MutationObserver(onMutations);
  active = { observer, lead };
  observer.observe(root, { subtree: true, childList: true, characterData: true });
  sweep(root, apply);
  return true;
}

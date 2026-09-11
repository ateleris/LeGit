// Splits for path-aware truncation: the returned `prefix` is the part a row
// may shrink away first, `leaf` the part that must stay visible. Invariant:
// prefix + leaf === input (rows render the concatenation verbatim).

export interface PathSplit {
  prefix: string;
  leaf: string;
}

export function splitRefName(name: string): PathSplit {
  const stripped = name.replace(/\/+$/, "");
  const i = stripped.lastIndexOf("/");
  if (i === -1) return { prefix: "", leaf: name };
  return { prefix: name.slice(0, i + 1), leaf: name.slice(i + 1) };
}

// Reflog subjects from `git stash`: "WIP on <branch>: <sha> <subject>" or
// "On <branch>: <message>". Only the branch portion is a ref path, so the
// split happens inside it; anything else (detached HEAD's "(no branch)",
// renamed custom messages) stays whole.
const STASH_SUBJECT = /^(WIP on |On )([^\s:]+): /;

export function splitStashMessage(message: string): PathSplit {
  const m = STASH_SUBJECT.exec(message);
  if (m) {
    const branch = m[2];
    const i = branch.lastIndexOf("/");
    if (i !== -1) {
      const cut = m[1].length + i + 1;
      return { prefix: message.slice(0, cut), leaf: message.slice(cut) };
    }
  }
  return { prefix: "", leaf: message };
}

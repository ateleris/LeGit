// Filename -> lazily loaded language, via @codemirror/language-data's
// registry. Each language is a dynamic import (its own bundle chunk), loaded
// once and cached; unknown extensions resolve to null (content renders
// unstyled, exactly as before syntax highlighting existed).
//
// Two consumers, one cache:
// - the diff views need only the bare `Parser` (they tokenize reconstructed
//   hunk sides off-editor - see syntaxModel.ts);
// - whole-file editors (File View, the 3-way resolve panes) attach the full
//   `LanguageSupport` directly, plus `syntaxColorTheme` for the colours.

import {
  HighlightStyle,
  LanguageDescription,
  type LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";
import type { Parser } from "@lezer/common";
import { tags as t } from "@lezer/highlight";

const cache = new Map<string, Promise<LanguageSupport | null>>();

/** The full `LanguageSupport` for a repo-relative path (git paths use "/"),
 *  or null when no registered language matches. Load failures resolve to
 *  null, never reject. */
export function loadLanguageForPath(path: string): Promise<LanguageSupport | null> {
  const filename = path.split("/").pop() ?? path;
  const desc = LanguageDescription.matchFilename(languages, filename);
  if (!desc) return Promise.resolve(null);
  let loading = cache.get(desc.name);
  if (!loading) {
    loading = desc.load().then(
      (support) => support,
      () => null
    );
    cache.set(desc.name, loading);
  }
  return loading;
}

/** Just the parser for a repo-relative path (the diff views' tokenizer). */
export function loadParserForPath(path: string): Promise<Parser | null> {
  return loadLanguageForPath(path).then((support) => support?.language.parser ?? null);
}

/** Highlighting colours for whole-file editors, drawn from the same
 *  `syntax.*` theme tokens as the diff views' `cm-syn-*` classes and the
 *  same tag collapsing as syntaxModel's `diffHighlighter` - the two paths
 *  must colour a given token identically. */
export const syntaxColorTheme: Extension = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.keyword, color: "var(--syntax-keyword)" },
    {
      tag: [t.string, t.special(t.string), t.regexp, t.character],
      color: "var(--syntax-string)",
    },
    { tag: t.number, color: "var(--syntax-number)" },
    { tag: [t.comment, t.meta], color: "var(--syntax-comment)" },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.labelName],
      color: "var(--syntax-function)",
    },
    { tag: [t.typeName, t.className, t.namespace], color: "var(--syntax-type)" },
    { tag: t.variableName, color: "var(--syntax-variable)" },
    { tag: [t.propertyName, t.attributeName], color: "var(--syntax-property)" },
    { tag: [t.operator, t.derefOperator], color: "var(--syntax-operator)" },
    { tag: [t.punctuation, t.bracket], color: "var(--syntax-punctuation)" },
    { tag: [t.bool, t.null, t.atom, t.self, t.literal], color: "var(--syntax-constant)" },
    { tag: [t.tagName, t.heading], color: "var(--syntax-tag)" },
  ])
);

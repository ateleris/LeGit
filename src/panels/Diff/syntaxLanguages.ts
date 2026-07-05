// Filename -> lazily loaded Lezer parser, via @codemirror/language-data's
// registry. Each language is a dynamic import (its own bundle chunk), loaded
// once and cached; unknown extensions resolve to null (diff renders unstyled,
// exactly as before syntax highlighting existed).

import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Parser } from "@lezer/common";

const cache = new Map<string, Promise<Parser | null>>();

/** The parser for a repo-relative path (git paths use "/"), or null when no
 *  registered language matches. Load failures resolve to null, never reject. */
export function loadParserForPath(path: string): Promise<Parser | null> {
  const filename = path.split("/").pop() ?? path;
  const desc = LanguageDescription.matchFilename(languages, filename);
  if (!desc) return Promise.resolve(null);
  let loading = cache.get(desc.name);
  if (!loading) {
    loading = desc.load().then(
      (support) => support.language.parser,
      () => null
    );
    cache.set(desc.name, loading);
  }
  return loading;
}

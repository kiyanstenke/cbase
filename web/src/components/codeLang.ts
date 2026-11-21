// Language extension for CodeMirror by file name — lazy via @codemirror/language-data,
// so dozens of languages are supported without bundling all packages eagerly.
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";

const cache = new Map<string, Extension>();

export async function loadLanguage(filename: string): Promise<Extension | null> {
  const desc =
    LanguageDescription.matchFilename(languages, filename) ||
    // Fallback: treat some files without a clear extension heuristically
    (/(^|\/)Dockerfile$/i.test(filename) ? LanguageDescription.matchLanguageName(languages, "dockerfile") : null);
  if (!desc) return null;
  if (cache.has(desc.name)) return cache.get(desc.name)!;
  try {
    const support = await desc.load();
    cache.set(desc.name, support);
    return support;
  } catch {
    return null;
  }
}

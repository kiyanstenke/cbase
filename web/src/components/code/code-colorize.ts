// Code outside the editor in the editor's syntax colours: the code blocks in the hover and the definition preview in the ⌘-hover. The
// language comes from @codemirror/language-data — by the target's file name (`languageForFile`) or by the name on the code block
// (```ts, `languageForName`), loaded once and remembered; colouring uses the colours the view currently shows (`highlightingFor` — Dark
// Modern or Light Modern, components/code/codeTheme.ts), like sticky scroll (sticky-scroll.ts).
import type { EditorState } from "@codemirror/state";
import { LanguageDescription, highlightingFor, type Language } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode } from "@lezer/highlight";

export type CodeChunk = { text: string; kind: string };

const loaded = new Map<string, Promise<Language | null>>();
function load(desc: LanguageDescription | null): Promise<Language | null> {
  if (!desc) return Promise.resolve(null);
  let p = loaded.get(desc.name);
  if (!p) {
    p = desc.load().then((s) => s.language).catch(() => null);
    loaded.set(desc.name, p);
  }
  return p;
}
/** The language of a file by its name — null: none known. */
export const languageForFile = (path: string): Promise<Language | null> => load(LanguageDescription.matchFilename(languages, String(path ?? "")));
/** The language on a hover's code block (`typescript`, `ts`, `python` …) — empty: the view's own. */
export function languageForName(name: string, view: Language | null): Promise<Language | null> {
  const n = String(name ?? "").trim();
  if (!n) return Promise.resolve(view);
  if (view && (view.name.toLowerCase() === n.toLowerCase())) return Promise.resolve(view);
  return load(LanguageDescription.matchLanguageName(languages, n, true)).then((s) => s ?? view);
}

/** The code as chunks with the classes of the view's syntax colours (without a language: one chunk without a class). */
export function colorize(state: EditorState, code: string, language: Language | null): CodeChunk[] {
  if (!language) return [{ text: code, kind: "" }];
  const out: CodeChunk[] = [];
  try {
    highlightCode(code, language.parser.parse(code), { style: (tags) => highlightingFor(state, tags) },
      (text, kind) => out.push({ text, kind }), () => out.push({ text: "\n", kind: "" }));
  } catch { return [{ text: code, kind: "" }]; }
  return out;
}

/** The chunks as nodes (`<span class>` per coloured chunk) in `target`. */
export function appendTo(target: HTMLElement, chunks: readonly CodeChunk[]): void {
  for (const s of chunks) {
    if (!s.kind) { target.append(s.text); continue; }
    const span = document.createElement("span");
    span.className = s.kind;
    span.textContent = s.text;
    target.append(span);
  }
}

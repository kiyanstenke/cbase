// The status bar entries of the editor like VS Code:
// "Ln L, Col C" (the VISIBLE column — a tab counts up to the next tab stop, as in VS Code), the selection like VS Code
// `getSelectionLabel` ("Ln L, Col C (N selected)", several cursors "3 selections (12 characters selected)"), the detected
// indentation ("Spaces: 2" · "Tab Size: 4", VS Code `guessIndentation` in small) and what the editor makes of it (unit and
// tab size as facets, Tab at the cursor), the language mode ("TypeScript JSX") and the line ending ("LF"/"CRLF").
//
// Pure (no imports): EXECUTED in web/test/editor-status.test.mjs, each computation with a sabotage.

/** The visible column (1-based) of a position in a row: a tab jumps to the next tab stop. */
export function visibleColumn(row: string, offset: number, tabSize: number): number {
  const tg = Math.max(1, Math.floor(tabSize) || 1);
  let column = 0;
  const until = Math.min(Math.max(0, offset), row.length);
  for (let i = 0; i < until; i++) column = row[i] === "\t" ? column + tg - (column % tg) : column + 1;
  return column + 1;
}

export type SelectionSituation = { row: number; column: number; character: number; selections: number };
/** The position for the status bar: row/column of the main selection, selected characters over all ranges, number of ranges. */
export function selectionSituation(o: { row: number; rowText: string; offsetInLine: number; tabSize: number; areas: readonly { from: number; to: number }[] }): SelectionSituation {
  const character = o.areas.reduce((s, b) => s + Math.abs(b.to - b.from), 0);
  return { row: o.row, column: visibleColumn(o.rowText, o.offsetInLine, o.tabSize), character, selections: Math.max(1, o.areas.length) };
}

/** The text of the entry "Ln, Col" like VS Code `getSelectionLabel` — a UI key with values: one selection "Ln L, Col C"
 *  (with characters "… (N selected)"), several "N selections" (with characters "N selections (M characters selected)") — then without row and column. */
export function selectionText(l: SelectionSituation): { key: string; values: Record<string, number> } {
  if (l.selections > 1) {
    return l.character
      ? { key: "{a} selections ({n} characters selected)", values: { a: l.selections, n: l.character } }
      : { key: "{a} selections", values: { a: l.selections } };
  }
  return l.character
    ? { key: "Ln {z}, Col {s} ({n} selected)", values: { z: l.row, s: l.column, n: l.character } }
    : { key: "Ln {z}, Col {s}", values: { z: l.row, s: l.column } };
}

export type Indentation = { kind: "empty" | "tab"; width: number };
/** What the editor makes of the guessed indentation (VS Code `detectIndentation` sets both): the unit (`indentUnit` — a tab or
 *  N spaces) and the tab size (`EditorState.tabSize` — in a tab file the setting, otherwise the step). */
export function indentationFacets(e: Indentation, defaultTab: number): { unit: string; tabSize: number } {
  return e.kind === "tab" ? { unit: "\t", tabSize: Math.max(1, defaultTab) } : { unit: " ".repeat(Math.max(1, e.width)), tabSize: Math.max(1, e.width) };
}
/** The indentation as the editor DRIVES it (back from its facets) — that is what the status bar shows, not an estimate of its own. */
export function indentationFromFacets(unit: string, tabSize: number): Indentation {
  return unit.includes("\t") ? { kind: "tab", width: tabSize } : { kind: "empty", width: unit.length };
}
/** What Tab without a selection inserts at the cursor (VS Code): in a tab file a tab, otherwise spaces up to the next step. */
export function tabInsertion(unit: string, row: string, offset: number, tabSize: number): string {
  if (unit.includes("\t")) return "\t";
  const n = Math.max(1, unit.length);
  return " ".repeat(n - ((visibleColumn(row, offset, tabSize) - 1) % n));
}
/**
 * Guess the indentation of a file (VS Code `guessIndentation`, simplified): more rows with a leading tab than with spaces ⇒ tab; otherwise the
 * most frequent step between consecutive indented rows (1–8; tie: the smaller). Without a hint in the text: the default.
 */
export function indentationDetect(text: string, preset: Indentation): Indentation {
  let tabs = 0, empty = 0, prior = 0;
  const stages = new Map<number, number>();
  const rows = text.split("\n", 10_000);
  for (const z of rows) {
    if (!z.trim()) continue;
    if (z[0] === "\t") { tabs++; continue; }
    const n = z.length - z.trimStart().length;
    if (n > 0 && z[0] === " ") empty++;
    const d = Math.abs(n - prior);
    if (d >= 1 && d <= 8) stages.set(d, (stages.get(d) ?? 0) + 1);
    prior = n;
  }
  if (tabs > empty) return { kind: "tab", width: preset.width };
  if (!empty) return preset;
  let best = preset.width, count = 0;
  for (const [d, c] of stages) if (c > count || (c === count && d < best)) { best = d; count = c; }
  return { kind: "empty", width: count ? best : preset.width };
}

// The names of the language modes like VS Code (extension → name; whole file names first).
const NAMES: Record<string, string> = {
  ts: "TypeScript", mts: "TypeScript", cts: "TypeScript", tsx: "TypeScript JSX", js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  jsx: "JavaScript JSX", json: "JSON", jsonc: "JSON with Comments", md: "Markdown", markdown: "Markdown", py: "Python", pyi: "Python",
  yml: "YAML", yaml: "YAML", css: "CSS", scss: "SCSS", less: "Less", html: "HTML", htm: "HTML", xml: "XML", svg: "XML", sh: "Shell Script",
  bash: "Shell Script", zsh: "Shell Script", swift: "Swift", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", c: "C", h: "C", cpp: "C++",
  cc: "C++", hpp: "C++", cs: "C#", rb: "Ruby", php: "PHP", sql: "SQL", toml: "TOML", ini: "Ini", lua: "Lua", r: "R", dart: "Dart",
  vue: "Vue", svelte: "Svelte", graphql: "GraphQL", gql: "GraphQL", prisma: "Prisma", txt: "Plain Text", log: "Log", csv: "CSV",
};
const WHOLE: Record<string, string> = {
  dockerfile: "Dockerfile", makefile: "Makefile", ".gitignore": "Ignore", ".dockerignore": "Ignore", ".env": "Dotenv", "package.json": "JSON",
  "tsconfig.json": "JSON with Comments", "jsconfig.json": "JSON with Comments",
};
/** The language mode of a file as VS Code names it — unknown: "Plain Text". */
export function languageName(path: string): string {
  const name = (path.split("/").pop() || "").toLowerCase();
  if (WHOLE[name]) return WHOLE[name];
  if (name.startsWith(".env.")) return "Dotenv";
  if (name.startsWith("dockerfile.")) return "Dockerfile";
  const i = name.lastIndexOf(".");
  return i < 0 ? "Plain Text" : NAMES[name.slice(i + 1)] ?? "Plain Text";
}

/** The line ending as VS Code names it. */
export const lineEndingName = (ze: string): "LF" | "CRLF" => (ze === "\r\n" ? "CRLF" : "LF");

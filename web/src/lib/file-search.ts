// File search as in VS Code: the hits of a line, the hit list (ONE row per hit), the replacement of a hit (VS Code ReplacePattern including
// "preserve case"), the plan of "Replace all" over exactly the displayed hits, and the search in unsaved buffers — with the same toggles as
// in the field: Aa (match case), ab (whole word), .* (regular expression).
//
// TWO VERSIONS, BOUND: the hits the server delivers are computed by runtime/fileAccess.js `searchPattern`/`searchLines` (B and the program
// in the container); here the same rules stand for the buffers and the check before replacing. web/test/file-search.test.mjs runs BOTH
// against the same lines — a deviation is red.
//   - "Whole word" as in VS Code: on the left line start, a separator before or a separator as the first character of the hit; on the right
//     likewise. Separator = `editor.wordSeparators` and whitespace.
//   - Without .* the input is literal; an empty hit (`^`, `x*`) counts and advances by one character.
//   - Replacing with .* as in VS Code (`parseReplaceString`/`buildReplaceString`): `$0`/`$&` (the hit), `$1`…`$99` (a group that does not
//     exist falls apart as there: `$10` with one group = group 1 + "0"), `$$`, `\n`, `\t`, `\\`, `\u`/`\l` (next character of the next group
//     upper/lower), `\U`/`\L` (the whole next group); literal without .*. "Preserve case" (AB) as in
//     `buildReplaceStringWithCasePreserved` — only for a replacement without groups.
//
// Pure (no imports).

export type SearchOptions = { query: string; regex: boolean; caseSensitive: boolean; wholeWord: boolean };
/** Everything that was searched for — the results hold only for exactly these fields. */
export type SearchFields = SearchOptions & { include: string; exclude: string; exclusions: boolean };
export type Citation = { start: number; end: number; groups?: (string | undefined)[] };
/** A line as the server delivers it: `hits` = the columns of each hit in the WHOLE line (missing with an old server). */
export type SearchRow = { line: number; text: string; hits?: readonly (readonly [number, number])[] };
export type SearchFile = { path: string; matches: readonly SearchRow[] };
/** A hit = one row in the list: line (1-based), columns in the whole line, the text of the line (preview, possibly shortened). */
export type Hits = { row: number; from: number; until: number; text: string };
export type FileHits = { path: string; hits: Hits[] };
/** A range in the text (like `Area` in lib/buffer.ts). */
export type TextArea = { from: number; to: number; insert: string };

const SEPARATOR = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";
const separator = (c: string | undefined) => c === undefined || SEPARATOR.includes(c) || /\s/.test(c);
const wholeTerm = (z: string, s: number, e: number) => (s === 0 || separator(z[s - 1]) || (e > s && separator(z[s])))
  && (e === z.length || separator(z[e]) || (e > s && separator(z[e - 1])));

/** The expression of the search — an error (invalid regular expression) as text. */
export function searchExpression(o: SearchOptions): RegExp | { error: string } {
  try {
    return new RegExp(o.regex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), o.caseSensitive ? "g" : "gi");
  } catch (e) {
    return { error: `Invalid regular expression: ${(e as Error).message}` };
  }
}

/** The hits in ONE line (at most `max`). */
export function citations(row: string, o: SearchOptions, max = 1000): Citation[] {
  if (!o.query) return [];
  const re = searchExpression(o);
  if (!(re instanceof RegExp)) return [];
  const out: Citation[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (out.length < max && (m = re.exec(row)) !== null) {
    const s = m.index, e = s + m[0].length;
    if (!o.wholeWord || wholeTerm(row, s, e)) out.push(m.length > 1 ? { start: s, end: e, groups: m.slice(1) } : { start: s, end: e });
    if (e === s) { if (s >= row.length) break; re.lastIndex = s + 1; }
  }
  return out;
}

// ── Replace ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Preserve case" like VS Code `buildReplaceStringWithCasePreserved`: with "-" or "_" in hit AND replacement (same number of parts) per
 *  part; otherwise all upper, all lower, first letter upper or lower — or the replacement as it is. */
export function preserveSpelling(hits: string, replacement: string): string {
  if (!hits) return replacement;
  const partial = (z: string) => hits.includes(z) && replacement.includes(z) && hits.split(z).length === replacement.split(z).length;
  const withBind = partial("-"), withUnder = partial("_");
  if (withBind !== withUnder) {
    const z = withBind ? "-" : "_";
    const t = hits.split(z);
    return replacement.split(z).map((s, i) => preserveSpelling(t[i] ?? "", s)).join(z);
  }
  if (hits.toUpperCase() === hits) return replacement.toUpperCase();
  if (hits.toLowerCase() === hits) return replacement.toLowerCase();
  if (hits[0].toLowerCase() !== hits[0] && replacement.length > 0) return replacement[0].toUpperCase() + replacement.slice(1);
  if (hits[0].toUpperCase() !== hits[0] && replacement.length > 0) return replacement[0].toLowerCase() + replacement.slice(1);
  return replacement;
}

type ReplacementChunk = { text: string } | { group: number; cases: string[] };
/** The replacement with .* split into chunks like VS Code `parseReplaceString` (unknown sequences stay as they are). */
function replacementChunks(replacement: string): ReplacementChunk[] {
  const out: ReplacementChunk[] = [];
  let text = "";
  let cases: string[] = [];
  const group = (n: number) => { if (text) out.push({ text }); text = ""; out.push({ group: n, cases }); cases = []; };
  for (let i = 0; i < replacement.length; i++) {
    const c = replacement[i];
    if (c === "\\" && i + 1 < replacement.length) {
      const n = replacement[i + 1];
      if (n === "\\") { text += "\\"; i++; continue; }
      if (n === "n") { text += "\n"; i++; continue; }
      if (n === "t") { text += "\t"; i++; continue; }
      if (n === "u" || n === "U" || n === "l" || n === "L") { cases.push(n); i++; continue; }
      text += c;
      continue;
    }
    if (c === "$" && i + 1 < replacement.length) {
      const n = replacement[i + 1];
      if (n === "$") { text += "$"; i++; continue; }
      if (n === "0" || n === "&") { group(0); i++; continue; }
      if (n >= "1" && n <= "9") {
        const z = replacement[i + 2];
        if (z !== undefined && z >= "0" && z <= "9") { group(Number(n + z)); i += 2; continue; }
        group(Number(n)); i++; continue;
      }
    }
    text += c;
  }
  if (text) out.push({ text });
  return out;
}
/** A group like VS Code `_substitute`: if `$nn` does not exist, the number falls apart from the back (`$10` = group 1 + "0"), else `$n` stays. */
function groupOf(n: number, all: readonly (string | undefined)[]): string {
  if (n === 0) return all[0] ?? "";
  let rest = "";
  while (n > 0) {
    if (n < all.length) return (all[n] ?? "") + rest;
    rest = String(n % 10) + rest;
    n = Math.floor(n / 10);
  }
  return `$${rest}`;
}
function withCases(s: string, cases: readonly string[]): string {
  if (!cases.length) return s;
  let out = "", op = 0;
  for (let i = 0; i < s.length; i++) {
    if (op >= cases.length) { out += s.slice(i); break; }
    const f = cases[op];
    if (f === "U") out += s[i].toUpperCase();
    else if (f === "L") out += s[i].toLowerCase();
    else if (f === "u") { out += s[i].toUpperCase(); op++; }
    else if (f === "l") { out += s[i].toLowerCase(); op++; }
  }
  return out;
}

/** The replacement for ONE hit (see header). `preserved` = "preserve case". */
export function substituteFor(replacement: string, hits: string, groups: readonly (string | undefined)[] | undefined, regex: boolean, preserved = false): string {
  if (!regex) return preserved ? preserveSpelling(hits, replacement) : replacement;
  const chunks = replacementChunks(replacement);
  if (chunks.every((s) => "text" in s)) {
    const statical = chunks.map((s) => ("text" in s ? s.text : "")).join("");
    return preserved ? preserveSpelling(hits, statical) : statical;
  }
  const all = [hits, ...(groups ?? [])];
  return chunks.map((s) => ("text" in s ? s.text : withCases(groupOf(s.group, all), s.cases))).join("");
}

/** Replaces every hit of a text (line by line, as the search searches). `count` = replaced hits. */
export function replace(text: string, o: SearchOptions, replacement: string, preserved = false): { text: string; count: number } {
  let count = 0;
  const rows = text.split("\n").map((z) => {
    const f = citations(z, o, Number.MAX_SAFE_INTEGER);
    if (!f.length) return z;
    count += f.length;
    let out = "", at = 0;
    for (const x of f) { out += z.slice(at, x.start) + substituteFor(replacement, z.slice(x.start, x.end), x.groups, o.regex, preserved); at = x.end; }
    return out + z.slice(at);
  });
  return { text: rows.join("\n"), count };
}

/** The plan of "Replace all" in ONE file: exactly the displayed hits, each only if at its place in the text (line, columns) this very hit
 *  still stands with the SAME fields the search used — otherwise it counts as `stale` and stays. Ranges in offsets of the text. */
export function replacePlan(text: string, hits: readonly Hits[], o: SearchOptions, replacement: string, preserved = false): { areas: TextArea[]; stale: number } {
  const beginning: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") beginning.push(i + 1);
  const rowOf = (n: number) => { const a = beginning[n - 1]; if (a === undefined) return null; const e = n < beginning.length ? beginning[n] - 1 : text.length; let z = text.slice(a, e); if (z.endsWith("\r")) z = z.slice(0, -1); return { a, z }; };
  const areas: TextArea[] = [];
  let stale = 0;
  const findings = new Map<number, Citation[]>();
  for (const t of hits) {
    const rowLine = rowOf(t.row);
    if (!rowLine) { stale++; continue; }
    let f = findings.get(t.row);
    if (!f) { f = citations(rowLine.z, o, Number.MAX_SAFE_INTEGER); findings.set(t.row, f); }
    const x = f.find((y) => y.start === t.from && y.end === t.until);
    if (!x) { stale++; continue; }
    areas.push({ from: rowLine.a + x.start, to: rowLine.a + x.end, insert: substituteFor(replacement, rowLine.z.slice(x.start, x.end), x.groups, o.regex, preserved) });
  }
  areas.sort((a, b) => a.from - b.from);
  return { areas: areas.filter((b, i) => i === 0 || b.from >= areas[i - 1].to), stale };
}

// ── The list ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The hits of a text like the server (`searchLines`): `\r` at the line end drops, per line the columns of each hit. */
export function rowsHits(text: string, o: SearchOptions, max = 2000): SearchRow[] {
  const out: SearchRow[] = [];
  let n = 0;
  const rows = text.split("\n");
  for (let i = 0; i < rows.length && n < max; i++) {
    let z = rows[i];
    if (z.endsWith("\r")) z = z.slice(0, -1);
    const f = citations(z, o, max - n);
    if (!f.length) continue;
    out.push({ line: i + 1, text: z.length > 1000 ? z.slice(0, 1000) : z, hits: f.map((x) => [x.start, x.end] as const) });
    n += f.length;
  }
  return out;
}

/** The unsaved buffers into the server's results (as in VS Code): a file with unsaved content counts with ITS text — its result from disk
 *  drops, and if it lies in the scope of the search (`matches`, from the server: filters, exclusions, ignore files), the buffer searches
 *  itself. Without `matches` (old server) the list stays as it is. Sorted by path like the server. */
export function withBuffers(results: readonly SearchFile[], buffer: ReadonlyMap<string, string>, matches: readonly string[] | undefined, o: SearchOptions): SearchFile[] {
  if (!matches || !buffer.size) return [...results];
  const kept = results.filter((e) => !buffer.has(e.path));
  for (const p of matches) {
    const text = buffer.get(p);
    if (text === undefined) continue;
    const z = rowsHits(text, o);
    if (z.length) kept.push({ path: p, matches: z });
  }
  return kept.sort((a, b) => a.path.localeCompare(b.path));
}

/** The list: ONE row per hit (as in VS Code — the same line twice, each with its highlight). Columns from the server, otherwise computed
 *  from the text. */
export function hitsList(results: readonly SearchFile[], o: SearchOptions): FileHits[] {
  return results.map((e) => ({
    path: e.path,
    hits: e.matches.flatMap((m) => (m.hits ?? citations(m.text, o).map((f) => [f.start, f.end] as const)).map(([from, until]) => ({ row: m.line, from, until, text: m.text }))),
  })).filter((d) => d.hits.length > 0);
}

/** "N results in M files" — the same number as the rows of the list. */
export function resultCounts(list: readonly FileHits[]): { hits: number; files: number } {
  let hits = 0;
  for (const d of list) hits += d.hits.length;
  return { hits, files: list.length };
}

/** The header like VS Code `buildResultCountMessage` — singular and plural per number. Key for `t` (with `{n}`, `{m}`). */
export function resultKey(n: number, m: number): string {
  if (n === 1 && m === 1) return "1 result in 1 file";
  if (n === 1) return "1 result in {m} files";
  if (m === 1) return "{n} results in 1 file";
  return "{n} results in {m} files";
}
/** The question before "Replace all" like VS Code `buildReplaceAllConfirmationMessage` (with `{n}`, `{m}`, `{fresh}`). */
export function questionKey(n: number, m: number): string {
  if (n === 1 && m === 1) return "Replace 1 occurrence across 1 file with “{fresh}”?";
  if (n === 1) return "Replace 1 occurrence across {m} files with “{fresh}”?";
  if (m === 1) return "Replace {n} occurrences in 1 file with “{fresh}”?";
  return "Replace {n} occurrences in {m} files with “{fresh}”?";
}
/** The message afterwards as in VS Code ("Replaced {0} occurrence(s) across {1} file(s) with '{2}'."). */
export function replacedKey(n: number, m: number): string {
  if (n === 1 && m === 1) return "Replaced 1 occurrence across 1 file with “{fresh}”.";
  if (n === 1) return "Replaced 1 occurrence across {m} files with “{fresh}”.";
  if (m === 1) return "Replaced {n} occurrences across 1 file with “{fresh}”.";
  return "Replaced {n} occurrences across {m} files with “{fresh}”.";
}

/** Is the search still what the results were searched for? Only then may "Replace all" take them. */
export const sameFields = (a: SearchFields | null | undefined, b: SearchFields | null | undefined): boolean => Boolean(a && b)
  && a!.query === b!.query && a!.regex === b!.regex && a!.caseSensitive === b!.caseSensitive && a!.wholeWord === b!.wholeWord
  && a!.include === b!.include && a!.exclude === b!.exclude && a!.exclusions === b!.exclusions;

/** A folder for "Find in Folder…" as a glob that means exactly it: `* ? [ ] { } ,` as a character class (`[,]`) — a comma would
 *  otherwise separate the patterns, a brace would expand. The server (runtime/fileAccess.js `searchPattern`) reads classes so. */
export const globMasked = (path: string): string => path.replace(/[*?[\]{},]/g, "[$&]");

/** VS Code `lcut`: at most about `n` characters from the end, cut at a word boundary, with `front` prepended; leading whitespace drops. */
export function lcut(text: string, n: number, front = ""): string {
  const trimmed = text.trimStart();
  if (trimmed.length < n) return trimmed;
  const re = /\b/g;
  let i = 0;
  while (re.test(trimmed)) {
    if (trimmed.length - re.lastIndex < n) break;
    i = re.lastIndex;
    re.lastIndex += 1;
  }
  if (i === 0) return trimmed;
  return front + trimmed.substring(i).trimStart();
}
/** The preview of ONE hit like VS Code `Match.preview`: before it at most ~26 characters (`lcut`, "…"), the hit, after it up to 250
 *  characters in total. If the hit lies beyond the shortened line text (very long line), only "…" remains. */
export function previewParts(text: string, from: number, until: number): { before: string; hits: string; after: string } {
  if (from > text.length) return { before: "…", hits: "", after: "" };
  const before = lcut(text.slice(0, from), 26, "…");
  let rest = 250 - before.length;
  const hits = text.slice(from, Math.min(until, text.length)).slice(0, Math.max(0, rest));
  rest -= hits.length;
  return { before, hits, after: text.slice(until).slice(0, Math.max(0, rest)).trimEnd() };
}

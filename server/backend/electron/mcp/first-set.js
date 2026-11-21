// The FIRST SENTENCE of a tool description: the one definition of the sentence boundary. The first sentence of every cbase
// description IS its short description (one source, no second field). Two places read it, and both read THIS function:
//   - the loop engine (server/providers/engine.js, catalog line `- <name>: <catalogRow(description)>` in the system prompt);
//   - the length guard (server/backend/test/mcp-description-length.test.js: every first sentence a purpose sentence, at most
//     160 characters).
// A leaf without imports (like visibility.js): the server imports it, the MCP server does not need it.
//
// The boundary: `.`, `?` or `!`, optionally followed by closing quotation marks, and then whitespace or the end; also a blank
// line. A period is NOT a boundary
//   - after a single letter or a chain of them ("z. B.", "u. a.", "d. h.", "e.g.", "i.e."),
//   - after a known abbreviation ("bzw.", "ggf.", "max.", "etc." ... see ABBREVIATIONS),
//   - inside an ellipsis ("..."),
//   - after a number or version number when no capital letter follows ("step 3. of 5"; "up to 9999. Then" ends there).
// A period INSIDE a word (versions "2.1.280", file extensions "CLAUDE.md", paths "/a.json", numbers "2.048") is never a boundary
// anyway: no whitespace follows it. "usw." and "etc." end a sentence when a capital letter follows (they close an enumeration).
// Known limit of this rule: a German ordinal before a capitalised word ("am 3. Oktober") ends the sentence; no first sentence
// in the catalog contains such a thing (the guard measures each one).
//
// Runtime: LINEAR. The abbreviation check must not scan the whole text before each period (40,000 x "x. " held the engine for
// 10 s synchronously; a foreign MCP description is arbitrarily long). For each period only the word before it is read, at most
// WORD_WINDOW characters; a longer word is not an abbreviation. Guard: first-set.test.js ("linear", deadline against hangs).

const ABBREVIATIONS = new Set([
  "bzw", "ggf", "usw", "etc", "inkl", "exkl", "evtl", "vgl", "ca", "max", "min", "nr", "bspw", "sog", "zzgl", "abzgl", "abs", "kap",
  "std", "mio", "mrd", "allg", "bzgl", "insb", "ff", "vs", "approx", "incl", "resp", "cf", "fig", "no",
]);
// Abbreviations that close an enumeration: before a capital letter they end the sentence.
const ENUMERATION_END = new Set(["usw", "etc"]);
const CLOSING = "\"'“”»’";
// What bounds a word on the left: whitespace (after folding only " ") and opening brackets/quotation marks.
const WORD_BEGINNING = new Set([" ", "(", "[", "{", "„", "“", "\"", "'", "«"]);
const WORD_WINDOW = 40;

// The word directly before the period at `i`; null if it is longer than WORD_WINDOW.
function wordBefore(t, i) {
  let a = i;
  while (a > 0 && !WORD_BEGINNING.has(t[a - 1])) {
    if (i - a >= WORD_WINDOW) return null;
    a--;
  }
  return t.slice(a, i);
}

function isAbbreviation(word) {
  if (!word) return false;
  if (/^(?:[A-Za-zÄÖÜäöüß]\.)*[A-Za-zÄÖÜäöüß]$/.test(word)) return true; // "z", "B", "e.g", "u.a"
  return ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * The first sentence of `text`, whitespace folded to single spaces. Without a boundary: the whole text (folded).
 * @param {unknown} text
 * @returns {string}
 */
export function firstSentence(text) {
  const raw = String(text ?? "");
  // A blank line always ends the first sentence (paragraph).
  const paragraph = /\n[ \t]*\n/.exec(raw);
  const t = (paragraph ? raw.slice(0, paragraph.index) : raw).replace(/\s+/g, " ").trim();
  const limit = /[.!?]/g;
  let m;
  while ((m = limit.exec(t))) {
    let end = m.index + 1;
    while (end < t.length && CLOSING.includes(t[end])) end++;
    if (end < t.length && t[end] !== " ") continue; // inside a word: version, path, number, file extension
    if (m[0] === ".") {
      const i = m.index;
      if (t[i - 1] === "." || t[i + 1] === ".") continue; // ellipsis "..."
      // The first character after the boundary (t is folded: at most one space in between).
      const next = t[end] === " " ? t[end + 1] : t[end];
      const upper = next !== undefined && /[A-ZÄÖÜ]/.test(next);
      const word = wordBefore(t, i);
      if (isAbbreviation(word) && !(upper && ENUMERATION_END.has(word.toLowerCase()))) continue;
      if (/\d/.test(t[i - 1] ?? "") && next !== undefined && !upper) continue; // number or ordinal in the middle of a sentence
    }
    return t.slice(0, end);
  }
  return t;
}

// The cap of a catalog line: a FOREIGN description (external MCP server) has no maintained first sentence; without a sentence
// end it would be the whole line. cbase descriptions never reach it (the guard keeps their first sentence under 160).
export const CATALOG_CAP = 200;

/** The catalog line of a tool: its first sentence, cut at `cap` characters and marked with "…". */
export function catalogRow(text, cap = CATALOG_CAP) {
  const set = firstSentence(text);
  return set.length > cap ? `${set.slice(0, cap).trimEnd()}…` : set;
}

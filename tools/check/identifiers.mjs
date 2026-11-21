#!/usr/bin/env node
// The German identifier guard: no name in the code of the public tree is made of German words.
//
// Promise: in .js/.mjs/.cjs/.ts/.tsx/.swift/.sh files no identifier (variable, function, class, property, parameter, label,
// shell variable or function) and no identifier-like quoted key ("kasse_id", 'abgeloest') contains a part from the German
// vocabulary (identifiers-vocab.json), and none contains an umlaut or ß. Comments, prose strings, regex literals, heredocs and
// documents are NOT looked at: the language guard (language.mjs) owns text; this guard owns names.
//
// Why a second guard: language.mjs looks at lines and calls a name German only when it holds two stop/noun words. A single
// German word as a name (`stand`, `nach`, `ordner`) passes it by design. Here a name is split into its parts (camelCase,
// snake_case, kebab-case) and every part is looked up in a PUBLIC, curated list of German word stems. A tokenizer reads the
// code, so words in comments and in prose do not count.
//
// !! RATCHET — NOT YET THE FINAL STATE. identifiers-ratchet.json records today's count; the test fails when it is exceeded,
// !! so it can only shrink. It MUST reach 0 before publication (then `--strict` is the whole gate).
//
// The vocabulary is conservative: unambiguous German only. English homographs (rat, rest, art, gift, bad, fast, will, man, die,
// sein, also, name, last, hat …) are not in the word list. A part counts when it EQUALS a word, or (stems) starts with a stem of >= 7
// letters that has no English reading. Short German function words (am, als, um, nr, ja, der, von, fuer, und …) are words too.
// Two homograph rules catch a German word that is also English only where the English reading is impossible:
//   exactOnly  counts only as the WHOLE name (stand, war, mit — standAlone, MIT_LICENSE stay English);
//   notFirst   counts as the whole name or as a part AFTER the first (was — wasReady is English, { was } and gateWas German).
//
//   node tools/check/identifiers.mjs                  report: count, top identifiers, top files; exit 1 above the ratchet
//   node tools/check/identifiers.mjs --strict         ratchet 0
//   node tools/check/identifiers.mjs --list [prefix]  every finding as file:line, kind, identifier (optionally below a prefix)
//   node tools/check/identifiers.mjs --json           machine-readable summary
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicFiles, REPO } from "./cleanliness.mjs";
import { loadAllow as loadLanguageAllow, fileAllowed } from "./language.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VOCAB_FILE = path.join(HERE, "identifiers-vocab.json");
export const ALLOW_FILE = path.join(HERE, "identifiers-allow.json");
export const RATCHET_FILE = path.join(HERE, "identifiers-ratchet.json");
const MAX_BYTES = 4 << 20;
export const CODE_FILE = /\.(js|mjs|cjs|ts|tsx|swift|sh)$/;
const NEVER = /(^|\/)(package-lock\.json|node_modules|vendor)(\/|$)/;
const UMLAUT = /[äöüÄÖÜß]/;

// ---- vocabulary --------------------------------------------------------------------------------------------------------

/** Loads the vocabulary file. A tree without it (never the case in the public clone) counts nothing. */
export function loadVocab(file = VOCAB_FILE) {
  if (!fs.existsSync(file)) return { words: new Set(), stems: [], exact: new Set(), notFirst: new Set() };
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const words = new Set(), stems = [], exact = new Set(), notFirst = new Set();
  for (const row of d.exactOnly || []) for (const w of String(row).split(/\s+/).filter(Boolean)) exact.add(w);
  for (const row of d.notFirst || []) for (const w of String(row).split(/\s+/).filter(Boolean)) {
    if (!/^[a-z]{2,}$/.test(w)) throw new Error(`${file}: notFirst word "${w}" must be lowercase letters only (a-z)`);
    notFirst.add(w);
  }
  for (const row of d.words || []) for (const w of String(row).split(/\s+/).filter(Boolean)) {
    if (!/^[a-z]{2,}$/.test(w)) throw new Error(`${file}: word "${w}" must be lowercase letters only (a-z)`);
    words.add(w);
  }
  for (const row of d.stems || []) for (const s of String(row).split(/\s+/).filter(Boolean)) {
    if (!/^[a-z]{7,}$/.test(s)) throw new Error(`${file}: stem "${s}" must be >= 7 lowercase letters`);
    stems.push(s);
  }
  for (const w of words) if (exact.has(w) || notFirst.has(w)) throw new Error(`${file}: "${w}" is a homograph: it belongs in exactOnly or notFirst, not in words`);
  return { words, stems, exact, notFirst };
}

/** Splits camelCase / PascalCase / snake_case / kebab-case / dotted names into lowercase parts (acronyms stay one part). */
export function partsOf(id) {
  return id.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((x) => x.toLowerCase());
}

/** The German word a name contains (first one), or null. An umlaut/ß in the name is German by itself. */
export function germanPart(id, vocab) {
  if (UMLAUT.test(id)) return "(umlaut)";
  if (vocab.exact.size && vocab.exact.has(id.toLowerCase())) return id.toLowerCase();
  const parts = partsOf(id);
  for (const [k, p] of parts.entries()) {
    if (vocab.words.has(p)) return p;
    if (vocab.notFirst?.has(p) && (k > 0 || parts.length === 1)) return p;
    if (p.length >= 7) for (const s of vocab.stems) if (p.startsWith(s)) return s;
  }
  return null;
}

// ---- tokenizer ----------------------------------------------------------------------------------------------------------
// Returns [{ id, pos, kind }] with kind "code" (an identifier in code) or "key" (a quoted, identifier-like single token).
// Comments, prose strings, regex literals and template text are skipped. It does not parse: it only has to know where code is.

const ID0 = /[\p{L}_$]/u, ID = /[\p{L}\p{N}_$]/u;
const KEY = /^[\p{L}_$][\p{L}\p{N}_$.\-]*$/u;
// A quoted token is a KEY (a stored or wire name) and not prose when it starts lowercase, or is camel/Pascal/ALL_CAPS compound; a
// capitalised single word ("Danach", "Kasse-Umbau", "Fertig.") is a word of text and belongs to the language guard.
const isKey = (b) => b.length >= 2 && KEY.test(b) && !/[.\-]$/.test(b) && (/^[\p{Ll}_$]/u.test(b) || /[\p{Ll}\p{N}]\p{Lu}/u.test(b) || /^[\p{Lu}\p{N}_]+$/u.test(b) && b.includes("_"));
const REGEX_AFTER_WORD = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|yield|await|else|do)$/;

export function tokensJsLike(t, swift = false) {
  const out = []; const n = t.length; let i = 0;
  const key = (body, start) => { if (isKey(body)) out.push({ id: body, pos: start, kind: "key" }); };
  // Scans code. `close` is the bracket that ends this level ("}" in a JS template, ")" in a Swift interpolation) or null.
  function code(close) {
    let depth = 0;
    while (i < n) {
      const c = t[i], d = t[i + 1];
      if (c === "/" && d === "/") { while (i < n && t[i] !== "\n") i++; continue; }
      if (c === "/" && d === "*") {
        if (swift) { let lvl = 1; i += 2; while (i < n && lvl) { if (t[i] === "/" && t[i + 1] === "*") { lvl++; i += 2; } else if (t[i] === "*" && t[i + 1] === "/") { lvl--; i += 2; } else i++; } }
        else { const e = t.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; }
        continue;
      }
      if (c === "/" && !swift && regexStart()) { skipRegex(); continue; }
      if (c === '"' || c === "'" || c === "`") {
        if (swift && c === "'") { i++; continue; }
        if (c === "`") { template(); continue; }
        if (swift) { swiftString(); continue; }
        plainString(c); continue;
      }
      if (swift && c === "#" && (d === '"' || d === "#")) { let h = 0; while (t[i + h] === "#") h++; if (t[i + h] === '"') { const q = t.startsWith('"""', i + h) ? '"""' : '"'; const e = t.indexOf(q + "#".repeat(h), i + h + q.length); i = e < 0 ? n : e + q.length + h; continue; } }
      if (close === "}" ? c === "{" : c === "(") depth++;
      if (c === close) { if (depth === 0) { i++; return; } depth--; }
      if (/[0-9]/.test(c)) { i++; while (i < n && /[\w.]/.test(t[i]) && !(t[i] === "." && t[i + 1] === ".")) i++; continue; }
      if (ID0.test(c)) { let j = i + 1; while (j < n && ID.test(t[j])) j++; out.push({ id: t.slice(i, j), pos: i, kind: "code" }); i = j; continue; }
      i++;
    }
  }
  function regexStart() {
    let k = i - 1; while (k >= 0 && (t[k] === " " || t[k] === "\t")) k--;
    const pc = k < 0 ? "\n" : t[k];
    if (!("(,=:[!&|?{;\n+-*%<>~^".includes(pc) || REGEX_AFTER_WORD.test(t.slice(Math.max(0, k - 10), k + 1)))) return false;
    let j = i + 1, cls = false;
    while (j < n && t[j] !== "\n") { const x = t[j]; if (x === "\\") { j += 2; continue; } if (x === "[") cls = true; else if (x === "]") cls = false; else if (x === "/" && !cls) return j > i + 1; j++; }
    return false;
  }
  function skipRegex() { i++; let cls = false; while (i < n && t[i] !== "\n") { const x = t[i]; if (x === "\\") { i += 2; continue; } if (x === "[") cls = true; else if (x === "]") cls = false; else if (x === "/" && !cls) { i++; break; } i++; } while (i < n && /[a-z]/.test(t[i])) i++; }
  function plainString(q) {
    const start = ++i;
    while (i < n && t[i] !== q && t[i] !== "\n") { if (t[i] === "\\") i++; i++; }
    key(t.slice(start, i), start); if (t[i] === q) i++;
  }
  function template() {
    i++;
    while (i < n) { const c = t[i]; if (c === "\\") { i += 2; continue; } if (c === "`") { i++; return; } if (c === "$" && t[i + 1] === "{") { i += 2; code("}"); continue; } i++; }
  }
  function swiftString() {
    const multi = t.startsWith('"""', i); i += multi ? 3 : 1; const start = i; let interp = false;
    while (i < n) {
      const c = t[i];
      if (c === "\\" && t[i + 1] === "(") { interp = true; i += 2; code(")"); continue; }
      if (c === "\\") { i += 2; continue; }
      if (multi ? t.startsWith('"""', i) : c === '"') { if (!multi && !interp) key(t.slice(start, i), start); i += multi ? 3 : 1; return; }
      if (!multi && c === "\n") return;
      i++;
    }
  }
  code(null);
  return out;
}

/** Shell: only names count — assignments (NAME=), expansions ($NAME, ${NAME}), `for NAME in`, `function NAME`, `NAME()`. */
export function tokensSh(t) {
  // Blank comments, single quotes and heredoc bodies; keep double-quoted text (marked) because "$name" is code.
  const n = t.length; const s = t.split(""); const dq = new Uint8Array(n); let i = 0, q = null, heredoc = null, pending = null;
  const blank = (a, b) => { for (let k = a; k < b; k++) if (s[k] !== "\n") s[k] = " "; };
  while (i < n) {
    if (heredoc) { const e = t.indexOf("\n", i); const end = e < 0 ? n : e; if (t.slice(i, end).replace(/^\t+/, "") === heredoc) heredoc = null; blank(i, end); i = end + 1; continue; }
    const c = t[i];
    if (q === "'") { if (c === "'") q = null; else blank(i, i + 1); i++; continue; }
    if (q === '"') { dq[i] = 1; if (c === "\\") { dq[i + 1] = 1; i += 2; continue; } if (c === '"') q = null; i++; continue; }
    if (c === "\n" && pending) { heredoc = pending; pending = null; i++; continue; }
    if (c === "\\") { i += 2; continue; }
    if (c === "'" ) { q = "'"; i++; continue; }
    if (c === '"') { q = '"'; i++; continue; }
    if (c === "#" && (i === 0 || /[\s;&|(]/.test(t[i - 1]))) { const e = t.indexOf("\n", i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
    if (c === "<" && t[i + 1] === "<" && t[i + 2] !== "<") {
      const m = /^<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(t.slice(i, i + 80)); if (m) { pending = m[2]; i += m[0].length; continue; }
    }
    i++;
  }
  const code = s.join(""); const out = []; const seen = new Set();
  const add = (id, pos, onlyCode) => { if (onlyCode && dq[pos]) return; const k = pos + ":" + id; if (seen.has(k)) return; seen.add(k); out.push({ id, pos, kind: "code" }); };
  for (const m of code.matchAll(/(?:^|[\s;&|(])(?:export\s+|local\s+|readonly\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_]\w*)\+?=/g)) add(m[1], m.index + m[0].indexOf(m[1]), true);
  for (const m of code.matchAll(/\$\{?([A-Za-z_]\w*)/g)) add(m[1], m.index + m[0].indexOf(m[1]), false);
  for (const m of code.matchAll(/(?:^|[\s;&|(])for\s+([A-Za-z_]\w*)\s+in\b/g)) add(m[1], m.index + m[0].indexOf(m[1]), true);
  for (const m of code.matchAll(/(?:^|[\s;&|(])function\s+([A-Za-z_][\w-]*)/g)) add(m[1], m.index + m[0].lastIndexOf(m[1]), true);
  for (const m of code.matchAll(/(?:^|[\s;&|(])([A-Za-z_][\w-]*)\s*\(\)\s*\{?/g)) add(m[1], m.index + m[0].indexOf(m[1]), true);
  return out.sort((a, b) => a.pos - b.pos);
}

export const tokensOf = (text, file) => file.endsWith(".sh") ? tokensSh(text) : tokensJsLike(text, file.endsWith(".swift"));

// ---- allowlist, ratchet ------------------------------------------------------------------------------------------------

/** identifiers-allow.json: { files: [{ path, reason }], identifiers: [{ pattern, file?, kind?, reason }] } — pattern is a regex on the whole name, file a regex on the path, kind "code" or "key". */
export function loadAllow(file = ALLOW_FILE) {
  if (!fs.existsSync(file)) return { files: [], identifiers: [] };
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const e of d.files || []) if (!e.path || !e.reason) throw new Error(`${file}: every file entry needs path and reason`);
  for (const e of d.identifiers || []) if (!e.pattern || !e.reason) throw new Error(`${file}: every identifier entry needs pattern and reason`);
  return { files: d.files || [], identifiers: (d.identifiers || []).map((e) => ({ ...e, re: new RegExp(e.pattern), fre: e.file ? new RegExp(e.file) : null })) };
}
export function loadRatchet(file = RATCHET_FILE) {
  if (!fs.existsSync(file)) return { maxFindings: 0, maxIdentifiers: 0 };
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const k of ["maxFindings", "maxIdentifiers"]) if (!Number.isInteger(d[k]) || d[k] < 0) throw new Error(`${file}: ${k} must be an integer >= 0`);
  return { maxFindings: d.maxFindings, maxIdentifiers: d.maxIdentifiers };
}

// ---- scan --------------------------------------------------------------------------------------------------------------

/**
 * Scans code files. Returns { findings: [{ file, line, id, word, kind }], allowed, skipped }.
 * `skipFile` also lets files through that the language allowlist excludes (translation tables, recorded CLI texts, vendored text).
 */
export function scan({ root = REPO, files, vocab = loadVocab(), allow = loadAllow(), languageAllow = loadLanguageAllow() } = {}) {
  files ||= publicFiles(root);
  const findings = []; let allowed = 0, skipped = 0;
  for (const p of files) {
    if (!CODE_FILE.test(p) || NEVER.test(p)) continue;
    if (fileAllowed(p, languageAllow) || fileAllowed(p, allow)) { continue; }
    let text;
    try { const st = fs.statSync(path.join(root, p)); if (!st.isFile()) continue; if (st.size > MAX_BYTES) { skipped++; continue; } text = fs.readFileSync(path.join(root, p), "utf8"); } catch { continue; }
    let line = 1, at = 0;
    for (const tk of tokensOf(text, p)) {
      const word = germanPart(tk.id, vocab); if (!word) continue;
      if (allow.identifiers.some((e) => e.re.test(tk.id) && (!e.fre || e.fre.test(p)) && (!e.kind || e.kind === tk.kind))) { allowed++; continue; }
      for (let k = text.indexOf("\n", at); k >= 0 && k < tk.pos; k = text.indexOf("\n", at)) { line++; at = k + 1; }
      findings.push({ file: p, line, pos: tk.pos, id: tk.id, word, kind: tk.kind });
    }
  }
  return { findings, allowed, skipped };
}

export const dirOf = (p) => { const s = p.split("/"), d = s.slice(0, -1); return d.length ? d.slice(0, s[0] === "server" || s[0] === "mobile" ? 3 : 2).join("/") : "(root)"; };
const tally = (list, f) => { const m = new Map(); for (const x of list) { const k = f(x); m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))); };
export function summarize(findings) {
  return { total: findings.length, identifiers: new Set(findings.map((f) => f.id)).size, byIdentifier: tally(findings, (f) => f.id), byFile: tally(findings, (f) => f.file), byWord: tally(findings, (f) => f.word), byDir: tally(findings, (f) => dirOf(f.file)) };
}
/** A short report: never a wall — a handful of identifiers, files and directories. */
export function render(r, { top = 10 } = {}) {
  const s = summarize(r.findings); const row = ([k, n]) => `  ${String(n).padStart(6)}  ${k}`;
  return [`${s.total} German identifier occurrences, ${s.identifiers} distinct identifiers`,
    "top identifiers:", ...s.byIdentifier.slice(0, top).map(row), "top files:", ...s.byFile.slice(0, top).map(row),
    "top vocabulary words:", ...s.byWord.slice(0, top).map(row), "directories:", ...s.byDir.slice(0, top).map(row),
    "full list: node tools/check/identifiers.mjs --list [prefix]"].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2); const flag = (x) => a.includes(x);
  const ratchet = flag("--strict") ? { maxFindings: 0, maxIdentifiers: 0 } : loadRatchet();
  const r = scan(); const s = summarize(r.findings);
  if (flag("--list")) { const li = a.indexOf("--list"); const pre = a[li + 1] && !a[li + 1].startsWith("--") ? a[li + 1] : ""; for (const f of r.findings) if (f.file.startsWith(pre)) console.log(`${f.file}:${f.line}\t${f.kind}\t${f.id}\t${f.word}`); }
  else if (flag("--json")) console.log(JSON.stringify({ ratchet, allowed: r.allowed, ...s, byIdentifier: s.byIdentifier.slice(0, 40), byFile: s.byFile.slice(0, 40) }, null, 1));
  else console.log(render(r));
  console.log(`${s.total} findings / ${s.identifiers} identifiers (ratchet ${ratchet.maxFindings} / ${ratchet.maxIdentifiers}${ratchet.maxFindings ? ": must reach 0 before publication" : ""}); allowlisted ${r.allowed}; skipped large files ${r.skipped}`);
  process.exit(s.total > ratchet.maxFindings || s.identifiers > ratchet.maxIdentifiers ? 1 : 0);
}

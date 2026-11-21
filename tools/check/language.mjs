#!/usr/bin/env node
// The language guard: the public tree is English.
//
// Promise: outside the allowlist (language-allow.json: translation tables, German test data that is meant to be German,
// recorded CLI texts, vendored third-party text) no comment, doc line, test title, string or identifier in the public
// tree is German.
//
// !! RATCHET — NOT YET THE FINAL STATE. language-ratchet.json records today's count of real German lines. The test fails
// !! when the count EXCEEDS it, so it can only shrink. The ratchet MUST reach 0 (maxFindings: 0, or `--strict`) before
// !! publication; until then the translation slices work it down and lower the number in the same change.
//
// How a line counts as German (conservative — a miss is cheaper than a false alarm):
//   a line is German if it contains an umlaut or ß, or at least 3 DISTINCT German-only function words.
//   Words that are also English (die, den, was, an, man, will, hat, also …) are not on the list.
//   Ordinary English text never has a ä/ö/ü/ß; the ones in English code are allowlisted by file or by line pattern.
// What kind a finding is (first match wins):
//   testname  the line opens test(/it(/describe( with a string       doc      a line of a .md / .txt file
//   comment   // /* * # <!-- -- lines or a trailing comment         string   a quoted literal on the line
//   identifier a name made of >= 2 German words (istNichtFertig) or with an umlaut    other   anything else
//
//   node tools/check/language.mjs                 report (per kind, per directory, top files); exit 1 above the ratchet
//   node tools/check/language.mjs --strict        ratchet 0: any finding fails (the state required for publication)
//   node tools/check/language.mjs --ratchet <n>   another ratchet for this run
//   node tools/check/language.mjs --list [dir]    every finding as file:line, kind, excerpt (optionally below a prefix)
//   node tools/check/language.mjs --json          machine-readable summary
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicFiles, REPO } from "./cleanliness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ALLOW_FILE = path.join(HERE, "language-allow.json");
export const RATCHET_FILE = path.join(HERE, "language-ratchet.json");
const MAX_BYTES = 4 << 20;      // a larger file is skipped (generated or recorded data), and counted as skipped
const MAX_LINE = 1500;          // only the head of a very long line is read

/** German-only function words. English twins (die, den, was, hat, man, will, also, an, in, so, war, bin) are left out. */
export const STOPWORDS = new Set(("der das und nicht wird für mit wenn oder ist eine ein zu von dem sich auch bei nach aus auf " +
  "aber dass wurde werden nur noch kein keine einen einem einer sind hier dann weil damit ohne sonst schon sondern jede jeder jedes " +
  "wir sie nicht kann muss soll zum zur vom beim über unter vor gegen zwischen sowie bzw wieder immer alle alles").split(/\s+/));
const UMLAUT = /[äöüÄÖÜß]/;
const WORD = /[A-Za-zäöüÄÖÜß]+/g;
// Words for the identifier rule: stopwords plus common German nouns/verbs that appear in names.
const NAME_WORDS = new Set([...STOPWORDS, "ist", "nicht", "fertig", "aufgabe", "nutzer", "datei", "fehler", "ergebnis", "zeile", "gruppe", "lauf",
  "anfrage", "antwort", "stand", "wert", "liste", "name", "pruefung", "prufung", "erledigt", "offen", "geplant", "senden", "lesen", "loeschen", "fuer", "ueber", "zurueck"]);

export function germanWords(line) { const s = new Set(); for (const w of line.toLowerCase().match(WORD) || []) if (STOPWORDS.has(w)) s.add(w); return s; }
export const isGerman = (line) => UMLAUT.test(line) || germanWords(line).size >= 3;

/** Splits camelCase / snake_case / kebab names into lowercase parts. */
const parts = (id) => id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-zäöüÄÖÜß0-9]+|\s+/).filter(Boolean).map((x) => x.toLowerCase());
const IDENT = /\b[A-Za-z_$][A-Za-z0-9_$]{3,}\b/g;
export function germanIdentifier(line) {
  for (const m of line.matchAll(IDENT)) { const p = parts(m[0]); if (p.length >= 2 && p.filter((w) => NAME_WORDS.has(w)).length >= 2) return m[0]; }
  return null;
}

export function kindOf(file, line) {
  if (/^\s*(?:test|it|describe)(?:\.\w+)?\(\s*(["'`])/.test(line)) return "testname";
  if (/\.(md|txt|markdown)$/i.test(file)) return "doc";
  if (/^\s*(?:\/\/|\/\*|\*|#|<!--|--\s|;)/.test(line) || /(?:^|\s)\/\/\s/.test(line.replace(/["'`][^"'`]*["'`]/g, ""))) return "comment";
  if (/["'`]/.test(line)) return "string";
  return "other";
}

export function loadAllow(file = ALLOW_FILE) {
  if (!fs.existsSync(file)) return { files: [], lines: [] };
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const e of d.files || []) if (!e.path || !e.reason) throw new Error(`${file}: every file entry needs path and reason`);
  for (const e of d.lines || []) if (!e.pattern || !e.reason) throw new Error(`${file}: every line entry needs pattern and reason`);
  return { files: d.files || [], lines: (d.lines || []).map((e) => ({ ...e, re: new RegExp(e.pattern), fre: e.file ? new RegExp(e.file) : null })) };
}
const globRe = (g) => new RegExp("^" + g.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");
export function fileAllowed(p, allow) {
  return allow.files.find((e) => (e.path.endsWith("/") ? p.startsWith(e.path) : e.path.includes("*") ? globRe(e.path).test(p) : p === e.path || p.startsWith(e.path + "/"))) || null;
}
export function loadRatchet(file = RATCHET_FILE) {
  if (!fs.existsSync(file)) return 0;
  const d = JSON.parse(fs.readFileSync(file, "utf8")); if (!Number.isInteger(d.maxFindings) || d.maxFindings < 0) throw new Error(`${file}: maxFindings must be an integer >= 0`);
  return d.maxFindings;
}

/** Scans files. Returns { findings: [{file, line, kind, text}], skipped, allowedFiles: Map(reason -> count lines) }. */
export function scan({ root = REPO, files = publicFiles(root), allow = loadAllow() } = {}) {
  const findings = []; let skipped = 0; const allowedLines = new Map();
  for (const p of files) {
    if (/(^|\/)package-lock\.json$/.test(p)) continue;
    const fa = fileAllowed(p, allow); let buf;
    try { const st = fs.statSync(path.join(root, p)); if (!st.isFile()) continue; if (st.size > MAX_BYTES) { skipped++; continue; } buf = fs.readFileSync(path.join(root, p)); } catch { continue; }
    if (buf.includes(0)) continue;   // binary
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].length > MAX_LINE ? lines[i].slice(0, MAX_LINE) : lines[i];
      let kind = null, hit = false;
      if (isGerman(line)) { hit = true; kind = kindOf(p, line); }
      else { const id = germanIdentifier(line); if (id) { hit = true; kind = "identifier"; } }
      if (!hit) continue;
      if (kind !== "identifier" && !germanWords(line).size && /[A-Za-z_$][\w$]*[äöüÄÖÜß][\w$]*\s*[=(:]/.test(line.replace(/(["'`]).*?\1/g, ""))) kind = "identifier";   // umlaut in a name
      if (fa) { allowedLines.set(fa.reason, (allowedLines.get(fa.reason) || 0) + 1); continue; }
      const la = allow.lines.find((e) => e.re.test(line) && (!e.fre || e.fre.test(p)));
      if (la) { allowedLines.set(la.reason, (allowedLines.get(la.reason) || 0) + 1); continue; }
      findings.push({ file: p, line: i + 1, kind, text: line.trim().replace(/\s+/g, " ").slice(0, 140) });
    }
  }
  return { findings, skipped, allowedLines };
}

export const KINDS = ["testname", "comment", "doc", "string", "identifier", "other"];
export const dirOf = (p) => { const s = p.split("/"); return s.length <= 2 ? s[0] : s.slice(0, s[0] === "server" || s[0] === "mobile" ? 3 : 2).join("/"); };
export function summarize(findings) {
  const kinds = {}, dirs = {}, files = {};
  for (const f of findings) { kinds[f.kind] = (kinds[f.kind] || 0) + 1; const d = (dirs[dirOf(f.file)] ||= { total: 0 }); d.total++; d[f.kind] = (d[f.kind] || 0) + 1; files[f.file] = (files[f.file] || 0) + 1; }
  return { total: findings.length, kinds, dirs, topFiles: Object.entries(files).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
}
export function render(r, { top = 15 } = {}) {
  const s = summarize(r.findings); const out = [];
  out.push(`per kind: ${KINDS.filter((k) => s.kinds[k]).map((k) => `${k} ${s.kinds[k]}`).join(", ") || "none"}`);
  out.push("per directory (lines):");
  for (const [d, v] of Object.entries(s.dirs).sort((a, b) => b[1].total - a[1].total)) out.push(`  ${String(v.total).padStart(6)}  ${d}  [${KINDS.filter((k) => v[k]).map((k) => `${k} ${v[k]}`).join(", ")}]`);
  out.push(`top files:`); for (const [f, n] of s.topFiles.slice(0, top)) out.push(`  ${String(n).padStart(6)}  ${f}`);
  return out.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2); const flag = (n) => a.includes(n);
  const ri = a.indexOf("--ratchet"); const ratchet = flag("--strict") ? 0 : ri >= 0 ? Number(a[ri + 1]) : loadRatchet();
  const r = scan();
  if (flag("--list")) { const li = a.indexOf("--list"); const pre = a[li + 1] && !a[li + 1].startsWith("--") ? a[li + 1] : ""; for (const f of r.findings) if (f.file.startsWith(pre)) console.log(`${f.file}:${f.line}\t${f.kind}\t${f.text}`); }
  else if (flag("--json")) console.log(JSON.stringify({ ratchet, skipped: r.skipped, ...summarize(r.findings), topFiles: undefined }, null, 1));
  else console.log(render(r));
  const allowed = [...r.allowedLines.values()].reduce((x, y) => x + y, 0);
  console.log(`${r.findings.length} German lines (ratchet ${ratchet}${ratchet ? ": must reach 0 before publication" : ""}); allowlisted ${allowed}; skipped large files ${r.skipped}`);
  process.exit(r.findings.length > ratchet ? 1 : 0);
}

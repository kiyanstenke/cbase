// Text, positions and paths of the language service — a leaf with no imports except node:*. As in LSP and in the contract
// (lsp/contract.js), positions are 0-based and `character` is in UTF-16 units — the same units as the indices of a JS string,
// so nothing is converted here. Line endings: `\n`, `\r\n` and `\r` (LSP 3.17 "Text Documents"); `character` never counts the ending.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The start offsets of all lines — `\r\n` is ONE line ending. */
export function lineBeginnings(text) {
  const t = String(text ?? "");
  const out = [0];
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 10) out.push(i + 1);
    else if (c === 13) { if (t.charCodeAt(i + 1) === 10) i++; out.push(i + 1); }
  }
  return out;
}

/** The end of a line (without the line ending). */
function lineEnd(t, beginnings, row) {
  let end = row + 1 < beginnings.length ? beginnings[row + 1] : t.length;
  if (end > beginnings[row] && t.charCodeAt(end - 1) === 10) end--;
  if (end > beginnings[row] && t.charCodeAt(end - 1) === 13) end--;
  return end;
}

/** Position → offset; clamped when outside (as in LSP: a `character` past the end of the line means the end of the line). */
export function offsetOf(text, pos, beginnings = lineBeginnings(text)) {
  const t = String(text ?? "");
  const row = Math.max(0, Math.min(Number(pos?.line) || 0, beginnings.length - 1));
  const end = lineEnd(t, beginnings, row);
  return Math.min(beginnings[row] + Math.max(0, Number(pos?.character) || 0), end);
}

/** Offset → position. */
export function positionOf(text, offset, beginnings = lineBeginnings(text)) {
  const o = Math.max(0, Math.min(Number(offset) || 0, String(text ?? "").length));
  let lo = 0, hi = beginnings.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (beginnings[mid] <= o) lo = mid; else hi = mid - 1; }
  return { line: lo, character: o - beginnings[lo] };
}

const WORD = /[\p{L}\p{N}_$]/u;
/** The word (identifier) at a position → `{ range, text }` or null. */
export function wordAt(text, pos) {
  const t = String(text ?? "");
  const o = offsetOf(t, pos);
  let a = o, b = o;
  while (a > 0 && WORD.test(t[a - 1])) a--;
  while (b < t.length && WORD.test(t[b])) b++;
  if (a === b) return null;
  return { range: { start: positionOf(t, a), end: positionOf(t, b) }, text: t.slice(a, b) };
}

/** A new name that is an identifier (letters, digits, `_`, `$`; no leading digit) — the rule of the agent route. */
export const isIdentifier = (s) => typeof s === "string" && /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(s);

/**
 * Apply text edits `[{ range, newText }]` to a text — back to front; an overlap throws (`EOVERLAP`). Several insertions at the
 * SAME position land in array order (LSP 3.17, TextEdit[]: the order in the array defines the order of the inserted texts) —
 * applied from the back that means: at the same position, the later one first.
 */
export function applyEdits(text, edits) {
  const t = String(text ?? "");
  const beginnings = lineBeginnings(t);
  const spans = (edits || []).map((e, i) => ({ a: offsetOf(t, e.range?.start, beginnings), b: offsetOf(t, e.range?.end, beginnings), fresh: String(e.newText ?? ""), i }))
    .sort((x, y) => y.a - x.a || y.b - x.b || y.i - x.i);
  let out = t;
  let limit = Infinity;
  for (const s of spans) {
    if (s.b < s.a || s.b > limit) throw Object.assign(new Error("Edits overlap"), { code: "EOVERLAP" });
    out = out.slice(0, s.a) + s.fresh + out.slice(s.b);
    limit = s.a;
  }
  return out;
}

/** file:// URI ↔ absolute path. Any other kind of URI (untitled:, …) ⇒ null. */
export function pathOfUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  try { return fileURLToPath(uri); } catch { return null; }
}
export const uriOfPath = (abs) => pathToFileURL(path.resolve(String(abs))).href;

/** Is `abs` below `root` (lexically)? → the relative path (posix) or null. The root itself does not count. */
export function relativeUnder(root, abs) {
  if (!root || !abs) return null;
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

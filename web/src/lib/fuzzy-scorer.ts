// Port of: microsoft/vscode src/vs/base/common/fuzzyScorer.ts (MIT)
// Port of: microsoft/vscode src/vs/base/common/filters.ts (MIT)
// The Quick Open scoring as in VS Code — a port of `src/vs/base/common/fuzzyScorer.ts` and the word filters from
// `src/vs/base/common/filters.ts` (Code - OSS, github.com/microsoft/vscode, tag 1.143.1), pure, without DOM and without network. Origin
// and license: Code - OSS © Microsoft Corporation, MIT license (https://github.com/microsoft/vscode/blob/1.143.1/LICENSE.txt) — the
// notice is in lib/thirdParty.ts.
//
//   scoreFuzzy                 the matrix scoring of a string (hit +1, follow-up bonus, same casing +1, start +8,
//                              after a separator +5 ("/", "\\") or +4 ("_ - . space ' \" :"), inner capital +2).
//   prepareRequest             `prepareQuery`: whitespace, "*", "…" and """ drop, a "#" at the end too; several words = several values.
//   evaluateEntry             `scoreItemFuzzy`: a hit in the name (prefix 1<<17, else 65536 + points) beats one in the path.
//   compareEntries        `compareItemsByFuzzyScore`: identity, name hit, points, name hit, compactness, fallback.
//   wordFilter                 the command palette filter (`matchesContiguousSubString` or `matchesWords`).
//
// The same calculation runs in the server (server/backend/electron/server/runtime/fast-open.js, the order of the ⌘P hits — the cap
// stands where the cost arises); web/test/quick-input.test.mjs runs BOTH against the same paths (binding).
// Deviation: VS Code scores the symbols (`@`, `#`) with `fuzzyScore` from filters.ts (the suggestion list scorer); here the same matrix
// as Quick Open scores — the order can differ for equally good hits.

export type Hits = { start: number; end: number };
export type RequestValue = {
  original: string;
  originalLowercase: string;
  pathNormalized: string;
  normalized: string;
  normalizedLowercase: string;
  expectContiguousMatch: boolean;
};
export type Request = RequestValue & { values?: RequestValue[]; containsPathSeparator: boolean };
export type EntryScore = { score: number; labelMatch?: Hits[]; descriptionMatch?: Hits[] };
export type Access<T> = { label: (x: T) => string | undefined; description: (x: T) => string | undefined; path: (x: T) => string | undefined };

const SEP = "/";
const NO_HITS = 0;
/** An exact path (the input IS the path). */
export const PATH_IDENTITY = 1 << 18;
/** The input is a prefix of the name. */
export const NAME_PREFIX = 1 << 17;
/** The input hits the name (anywhere). */
export const NAME_THRESHOLD = 1 << 16;
const NO_SCORE: EntryScore = Object.freeze({ score: 0 }) as EntryScore;

// ── scoreFuzzy ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** `[points, positions]` — 0: no hit. `notContiguous`: the characters may lie scattered; otherwise the start of the
 *  input must stand contiguously in the target. */
export function scoreFuzzy(target: string, request: string, requestSmall: string, notContiguous: boolean): [number, number[]] {
  if (!target || !request) return [NO_HITS, []];
  const rowLine = target.length, al = request.length;
  if (rowLine < al) return [NO_HITS, []];
  return matrix(request, requestSmall, al, target, target.toLowerCase(), rowLine, notContiguous);
}
function matrix(q: string, qk: string, ql: number, t: string, tk: string, tl: number, nonContiguous: boolean): [number, number[]] {
  const points: number[] = [], followUp: number[] = [];
  for (let qi = 0; qi < ql; qi++) {
    const off = qi * tl, offBefore = off - tl, qiGt0 = qi > 0, qc = q[qi], qck = qk[qi];
    for (let ti = 0; ti < tl; ti++) {
      const tiGt0 = ti > 0, i = off + ti, left = i - 1, diag = offBefore + ti - 1;
      const leftP = tiGt0 ? points[left] : 0;
      const diagP = qiGt0 && tiGt0 ? points[diag] : 0;
      const sequenceL = qiGt0 && tiGt0 ? followUp[diag] : 0;
      const p = !diagP && qiGt0 ? 0 : characterValue(qc, qck, t, tk, ti, sequenceL);
      if (p && diagP + p >= leftP && (nonContiguous || qiGt0 || tk.startsWith(qk, ti))) {
        followUp[i] = sequenceL + 1;
        points[i] = diagP + p;
      } else {
        followUp[i] = NO_HITS;
        points[i] = leftP;
      }
    }
  }
  const pos: number[] = [];
  let qi = ql - 1, ti = tl - 1;
  while (qi >= 0 && ti >= 0) {
    if (followUp[qi * tl + ti] !== NO_HITS) { pos.push(ti); qi--; }
    ti--;
  }
  return [points[ql * tl - 1], pos.reverse()];
}
function characterValue(qc: string, qck: string, t: string, tk: string, ti: number, sequenceL: number): number {
  let p = 0;
  if (!equal(qck, tk[ti])) return p;
  p += 1;
  if (sequenceL > 0) p += Math.min(sequenceL, 3) * 6 + Math.max(0, sequenceL - 3) * 3;
  if (qc === t[ti]) p += 1;
  if (ti === 0) p += 8;
  else {
    const separator = separatorValue(t.charCodeAt(ti - 1));
    if (separator) p += separator;
    else if (isUpper(t.charCodeAt(ti)) && sequenceL === 0) p += 2;
  }
  return p;
}
const equal = (a: string, b: string) => a === b || ((a === "/" || a === "\\") && (b === "/" || b === "\\"));
const isUpper = (c: number) => c >= 65 && c <= 90;
function separatorValue(c: number): number {
  switch (c) {
    case 47: case 92: return 5; // "/" "\\"
    case 95: case 45: case 46: case 32: case 39: case 34: case 58: return 4; // "_ - . space ' \" :"
    default: return 0;
  }
}

// ── prepareQuery ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function norm(s: string): { pathNormalized: string; normalized: string; normalizedLowercase: string } {
  const pathNormalized = s.replace(/\\/g, SEP);
  const normalized = pathNormalized.replace(/[*…\s"]/g, "").replace(/(?<=.)#$/, "");
  return { pathNormalized, normalized, normalizedLowercase: normalized.toLowerCase() };
}
const inQuotes = (s: string) => s.startsWith('"') && s.endsWith('"');
/** The request like VS Code `prepareQuery`. */
export function prepareRequest(input: string): Request {
  const s = typeof input === "string" ? input : "";
  const n = norm(s);
  let values: RequestValue[] | undefined;
  const parts = s.split(" ");
  if (parts.length > 1) {
    for (const w of parts) {
      const m = norm(w);
      if (!m.normalized) continue;
      (values ??= []).push({ original: w, originalLowercase: w.toLowerCase(), ...m, expectContiguousMatch: inQuotes(w) });
    }
  }
  return { original: s, originalLowercase: s.toLowerCase(), ...n, values, containsPathSeparator: n.pathNormalized.indexOf(SEP) >= 0, expectContiguousMatch: inQuotes(s) };
}

// ── scoreItemFuzzy ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Positions → ranges (consecutive ones merged). */
export function asAreas(pos: readonly number[] | undefined): Hits[] {
  const out: Hits[] = [];
  if (!pos) return out;
  let last: Hits | undefined;
  for (const p of pos) {
    if (last && last.end === p) last.end += 1;
    else { last = { start: p, end: p + 1 }; out.push(last); }
  }
  return out;
}
/** Merge overlapping ranges (sorted). */
export function merge(b: Hits[]): Hits[] {
  const s = b.sort((x, y) => x.start - y.start), out: Hits[] = [];
  let last: Hits | undefined;
  for (const x of s) {
    if (!last || last.end < x.start || x.end < last.start) { last = x; out.push(x); }
    else { last.start = Math.min(last.start, x.start); last.end = Math.max(last.end, x.end); }
  }
  return out;
}
/** `matchesPrefix` case-insensitive. */
export function prefixHits(word: string, target: string): Hits[] | null {
  if (!target || target.length < word.length) return null;
  if (target.slice(0, word.length).toLowerCase() !== word.toLowerCase()) return null;
  return word.length > 0 ? [{ start: 0, end: word.length }] : [];
}

function individual(label: string, desc: string | undefined, path: string | undefined, a: RequestValue, nameFirst: boolean, nonContiguous: boolean): EntryScore {
  if (nameFirst || !desc) {
    const [lp, lpos] = scoreFuzzy(label, a.normalized, a.normalizedLowercase, nonContiguous && !a.expectContiguousMatch);
    if (lp) {
      const prefix = prefixHits(a.normalized, label);
      const base = prefix ? NAME_PREFIX + Math.round((a.normalized.length / label.length) * 100) : NAME_THRESHOLD;
      return { score: base + lp, labelMatch: prefix || asAreas(lpos) };
    }
  }
  if (desc) {
    const before = path ? `${desc}${SEP}` : desc;
    const vl = before.length;
    const [p, pos] = scoreFuzzy(`${before}${label}`, a.normalized, a.normalizedLowercase, nonContiguous && !a.expectContiguousMatch);
    if (p) {
      const labelMatch: Hits[] = [], descriptionMatch: Hits[] = [];
      for (const h of asAreas(pos)) {
        if (h.start < vl && h.end > vl) { labelMatch.push({ start: 0, end: h.end - vl }); descriptionMatch.push({ start: h.start, end: vl }); }
        else if (h.start >= vl) labelMatch.push({ start: h.start - vl, end: h.end - vl });
        else descriptionMatch.push(h);
      }
      return { score: p, labelMatch, descriptionMatch };
    }
  }
  return NO_SCORE;
}
function score(label: string, desc: string | undefined, path: string | undefined, a: Request, nonContiguous: boolean): EntryScore {
  const nameFirst = !path || !a.containsPathSeparator;
  // As VS Code on the Mac (not Linux): an exact path is case-insensitive.
  if (path && a.pathNormalized.toLowerCase() === path.toLowerCase()) {
    return { score: PATH_IDENTITY, labelMatch: [{ start: 0, end: label.length }], descriptionMatch: desc ? [{ start: 0, end: desc.length }] : undefined };
  }
  if (a.values && a.values.length > 1) {
    let sum = 0;
    const lm: Hits[] = [], dm: Hits[] = [];
    for (const w of a.values) {
      const r = individual(label, desc, path, w, nameFirst, nonContiguous);
      if (r.score === NO_HITS) return NO_SCORE;
      sum += r.score;
      if (r.labelMatch) lm.push(...r.labelMatch);
      if (r.descriptionMatch) dm.push(...r.descriptionMatch);
    }
    return { score: sum, labelMatch: merge(lm), descriptionMatch: merge(dm) };
  }
  return individual(label, desc, path, a, nameFirst, nonContiguous);
}

/** A cache per request (VS Code `scorerCache`). */
export type Storage = Map<string, EntryScore>;
export function evaluateEntry<T>(x: T, a: Request, nonContiguous: boolean, z: Access<T>, storage?: Storage): EntryScore {
  if (!x || !a.normalized) return NO_SCORE;
  const label = z.label(x);
  if (!label) return NO_SCORE;
  const desc = z.description(x), path = z.path(x);
  const key = storage ? `${label}\u0000${desc ?? ""}\u0000${path ?? ""}\u0000${nonContiguous ? 1 : 0}\u0000${a.original}` : "";
  const old = storage?.get(key);
  if (old) return old;
  const r = score(label, desc, path, a, nonContiguous);
  storage?.set(key, r);
  return r;
}

// ── compareItemsByFuzzyScore ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const collator = typeof Intl !== "undefined" ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }) : null;
/** VS Code `compareFileNames` (numeric, ignoring accent and case differences; a tie by characters). */
export function compareFileNames(a: string, b: string): number {
  const x = a || "", y = b || "";
  const r = collator ? collator.compare(x, y) : x.localeCompare(y);
  if (r === 0 && x !== y) return x < y ? -1 : 1;
  return r;
}
function prefixComparison(a: string, b: string, search: string): number {
  const ak = a.toLowerCase(), bk = b.toLowerCase();
  const ap = ak.startsWith(search), bp = bk.startsWith(search);
  if (ap !== bp) return ap ? -1 : 1;
  if (ap && bp) { if (ak.length < bk.length) return -1; if (ak.length > bk.length) return 1; }
  return 0;
}
/** VS Code `compareAnything`. */
function compareAnything(a: string, b: string, search: string): number {
  const ak = a.toLowerCase(), bk = b.toLowerCase();
  const p = prefixComparison(a, b, search);
  if (p) return p;
  const as = ak.endsWith(search), bs = bk.endsWith(search);
  if (as !== bs) return as ? -1 : 1;
  const r = compareFileNames(ak, bk);
  return r !== 0 ? r : ak.localeCompare(bk);
}
function hitsLength(a: Hits[] | undefined, b: Hits[] | undefined): number {
  if ((!a && !b) || (!a?.length && !b?.length)) return 0;
  if (!b?.length) return -1;
  if (!a?.length) return 1;
  const la = a[a.length - 1].end - a[0].start, lb = b[b.length - 1].end - b[0].start;
  return la === lb ? 0 : lb < la ? 1 : -1;
}
function gap<T>(x: T, w: EntryScore, z: Access<T>): number {
  let from = -1, until = -1;
  if (w.descriptionMatch?.length) from = w.descriptionMatch[0].start;
  else if (w.labelMatch?.length) from = w.labelMatch[0].start;
  if (w.labelMatch?.length) {
    until = w.labelMatch[w.labelMatch.length - 1].end;
    if (w.descriptionMatch?.length) { const d = z.description(x); if (d) until += d.length; }
  } else if (w.descriptionMatch?.length) until = w.descriptionMatch[w.descriptionMatch.length - 1].end;
  return until - from;
}
function fallback<T>(x: T, y: T, a: Request, z: Access<T>): number {
  const lx = z.label(x) || "", ly = z.label(y) || "", dx = z.description(x), dy = z.description(y);
  const gx = lx.length + (dx ? dx.length : 0), gy = ly.length + (dy ? dy.length : 0);
  if (gx !== gy) return gx - gy;
  const px = z.path(x), py = z.path(y);
  if (px && py && px.length !== py.length) return px.length - py.length;
  if (lx !== ly) return compareAnything(lx, ly, a.normalized);
  if (dx && dy && dx !== dy) return compareAnything(dx, dy, a.normalized);
  if (px && py && px !== py) return compareAnything(px, py, a.normalized);
  return 0;
}
/** The order of Quick Open (VS Code `compareItemsByFuzzyScore`). */
export function compareEntries<T>(x: T, y: T, a: Request, nonContiguous: boolean, z: Access<T>, storage?: Storage): number {
  const wx = evaluateEntry(x, a, nonContiguous, z, storage), wy = evaluateEntry(y, a, nonContiguous, z, storage);
  const sx = wx.score, sy = wy.score;
  if ((sx === PATH_IDENTITY || sy === PATH_IDENTITY) && sx !== sy) return sx === PATH_IDENTITY ? -1 : 1;
  if (sx > NAME_THRESHOLD || sy > NAME_THRESHOLD) {
    if (sx !== sy) return sx > sy ? -1 : 1;
    if (sx < NAME_PREFIX && sy < NAME_PREFIX) { const l = hitsLength(wx.labelMatch, wy.labelMatch); if (l !== 0) return l; }
    const lx = z.label(x) || "", ly = z.label(y) || "";
    if (lx.length !== ly.length) return lx.length - ly.length;
  }
  if (sx !== sy) return sx > sy ? -1 : 1;
  const hx = Array.isArray(wx.labelMatch) && wx.labelMatch.length > 0, hy = Array.isArray(wy.labelMatch) && wy.labelMatch.length > 0;
  if (hx && !hy) return -1;
  if (hy && !hx) return 1;
  const ax = gap(x, wx, z), ay = gap(y, wy, z);
  if (ax && ay && ax !== ay) return ay > ax ? -1 : 1;
  return fallback(x, y, a, z);
}

/** The accessors for a relative file path: name, folder (relative), path. */
export const FILE_ACCESS: Access<string> = {
  label: (p) => p.slice(p.lastIndexOf("/") + 1),
  description: (p) => { const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : undefined; },
  path: (p) => p,
};
/** The same accessors WITHOUT the folder (VS Code `labelOnlyEditorHistoryPickAccessor` = `{ skipDescription: true }`): this is how Quick
 *  Open scores the history while the input contains no path separator — by name only (the path stays for the exact hit). */
export const FILE_ACCESS_NAME: Access<string> = { label: FILE_ACCESS.label, description: () => undefined, path: FILE_ACCESS.path };
/** Does every character of the request appear in this order in the target (case-insensitive)? (`fuzzyContains`, the prefilter of file search.) */
export function containsFuzzy(target: string, requestSmall: string): boolean {
  if (!target || !requestSmall) return false;
  if (target.length < requestSmall.length) return false;
  const tk = target.toLowerCase();
  let last = -1;
  for (let i = 0; i < requestSmall.length; i++) {
    const j = tk.indexOf(requestSmall[i], last + 1);
    if (j < 0) return false;
    last = j;
  }
  return true;
}

// ── The word filter of the command palette ──────────────────────────────────────────────────────────────────────────────────────────
const SEPARATOR = new Set([..."()[]{}<>`'\"-/;:,.?!"].map((c) => c.charCodeAt(0)));
const isSeparator = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || SEPARATOR.has(c);
/** Lower case without accents (VS Code `normalizeNFD` + removing the combining characters, only if the length stays). */
function withoutAccent(s: string): string {
  const n = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return (n.length === s.length ? n : s).toLowerCase();
}
/** `matchesContiguousSubString`. */
export function partHits(word: string, target: string): Hits[] | null {
  if (word.length > target.length) return null;
  const i = withoutAccent(target).indexOf(withoutAccent(word));
  return i === -1 ? null : [{ start: i, end: i + word.length }];
}
const characterFits = (a: number, b: number) => a === b || (isSeparator(a) && isSeparator(b));
function nextWord(s: string, start: number): number {
  for (let i = start; i < s.length; i++) if (isSeparator(s.charCodeAt(i)) || (i > 0 && isSeparator(s.charCodeAt(i - 1)))) return i;
  return s.length;
}
function front(header: Hits, rest: Hits[]): Hits[] {
  if (rest.length === 0) return [header];
  if (header.end === rest[0].start) rest[0].start = header.start;
  else rest.unshift(header);
  return rest;
}
const copy = (r: Hits[] | null) => (r === null ? null : r.map((x) => ({ start: x.start, end: x.end })));
function words(w: string, z: string, wi: number, tIdx: number, contiguous: boolean, memo: Map<number, Hits[] | null>): Hits[] | null {
  if (wi === w.length) return [];
  if (tIdx === z.length) return null;
  const k = wi * (z.length + 1) + tIdx;
  if (memo.has(k)) return copy(memo.get(k) ?? null);
  const r = wordsAfterAll(w, z, wi, tIdx, contiguous, memo);
  memo.set(k, copy(r));
  return r;
}
function wordsAfterAll(w: string, z: string, wi: number, tIdx: number, contiguous: boolean, memo: Map<number, Hits[] | null>): Hits[] | null {
  if (!characterFits(w.charCodeAt(wi), z.charCodeAt(tIdx))) return null;
  let next = tIdx + 1;
  let r = words(w, z, wi + 1, next, contiguous, memo);
  if (!contiguous) {
    while (!r && (next = nextWord(z, next)) < z.length) {
      r = words(w, z, wi + 1, next, contiguous, memo);
      next++;
    }
  }
  if (!r) return null;
  if (w.charCodeAt(wi) !== z.charCodeAt(tIdx)) return r; // one separator against another: fits, but is not highlighted
  return front({ start: tIdx, end: tIdx + 1 }, r);
}
/** `matchesWords`: the words of the input as beginnings of words of the target ("gtd" hits "Go to Definition"). */
export function wordHits(word: string, target: string, contiguous = false): Hits[] | null {
  if (!target || target.length === 0) return null;
  const w = withoutAccent(word), z = withoutAccent(target), memo = new Map<number, Hits[] | null>();
  let r: Hits[] | null = null, tIdx = 0;
  while (tIdx < z.length && (r = words(w, z, 0, tIdx, contiguous, memo)) === null) tIdx = nextWord(z, tIdx + 1);
  return r;
}
/** The command palette filter (VS Code `WORD_FILTER = or(matchesContiguousSubString, matchesWords)`). */
export function wordFilter(word: string, target: string): Hits[] | null {
  return partHits(word, target) ?? wordHits(word, target);
}

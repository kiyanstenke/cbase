// Port of: microsoft/vscode src/vs/base/common/fuzzyScorer.ts (MIT)
// Port of: microsoft/vscode src/vs/base/common/strings.ts (MIT)
// Quick Open like VS Code: which files ⌘P shows and in which order — in TWO stages, as in VS Code 1.143:
//   1. the file search service (`getFileSearchResults` → `fileSearch` with `sortByScore`): with several words its pattern is ONLY
//      the first one (`values[0]`), otherwise the whole input; filtered with `fuzzyContains` (every character in this order in the
//      relative path, case-insensitive), sorted by this pattern, capped (`MAX_RESULTS` 512). At the cap with several words, the
//      same search with the whole input is added (`limitHit && values.length > 1`).
//   2. Quick Open itself (`getAdditionalPicks`): everything sorted with the WHOLE input (`compareItemsByFuzzyScore`; each word on
//      its own, in any order, against name or path), the best 512; whatever gets no score is dropped.
// Name = basename, description = folder, path = relative path. The cap belongs where the cost arises: here, in B or in the
// container of a copy. `fastPattern`/`fastMatches` give the walk over the files (files.js `quickOpenFiles`, fileAccess.js
// `fastCore`) the stage-1 prefilter, so its caps count hits only.
//
// Functions WITHOUT outside references (their text goes via Function#toString into the program in the container,
// runtime/fileAccess.js, like the other cores). The same computation lives in the web client (web/src/lib/fuzzy-scorer.ts —
// there it also scores the history and draws the matches); web/test/quick-input.test.mjs runs BOTH against the same paths and
// inputs — whoever changes something here changes it there. Origin and licence: port of `src/vs/base/common/fuzzyScorer.ts` and
// `fuzzyContains` (`src/vs/base/common/strings.ts`) from Code - OSS (github.com/microsoft/vscode, tag 1.143.1) © Microsoft
// Corporation, MIT licence (https://github.com/microsoft/vscode/blob/1.143.1/LICENSE.txt) — the notice is in
// web/src/lib/thirdParty.ts.

/**
 * `files`: relative paths (with "/"), `input`: the text without `:line` and `@symbol`, `cap`: at most this many results.
 * → `{ results, truncated }` — `truncated`: more than `cap` matched.
 */
export function fastOpen(files, input, cap) {
  const SEP = "/";
  const PATH_IDENTITY = 1 << 18, NAME_PREFIX = 1 << 17, NAME_THRESHOLD = 1 << 16;
  const NO = { score: 0 };
  const equal = (a, b) => a === b || ((a === "/" || a === "\\") && (b === "/" || b === "\\"));
  const isUpper = (c) => c >= 65 && c <= 90;
  const separatorValue = (c) => (c === 47 || c === 92 ? 5 : c === 95 || c === 45 || c === 46 || c === 32 || c === 39 || c === 34 || c === 58 ? 4 : 0);
  const characterValue = (qc, qck, t, tk, ti, sequenceL) => {
    let p = 0;
    if (!equal(qck, tk[ti])) return p;
    p += 1;
    if (sequenceL > 0) p += Math.min(sequenceL, 3) * 6 + Math.max(0, sequenceL - 3) * 3;
    if (qc === t[ti]) p += 1;
    if (ti === 0) p += 8;
    else {
      const tr = separatorValue(t.charCodeAt(ti - 1));
      if (tr) p += tr;
      else if (isUpper(t.charCodeAt(ti)) && sequenceL === 0) p += 2;
    }
    return p;
  };
  const scoreFuzzy = (t, q, qk, notTogether) => {
    if (!t || !q) return [0, []];
    const tl = t.length, ql = q.length;
    if (tl < ql) return [0, []];
    const tk = t.toLowerCase();
    const points = [], followUp = [];
    for (let qi = 0; qi < ql; qi++) {
      const off = qi * tl, offBefore = off - tl, qiGt0 = qi > 0, qc = q[qi], qck = qk[qi];
      for (let ti = 0; ti < tl; ti++) {
        const tiGt0 = ti > 0, i = off + ti, left = i - 1, diag = offBefore + ti - 1;
        const leftP = tiGt0 ? points[left] : 0;
        const diagP = qiGt0 && tiGt0 ? points[diag] : 0;
        const sequenceL = qiGt0 && tiGt0 ? followUp[diag] : 0;
        const p = !diagP && qiGt0 ? 0 : characterValue(qc, qck, t, tk, ti, sequenceL);
        if (p && diagP + p >= leftP && (notTogether || qiGt0 || tk.startsWith(qk, ti))) { followUp[i] = sequenceL + 1; points[i] = diagP + p; }
        else { followUp[i] = 0; points[i] = leftP; }
      }
    }
    const pos = [];
    let qi = ql - 1, ti = tl - 1;
    while (qi >= 0 && ti >= 0) { if (followUp[qi * tl + ti] !== 0) { pos.push(ti); qi--; } ti--; }
    return [points[ql * tl - 1], pos.reverse()];
  };
  const norm = (s) => {
    const pathNormalized = s.replace(/\\/g, SEP);
    const normalized = pathNormalized.replace(/[*…\s"]/g, "").replace(/(?<=.)#$/, "");
    return { pathNormalized, normalized, normalizedLowercase: normalized.toLowerCase() };
  };
  const inAnf = (s) => s.startsWith('"') && s.endsWith('"');
  const prepare = (s) => {
    const n = norm(s);
    let values;
    const parts = s.split(" ");
    if (parts.length > 1) for (const w of parts) { const m = norm(w); if (m.normalized) (values = values || []).push({ original: w, ...m, expectContiguousMatch: inAnf(w) }); }
    return { original: s, ...n, values, containsPathSeparator: n.pathNormalized.indexOf(SEP) >= 0, expectContiguousMatch: inAnf(s) };
  };
  const asAreas = (pos) => {
    const out = [];
    let l;
    for (const p of pos) { if (l && l.end === p) l.end += 1; else { l = { start: p, end: p + 1 }; out.push(l); } }
    return out;
  };
  const merge = (b) => {
    const s = b.sort((x, y) => x.start - y.start), out = [];
    let l;
    for (const x of s) {
      if (!l || l.end < x.start || x.end < l.start) { l = x; out.push(x); }
      else { l.start = Math.min(l.start, x.start); l.end = Math.max(l.end, x.end); }
    }
    return out;
  };
  const prefix = (w, z) => (!z || z.length < w.length || z.slice(0, w.length).toLowerCase() !== w.toLowerCase() ? null : w.length > 0 ? [{ start: 0, end: w.length }] : []);
  const individual = (label, desc, path, a, nameFirst) => {
    if (nameFirst || !desc) {
      const [lp, lpos] = scoreFuzzy(label, a.normalized, a.normalizedLowercase, !a.expectContiguousMatch);
      if (lp) {
        const pr = prefix(a.normalized, label);
        const base = pr ? NAME_PREFIX + Math.round((a.normalized.length / label.length) * 100) : NAME_THRESHOLD;
        return { score: base + lp, labelMatch: pr || asAreas(lpos) };
      }
    }
    if (desc) {
      const before = path ? `${desc}${SEP}` : desc, vl = before.length;
      const [p, pos] = scoreFuzzy(`${before}${label}`, a.normalized, a.normalizedLowercase, !a.expectContiguousMatch);
      if (p) {
        const labelMatch = [], descriptionMatch = [];
        for (const h of asAreas(pos)) {
          if (h.start < vl && h.end > vl) { labelMatch.push({ start: 0, end: h.end - vl }); descriptionMatch.push({ start: h.start, end: vl }); }
          else if (h.start >= vl) labelMatch.push({ start: h.start - vl, end: h.end - vl });
          else descriptionMatch.push(h);
        }
        return { score: p, labelMatch, descriptionMatch };
      }
    }
    return NO;
  };
  const label = (p) => p.slice(p.lastIndexOf("/") + 1);
  const desc = (p) => { const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : undefined; };
  // Score and order for ONE query (VS Code `scoreItemFuzzy`/`compareItemsByFuzzyScore` with `allowNonContiguousMatches: true`).
  const reader = (a) => {
    const storage = new Map();
    const score = (p) => {
      if (storage.has(p)) return storage.get(p);
      const l = label(p), d = desc(p);
      let r;
      if (!a.normalized || !l) r = NO;
      else if (a.pathNormalized.toLowerCase() === p.toLowerCase()) r = { score: PATH_IDENTITY, labelMatch: [{ start: 0, end: l.length }], descriptionMatch: d ? [{ start: 0, end: d.length }] : undefined };
      else if (a.values && a.values.length > 1) {
        let sum = 0;
        const lm = [], dm = [];
        r = null;
        for (const w of a.values) {
          const x = individual(l, d, p, w, !a.containsPathSeparator);
          if (x.score === 0) { r = NO; break; }
          sum += x.score;
          if (x.labelMatch) lm.push(...x.labelMatch);
          if (x.descriptionMatch) dm.push(...x.descriptionMatch);
        }
        if (!r) r = { score: sum, labelMatch: merge(lm), descriptionMatch: merge(dm) };
      } else r = individual(l, d, p, a, !a.containsPathSeparator);
      storage.set(p, r);
      return r;
    };
    const collator = typeof Intl !== "undefined" ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }) : null;
    const fileNames = (x, y) => { const r = collator ? collator.compare(x, y) : x.localeCompare(y); return r === 0 && x !== y ? (x < y ? -1 : 1) : r; };
    const anything = (x, y, search) => {
      const xk = x.toLowerCase(), yk = y.toLowerCase();
      const xp = xk.startsWith(search), yp = yk.startsWith(search);
      if (xp !== yp) return xp ? -1 : 1;
      if (xp && yp) { if (xk.length < yk.length) return -1; if (xk.length > yk.length) return 1; }
      const xs = xk.endsWith(search), ys = yk.endsWith(search);
      if (xs !== ys) return xs ? -1 : 1;
      const r = fileNames(xk, yk);
      return r !== 0 ? r : xk.localeCompare(yk);
    };
    const length = (x, y) => {
      if ((!x && !y) || (!(x && x.length) && !(y && y.length))) return 0;
      if (!(y && y.length)) return -1;
      if (!(x && x.length)) return 1;
      const lx = x[x.length - 1].end - x[0].start, ly = y[y.length - 1].end - y[0].start;
      return lx === ly ? 0 : ly < lx ? 1 : -1;
    };
    const gap = (p, w) => {
      let from = -1, until = -1;
      const dm = w.descriptionMatch, lm = w.labelMatch;
      if (dm && dm.length) from = dm[0].start; else if (lm && lm.length) from = lm[0].start;
      if (lm && lm.length) { until = lm[lm.length - 1].end; if (dm && dm.length) { const d = desc(p); if (d) until += d.length; } }
      else if (dm && dm.length) until = dm[dm.length - 1].end;
      return until - from;
    };
    const fallback = (x, y) => {
      const lx = label(x), ly = label(y), dx = desc(x), dy = desc(y);
      const gx = lx.length + (dx ? dx.length : 0), gy = ly.length + (dy ? dy.length : 0);
      if (gx !== gy) return gx - gy;
      if (x.length !== y.length) return x.length - y.length;
      if (lx !== ly) return anything(lx, ly, a.normalized);
      if (dx && dy && dx !== dy) return anything(dx, dy, a.normalized);
      if (x !== y) return anything(x, y, a.normalized);
      return 0;
    };
    const compare = (x, y) => {
      const wx = score(x), wy = score(y), sx = wx.score, sy = wy.score;
      if ((sx === PATH_IDENTITY || sy === PATH_IDENTITY) && sx !== sy) return sx === PATH_IDENTITY ? -1 : 1;
      if (sx > NAME_THRESHOLD || sy > NAME_THRESHOLD) {
        if (sx !== sy) return sx > sy ? -1 : 1;
        if (sx < NAME_PREFIX && sy < NAME_PREFIX) { const l = length(wx.labelMatch, wy.labelMatch); if (l !== 0) return l; }
        const lx = label(x), ly = label(y);
        if (lx.length !== ly.length) return lx.length - ly.length;
      }
      if (sx !== sy) return sx > sy ? -1 : 1;
      const hx = Array.isArray(wx.labelMatch) && wx.labelMatch.length > 0, hy = Array.isArray(wy.labelMatch) && wy.labelMatch.length > 0;
      if (hx && !hy) return -1;
      if (hy && !hx) return 1;
      const ax = gap(x, wx), ay = gap(y, wy);
      if (ax && ay && ax !== ay) return ay > ax ? -1 : 1;
      return fallback(x, y);
    };
    return { score, compare };
  };
  const n = Math.max(0, Math.floor(Number(cap) || 0));
  const whole = prepare(typeof input === "string" ? input : "");
  if (!whole.normalized) return { results: [], truncated: false };
  // Stage 1 — VS Code's file search service (`getFileSearchResults` → `fileSearch` with `sortByScore`): with several words its
  // `filePattern` is ONLY the first one, otherwise the whole input; filtered with `fuzzyContains`, sorted by it, `MAX_RESULTS`.
  const search = (pattern) => {
    const q = prepare(pattern), qk = q.normalizedLowercase, L = reader(q);
    const contains = (z) => {
      if (z.length < qk.length) return false;
      const tk = z.toLowerCase();
      let l = -1;
      for (let i = 0; i < qk.length; i++) { const j = tk.indexOf(qk[i], l + 1); if (j < 0) return false; l = j; }
      return true;
    };
    const hits = [];
    if (qk) for (const p of Array.isArray(files) ? files : []) if (typeof p === "string" && contains(p)) hits.push(p);
    hits.sort(L.compare);
    return { results: hits.slice(0, n), limitHit: hits.length > n };
  };
  const several = Boolean(whole.values && whole.values.length > 1);
  const first = search(several ? whole.values[0].original : whole.original);
  const list = first.results;
  // Several words at the cap: add the search with the whole input (VS Code: `limitHit && values.length > 1`), new ones appended.
  if (first.limitHit && several) {
    const existing = new Set(list);
    for (const p of search(whole.original).results) if (!existing.has(p)) list.push(p);
  }
  // Stage 2 — Quick Open itself (`getAdditionalPicks`): sorted with the WHOLE input (each word in any order, against name or
  // path), the best `MAX_RESULTS`; whatever gets no score is dropped.
  const L = reader(whole);
  const sorted = list.slice().sort(L.compare);
  const results = sorted.slice(0, n).filter((p) => L.score(p).score > 0);
  return { results, truncated: first.limitHit || sorted.length > n };
}

/**
 * The prefilter pattern the walk over the files already filters with (the caps then count hits only): with several words VS
 * Code gives the file search only the FIRST one as `filePattern`, otherwise the whole input — normalised and lower-cased like
 * `prepareQuery` (`normalizedLowercase`). "" = no search. No outside references (Function#toString, like `fastOpen`).
 */
export function fastPattern(input) {
  const s = typeof input === "string" ? input : "";
  const norm = (x) => x.replace(/\\/g, "/").replace(/[*…\s"]/g, "").replace(/(?<=.)#$/, "");
  const values = s.split(" ").filter((w) => norm(w));
  return norm(values.length > 1 ? values[0] : s).toLowerCase();
}
/** `fuzzyContains`: every character of `pattern` (lower-case) in this order in the path, case-insensitive. */
export function fastMatches(path, pattern) {
  if (!pattern || path.length < pattern.length) return false;
  const tk = path.toLowerCase();
  let l = -1;
  for (let i = 0; i < pattern.length; i++) { const j = tk.indexOf(pattern[i], l + 1); if (j < 0) return false; l = j; }
  return true;
}

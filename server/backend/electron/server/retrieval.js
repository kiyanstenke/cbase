// Hybrid context search: the READ path of the knowledge. It was once a plain `LIKE '%q%'`: whoever asked "How do I restart
// the service?" only found the entry about `systemctl restart` if they already knew the word. Now three signals,
// combined additively.
//
// Structure: FIND, then SORT.
//
//   FIND  - BM25 (SQLite FTS5 over title/summary/body/tags/slug/owners/symbols/code_paths, raw value sigmoid-normalized) plus
//           cbase's own structure signals (hits in slug, tags, codePaths/symbols). Only these make an entry a hit. The structure
//           signals replace mem0's entity boost, which builds on English NLP ("capitalized multi-word sequences") and in German
//           would declare every noun phrase an entity.
//   SORT  - the cosine against the local multilingual embedding model reorders the found candidates. Vectors live PERSISTENTLY
//           in the DB (column embedding), valid while embedding_at >= updated_at and the model is the same. `pinned` and the
//           status demotion likewise only shift the order.
//
// WHY semantics does not find by itself (measured on 39 real entries over six projects, 5 question/answer pairs, 11 right
// against 53 wrong assignments):
//
//   right entries:  median 0.224   range 0.120-0.351
//   wrong entries:  median 0.137   range -0.006-0.439
//
// The distributions OVERLAP. The sharpest absolute threshold (0.12) finds all right entries but lets 57% of the wrong ones in.
// On average the cosine separates, per entry it does not; an absolute threshold cannot work here in principle, wherever it is
// put. The reason is asymmetry: the model (paraphrase-multilingual) is trained on sentence pairs of equal length, here a short
// question stands against a long knowledge text. The usable information is the ORDER within a candidate set, not the absolute
// value. That is how it is used: min-max normalized over the found candidates, with moderate weight.
//
// Price of this decision, stated openly: an entry without ONE common word stem with the question is not found. Only semantics
// could do that, and on this data it measurably cannot without returning more junk than hits.
//
// Deliberately NOT adopted: an age decay ("memory decay"). For code knowledge age says nothing; commits on the codePaths say
// everything, and okf.js measures that. An outdated entry is therefore not penalized either: it should be found and then
// checked, not hidden.
//
// Degrades cleanly: without an embedding model BM25 + boosts remain, without FTS hits semantics remains. If both fail, the
// caller still delivers its LIKE list.

import { embed, embeddingsAvailable, EMBED_MODEL_ID } from "./embeddings.js";
// fold/stem/STOP come from dedup.js so the READ and WRITE paths use the same normalization. Two copies of one rule drift
// apart; the diacritics comparison already failed that way once (see there).
import { fold, stem, STOP } from "./dedup.js";
import * as store from "./store.js";

const num = (key, dflt) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : dflt;
};

// Weights of the three signals. Semantics and BM25 both lie in [0,1], the boosts on top.
const W_BM25 = num("CTX_W_BM25", 1.0);
const B_SLUG = num("CTX_B_SLUG", 0.5);
const B_TAG = num("CTX_B_TAG", 0.3);
const B_PATH = num("CTX_B_PATH", 0.4);
const B_PINNED = num("CTX_B_PINNED", 0.15);
const P_INACTIVE = num("CTX_P_INACTIVE", 0.5); // deprecated/superseded move down, but not out
// Weight of the semantic REORDERING (on the min-max normalized cosine, so [0,1]). Moderate: it should improve the order, not
// decide the hit list.
const W_SEM_RERANK = num("CTX_W_SEM_RERANK", 0.25);
// If all candidates are practically equally far away, the normalization carries no information (it would spread noise over
// [0,1]); then semantics stays out entirely.
const SEM_MIN_SPREAD = num("CTX_SEM_MIN_SPREAD", 0.03);
// Noise floor, DERIVED FROM MEASUREMENT, not set. Method: 5 questions with a known answer plus 2 questions whose answer stands
// nowhere, against 39 real entries over six projects; for every entry the finished relevance, then the threshold plotted over
// all candidates:
//
//   right answers: min 0.592   median 0.682   max 1.375
//   all others:    min 0.179   median 0.371   max 1.176
//
//   threshold   right found   wrong let through
//     0.50          8/8             23/73
//     0.55          8/8             15/73   <- knee
//     0.60          7/8             14/73
//     0.65          5/8             11/73
//
// 0.55 was the knee AS LONG AS the score consisted only of BM25 + boosts. With the term coverage as a fourth quantity all values
// lie higher, so it was measured again, this time by how often the known answer lands in first place and how often a question
// WITHOUT a stored answer still returns something (26 cases over six projects):
//
//   threshold   answer in first place   noise when the answer is missing
//     0.55            4/8                         5/18
//     0.70            4/8                         4/18
//     0.85            4/8                         1/18   <- knee
//     1.00            4/8                         1/18
//
// 0.85: the hit rate stays, the noise drops to one eighteenth. Above 0.85 nothing changes. The direction of this choice is
// deliberate: for an agent a false hit costs context and lays a false trail, a missed hit only costs a look at the code.
//
// Two limits together, because neither suffices alone:
//   MIN_RELEVANCE - absolute, catches "the knowledge is not there at all" (then the answer is empty)
//   TAIL_RATIO    - relative to the best hit: if there is a clear winner the weak rest drops out instead of padding the
//                   answer with half hits
const MIN_RELEVANCE = num("CTX_MIN_RELEVANCE", 0.85);
const TAIL_RATIO = num("CTX_TAIL_RATIO", 0.5);
// Minimum coverage of the question in slug/tags/paths so an entry is admitted EVEN WITHOUT a lexical hit (second admission
// path, see below).
const STRUCT_SHARE_MIN = num("CTX_STRUCT_SHARE_MIN", 0.5);
// Cap for NEWLY computed vectors per search. The rest comes with the background backfill (or the next search): a cold DB should
// not block the first question.
const EMBED_BUDGET = Math.max(0, num("CTX_EMBED_BUDGET", 64));

// ── Query decomposition ──────────────────────────────────────────────────────

// `stem` and `fold` live in dedup.js: the same normalization for search and dedup.
//
// NO additional hard truncation of the question stems. Trying to make "Repositories" (stem "reposit") also hit the entry
// "Repos - ..." through a five-character truncation "repos"* destroyed more than it helped: "reservieren" became `"reser"*` and
// hit a completely unrelated entry with BM25 4.09, the highest value in the whole project. Blind truncation produces prefixes
// that are not words. An entry whose term is SHORTER than the question stem thus stays unfindable; that is the deliberately
// chosen smaller harm.

export function parseQuery(query) {
  const tokens = fold(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOP.has(t));
  const stems = [...new Set(tokens.map(stem))];
  return { tokens, stems, matchTerms: stems, match: stems.map((t) => `"${t}"*`).join(" OR ") };
}

// ── BM25 normalization ──────────────────────────────────────────────────────

// Sigmoid parameters by question length. NOT mem0's table (midpoints 5-12): it is calibrated to their BM25 implementation.
// SQLite's `bm25()` lies at 0.2-7 on our data, centre of mass 0.7-2.5; with foreign midpoints EVERY hit landed in the lower
// tail of the sigmoid and the whole signal was flattened. A number taken over without a unit check is only a guess. More
// question terms mean more OR branches and thus higher raw values, so the midpoint moves with the question length.
function bm25Params(numTerms) {
  return [1.0 + 0.25 * Math.min(numTerms, 12), 1.0];
}

// SQLite returns bm25() NEGATIVE (smaller = better). We flip it and squash to [0,1].
function normalizeBm25(raw, numTerms) {
  const [midpoint, steepness] = bm25Params(numTerms);
  return 1 / (1 + Math.exp(-steepness * (raw - midpoint)));
}

// ── Vectors (persistent) ─────────────────────────────────────────────────────

const f32ToBlob = (vec) => Buffer.from(new Float32Array(vec).buffer);

// BLOB -> Float32Array. `slice()` forces an own ArrayBuffer starting at 0; a Buffer from the Node pool would have an arbitrary
// byteOffset, and the Float32Array constructor requires 4-byte alignment.
function blobToF32(blob) {
  if (!blob || !blob.byteLength || blob.byteLength % 4) return null;
  return new Float32Array(new Uint8Array(blob).slice().buffer);
}

const cosine = (a, b) => {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
};

// An entry's text for the embedding. Title weighted threefold: it carries the most meaning per character.
export function embedText(e) {
  const title = String(e.title || "");
  return `${title} ${title} ${title} ${e.summary || ""} ${e.body || ""}`;
}

// Obtain vectors for a candidate list: what lies valid in the DB is read; what is missing or stale is computed and written back,
// but only `budget` of them, so a cold DB does not slow the first question. Returns { vectors: Map id->vec, computed }.
async function vectorsFor(scope, candidates, budget) {
  const vectors = new Map();
  let computed = 0;
  if (!candidates.length) return { vectors, computed };
  const stored = store.getContextEmbeddings(scope, candidates.map((c) => c.id));
  const stale = [];
  for (const c of candidates) {
    const row = stored.get(c.id);
    const vec = row && row.model === EMBED_MODEL_ID && row.at >= (c.updatedAt || 0) ? blobToF32(row.blob) : null;
    if (vec) vectors.set(c.id, vec);
    else stale.push(c);
  }
  for (const c of stale.slice(0, Math.max(0, budget))) {
    const vec = await embed(embedText(c));
    if (!vec) break; // model dropped out: the rest stays without semantics instead of throwing
    vectors.set(c.id, Float32Array.from(vec));
    computed++;
    try { store.setContextEmbedding(scope, c.id, f32ToBlob(vec), EMBED_MODEL_ID); } catch { /* cache writing is a side issue */ }
  }
  return { vectors, computed };
}

// ── Term coverage (independent of stock size) ────────────────────────────────
// BM25 depends on a stock: its IDF term becomes zero if every term is in all documents. With ONE entry in the index SQLite thus
// returns 0.0000053 for a perfect hit (measured). A fresh workspace with few entries would have answered every right question
// with "nothing found": the case where knowledge is most valuable would be the only one where search fails.
//
// Coverage measures directly instead: what SHARE of the question stems occurs in the entry. That is as meaningful with one
// document as with a thousand.
const COVER_WEIGHT = num("CTX_W_COVER", 0.5);

function coverage(entry, stems) {
  if (!stems.length) return 0;
  const text = `${entry.title || ""} ${entry.summary || ""} ${entry.body || ""} ${entry.tags || ""} ${entry.slug || ""}`;
  return overlap(stems, structTokens(text));
}

// ── Structure boosts ─────────────────────────────────────────────────────────

// Splits structure fields (slug, tags, codePaths, symbols) into comparable stems.
const structTokens = (text) => [...new Set(
  fold(text).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2).map(stem),
)];

// Share of the question stems that occur in a structure field. PROPORTIONAL and not binary, because otherwise a single common
// word triggers the full boost: "Warum braucht der Sauerteig ein EIGENES Glas?" hit the slug "kuchen-mit-eigenem-rezept"
// via "eigen" and catapulted a completely unrelated entry upwards (observed on real data). One word of five is a fifth of a
// signal; a one-word question that hits the slug is a full signal.
// Compared as a PREFIX, just like in the FTS expression: otherwise the two lexical signals would behave differently: "Port"
// found the title "Portzuteilung" via BM25 but did not hit the slug "portzuteilung". German compounds make that the normal case,
// not the exception. The sets are tiny (slug, tags, paths), the loop costs nothing.
// In BOTH directions, from four characters on the shorter side. The FTS expression can only do "index term starts with question
// stem"; so "Repositories" (stem "repositor") did not find the entry "Repos - ...": the term is SHORTER than the stem. Over the
// structure fields the opposite direction can be made up safely: slug, tags and paths are short and maintained, a hit there is a
// real signal. Running the same comparison over the full text would not be: there blind truncation measurably produced junk (see
// parseQuery).
const MIN_PREFIX = 4;
const covers = (structs, s) => structs.some((t) =>
  (t.length >= MIN_PREFIX && s.startsWith(t)) || (s.length >= MIN_PREFIX && t.startsWith(s)));
const overlap = (stems, structs) =>
  (stems.length ? stems.filter((s) => covers(structs, s)).length / stems.length : 0);

// `structure` is returned separately because only CONTENT signals (semantics, BM25, structure hits) may make an entry a hit at
// all. `pinned` and the status demotion are sort criteria, no proof of relevance; see the admission check below.
function boostFor(entry, stems) {
  let structure = 0;
  let extra = 0;
  const reasons = [];
  let maxShare = 0;
  const add = (weight, set, label) => {
    const share = overlap(stems, set);
    if (share > 0) { structure += weight * share; maxShare = Math.max(maxShare, share); reasons.push(label); }
  };
  add(B_SLUG, structTokens(entry.slug), "slug");
  add(B_TAG, structTokens(entry.tags), "tag");
  const pathText = `${(entry.codePaths || []).join(" ")} ${entry.symbols || ""}`;
  if (pathText.trim()) add(B_PATH, structTokens(pathText), "path");
  if (entry.pinned) { extra += B_PINNED; reasons.push("pinned"); }
  // Demotion, not exclusion: superseded knowledge should stay findable ("that once applied").
  if (entry.status && entry.status !== "active") { extra -= P_INACTIVE; reasons.push(entry.status); }
  const r3 = (n) => Math.round(n * 1000) / 1000;
  return { boost: r3(structure + extra), structure: r3(structure), structShare: r3(maxShare), reasons };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Ranking of an ALREADY FILTERED candidate list by relevance to the question.
 *
 * The caller keeps filtering with the existing means (category, status, path, tag) and passes the result here, so every existing
 * filter semantics stays untouched and this function only takes care of the order.
 *
 * @param query      free-text question of the user/agent
 * @param candidates entries in store form (id, title, summary, body, tags, slug, codePaths, symbols, status, pinned,
 *                   updatedAt); NEGATIVE ids (adopted workspace context) are allowed and are directed to the workspace scope
 * @param opts       { projectId, workspaceId, limit }
 * @returns          candidates descending by `relevance`, each with `relevance` and `scoreParts`
 */
export async function rankContext(query, candidates, { projectId, workspaceId, limit = 20 } = {}) {
  const entries = Array.isArray(candidates) ? candidates : [];
  const { tokens, stems, match } = parseQuery(query);
  if (!entries.length || !stems.length) return entries.slice(0, limit);

  // Where an entry really lives: own project entries in project_context, everything else (the workspace archive directly AND the
  // entries adopted into the project with a negative id) in context_items. This holds for the FTS lookup as for the vector store.
  const scopeOf = (e) => (projectId && e.id > 0 ? "project" : "workspace");

  // BM25 from the FTS index, once per table.
  const bm = new Map(); // "scope:storeId" -> raw value (already flipped positive)
  const collect = (scope, rows) => { for (const r of rows) bm.set(`${scope}:${r.id}`, r.score); };
  try {
    if (projectId) collect("project", store.ftsSearchProjectContext(projectId, match));
    if (workspaceId) collect("workspace", store.ftsSearchContextItems(workspaceId, match));
  } catch (e) {
    console.error("[retrieval] FTS search failed, continuing without BM25:", String(e?.message || e).slice(0, 160));
  }

  // ── FIND: BM25 + structure decide WHAT a hit is ───────────────────────────
  const found = [];
  for (const e of entries) {
    const raw = bm.get(`${scopeOf(e)}:${Math.abs(e.id)}`) || 0;
    const bmScore = raw > 0 ? normalizeBm25(raw, tokens.length) : 0;
    const { boost, structure, structShare, reasons } = boostFor(e, stems);
    const cover = coverage(e, stems);
    // `pinned` and the status demotion sit in `boost` but do NOT count here: otherwise every pinned entry would land in every
    // answer (observed live: with B_PINNED == MIN_RELEVANCE pinning alone carried over the limit, even for an unrelated question about booking a ferry).
    if (bmScore <= 0 && structure <= 0 && cover <= 0) continue;
    found.push({ entry: e, bmScore, boost, structShare, cover, reasons });
  }
  if (!found.length) return [];

  // ── SORT: semantics reorders the found ────────────────────────────────────
  // Fetch vectors only for the found: that saves computation on every search and keeps the embedding cap free for the cases that
  // need it.
  const cosines = new Map(); // original (possibly negative) id -> raw cosine
  if (await embeddingsAvailable()) {
    const qvec = await embed(query);
    if (qvec) {
      const q = Float32Array.from(qvec);
      const groups = new Map();
      for (const { entry: e } of found) {
        const scope = scopeOf(e);
        if (!groups.has(scope)) groups.set(scope, []);
        groups.get(scope).push({ ...e, id: Math.abs(e.id), originalId: e.id });
      }
      let budget = EMBED_BUDGET;
      for (const [scope, list] of groups) {
        const { vectors, computed } = await vectorsFor(scope, list, budget);
        budget -= computed;
        for (const item of list) {
          const v = vectors.get(item.id);
          if (v) cosines.set(item.originalId, cosine(q, v));
        }
      }
    }
  }

  // Min-max normalization over the FOUND: the absolute cosine carries no information here (see the measurement in the head of this
  // file), the order does. Too little spread means all equally far away, so no signal.
  const vals = [...cosines.values()];
  const lo = vals.length ? Math.min(...vals) : 0;
  const hi = vals.length ? Math.max(...vals) : 0;
  const useSem = vals.length >= 2 && hi - lo >= SEM_MIN_SPREAD;
  const semShare = (id) => {
    if (!useSem || !cosines.has(id)) return 0;
    return (cosines.get(id) - lo) / (hi - lo);
  };

  const r3 = (n) => Math.round(n * 1000) / 1000;
  const scored = found.map(({ entry: e, bmScore, boost, structShare, cover, reasons }) => {
    const share = semShare(e.id);
    return {
      ...e,
      relevance: r3(W_BM25 * bmScore + COVER_WEIGHT * cover + boost + W_SEM_RERANK * share),
      scoreParts: {
        // `semantic` is the raw cosine (for assessment), `semanticRank` the normalized share actually counted.
        semantic: cosines.has(e.id) ? r3(cosines.get(e.id)) : null,
        semanticRank: r3(share),
        bm25: r3(bmScore),
        boost,
        structShare: r3(structShare),
        cover: r3(cover),
        signals: [...(bmScore ? ["bm25"] : []), ...(cover > 0 ? [`coverage ${Math.round(cover * 100)}%`] : []),
          ...reasons, ...(share > 0 ? ["semantic-rank"] : [])],
      },
    };
  });

  // ADMISSION per channel, not over the sum. Reason: BM25 and the structure boosts lie on different scales. A common threshold
  // derived from a BM25-dominated distribution (0.55) discarded every entry hit ONLY through structure: "Repositories" correctly
  // found the entry "Repos - ..." via the slug, but landed at 0.25 and dropped out. Two rules, each interpretable for its channel:
  //   - lexical: the finished relevance reaches MIN_RELEVANCE (derived from data)
  //     (A separate admission path "high coverage" was planned and removed after the parameter sweep: from 0.6 to 1.0 it did not
  //     change a single result; what has enough coverage reaches the threshold via the score anyway. A parameter that does
  //     nothing should go.)
  //   - structural: the question covers at least half of its stems in slug/tags/paths. These fields are short and maintained; a
  //     half question hit there is a real signal, not chance as in full text.
  // Third admission path: if there is EXACTLY ONE candidate, half the threshold is enough. The point of the threshold is to
  // SEPARATE signal from noise; it is derived from a distribution over many candidates per question. With a single candidate
  // there is nothing to separate, and the semantic reordering drops out too (min-max needs two values), which costs up to 0.25
  // points. Example "Roggenmehl Aceton Sauerteig lauwarm": four rare terms, all in the single hit, together 0.487, and still
  // discarded. Not entirely without a limit, so a single chance hit does not slip through.
  const alone = scored.length === 1;
  const floor = alone ? MIN_RELEVANCE * 0.5 : MIN_RELEVANCE;
  const admitted = scored.filter((s) => s.relevance >= floor || s.scoreParts.structShare >= STRUCT_SHARE_MIN);
  admitted.sort((a, b) => b.relevance - a.relevance || (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
  // If there is a clear winner, the weak rest drops out instead of lengthening the answer.
  const tail = admitted.length ? admitted[0].relevance * TAIL_RATIO : 0;
  return admitted.filter((s) => s.relevance >= tail).slice(0, limit);
}


// ── Migration / backfill ─────────────────────────────────────────────────────

// Catch up vectors for everything that has no (valid) one yet. Runs in the background at server start and is idempotent +
// abortable: every entry is written individually, an abort only loses the running one. The FTS index does not need this: SQLite
// builds it in one go at start (store/db.js, initStore: `INSERT INTO <table>_fts VALUES('rebuild')`).
export async function backfillContextEmbeddings({ batch = 50, onProgress = null } = {}) {
  if (!(await embeddingsAvailable())) return { skipped: "no embedding model", done: 0 };
  let done = 0;
  for (const scope of ["project", "workspace"]) {
    // Record the ids already handled: if an entry's updated_at (clock jump, import) lies in the future, it never leaves the work
    // queue; without this brake the loop would embed the same entry forever.
    const seen = new Set();
    for (;;) {
      const rows = store.contextEmbeddingBacklog(scope, EMBED_MODEL_ID, batch);
      const fresh = rows.filter((r) => !seen.has(r.id));
      if (!fresh.length) break;
      for (const r of fresh) {
        seen.add(r.id);
        const vec = await embed(embedText(r));
        if (!vec) return { done, aborted: "model no longer available" };
        store.setContextEmbedding(scope, r.id, f32ToBlob(vec), EMBED_MODEL_ID);
        done++;
      }
      if (onProgress) onProgress(done);
    }
  }
  return { done };
}

// Trigger at server start without holding up the start.
export function warmContextIndex() {
  backfillContextEmbeddings()
    .then((r) => {
      if (r.done) console.log(`[retrieval] ${r.done} context entries embedded`);
      if (r.skipped) console.log(`[retrieval] backfill skipped: ${r.skipped}`);
    })
    .catch((e) => console.error("[retrieval] backfill failed:", String(e?.message || e).slice(0, 200)));
}

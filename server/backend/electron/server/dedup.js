// Duplicate check for project context: the gatekeeper of the WRITE path. It answers one question:
// "Is what is about to be created already in an existing entry?"
//
// It measures WORD COVERAGE: the share of the candidate's meaning-bearing word stems that occur
// in the existing entry. Nothing semantic; this is a measurement, not an opinion.
//
// WHY cosine does NOT work here (calibrated against real data: 33 entries, 35 REAL positive
// pairs = the same entry reworded by the agent, 430 negative pairs = different entries of one project):
//
//                     cosine                       word coverage
//   positives  median 0.964  range 0.882-1.000      median 0.807  range 0.369-1.000
//   negatives  median 0.906  range 0.578-0.965      median 0.176  range 0.041-0.404
//
// Cosine overlaps completely: the worst rewording (0.882) lies BELOW the best foreign entry
// (0.965); any threshold from 0.0 to 0.8 gave identical results. Word coverage separates almost
// cleanly (gap 0.404 -> 0.369 with minimal overlap). A fixed embedding threshold of 0.5 was
// wrong twice (guessed AND on the wrong quantity): with working embeddings it reported a long
// entry on a completely unrelated topic as a duplicate and got the model to merge the new fact
// into an unrelated entry. Hence the semantic path is gone.
//
// TWO LEVELS, because the cost of errors is asymmetric:
//   BLOCK - nothing is created, the model should update. A false alarm merges knowledge into the
//           wrong entry: silent data damage. Hence a high threshold (0.65) and only with enough
//           candidate stems.
//   HINT  - the entry is created, the candidate comes back as `similar`. A false alarm costs one
//           line of text. Hence a low threshold (0.40).
//
// Measured on the same data: BLOCK catches 77% of real rewordings with 0 false alarms among 430
// negative pairs; HINT reaches 94% with 2 false alarms (0.5%).

// Small bilingual stop word list (frequent, barely discriminating tokens). The German words are
// DATA: they filter stop words out of German user texts.
export const STOP = new Set([
  // Articles, prepositions, auxiliary verbs
  "der", "die", "das", "des", "dem", "den", "ein", "eine", "einen", "einem", "einer", "eines",
  "und", "oder", "aber", "auch", "als", "wie", "nicht", "kein", "keine", "keinen", "nur", "noch",
  "für", "mit", "von", "vom", "im", "in", "auf", "an", "am", "zu", "zum", "zur", "aus", "bei",
  "über", "unter", "nach", "vor", "durch", "gegen", "ohne", "um", "bis", "seit", "während",
  "ist", "sind", "war", "waren", "wird", "werden", "wurde", "wurden", "sein", "hat", "haben",
  "hatte", "hatten", "kann", "können", "soll", "sollen", "muss", "müssen", "darf", "dürfen",
  "will", "wollen", "mag", "möchte", "würde", "sei",
  // Question words and pronouns: exactly the words a question consists of. Without them
  // "Wie buche ICH eine Fähre?" becomes a search term `"ich"*` that hits across the whole stock
  // (observed on real data: `"ich"*` and `"welch"*` gave the highest BM25 scores of the project, on unrelated entries).
  "wer", "wen", "wem", "wessen", "was", "wo", "wohin", "woher", "wann", "warum", "wieso",
  "weshalb", "wozu", "womit", "wodurch", "wieviel", "welche", "welcher", "welches", "welchen",
  "welchem", "ich", "du", "er", "sie", "es", "wir", "ihr", "mich", "dich", "sich", "uns", "euch",
  "mir", "dir", "ihm", "ihnen", "mein", "dein", "sein", "unser", "man", "jemand", "etwas",
  "dies", "diese", "dieser", "dieses", "diesen", "diesem", "jene", "jeder", "jede", "jedes",
  "alle", "allen", "alles", "beide", "andere", "anderen", "solche", "eigene", "eigenen", "eigenes",
  // Filler words that appear constantly in questions and notes
  "dann", "damit", "dazu", "daher", "deshalb", "also", "schon", "sehr", "mehr", "ganz", "ganze",
  "ganzen", "immer", "wieder", "erst", "eben", "gerade", "hier", "dort", "da", "so", "doch",
  "denn", "zwar", "etwa", "ja", "nein", "gibt", "geht", "macht", "machen", "gemacht", "tun",
  // English
  "the", "a", "an", "and", "or", "of", "to", "is", "are", "was", "were", "be", "been", "being",
  "in", "on", "for", "with", "by", "as", "at", "from", "this", "that", "these", "those", "it",
  "its", "i", "you", "he", "she", "we", "they", "me", "him", "her", "them", "my", "your", "our",
  "what", "which", "who", "whom", "whose", "where", "when", "why", "how", "can", "could",
  "should", "would", "will", "shall", "may", "might", "must", "do", "does", "did", "done",
  "have", "has", "had", "not", "no", "only", "also", "then", "than", "there", "here", "all",
  "any", "some", "such", "own", "very", "just", "into", "about", "over", "under", "after",
  "before", "between", "through", "get", "gets", "got", "make", "makes", "made",
]);

// ── Shared text normalisation (read AND write path) ──────────────────────────
//
// These helpers live here because BOTH paths need them and they are only worth anything when
// identical. FTS5 folds diacritics (`remove_diacritics 2`); the JS comparison once did not:
// `lauf*` found "Läuft" in the index, but the JS coverage comparison saw no hit. Two copies of
// one rule drift apart; one cannot. retrieval.js imports them from here.

// Suffixes we cut off, longest first. Allowed because the read path searches by PREFIX
// (`stem*`) and shortening only widens the hit set: `gateway*` finds "Gateway" and "Gateways",
// `laufen` -> `lauf*` finds "Lauf", "läuft", "laufende". German AND English, as the app is bilingual.
const SUFFIXES = [
  "ungen", "ungs", "chen", "lein", "keit", "heit", "isch", "lich", "ung",
  "ern", "est", "end", "ies", "ing", "ern", "em", "en", "er", "es", "st", "ed", "e", "n", "s",
];
const MIN_STEM = 4;

export function stem(token) {
  for (const s of SUFFIXES) {
    if (token.length - s.length >= MIN_STEM && token.endsWith(s)) return token.slice(0, -s.length);
  }
  return token;
}

// Fold diacritics EXACTLY as the FTS5 tokenizer does (`remove_diacritics 2`).
export const fold = (text) => String(text || "").toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");

// Text -> set of meaning-bearing word stems.
export function contentStems(text) {
  return [...new Set(
    fold(text).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 && !STOP.has(t)).map(stem),
  )];
}

// ── Duplicate detection ──────────────────────────────────────────────────────

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
};

// From here the create is REJECTED (the model should extend the existing entry).
export const DUP_BLOCK = num("CTX_DUP_BLOCK", 0.65);
// From here the entry is created, but the match is sent back as a hint.
export const DUP_HINT = num("CTX_DUP_HINT", 0.40);

// Below this many own stems the coverage must NOT block. Candidates made of only a title (6-11
// stems) reach up to 0.73 on FOREIGN entries: with so few words "all occur there" is no evidence.
// Real short entries (17-84 stems) stayed below 0.35. The limit lies in between.
export const MIN_CAND_STEMS = num("CTX_DUP_MIN_STEMS", 15);

const entryText = (e) => `${e.title || ""} ${e.summary || ""} ${e.body || ""} ${e.tags || ""}`;

// Share of the candidate stems that occur in the existing entry. Deliberately NOT symmetric: the
// question is "does the candidate say something that is already there", not "are both equally
// long". A terse new entry about an already described fact is exactly the case to catch; Jaccard
// would miss it because of the length difference.
function coverage(candStems, entryStems) {
  if (!candStems.length) return 0;
  const set = new Set(entryStems);
  return candStems.filter((s) => set.has(s)).length / candStems.length;
}

// Entry point: finds existing entries that already say the same.
//   existing:  [{id, category, title, summary, body, tags}]
//   candidate: {title, summary, body, category}
//   -> [{id, category, title, score, sameCategory, blocking, method}], score descending
// `blocking:true` means strong enough to reject the create. The caller decides what to do with
// it; this module only measures.
export function findSimilarContext(existing, candidate, { limit = 3, threshold = DUP_HINT } = {}) {
  const entries = Array.isArray(existing) ? existing : [];
  if (!entries.length) return [];
  const candStems = contentStems(entryText(candidate));
  if (!candStems.length) return [];
  const trustworthy = candStems.length >= MIN_CAND_STEMS;
  return entries
    .map((e) => {
      const score = coverage(candStems, contentStems(entryText(e)));
      return {
        id: e.id,
        category: e.category,
        title: e.title,
        score: Math.round(score * 1000) / 1000,
        sameCategory: e.category === candidate.category,
        blocking: trustworthy && score >= DUP_BLOCK,
        method: "coverage",
      };
    })
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

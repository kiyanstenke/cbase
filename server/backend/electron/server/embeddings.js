import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Local neural embedding model (transformers.js + onnxruntime-node).
// Multilingual sentence embedding (paraphrase-multilingual-MiniLM-L12-v2, q8, 384-dim) for the semantic dedup check
// (dedup.js) AND the hybrid knowledge search (retrieval.js).
//
// Two modes of operation, because the app has two shapes:
//   CBASE_MODELS_DIR set (bundle/dev) → load locally only, no network access.
//   not set (user container)          → load once, cache into the persistent HOME.
// If loading fails, `embeddingsAvailable()` is false and the callers carry on — only without the semantic signal. A failed load
// is tried again after RETRY_AFTER_MS (5 min, 30 min, 2 h, then every 6 h): a download cut off once (20.11.2026: "terminated"
// during a cold start under memory pressure) used to switch the semantic path off until the next restart.

const MODEL = process.env.EMBED_MODEL || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

// Identifier of the model a persisted vector was made with. If the model changes, all stored vectors automatically become
// invalid (retrieval.js checks them).
export const EMBED_MODEL_ID = MODEL;

let _pipe = null;
let _loading = null;
let _failures = 0;
let _retryAt = 0;
/** Waiting time before the next load attempt after the 1st, 2nd, 3rd, … failure (the last value repeats). */
export const RETRY_AFTER_MS = Object.freeze([5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000]);
let _now = () => Date.now();
let _loader = null;
/** Test seams: the clock and the loader (null = the real model). */
export function setEmbedClock(fn) { _now = typeof fn === "function" ? fn : () => Date.now(); }
export function setEmbedLoader(fn) { _loader = typeof fn === "function" ? fn : null; _pipe = null; _loading = null; _failures = 0; _retryAt = 0; }

// Fetch transformers.js, choose the mode, load the model.
async function loadModel() {
  const { pipeline, env } = await import("@huggingface/transformers");
  // Is the model REALLY under CBASE_MODELS_DIR? The mere existence of the variable is not enough: `server/backend/headless.js`
  // sets it in the container to `$HOME/models`, and that directory was never filled. A plain `if (dir)` would then switch off
  // allowRemoteModels and thereby guarantee the failure — the semantic path would be hard off on the server, visible only as a
  // silent TF-IDF fallback.
  const dir = process.env.CBASE_MODELS_DIR;
  const bundled = !!dir && fs.existsSync(path.join(dir, MODEL));
  if (bundled || process.env.CBASE_EMBED_OFFLINE === "1") {
    // Bundle/dev (or explicitly forced): load locally only, no network access.
    if (dir) env.localModelPath = dir;
    env.allowRemoteModels = false;
  } else {
    // Container operation: the model is not included, so fetch it once. transformers.js otherwise caches UNDER node_modules —
    // that is what additionally failed in the user container: `/app` belongs to root, the server process runs as `agent`,
    // every load attempt ended with EACCES. Hence the cache in HOME: that is the persistent user volume, the download
    // (~130 MB, ~13 s) happens once and survives recreating the container.
    // Whoever wants no network access sets CBASE_EMBED_OFFLINE=1 — then it stays with the lexical fallback instead of
    // silently phoning out.
    if (dir) env.localModelPath = dir; // local stays the first look
    env.cacheDir = process.env.CBASE_MODEL_CACHE
      || path.join(process.env.HOME || os.tmpdir(), ".cache", "cbase-models");
    try { fs.mkdirSync(env.cacheDir, { recursive: true }); } catch { /* then the fallback applies */ }
  }
  return pipeline("feature-extraction", MODEL, { dtype: "q8" });
}

async function getPipe() {
  if (_pipe) return _pipe;
  if (_loading) return _loading;
  if (_retryAt && _now() < _retryAt) return null;
  _loading = (async () => {
    try {
      const pipe = await (_loader || loadModel)();
      _pipe = pipe;
      _failures = 0;
      _retryAt = 0;
      return pipe;
    } catch (e) {
      const wait = RETRY_AFTER_MS[Math.min(_failures, RETRY_AFTER_MS.length - 1)];
      _failures += 1;
      _retryAt = _now() + wait;
      console.error(`[embeddings] model could not be loaded — falling back to lexical similarity, next attempt in ${Math.round(wait / 60_000)} min:`, String(e?.message || e).slice(0, 200));
      return null;
    } finally {
      _loading = null;
    }
  })();
  return _loading;
}

// Preloads the model in the background (called at server start) so that the first dedup check does not bear the load
// time. Best effort.
export function warmupEmbeddings() {
  getPipe().catch(() => {});
}

// Waits until the model is loaded or loading fails — WITHOUT a limit. A download that hangs holds the caller as long as the
// download (in the user container ~130 MB, minutes on a slow line).
export async function embeddingsAvailable() {
  return !!(await getPipe());
}

// A text → normalized 384-dim vector (array) or null if there is no model.
export async function embed(text) {
  const pipe = await getPipe();
  if (!pipe) return null;
  const out = await pipe(String(text || "").slice(0, 4000), { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

// Cosine similarity of two already normalized vectors = dot product.
export function cosineDense(a, b) {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
}

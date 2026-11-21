// providers/openrouter-catalog.js — the OpenRouter model catalog, automatic: no manual model lists or prices.
//
// OpenRouter is a BUILT-IN provider, and its models come from here: `GET <base>/models` (public, no key), stored in
// `<data>/openrouter-catalog.json`, refreshed every 6 h, loaded from the file right at start. An error (network, HTTP,
// broken response) changes nothing — the last state stays valid; without a file and without network the catalog is
// EMPTY, and empty means "unknown" here, not "no models" (`catalogKnows`).
//
// What an entry carries (measured at the public API):
//   tools    `supported_parameters` contains "tools" — cbase only offers such models (the loop engine needs tools);
//   vision   `architecture.input_modalities` contains "image" — the connector sends no images to a model without image
//            input (OpenRouter otherwise answers "No endpoints found that support image input");
//   context  the context window cbase COMPUTES with (transcript budget, compaction): the median of the active endpoints
//            (`openrouter-endpoints.js:endpointsMedian`), fetched on first use of a model and stored 24 h per model,
//            never above `context_length`; until then min(`top_provider.context_length`, `context_length`) (if one is
//            missing, the other). `context_length` alone is the MAXIMUM over all providers and no good as a working
//            number. The median is only fetched where `top_provider` and `context_length` DISAGREE; if they agree, the
//            number holds without another fetch;
//   prices   USD per token from `pricing` (prompt, completion, input_cache_read, input_cache_write) — for the
//            equivalent value of the subscription providers and the estimate for old OpenRouter rows without an amount;
//            negative, empty or not a number ⇒ null (unknown, never 0), "0" is a price (`:free`).
//
// The base comes from the contract (`OPENROUTER_BASE`); only `CBASE_OPENROUTER_BASE` overrides it — the test seam (the
// fake endpoint of the agent harness answers `/models`). `CBASE_OPENROUTER_OFFLINE=1` blocks the network to the REAL
// base (the gate sets it, `tools/check/targets/check.mjs`: a test process with its own data folder has no catalog file
// and would otherwise fetch the whole catalog from openrouter.ai on every server start); an overridden base stays
// reachable.
//
// A leaf except for the contract and the endpoint query: the store does not know the catalog, the catalog not the store.
// The server names the data folder at start (`startCatalog`), tests replace the source (`setCatalogSourceForTests`).
// Guard: server/backend/test/openrouter-catalog.test.js.
import fs from "node:fs";
import path from "node:path";
import { OPENROUTER_BASE } from "../account/usage-contract.js";
import { endpointsMedian, fetchEndpoints } from "./openrouter-endpoints.js";

/** How often the catalog is refreshed. */
export const CATALOG_REFRESH_MS = 6 * 3_600_000;
/** A failed fetch is retried after this time (the last state stays valid until then). */
const CATALOG_AGAIN_MS = 15 * 60_000;
/** How long the median of a model is valid. */
export const CONTEXT_APPLIES_MS = 24 * 3_600_000;
/** A failed endpoint fetch is retried after this time at the earliest. */
const CONTEXT_AGAIN_MS = 10 * 60_000;
/** Deadline of the catalog fetch (the catalog is ≈ 1 MB). */
const CATALOG_DEADLINE_MS = 30_000;

/** The base of the OpenRouter API: the contract, overridden only by `CBASE_OPENROUTER_BASE` (test seam). No trailing "/". */
export function openRouterBase() {
  const raw = String(process.env.CBASE_OPENROUTER_BASE || "").trim().replace(/\/+$/, "");
  return raw || OPENROUTER_BASE;
}

/** May a fetch go to the network now? No only with `CBASE_OPENROUTER_OFFLINE=1` AND the real base (see header). */
export function openRouterNetworkAllowed() {
  return !(process.env.CBASE_OPENROUTER_OFFLINE === "1" && openRouterBase() === OPENROUTER_BASE);
}

const count = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
// USD per token; negative, empty or not a number ⇒ null (unknown). "0" is a real price.
const usd = (v) => {
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() ? Number(v) : NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * A raw entry from `GET /models` → the stored form, or null (no id). `contextCatalog` is the fallback number until the
 * first median (see header), `contextMax` the upper bound (`context_length`), `alias` the target of an alias ("~…").
 */
export function normalize(x) {
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !x.id.trim()) return null;
  const params = Array.isArray(x.supported_parameters) ? x.supported_parameters : [];
  const modal = Array.isArray(x.architecture?.input_modalities) ? x.architecture.input_modalities : [];
  const max = count(x.context_length);
  const top = count(x.top_provider?.context_length);
  return {
    id: x.id.trim(),
    name: String(x.name || x.id).trim(),
    tools: params.includes("tools"),
    vision: modal.includes("image"),
    // Until the median: the SMALLER of the two numbers (a top_provider ABOVE the catalog maximum is not a window cbase
    // may compute with); if one is missing, the other.
    contextCatalog: top && max ? Math.min(top, max) : (top || max),
    contextMax: max,
    // The median is only worth it then (see header): both numbers present and different.
    atOdds: Boolean(top && max && top !== max),
    alias: typeof x.alias_target?.slug === "string" ? x.alias_target.slug : "",
    prices: {
      prompt: usd(x.pricing?.prompt),
      completion: usd(x.pricing?.completion),
      cacheRead: usd(x.pricing?.input_cache_read),
      cacheWrite: usd(x.pricing?.input_cache_write),
    },
  };
}

// ── State ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ONE catalog per process (in production one server per process; in tests many run one after another, each restarts).
let file = "";          // <data>/openrouter-catalog.json — "" = in memory only (tests without a server)
let models = [];        // normalized entries in catalog order
let index = new Map();   // id → entry
let state = 0;           // counts every change of the list (the connector keeps its mapping fresh by it)
let catalogAt = 0;       // when the state was fetched (ms)
let contexts = {};       // id → { value, at } — the median, 24 h per model
const contextError = new Map(); // id → no new attempt until then
const contextRunning = new Set();
let running = null;       // the open fetch (promise) — at most one at a time
let clock = null;          // the next fetch
let attempted = false;    // has there been a first load attempt since start (file or network)?
let readyRelease = null;
let ready = null;
let testSource = null;
const observer = new Set();

function newReady() {
  ready = new Promise((r) => { readyRelease = r; });
  attempted = false;
}
newReady();
const reportReady = () => { attempted = true; readyRelease?.(); };

function setModels(list, at) {
  models = list;
  index = new Map(list.map((m) => [m.id, m]));
  catalogAt = at;
  state += 1;
  for (const fn of observer) { try { fn(); } catch { /* an observer never takes the catalog down */ } }
}

function writeFile() {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, at: catalogAt, base: openRouterBase(), models, contexts }));
    fs.renameSync(tmp, file);
  } catch (e) { console.warn(`[openrouter] catalog not saved: ${e?.message || e}`); }
}

function readFile(f) {
  if (!f) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!j || !Array.isArray(j.models)) return null;
    // A state from another base (test seam ↔ real) does not count: the fake endpoint knows other models.
    if (typeof j.base === "string" && j.base && j.base !== openRouterBase()) return null;
    const list = j.models.filter((m) => m && typeof m.id === "string" && m.id);
    return { at: Number(j.at) || 0, models: list, contexts: j.contexts && typeof j.contexts === "object" ? j.contexts : {} };
  } catch { return null; }
}

async function networkSource() {
  if (!openRouterNetworkAllowed()) throw new Error("OpenRouter is offline for this process (CBASE_OPENROUTER_OFFLINE=1)");
  const r = await fetch(`${openRouterBase()}/models`, { signal: AbortSignal.timeout(CATALOG_DEADLINE_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function plane(ms) {
  if (clock) clearTimeout(clock);
  clock = setTimeout(() => { clock = null; refreshCatalog().catch(() => {}); }, Math.max(0, ms));
  clock.unref?.();
}

/**
 * Fetch the catalog NOW (source: the test source, otherwise `GET <base>/models`). Success ⇒ new state, into the file,
 * next fetch in 6 h; error ⇒ the last state stays, next attempt in 15 min. Never throws; returns whether it worked.
 * At most one fetch at a time — a second call gets the running one.
 */
export function refreshCatalog() {
  if (running) return running;
  running = (async () => {
    // The body never runs synchronously: if the source throws IMMEDIATELY (a test source), `finally` would otherwise run
    // before the assignment above — `running` would stay on the settled promise forever, and no fetch and no
    // `catalogReady` would ever arrive again.
    await null;
    try {
      const raw = await (testSource ? testSource({ base: openRouterBase() }) : networkSource());
      const data = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : null);
      if (!data) throw new Error("no model list in the response");
      const list = data.map(normalize).filter(Boolean);
      // An EMPTY response is not a catalog (an API outage would otherwise look like "OpenRouter has no models").
      if (!list.length) throw new Error("empty model list");
      setModels(list, Date.now());
      writeFile();
      plane(CATALOG_REFRESH_MS);
      return true;
    } catch (e) {
      if (!testSource && openRouterNetworkAllowed()) console.warn(`[openrouter] catalog not refreshed (the last state stays valid): ${e?.message || e}`);
      plane(CATALOG_AGAIN_MS);
      return false;
    } finally {
      running = null;
      reportReady();
    }
  })();
  return running;
}

/**
 * At server start: the data folder, then the stored state right away. If it is older than 6 h (or missing), a fresh
 * fetch starts immediately — in the background, the start does not wait. A second start in the same process (tests)
 * begins from scratch.
 * @param {{ file?: string }} [o]  the path of the catalog file (`<data>/openrouter-catalog.json`)
 */
export function startCatalog({ file: f = "" } = {}) {
  stopCatalog();
  file = String(f || "");
  setModels([], 0);
  contexts = {};
  contextError.clear();
  newReady();
  const read = readFile(file);
  if (read && read.models.length) {
    contexts = read.contexts;
    setModels(read.models, read.at);
    reportReady();
  }
  const due = read?.models.length ? read.at + CATALOG_REFRESH_MS - Date.now() : 0;
  if (due <= 0) refreshCatalog().catch(() => {});
  else plane(due);
}

/** The timer stops (server end). The loaded state stays readable. */
export function stopCatalog() {
  if (clock) { clearTimeout(clock); clock = null; }
}

/**
 * Resolves as soon as the first load attempt since start is over — from the file or the network, successful or not.
 * A caller that asks before anyone has loaded (a test without a server) triggers the fetch itself. The waiter decides
 * how long to wait (the provider migration at most 10 s).
 */
export function catalogReady() {
  if (!attempted && !running) refreshCatalog().catch(() => {});
  return ready;
}

/** The test seam: replace the catalog source (`fn({ base })` → list of raw entries or `{ data }`; throwing = error).
 *  Null restores the real source. Every call begins from scratch (empty catalog, new load attempt on the next question). */
export function setCatalogSourceForTests(fn) {
  testSource = typeof fn === "function" ? fn : null;
  stopCatalog();
  setModels([], 0);
  contexts = {};
  contextError.clear();
  contextRunning.clear();
  newReady();
}

/** A callback on every change of the list (the connector refreshes its mapping). Returns: unsubscribe. */
export function atCatalogChange(fn) {
  if (typeof fn !== "function") return () => {};
  observer.add(fn);
  return () => observer.delete(fn);
}

/** A counter that grows with every change — cheap to compare. */
export const catalogStatus = () => state;
/** When the loaded state was fetched (ms; 0 = nothing loaded). */
export const catalogTime = () => catalogAt;

function publiclyVisible(m) {
  const k = contexts[m.id];
  const median = k && Number(k.at) + CONTEXT_APPLIES_MS > Date.now() ? count(k.value) : 0;
  return {
    id: m.id,
    name: m.name,
    tools: m.tools === true,
    vision: m.vision === true,
    context: median || count(m.contextCatalog) || count(m.contextMax),
    prices: { ...m.prices },
  };
}

/** A catalog model — `{ id, name, tools, vision, context, prices: { prompt, completion, cacheRead, cacheWrite } }` (USD
 *  per token, null = unknown) — or null if the catalog does not list it (also while it is still empty). */
export function catalogModel(id) {
  const m = index.get(String(id || "").trim());
  return m ? publiclyVisible(m) : null;
}

/** All models with tools, in catalog order (same shape as `catalogModel`). */
export function catalogList() {
  return models.filter((m) => m.tools === true).map(publiclyVisible);
}

/**
 * May a run use this model at OpenRouter? `true` = in the catalog with tools, `false` = not in the catalog or without
 * tools, `null` = UNKNOWN (the catalog is empty: no state in the file, no network) — empty is not "does not exist".
 */
export function catalogKnows(id) {
  if (!models.length) return null;
  return index.get(String(id || "").trim())?.tools === true;
}

/**
 * The model is being used right now (a run, a oneshot): if its catalog numbers disagree and its median is missing or
 * older than 24 h, it is fetched in the background (`GET <base>/models/<id>/endpoints`, public; an alias asks its
 * target) and stored. The running call still computes with the fallback number — the next one with the median. A
 * failure is not retried for 10 min. Never throws. Returns a promise that never rejects — `true` once a median is
 * stored, otherwise `false` (nothing to do, failure). The connector does not wait for it, the guard does
 * (server/backend/test/openrouter-catalog.test.js — without the promise it would have to wait for a duration).
 */
export function catalogUse(id) {
  const m = index.get(String(id || "").trim());
  if (!m || m.atOdds !== true) return Promise.resolve(false);
  const k = contexts[m.id];
  if (k && Number(k.at) + CONTEXT_APPLIES_MS > Date.now()) return Promise.resolve(false);
  if (contextRunning.has(m.id) || (contextError.get(m.id) || 0) > Date.now()) return Promise.resolve(false);
  if (!openRouterNetworkAllowed()) return Promise.resolve(false);
  contextRunning.add(m.id);
  const toFile = file;
  return fetchEndpoints(openRouterBase(), "", m.id, { aliasTarget: m.alias || "" })
    .then((endpoints) => {
      const median = endpointsMedian(endpoints);
      if (!median) throw new Error("no active endpoint");
      // A server that has restarted in the meantime (different data folder) does not get the value.
      if (toFile !== file || !index.has(m.id)) return false;
      contexts[m.id] = { value: m.contextMax ? Math.min(median, m.contextMax) : median, at: Date.now() };
      writeFile();
      return true;
    })
    .catch(() => { contextError.set(m.id, Date.now() + CONTEXT_AGAIN_MS); return false; })
    .finally(() => { contextRunning.delete(m.id); });
}

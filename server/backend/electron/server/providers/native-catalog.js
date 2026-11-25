// providers/native-catalog.js — the model lists of Claude and Codex, read from the CLIs' own account catalogs.
//
// Both CLIs fetch the models the signed-in account may use and keep them on disk; cbase reads those files instead of a list
// maintained by hand, so a new model shows up in the picker as soon as the CLI knows it:
//   Claude  `<CLAUDE_CONFIG_DIR | ~/.claude>/cache/model-catalog/<org>-<hash>-cc.json` — `catalog.config.models[]` with `id`,
//           `name`, `disabled` (the plan may not use it), `min_claude_code_version`, `runtime.max_input_tokens`,
//           `runtime.effort_levels`, `runtime.default_effort`, `thinking.type` ("none" ⇒ no levels). One file per
//           organisation the CLI was signed in to; the NEWEST `fetchedAt` is the current login.
//   Codex   `<CODEX_HOME | ~/.codex>/models_cache.json` — `client_version` (the CLI that fetched it) and `models[]` with
//           `slug`, `display_name`, `priority` (picker order), `visibility` ("hide" = internal, never offered),
//           `minimal_client_version`, `context_window`, `max_context_window`, `supported_reasoning_levels[].effort`,
//           `default_reasoning_level`.
//
// What cbase takes over, and what it does not:
//   • levels are cut to `EFFORT_LEVELS` (workflows.js) — Codex's level above `max` is never offered (it switches on Codex's
//     own delegation, which cbase does not see), `none`/`minimal` neither. A model without levels gets `[]` ("no levels",
//     no flag), never a missing list;
//   • `catalogLevel` is the catalog default, only when it is one of the model's levels;
//   • Codex `context` is `max_context_window` (the CLI clamps `-c model_context_window` to it; cbase asks for the largest
//     window, see connectors/codex.js), else `context_window`;
//   • a model that needs a newer CLI than the one installed is left out (Claude: the version the CLI reports; Codex: the
//     `client_version` of the file);
//   • a disabled (Claude) or hidden (Codex) model is left out.
//
// No file, an unreadable one, or one without a single usable model ⇒ `null`: the connector keeps its own static list (the
// floor every installation has, and what the tests see). The files are read lazily and again when their mtime changes, at
// most every `RECHECK_MS` — the CLIs rewrite them during operation (Claude about hourly, Codex at each start).
//
// A leaf: the server names the folders at start (`startNativeCatalogs`), tests set them directly (`setNativeCatalogsForTests`).
// `CBASE_NATIVE_CATALOG_OFF=1` (set by the gate, tools/check/targets/check.mjs) keeps the start a no-op, so a test server on a
// developer machine never reads that machine's real catalogs. Guard: server/backend/test/native-catalog.test.js.
import fs from "node:fs";
import path from "node:path";
import { effortSavable } from "../workflows.js";

/** How often the files' mtime is checked at most. */
export const RECHECK_MS = 30_000;

/** "2.1.332" vs "2.1.290" → >0 / 0 / <0; non-numeric parts count as 0. */
export function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
// A model needs a newer CLI than `have`? Unknown on either side ⇒ no.
const tooNew = (need, have) => !!need && !!have && compareVersions(need, have) > 0;
// Only what cbase may store as a level at all (`effortSavable`, the one judge), in the catalog's order, once each.
const levelsOf = (list) => [...new Set((list || []).filter((l) => effortSavable(l).kind === "level"))];
const positive = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };

/**
 * A Claude account catalog (the parsed `*-cc.json`) → cbase's model list, or null (nothing usable).
 * @param {object} file
 * @param {{ cliVersion?: string }} [o]  the installed CLI's version; empty = unknown (no version filter)
 */
export function fromClaudeCatalog(file, { cliVersion = "" } = {}) {
  const models = file?.catalog?.config?.models;
  if (!Array.isArray(models)) return null;
  const out = [];
  for (const m of models) {
    const id = typeof m?.id === "string" ? m.id.trim() : "";
    if (!id || m.disabled === true || out.some((x) => x.id === id)) continue;
    if (tooNew(m.min_claude_code_version, cliVersion)) continue;
    const runtime = m.runtime || {};
    const none = m.thinking?.type === "none";
    const raw = Array.isArray(runtime.effort_levels) ? runtime.effort_levels
      : (m.thinking?.effort_options || []).map((o) => o?.id);
    const efforts = none ? [] : levelsOf(raw);
    const entry = { id, label: String(m.name || id).trim(), context: positive(runtime.max_input_tokens), efforts };
    if (efforts.includes(runtime.default_effort)) entry.catalogLevel = runtime.default_effort;
    out.push(entry);
  }
  return out.length ? out : null;
}

/** "GPT-6.2-Sol" → "GPT-6.2 Sol" (the catalog joins family and name with a dash; cbase's labels use a space). */
export function codexLabel(name, slug) {
  const s = String(name || slug || "").trim();
  return s.replace(/^(GPT-\d+(?:\.\d+)*)-(?=\S)/i, "$1 ");
}

/** A Codex account catalog (the parsed `models_cache.json`) → cbase's model list in `priority` order, or null. */
export function fromCodexCatalog(file) {
  const models = file?.models;
  if (!Array.isArray(models)) return null;
  const cliVersion = String(file.client_version || "");
  const rows = [];
  for (const m of models) {
    const id = typeof m?.slug === "string" ? m.slug.trim() : "";
    if (!id || m.visibility === "hide" || rows.some((x) => x.entry.id === id)) continue;
    if (tooNew(m.minimal_client_version, cliVersion)) continue;
    const efforts = levelsOf((m.supported_reasoning_levels || []).map((l) => (typeof l === "string" ? l : l?.effort)));
    const entry = { id, label: codexLabel(m.display_name, id), context: positive(m.max_context_window) || positive(m.context_window), efforts };
    if (efforts.includes(m.default_reasoning_level)) entry.catalogLevel = m.default_reasoning_level;
    rows.push({ entry, priority: Number.isFinite(Number(m.priority)) ? Number(m.priority) : Infinity, at: rows.length });
  }
  rows.sort((a, b) => a.priority - b.priority || a.at - b.at);
  return rows.length ? rows.map((r) => r.entry) : null;
}

// ── Sources ──────────────────────────────────────────────────────────────────────
let claudeDir = "";
let codexDir = "";
let claudeVersion = "";
const cache = { claude: { key: "", at: 0, list: null }, codex: { key: "", at: 0, list: null } };

function resetCache() {
  for (const c of Object.values(cache)) { c.key = ""; c.at = 0; c.list = null; }
}

// The newest Claude catalog file (by `fetchedAt`, then mtime) and its parsed content.
function newestClaudeFile() {
  const dir = path.join(claudeDir, "cache", "model-catalog");
  let best = null;
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith("-cc.json")); } catch { return null; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      const at = Number(json?.fetchedAt) || stat.mtimeMs;
      if (!best || at > best.at) best = { file, at, mtime: stat.mtimeMs, json };
    } catch { /* half-written or foreign: skip */ }
  }
  return best;
}

function claudeKey() {
  const dir = path.join(claudeDir, "cache", "model-catalog");
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith("-cc.json"))
      .map((n) => `${n}:${fs.statSync(path.join(dir, n)).mtimeMs}`).sort().join("|") + `@${claudeVersion}`;
  } catch { return ""; }
}

function codexKey() {
  try { return `${fs.statSync(path.join(codexDir, "models_cache.json")).mtimeMs}`; } catch { return ""; }
}

function cached(kind, keyFn, load) {
  const c = cache[kind];
  const now = Date.now();
  if (c.at && now - c.at < RECHECK_MS) return c.list;
  c.at = now;
  const key = keyFn();
  if (key === c.key) return c.list;
  c.key = key;
  try { c.list = key ? load() : null; } catch { c.list = null; }
  return c.list;
}

/** Claude's models from the account catalog, or null (no catalog — the connector keeps its static list). */
export function claudeCatalogModels() {
  if (!claudeDir) return null;
  return cached("claude", claudeKey, () => {
    const best = newestClaudeFile();
    return best ? fromClaudeCatalog(best.json, { cliVersion: claudeVersion }) : null;
  });
}

/** Codex's models from the account catalog, or null. */
export function codexCatalogModels() {
  if (!codexDir) return null;
  return cached("codex", codexKey, () => fromCodexCatalog(JSON.parse(fs.readFileSync(path.join(codexDir, "models_cache.json"), "utf8"))));
}

/**
 * The installed Claude CLI's version WITHOUT starting it (no child process past the start places): the binary is resolved via
 * PATH and its real path read — the native installer keeps it as `…/versions/<version>`, the npm package as
 * `…/@anthropic-ai/claude-code/bin/…` next to its `package.json`. Unknown ⇒ "" (no version filter).
 * @param {string} bin  `claudeBin()` — a name or a path
 */
export function claudeCliVersion(bin) {
  try {
    let file = String(bin || "");
    if (!file) return "";
    if (!file.includes(path.sep)) {
      const hit = String(process.env.PATH || "").split(path.delimiter).filter(Boolean)
        .map((d) => path.join(d, file)).find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
      if (!hit) return "";
      file = hit;
    }
    const real = fs.realpathSync(file);
    const own = path.basename(real).match(/^\d+\.\d+\.\d+$/)?.[0];
    if (own) return own;
    let dir = path.dirname(real);
    for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
        if (pkg?.name === "@anthropic-ai/claude-code") return String(pkg.version || "");
      } catch { /* not here */ }
    }
  } catch { /* unknown */ }
  return "";
}

/**
 * Called once at server start with the backend's CLI homes and the Claude binary (for its version). A no-op under
 * `CBASE_NATIVE_CATALOG_OFF=1`.
 * @param {{ claudeDir?: string, codexDir?: string, claudeBin?: string }} o
 */
export function startNativeCatalogs({ claudeDir: cd = "", codexDir: xd = "", claudeBin = "" } = {}) {
  if (process.env.CBASE_NATIVE_CATALOG_OFF === "1") return;
  claudeDir = cd; codexDir = xd; claudeVersion = claudeCliVersion(claudeBin);
  resetCache();
}

/** Test seam: set the folders (and the Claude CLI's version) directly; empty folders switch the catalogs off. */
export function setNativeCatalogsForTests({ claudeDir: cd = "", codexDir: xd = "", claudeVersion: v = "" } = {}) {
  claudeDir = cd; codexDir = xd; claudeVersion = v;
  resetCache();
}

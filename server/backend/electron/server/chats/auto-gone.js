// "Auto" is gone: the one-time migration of chats without an effort level.
//
// A chat used to be allowed to carry "Auto" ('' in `chats.effort`): cbase then sent no level and the CLI thought with what
// ITS configuration says — Claude with `effortLevel` from the user settings (`~/.claude/settings.json`), Codex with
// `model_reasoning_effort` from `~/.codex/config.toml`, and without an entry with the catalog level of the model. The run
// now resolves an empty field to the provider's default level — without this migration every Auto chat would silently
// think differently than the day before. So it gets, ONCE, the level it really runs with today, clamped to its model:
//   • Claude/Codex: the value from the configuration file; if missing (or not a level), the catalog level of ITS model
//     (what the CLI runs without one); if the catalog does not know the model, the default level plus a hint line as
//     below — then it is unknown what it ran with.
//   • Third-party providers (no configuration file): the provider's default level (`medium` without a catalog) — and ONE
//     hint line in the chat "Thinking level now <level> (before: none)": until then no level reached the API there; the
//     change should be visible.
//   • A model without levels (Haiku 4.5) keeps '' — the clamp yields no level and there is nothing to show.
//
// Read from the home of the RUNNING server (`os.homedir()`): `/home/agent` in the user container, the real home on a
// local server — the same files this server's CLI reads. `CLAUDE_CONFIG_DIR` / `CODEX_HOME` take precedence, as in the CLI
// itself. The Codex configuration is TOML, not JSON (see `tomlValues`).
//
// Once per store: the marker `migration.effort_auto_gone` in app_settings is set after the first run, EVEN if there was
// nothing to migrate. Migrating without a marker would be wrong here: a chat created empty AFTER the first start thinks
// with the default level (the run resolves it) — a second start without the marker would give it the value of the CLI
// configuration, silently a different one. A level set after the migration survives every later start. Called from
// server.js AFTER the provider migration (account/provider-migration.js; the clamp needs the catalogs) — not in the schema
// registry: the store does not know the providers.
//
// Manager chats are read-only (runs/manager-lock.js): `chatsWithoutLevel` leaves them out, and `migrateRoleLevelsLater`
// only sets its marker.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { effortSavable } from "../workflows.js";
import { defaultModelFor, effortCatalogLevel, effortRunning, effortStandard, levelOnWire, providerForChat } from "../providers/index.js";


export const AUTO_GONE_MARKER = "migration.effort_auto_gone";
export const ROLES_AFTER_MARKER = "migration.effort_roles_after";

/** The hint line of both migrations: "Thinking level now <level> (before: <level>|none)". */
function hintText(level, prior) {
  return prior
    ? T`Thinking level now ${level} (before: ${prior})`
    : T`Thinking level now ${level} (before: none)`;
}

/**
 * A value from a configuration file as a level of the scale — the explicit rule for everything outside it:
 *   • a level of the scale (`effortSavable`; case and surrounding whitespace ignored) ⇒ itself;
 *   • `ultra` ⇒ `max` — as for stored values (with Claude it already ran as max);
 *   • Codex `minimal`/`none` ⇒ `low`: the lowest level cbase offers (fallback rule: none below ⇒ the lowest) — never
 *     higher than needed, since one level more costs thinking tokens against the subscription limit. With Claude the
 *     CLI ignores these words (it then runs its default), so there they count like any other word:
 *   • anything else ⇒ "" (no value — the model's catalog level or the default level applies).
 * @param {unknown} value
 * @param {string} provider  "claude" | "codex"
 * @returns {string}
 */
export function levelFromConfig(value, provider) {
  const w = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (effortSavable(w).kind === "level") return w;
  if (w === "ultra") return "max";
  if (provider === "codex" && (w === "minimal" || w === "none")) return "low";
  return "";
}

// ── TOML, as far as the question reaches ─────────────────────────────────────────────────────────
// Not a full parser: key = value per line, table headers `[a.b]` / `[[a]]` (also quoted), dotted keys, values as "…",
// '…' or bare; comments after `#`. Multi-line content of the Codex configuration (arrays, inline tables across lines)
// lives in other keys and is skipped.
function tomlKey(raw) {
  return raw.split(".").map((t) => t.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
}
function tomlValue(raw) {
  const r = raw.trim();
  let m = r.match(/^"((?:[^"\\]|\\.)*)"/);
  if (m) return m[1].replace(/\\(["\\])/g, "$1");
  m = r.match(/^'([^']*)'/);
  if (m) return m[1];
  m = r.match(/^([^\s#]+)/);
  return m ? m[1] : "";
}
/**
 * All simple values of a TOML file as a map "table.key" → string ("" = top level).
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function tomlValues(text) {
  const values = new Map();
  let table = [];
  for (const row of String(text || "").split(/\r?\n/)) {
    const z = row.trim();
    if (!z || z.startsWith("#")) continue;
    const header = z.match(/^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/);
    if (header) { table = tomlKey(header[1]); continue; }
    const paar = z.match(/^((?:"[^"]*"|'[^']*'|[A-Za-z0-9_.\-\s])+?)\s*=\s*(.*)$/);
    if (!paar) continue;
    values.set([...table, ...tomlKey(paar[1])].join("."), tomlValue(paar[2]));
  }
  return values;
}

/** `model_reasoning_effort` as Codex reads it without `--profile`: the selected profile takes precedence over the top level. */
export function codexReasoningEffort(home = os.homedir()) {
  const dir = process.env.CODEX_HOME || path.join(home, ".codex");
  let text = "";
  try { text = fs.readFileSync(path.join(dir, "config.toml"), "utf8"); } catch { return ""; }
  const w = tomlValues(text);
  const profile = w.get("profile");
  return (profile && w.get(`profiles.${profile}.model_reasoning_effort`)) || w.get("model_reasoning_effort") || "";
}

/** `effortLevel` from the user settings of the Claude CLI. Broken JSON means "no value", not an abort. */
export function claudeEffortLevel(home = os.homedir()) {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    return typeof o?.effortLevel === "string" ? o.effortLevel : "";
  } catch { return ""; }
}

/**
 * The migration. Once per store (marker), a no-op afterwards.
 * @returns {{chats: number, hints: number} | null}  null = the marker was already set
 */
export function migrateAutoChats() {
  if (store.getSetting(AUTO_GONE_MARKER, "")) return null;
  const home = os.homedir();
  const config = {
    claude: levelFromConfig(claudeEffortLevel(home), "claude"),
    codex: levelFromConfig(codexReasoningEffort(home), "codex"),
  };
  const tally = { chats: 0, hints: 0 };
  for (const c of store.chatsWithoutLevel()) {
    const provider = providerForChat(c);
    const model = c.model || defaultModelFor(provider);
    const native = provider === "claude" || provider === "codex";
    // What the CLI runs today: its configuration value, else the catalog level of THIS model.
    const today = native ? (config[provider] || effortCatalogLevel(provider, model)) : "";
    const level = effortRunning(provider, model, today || effortStandard(provider));
    if (!level || !store.setLevelIfEmpty(c.id, level)) continue;
    tally.chats++;
    // A provider with `caps.effort: false` does not send the level: the value may stand, but a line "Thinking level
    // now …" would claim a change that does not happen on the wire.
    if (levelOnWire(provider) && !today) {
      store.addMessage(c.id, "hint", hintText(level, today));
      tally.hints++;
    }
  }
  store.setSetting(AUTO_GONE_MARKER, new Date().toISOString());
  if (tally.chats) console.log(`[store] effort: ${tally.chats} chat(s) without a level get their running level, ${tally.hints} with a hint line`);
  return tally;
}

/**
 * The follow-up migration: it once moved the role chats of the manager to the level of their run. Those are all manager
 * chats, which are read-only now (runs/manager-lock.js), so it only sets its marker — under the same condition as before:
 * only if the marker of the FIRST migration was already set when this start began (server.js calls it BEFORE
 * `migrateAutoChats`).
 * @returns {{chats: number} | null}  null = did not run (marker set, or the first migration is still pending)
 */
export function migrateRoleLevelsLater() {
  if (store.getSetting(ROLES_AFTER_MARKER, "") || !store.getSetting(AUTO_GONE_MARKER, "")) return null;
  store.setSetting(ROLES_AFTER_MARKER, new Date().toISOString());
  return { chats: 0 };
}

// Normalisation of the recordings: everything that depends on chance, clock, machine or process gets a
// placeholder, so that two recordings of the same scenario are byte-equal. The ORDER of the events stays
// untouched: it IS the proof. Pure, no side effects; the gate test (web/test/streams.test.mjs) only reads
// the results.
//
// Rules (each for a measured source of flakiness, see README.md):
//   ids      UUIDs, also INSIDE strings (the report of cbase_ask carries the requestId as JSON text):
//            known ids by role (<chat-1>, <ws-1>), all others <id-N> in order of first occurrence; the
//            row ids of the history (`id` of a log row) become <msg-N> in order.
//   times    epoch milliseconds (2020–2033) as number → "<t>"; ISO timestamps in text → <iso>; clock texts
//            of the server ("17.09., 14:32", clockText) → <clock>; `secs` of a run meta → "<secs>"
//            (run duration rounded to seconds — 2 instead of 1 under load).
//   paths    the temp root of the server → <path>; the base URL → <basis>; ports → <port>.
//   process  `pid` → "<pid>"; version stamps (`version`, `claude_code_version`) → "<version>".
//
// Deliberately NOT normalised: token counts (the fake CLI sends fixed ones), contextTokens (derived from
// them), the numbers of the bell notices (from 1 per server process — a scenario is one process) and the
// counts in `queued`, `attempts`, `num_turns`.
//
// The table has two OPT-IN extensions — without them the result is byte-equal to the plain form (the web
// fixtures are the proof): `known` (further ids by role, e.g. <chat-2>, <agent-1>, <channel-1>) and `rules`
// (additional time and duration keys, text patterns, epoch numbers INSIDE strings). The golden recorder
// (server/backend/test/golden-harness.mjs) needs them for DB rows and prompt bytes.

import fs from "node:fs";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g;
// clockText in limit-gate.js: de-DE "17.09., 14:32", en-GB "17/09, 14:32".
const CLOCK = /\b\d{2}\.\d{2}\., \d{2}:\d{2}\b|\b\d{2}\/\d{2}, \d{2}:\d{2}\b/g;
// Epoch milliseconds 2020–2033 as a number IN a text (rule `epochInText`): the same form the gate test
// treats as "not normalised".
const EPOCH_IN_TEXT = /\b1[6-9]\d{11}\b/g;
const EPOCH_MS_OF = Date.UTC(2020, 0, 1);
const EPOCH_MS_UNTIL = Date.UTC(2033, 0, 1);
const TIME_KEY = new Set(["ts", "at", "createdAt", "updatedAt", "dueAt", "resetsAt", "startedAt", "wakeupAt", "resolvedAt"]);

// `root` occurs in TWO spellings: os.tmpdir() yields "/var/folders/…" on macOS, the fake CLI reports its
// cwd resolved as "/private/var/folders/…" — both become <path>, the longer one first.
//
// `known`: { "<uuid>": "<chat-2>", … } — further ids with a role (in addition to chatId/workspaceId).
// `rules`: { timeKey: [], msKey: [], replacement: {}, upfront: [[RegExp, replacement], …], texts: [[RegExp, replacement], …],
//          epochInText: false }
//          — timeKey adds time keys (number > 0 → "<t>"), msKey are duration keys (number → "<ms>"),
//          replacement replaces the value of a key entirely (e.g. a hash over volatile payload), upfront are
//          patterns BEFORE all built-in ones (before root, base and id table — for paths that may themselves
//          carry a UUID: otherwise the UUID in the path would get an <id-N> before the pattern found the
//          path), texts are further patterns over every string (after the built-in ones), epochInText
//          replaces epoch numbers also INSIDE strings.
export function newTable({ chatId = "", workspaceId = "", root = "", base = "", known = {}, rules = {} } = {}) {
  const ids = new Map();
  if (chatId) ids.set(chatId.toLowerCase(), "<chat-1>");
  if (workspaceId) ids.set(workspaceId.toLowerCase(), "<ws-1>");
  for (const [id, role] of Object.entries(known)) if (id) ids.set(String(id).toLowerCase(), role);
  const roots = [];
  if (root) {
    let real = root;
    try { real = fs.realpathSync(root); } catch { /* then only the one spelling */ }
    for (const w of new Set([real, root])) roots.push(w);
    roots.sort((a, b) => b.length - a.length);
  }
  return {
    ids, unknown: 0, msgIds: new Map(), roots, base,
    rules: {
      timeKey: new Set(rules.timeKey || []),
      msKey: new Set(rules.msKey || []),
      replacement: { ...(rules.replacement || {}) },
      upfront: (rules.upfront || []).map(([pattern, replacement]) => [pattern, replacement]),
      texts: (rules.texts || []).map(([pattern, replacement]) => [pattern, replacement]),
      epochInText: Boolean(rules.epochInText),
    },
  };
}

function idFor(table, raw) {
  const k = raw.toLowerCase();
  if (!table.ids.has(k)) table.ids.set(k, `<id-${++table.unknown}>`);
  return table.ids.get(k);
}

export function normalizeText(s, table) {
  let t = s;
  for (const [pattern, replacement] of table.rules?.upfront || []) t = t.replace(pattern, replacement);
  for (const w of table.roots) t = t.split(w).join("<path>");
  if (table.base) t = t.split(table.base).join("<basis>");
  t = t.replace(/127\.0\.0\.1:\d{4,5}/g, "127.0.0.1:<port>");
  t = t.replace(UUID, (m) => idFor(table, m));
  t = t.replace(ISO, "<iso>");
  t = t.replace(CLOCK, "<clock>");
  const rules = table.rules;
  if (rules) {
    if (rules.epochInText) t = t.replace(EPOCH_IN_TEXT, "<t>");
    for (const [pattern, replacement] of rules.texts) t = t.replace(pattern, replacement);
  }
  return t;
}

// `path` is the key chain up to here — for the few rules that depend on the key.
export function normalize(value, table, path = []) {
  if (Array.isArray(value)) return value.map((w, i) => normalize(w, table, [...path, i]));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, table, [...path, k]);
    return out;
  }
  const key = path.length ? path[path.length - 1] : "";
  const rules = table.rules;
  if (rules && value !== null && value !== undefined && Object.prototype.hasOwnProperty.call(rules.replacement, key)) return rules.replacement[key];
  if (typeof value === "number") {
    if (key === "pid") return "<pid>";
    if (key === "secs") return "<secs>";
    if (key === "port" && path.length >= 1) return "<port>";
    if (rules && rules.msKey.has(key)) return "<ms>";
    if (TIME_KEY.has(key) && value > 0) return "<t>";
    if (rules && rules.timeKey.has(key) && value > 0) return "<t>";
    if (Number.isInteger(value) && value >= EPOCH_MS_OF && value < EPOCH_MS_UNTIL) return "<t>";
    return value;
  }
  if (typeof value === "string") {
    if (key === "version" || key === "claude_code_version") return "<version>";
    return normalizeText(value, table);
  }
  return value;
}

// A string carrying JSON (history `text`, DB columns with JSON): normalised as JSON and serialised
// again, so that ids and times INSIDE it get the placeholder too. Free text comes back unchanged
// (`null`), the caller then keeps its text normalisation.
export function normalizeJsonText(s, table) {
  let json = null;
  try { json = JSON.parse(s); } catch { return null; }
  if (!json || typeof json !== "object") return null;
  return JSON.stringify(normalize(json, table));
}

// A history row (GET /api/chats/:id/log): `id` is the DB row id → <msg-N> in order; `text` often
// carries JSON (tool, meta, limit, ask …) — that is normalised as JSON and serialised again, so that
// ids and times INSIDE it get the placeholder too.
export function normalizeLogLine(row, table) {
  const out = normalize({ ...row, id: undefined }, table);
  delete out.id;
  if (typeof row.id === "number") {
    if (!table.msgIds.has(row.id)) table.msgIds.set(row.id, `<msg-${table.msgIds.size + 1}>`);
    out.id = table.msgIds.get(row.id);
  }
  if (typeof row.text === "string") {
    const json = normalizeJsonText(row.text, table);
    if (json !== null) out.text = json;
  }
  // Keys in a fixed order (id first) to keep the file readable.
  const { id, ...rest } = out;
  return { id, ...rest };
}

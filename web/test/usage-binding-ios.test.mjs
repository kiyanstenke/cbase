// The seam "provider and usage", iOS side: contract <-> app.
//
// `server/backend/electron/server/account/usage-contract.js` (a leaf without imports) carries the lists the server computes with: the
// three providers, the subpages of the usage including the jump `usage:<subpage>`, the windows per provider, the origin of an
// OpenRouter amount, the roles of the one-shot calls, the fields of every answer under `/api/usage/*` and `GET /api/openrouter`, and
// the required keys of the PUT. Server, web and iOS were built IN PARALLEL against this leaf; without this test a renamed field would
// keep running silently in the app with default values: a missing `chatsAdditional` would mean "no more chats" (the list would be
// silently shortened), a missing switch in the PUT would be a 400, a `Double` instead of `Double?` would turn "unknown" into "$0.00".
// Counterpart for the web: `web/test/usage-binding.test.mjs` (lib/api/usage.ts, executed).
//
// What is bound here: `mobile/CbaseMobile/Models/UsageModels.swift` and the views, read as TEXT (no xcrun, runs on any machine, NOT
// `onlyMacOS`):
//   (a) Every export of the contract has EXACTLY one place: mirrored as a constant in `enum UsageContract` (`MIRROR`, same value),
//       as the list of keys of a type (`FIELDS_TYPES`) or named "server only" (`ONLY_SERVER`, with a reason); a new export without
//       a row here is red.
//   (b) Per answer type: `CodingKeys` == list of the contract (in its order), an own `init(from:)` (a synthesized one would
//       require EVERY key), every key read in it; every field the contract lets be `null` (amounts, split, origin, credit) is optional
//       in Swift, otherwise "unknown" would show as 0.
//   (c) `GET /api/openrouter`: each of the three switches read as REQUIRED (`try c.decode(Bool.self, …)`; a missing one read as "off"
//       would go out as "off" with the next save). PUT: `CodingKeys` == OPENROUTER_PUT_REQUIRED + `apiKey`, an own `encode(to:)`,
//       every required key with `encode` (never `encodeIfPresent`), `apiKey` only with `encodeIfPresent`.
//   (d) The words: per subpage, window (known AND sliding), origin (+ "unknown") and role one `case`; the set equals the contract and
//       the wording equals the table both web and iOS were given (`WORD_*` below); the hint at the equivalent stands there verbatim.
//   (e) The routes: the four routes under `/api/usage/` with their query names, `/api/openrouter` with GET/PUT/DELETE, no
//       `addingPercentEncoding` (`APIClient.makeURL` encodes itself; on mobile do NOT encode before the path).
//   (f) The jump: the rings of the header open `"\(UsageContract.usagePage):\(ring.id)"`, the ring ids are subpages, `SettingsView`
//       knows `usagePage` and `workflowsPage`, the usage opens only a subpage of the contract; the page "Workflows" stands in the group
//       "Behavior" behind "Chats".
//   (g) Compared literals in the views (provider, window, subpage, arguments of `loadConsumption`) are a subset of the contract.
//   (h) Per binding a built-in sabotage on an in-memory copy; each one => deviation.
//   (i) Web <-> iOS: the same words per key in `web/src/lib/api/usage.ts`. Without that file the test says so instead of silently
//       skipping (a skipped test is red in the gate, a conditional one would be a promise without a path).
//
// Counter-tests: in UsageModels.swift `try c.encode(noDataUsage, forKey: .noDataUsage)` to `try c.encodeIfPresent(…)` => (c) red
// (required key "noDataUsage" not with encode); deleting `var chatsAdditional: Int` together with its line in the decoder => (b) red
// (does not read "chatsAdditional"); `case "second_look": return L("Second look")` changed to another wording => (d) red.
//
// Run:  node --test --test-reporter=tap web/test/usage-binding-ios.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as V from "../../server/backend/electron/server/account/usage-contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const ios = (...p) => path.join(repo, "mobile", "CbaseMobile", ...p);
const read = (p) => fs.readFileSync(p, "utf8");

// Every export of the contract has EXACTLY one place.
const MIRROR = {
  PROVIDER: "provider", SUBSCRIPTION_PROVIDER: "subscriptionProvider", OPENROUTER_ID: "openrouterId", USAGE_PAGE: "usagePage",
  USAGE_SUBPAGES: "usageSubpages", WORKFLOWS_PAGE: "workflowsPage", SUBSCRIPTION_WINDOW: "subscriptionWindow",
  OPENROUTER_WINDOW: "openrouterWindow", COST_ORIGIN: "costOrigin", ONCE_ROLES: "onceRoles",
  OPENROUTER_PUT_REQUIRED: "openrouterPutRequired",
};
const FIELDS_TYPES = {
  CONSUMPTION_FIELDS: "struct UsageConsumption:", SUMS_FIELDS: "struct UsageSums:", PARTS_FIELDS: "struct UsageParts:",
  ORIGIN_TALLY_FIELDS: "struct UsageOriginTally:", MODEL_FIELDS: "struct UsageModel:", CHAT_FIELDS: "struct UsageChat:",
  BACKGROUND_FIELDS: "struct UsageBackground:", HISTORY_FIELDS: "struct UsageHistory:", POINT_FIELDS: "struct UsagePoint:",
  CLAUDE_LIMITS_FIELDS: "struct ClaudeLimits:", LIMIT_WINDOW_FIELDS: "struct ClaudeLimitWindow:",
  CREDIT_FIELDS: "struct OpenRouterCredit:", OPENROUTER_ACCESS_FIELDS: "struct OpenRouterAccess:",
};
const ONLY_SERVER = {
  OPENROUTER_BASE: "the app never asks OpenRouter itself: credit, catalog and costs are fetched by the server (the key never leaves it)",
};

/** The fields the contract explicitly lets be `null` (amounts "USD or null", "null for OpenRouter", "otherwise null",
 *  `known: false` => "all numbers null"); optional in Swift, otherwise "unknown" would show as 0. */
const NULLABLE = {
  SUMS_FIELDS: ["equivalentUsd", "partsUsd", "costUsd", "costOrigin"],
  PARTS_FIELDS: ["input", "output", "cacheRead", "cacheWrite"],
  MODEL_FIELDS: ["equivalentUsd", "costUsd"],
  CHAT_FIELDS: ["equivalentUsd", "costUsd"],
  BACKGROUND_FIELDS: ["equivalentUsd", "costUsd"],
  POINT_FIELDS: ["equivalentUsd", "costUsd"],
  CREDIT_FIELDS: ["totalUsd", "consumedUsd", "restUsd", "keyLimitUsd", "keyRestUsd", "at"],
};

// The words: web and iOS were given the same table. The providers are proper names.
const WORD_SUBPAGE = { overview: "Overview", claude: "Claude", codex: "Codex", openrouter: "OpenRouter", limit: "At the limit" };
const WORD_WINDOW = { session: "Current window", week: "Current week", "30d": "30 days", total: "All time" };
const WORD_SLIDING = { session: "Last 5 hrs", week: "Last 7 days" };
const WORD_ORIGIN = { reported: "reported", inquired: "queried", estimated: "estimated", unknown: "unknown" };
const WORD_ROLE = {
  categorization: "Classification", extraction: "Extraction", second_look: "Second look", compaction: "Compaction", title: "Chat title",
  target: "Goal check", workflow_verdict: "Workflow verdict", adjust: "Adjust", context_categorize: "Classify context",
  project_categorize: "Classify project", project_merge: "Merge project context", project_assign: "Assign project",
  context_maintain: "Curate context", services: "Detect services", retrieval: "Summary on request", outer_loop: "Outer loop",
};
const EQUIVALENT_HINT = "Estimate at API list price — the subscription counts its quota itself.";

const FILES = {
  models: ios("Models", "UsageModels.swift"),
  settings: ios("Settings", "SettingsView.swift"),
  shell: ios("Shell", "AppShell.swift"),
  rings: ios("Models", "UsageStore.swift"),
};
const VIEWS = [
  ios("Settings", "UsageSettings.swift"), ios("Settings", "UsageOverview.swift"), ios("Settings", "UsageSubscription.swift"),
  ios("Settings", "UsageOpenRouter.swift"), ios("Settings", "ProviderSettings.swift"),
];
const iosTexts = () => ({
  ...Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, read(p)])),
  views: VIEWS.map(read),
});

// ── Helpers for Swift text (model: administration-binding.test.mjs) ─────────────────────────────────────────────────────────

/** A top-level type: from its header to the first `}` in column 0. */
function block(text, header) {
  const rows = text.split("\n");
  const start = rows.findIndex((z) => z.startsWith(header));
  if (start < 0) return null;
  const end = rows.findIndex((z, i) => i > start && z === "}");
  return end > start ? rows.slice(start, end + 1).join("\n") : null;
}

/** The keys of an `enum CodingKeys` in their order: one line or several, with raw values. */
function codingKeys(b) {
  const m = /enum CodingKeys: String, CodingKey \{([\s\S]*?)\n?\s*\}/.exec(b ?? "");
  if (!m) return null;
  const out = [];
  for (const row of m[1].split(/\n|(?=\bcase\b)/)) {
    const c = /\bcase\s+(.*)$/.exec(row.trim());
    if (!c) continue;
    for (const part of c[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const raw = /^(\w+)\s*=\s*"([^"]+)"$/.exec(t);
      out.push(raw ? raw[2] : t);
    }
  }
  return out;
}

/** The raw value of a `static let` in a block, across several lines if it starts with `[`. */
function constant(b, name) {
  const m = new RegExp(`static let ${name}(?:: [^=]+)? = `).exec(b ?? "");
  if (!m) return null;
  const rest = b.slice(m.index + m[0].length);
  if (!rest.startsWith("[")) return rest.split("\n")[0].trim();
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "[") depth++;
    if (rest[i] === "]" && --depth === 0) return rest.slice(0, i + 1);
  }
  return null;
}
const swiftList = (raw) => (raw ? [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null);

/** The body of a top-level function (`func name(`) up to the `}` in column 0. */
function fnValue(text, name) {
  const i = text.indexOf(`\nfunc ${name}(`);
  if (i < 0) return "";
  const rest = text.slice(i + 1);
  const end = rest.indexOf("\n}");
  return end > 0 ? rest.slice(0, end + 2) : "";
}

/** For each `case "x": return …` of a word function the literals behind it (an `L("…")` or a bare `"…"`, with `known ? … : …`). */
function words(fn) {
  const out = {};
  for (const m of fn.matchAll(/case "([^"]+)": return ([^\n]+)/g)) {
    out[m[1]] = [...m[2].matchAll(/(?:L\()?"([^"]+)"\)?/g)].map((x) => x[1]);
  }
  return out;
}

const set = (xs) => [...new Set(xs)].sort();

/** All deviations of the iOS side from the contract (empty = bound). `t` = texts (for the sabotage on copies). */
function iosDeviations(t, contract = V) {
  const out = [];
  const equal = (holds, desired, what) => { try { assert.deepStrictEqual(holds, desired); } catch { out.push(`${what}: iOS ${JSON.stringify(holds)}, contract ${JSON.stringify(desired)}`); } };

  // (a) Every export has its place; the mirrored ones carry the same value.
  const k = block(t.models, "enum UsageContract");
  if (!k) out.push("enum UsageContract is missing in UsageModels.swift");
  for (const name of Object.keys(contract).sort()) {
    if (Object.hasOwn(ONLY_SERVER, name) || Object.hasOwn(FIELDS_TYPES, name)) continue;
    if (!Object.hasOwn(MIRROR, name)) { out.push(`contract exports "${name}": neither mirrored in UsageContract (MIRROR), nor fields of a type (FIELDS_TYPES), nor "server only"`); continue; }
    const value = contract[name];
    const raw = constant(k, MIRROR[name]);
    if (raw == null) { out.push(`UsageContract.${MIRROR[name]} missing (contract ${name})`); continue; }
    equal(Array.isArray(value) ? swiftList(raw) : swiftList(raw)?.[0], Array.isArray(value) ? [...value] : value, `UsageContract.${MIRROR[name]} (contract ${name})`);
  }
  for (const name of [...Object.keys(MIRROR), ...Object.keys(FIELDS_TYPES), ...Object.keys(ONLY_SERVER)]) {
    if (!Object.hasOwn(contract, name)) out.push(`this test lists "${name}", which the contract does not (any more) export`);
  }

  // (b) Answer types: CodingKeys in contract order, own decoder, every key read, nullable ones optional.
  for (const [list, header] of Object.entries(FIELDS_TYPES)) {
    const fields = contract[list];
    if (!fields) continue;
    const b = block(t.models, header);
    if (!b) { out.push(`${header} is missing in UsageModels.swift (contract ${list})`); continue; }
    equal(codingKeys(b), [...fields], `${header} CodingKeys (contract ${list})`);
    if (!b.includes("init(from decoder")) { out.push(`${header}: no own init(from:); a synthesized one would require EVERY key`); continue; }
    const read = b.slice(b.indexOf("init(from decoder"));
    for (const f of fields) if (!new RegExp(`(?:\\(|forKey: )\\.${f}\\b`).test(read)) out.push(`${header} does not read "${f}"`);
    for (const f of NULLABLE[list] ?? []) {
      const type = new RegExp(`\\bvar ${f}: ([^\\n=]+)`).exec(b)?.[1]?.trim();
      if (!type) out.push(`${header}: no property "${f}"`);
      else if (!type.endsWith("?")) out.push(`${header}: "${f}" may be null according to the contract, but in Swift it is "${type}", so "unknown" would show as 0`);
    }
  }

  // (c) The access: GET reads every switch as required; PUT always sends every required key, the API key only if set.
  const access = block(t.models, "struct OpenRouterAccess:") ?? "";
  for (const f of contract.OPENROUTER_ACCESS_FIELDS) {
    if (!new RegExp(`try c\\.decode\\(Bool\\.self, forKey: \\.${f}\\)`).test(access)) out.push(`OpenRouterAccess does not read "${f}" as required (try c.decode(Bool.self, …)); a missing switch would mean "off"`);
  }
  const body = block(t.models, "struct OpenRouterAccessBody:");
  if (!body) out.push("struct OpenRouterAccessBody is missing in UsageModels.swift");
  else {
    equal(set(codingKeys(body) ?? []), set([...contract.OPENROUTER_PUT_REQUIRED, "apiKey"]), "OpenRouterAccessBody CodingKeys (PUT_REQUIRED + apiKey)");
    if (!body.includes("func encode(to encoder")) out.push("OpenRouterAccessBody: no own encode(to:)");
    const encode = body.slice(Math.max(0, body.indexOf("func encode(to encoder")));
    for (const f of contract.OPENROUTER_PUT_REQUIRED) {
      if (!new RegExp(`try c\\.encode\\(${f}, forKey: \\.${f}\\)`).test(encode)) out.push(`OpenRouterAccessBody: required key "${f}" not with encode; a missing one is a 400 at the server`);
      const type = new RegExp(`\\blet ${f}: ([^\\n=]+)`).exec(body)?.[1]?.trim();
      if (type !== "Bool") out.push(`OpenRouterAccessBody: "${f}" is "${type ?? "-"}", not Bool; a required switch has no "unchanged"`);
    }
    if (!/try c\.encodeIfPresent\(apiKey, forKey: \.apiKey\)/.test(encode)) out.push("OpenRouterAccessBody: `apiKey` not with encodeIfPresent; if it is missing, the stored one stays; empty would be a 400");
  }

  // (d) The words.
  const checkWords = (fn, desired, what, { sliding } = {}) => {
    const w = words(fnValue(t.models, fn));
    if (!Object.keys(w).length) { out.push(`${fn} is missing or has no cases; this test reads the literals there`); return; }
    equal(set(Object.keys(w)), set(Object.keys(desired)), `${fn}: cases`);
    for (const [key, word] of Object.entries(desired)) {
      const holds = w[key];
      if (!holds) continue;
      if (holds[0] !== word) out.push(`${fn}("${key}") says "${holds[0]}", the shared table "${word}" (${what})`);
      if (sliding && Object.hasOwn(sliding, key) && holds[1] !== sliding[key]) {
        out.push(`${fn}("${key}", known: false) says "${holds[1] ?? "-"}", the shared table "${sliding[key]}"`);
      }
    }
  };
  // The tables only apply as far as the contract knows the keys; a new key in the contract shows up as a missing case.
  const only = (table, key) => Object.fromEntries(key.map((s) => [s, table[s] ?? `(no word for "${s}")`]));
  checkWords("usageSubpageWord", only(WORD_SUBPAGE, contract.USAGE_SUBPAGES), "subpage");
  checkWords("usageWindowWord", only(WORD_WINDOW, set([...contract.SUBSCRIPTION_WINDOW, ...contract.OPENROUTER_WINDOW])), "window", { sliding: WORD_SLIDING });
  checkWords("usageOriginWord", only(WORD_ORIGIN, [...contract.COST_ORIGIN, "unknown"]), "origin");
  checkWords("usageRoleWord", only(WORD_ROLE, contract.ONCE_ROLES), "role");
  if (!t.views.some((a) => a.includes(`L("${EQUIVALENT_HINT}")`))) out.push(`the hint at the equivalent ("${EQUIVALENT_HINT}") is in no view`);

  // (e) The routes: paths unencoded, query names as the route reads them.
  const ways = [
    ["/api/usage/consumption", ["provider", "window"]], ["/api/usage/history", ["provider", "days", "offsetMin"]],
    ["/api/usage/claude-limits", []], ["/api/usage/openrouter-credit", []],
  ];
  for (const [filePath, names] of ways) {
    const i = t.models.indexOf(`"${filePath}"`);
    if (i < 0) { out.push(`route ${filePath} is missing in the APIClient`); continue; }
    const call = t.models.slice(i, t.models.indexOf("}", i));
    for (const n of names) if (!call.includes(`URLQueryItem(name: "${n}"`)) out.push(`route ${filePath}: query "${n}" is missing`);
  }
  for (const kind of ["get(\"/api/openrouter\"", "send(\"/api/openrouter\", method: .put", "send(\"/api/openrouter\", method: .delete"]) {
    if (!t.models.includes(kind)) out.push(`/api/openrouter: "${kind}…" is missing in the APIClient`);
  }
  if (/addingPercentEncoding/.test(t.models)) out.push("UsageModels.swift encodes beforehand (addingPercentEncoding); makeURL encodes itself, otherwise %25");

  // (f) The jump.
  if (!t.shell.includes('openSettings("\\(UsageContract.usagePage):\\(ring.id)")')) out.push("the rings of the header do not open \"<USAGE_PAGE>:<provider>\" (AppShell.swift, UsageRingsBar)");
  const ringIds = set([...t.rings.matchAll(/Ring\(\s*id: "([^"]+)"/g)].map((m) => m[1]));
  if (!ringIds.length) out.push("no ring id found in UsageStore.swift: does the test still read the right file?");
  for (const id of ringIds) if (!contract.USAGE_SUBPAGES.includes(id)) out.push(`the ring "${id}" jumps to a subpage the contract does not know`);
  for (const k2 of ["UsageContract.usagePage", "UsageContract.workflowsPage"]) if (!t.settings.includes(k2)) out.push(`SettingsView does not know ${k2} as a jump target`);
  if (!/UsageContract\.usageSubpages\.contains\(start\)/.test(t.views.join("\n"))) out.push("the usage opens a subpage on the jump without checking it against the contract");
  if (!/ForEach\(UsageContract\.usageSubpages/.test(t.views.join("\n"))) out.push("the list of the usage does not enumerate its subpages from the contract");
  const behavior = t.settings.indexOf('CbSettingGroup(title: L("Behavior"))');
  const chats = t.settings.indexOf("ChatSettingsView()", behavior);
  const wf = t.settings.indexOf("WorkflowsSettingsView()", behavior);
  const afterwards = t.settings.indexOf("CbSettingGroup(title:", behavior + 1);
  if (!(behavior > 0 && chats > behavior && wf > chats && (afterwards < 0 || wf < afterwards))) out.push("the page \"Workflows\" is not in the group \"Behavior\" behind \"Chats\"");

  // (g) Compared literals are a subset of the contract.
  const all = t.views.join("\n");
  const windowAll = set([...contract.SUBSCRIPTION_WINDOW, ...contract.OPENROUTER_WINDOW]);
  for (const m of all.matchAll(/\b(provider|id|page|window)\s*(?:==|!=)\s*"([^"]+)"/g)) {
    const [, what, value] = m;
    const allowed = what === "window" ? windowAll : what === "page" ? [...contract.USAGE_SUBPAGES] : what === "id" ? [...contract.PROVIDER] : [...contract.PROVIDER];
    if (!allowed.includes(value)) out.push(`iOS compares ${what} with "${value}", which the contract does not know`);
  }
  for (const m of all.matchAll(/loadConsumption\(provider: (?:"([^"]+)"|UsageContract\.(\w+)), window: "([^"]+)"\)/g)) {
    const provider = m[1] ?? (m[2] === "openrouterId" ? contract.OPENROUTER_ID : null);
    if (!contract.PROVIDER.includes(provider)) { out.push(`loadConsumption with the provider "${m[1] ?? m[2]}", which the contract does not know`); continue; }
    const window = provider === contract.OPENROUTER_ID ? contract.OPENROUTER_WINDOW : contract.SUBSCRIPTION_WINDOW;
    if (!window.includes(m[3])) out.push(`loadConsumption(${provider}) with the window "${m[3]}", which the provider does not know (400)`);
  }
  for (const m of all.matchAll(/@State private var window = "([^"]+)"/g)) if (!windowAll.includes(m[1])) out.push(`a window starts on "${m[1]}", which the contract does not know`);
  const turnout = /struct UsageSubpage: View \{[\s\S]*?\n\}/.exec(all)?.[0] ?? "";
  const cases = [...turnout.matchAll(/case ([^:]+):/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  if (!cases.length) out.push("the switch UsageSubpage is missing or has no cases");
  for (const f of cases) if (!contract.USAGE_SUBPAGES.includes(f)) out.push(`the switch UsageSubpage knows "${f}", which is no subpage`);
  // Exactly ONE subpage falls into the `default:`; more would mean a subpage of the contract has no case of its own.
  equal(contract.USAGE_SUBPAGES.filter((s) => !cases.includes(s)).length, 1, "UsageSubpage: subpages without a case of their own (one may be the default:)");
  return out;
}

test("iOS: UsageModels.swift and the views mirror usage-contract.js: constants, CodingKeys, decoder, PUT body, words, routes, jump", () => {
  const out = iosDeviations(iosTexts());
  assert.deepEqual(out, [], `iOS != usage-contract.js:\n${out.join("\n")}`);
});

test("iOS, counter-test: encodeIfPresent, a renamed key, an unread one, a non-optional amount, a foreign word, a new export and a wrong jump are detected", () => {
  const t = iosTexts();
  const replace = (field, old, fresh) => {
    assert.ok(t[field].includes(old), `"${old}" no longer reads like this in ${field}: update the sabotage`);
    return { ...t, [field]: t[field].replace(old, fresh) };
  };
  const contains = (a, part) => assert.ok(a.some((z) => z.includes(part)), `"${part}" went unnoticed:\n${a.join("\n")}`);

  contains(iosDeviations(replace("models", "try c.encode(noDataUsage, forKey: .noDataUsage)", "try c.encodeIfPresent(noDataUsage, forKey: .noDataUsage)")),
    "required key \"noDataUsage\" not with encode");
  contains(iosDeviations(replace("models", "case chatId, title, deleted,", "case chatId, heading, removed,")), "struct UsageChat: CodingKeys");
  contains(iosDeviations(replace("models", "        chatsAdditional = c.int(.chatsAdditional)\n", "")), "does not read \"chatsAdditional\"");
  contains(iosDeviations(replace("models", "    var restUsd: Double?\n", "    var restUsd: Double\n")), "\"restUsd\" may be null according to the contract");
  contains(iosDeviations(replace("models", "onlyWithoutSaving = try c.decode(Bool.self, forKey: .onlyWithoutSaving)", "onlyWithoutSaving = c.bool(.onlyWithoutSaving)")),
    "OpenRouterAccess does not read \"onlyWithoutSaving\" as required");
  contains(iosDeviations(replace("models", 'case "second_look": return L("Second look")', 'case "second_look": return L("Second glance")')), "usageRoleWord(\"second_look\") says \"Second glance\"");
  contains(iosDeviations(replace("models", 'return known ? L("Current window") : L("Last 5 hrs")', 'return L("Current window")')),
    "usageWindowWord(\"session\", known: false)");
  contains(iosDeviations(replace("models", '"/api/usage/history", query: [', '"/api/usage/history".addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)!, query: [')), "encodes beforehand");
  contains(iosDeviations(replace("shell", 'openSettings("\\(UsageContract.usagePage):\\(ring.id)")', 'openSettings("usage:\\(ring.id)")')),
    "the rings of the header do not open");
  contains(iosDeviations({ ...t, views: [...t.views, 'if v.window == "day" {}'] }), "iOS compares window with \"day\"");
  contains(iosDeviations({ ...t, views: [...t.views, 'let x = try? await client.loadConsumption(provider: "codex", window: "total")'] }),
    "loadConsumption(codex) with the window \"total\"");

  const foreign = { ...V, ONCE_ROLES: [...V.ONCE_ROLES, "new_role"], NEW_FIELDS: ["x"] };
  const a = iosDeviations(t, foreign);
  contains(a, "UsageContract.onceRoles (contract ONCE_ROLES)");
  contains(a, "usageRoleWord: cases");
  contains(a, "contract exports \"NEW_FIELDS\"");
});

// ── (i) Web <-> iOS: the same words ──────────────────────────────────────────────────────────────────────────────────────────

const WEB_USAGE = path.join(repo, "web", "src", "lib", "api", "usage.ts");

/** For each word of the iOS tables: is it in the web under the SAME key (`key: "word"` or `"30d": "word"`)? */
function webDeviations(web, tables) {
  const out = [];
  for (const [what, table] of tables) {
    for (const [key, word] of Object.entries(table)) {
      const s = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const w = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`(?:^|[\\s{,])"?${s}"?\\s*:\\s*"${w}"`, "m").test(web)) out.push(`${what} "${key}": iOS "${word}", not found in the web under this key`);
    }
  }
  if (!web.includes(`"${EQUIVALENT_HINT}"`)) out.push(`the hint at the equivalent is not verbatim in the web ("${EQUIVALENT_HINT}")`);
  return out;
}

/** The words as iOS REALLY carries them (read from UsageModels.swift, not from the tables above). */
function iosWords(models) {
  const w = (fn) => words(fnValue(models, fn));
  const window = w("usageWindowWord");
  return [
    ["subpage", Object.fromEntries(Object.entries(w("usageSubpageWord")).map(([k, v]) => [k, v[0]]))],
    ["window", Object.fromEntries(Object.entries(window).map(([k, v]) => [k, v[0]]))],
    ["window sliding", Object.fromEntries(Object.entries(window).filter(([, v]) => v.length > 1).map(([k, v]) => [k, v[1]]))],
    ["origin", Object.fromEntries(Object.entries(w("usageOriginWord")).map(([k, v]) => [k, v[0]]))],
    ["role", Object.fromEntries(Object.entries(w("usageRoleWord")).map(([k, v]) => [k, v[0]]))],
  ];
}

test("Web <-> iOS: the same word per subpage, window, origin and role (lib/api/usage.ts)", () => {
  assert.ok(fs.existsSync(WEB_USAGE), `${path.relative(repo, WEB_USAGE)} is missing (this test binds BOTH sides)`);
  const out = webDeviations(read(WEB_USAGE), iosWords(read(FILES.models)));
  assert.deepEqual(out, [], `web != iOS:\n${out.join("\n")}`);
});

test("Web <-> iOS, counter-test: a different word in the web or a missing hint are detected", () => {
  const ios = iosWords(read(FILES.models));
  // A web version that carries EXACTLY the iOS words, and the same with one deviation each.
  const rows = ios.flatMap(([, tab]) => Object.entries(tab).map(([k, v]) => `  ${/^\w+$/.test(k) ? k : JSON.stringify(k)}: ${JSON.stringify(v)},`));
  const matching = `export const T = {\n${rows.join("\n")}\n};\nexport const H = "${EQUIVALENT_HINT}";\n`;
  assert.deepEqual(webDeviations(matching, ios), [], "the counter-test itself is off: a matching web version reports deviations");
  const different = matching.replace('second_look: "Second look"', 'second_look: "Second glance"');
  assert.notEqual(different, matching, "sabotage did not take");
  assert.ok(webDeviations(different, ios).some((z) => z.startsWith("role \"second_look\"")), "a different role word in the web went unnoticed");
  assert.ok(webDeviations(matching.replace(EQUIVALENT_HINT, "Estimate."), ios).some((z) => z.includes("hint at the equivalent")), "the missing hint went unnoticed");
});

// Binds the "provider and usage" seam: server and web share ONE sheet.
//
// `server/backend/electron/server/account/usage-contract.js` (a sheet without imports) holds the lists the server computes with: the
// three providers, the subpages of Settings → Usage with the jump `usage:<subpage>`, the windows per provider, the origin of an
// OpenRouter amount, the roles of one-shot calls, the fields of every answer under `/api/usage/*` and of `GET /api/openrouter`,
// and the required keys of the PUT. Server, web and iOS were built IN PARALLEL against this sheet — without this test a renamed
// field would keep showing as "—" in the web (`norm*` turns a missing field into `null`, never an error), and a PUT that left out
// a switched-off toggle would be a 400 at the server ("a missing field is not a statement").
// The iOS page of the same seam is held by `web/test/usage-binding-ios.test.mjs`.
//
// What is bound here:
//   (a) Web, EXECUTED: `web/src/lib/api/usage.ts` (compiled without tsconfig, like administration-binding.test.mjs) plus `i18n-de.ts`.
//       EVERY export of the contract is mirrored (`MIRROR`, same value) or named "server only" (`ONLY_SERVER`) — a new export
//       without a line here is red. The normalizers get an object made of EXACTLY the contract's fields (nested: sums, partsUsd,
//       costOrigin, models, chats, background, points, window) and return every field with its value, in contract order; every
//       provider with each of ITS windows and every role survives normalization, a foreign window becomes `null`. Empty is not
//       unknown: without an answer no number is 0 and nothing is "complete". The routes (fetch intercepted): paths and queries of
//       the four usage routes and of `/api/openrouter`; the PUT body ALWAYS carries both required toggles (even `false`) and
//       `apiKey` only trimmed and non-empty. The labels per subpage, window, origin and role are tables over exactly the
//       contract's lists, with exactly the words below (`WORDS` — iOS builds the same), and every word is in i18n-de.
//   (b) Web, as TEXT: the pages use the lists — SettingsModal lists `usage` (with subpage) and `workflows` (group "Behavior"
//       after "Chats"), UsageSettings draws one entry per contract subpage, the header rings jump via `usageJump`, the window
//       bars take their provider's list, the roles go through `roleLabel`, no view writes a route under `/api/usage/` or
//       `/api/openrouter` itself, and "At the limit" carries the wording the spec fixes for BOTH clients ("Do not start a new
//       turn above {pct}%").
//   (c) Each binding has a built-in sabotage on an in-memory copy — each one ⇒ deviation.
//
// Counter-tests: in lib/api/usage.ts let `openRouterBody` send the second required toggle only when it is on (`tsc --noEmit`
// stays GREEN) ⇒ (a) red ("PUT body /api/openrouter (both off)" and "(with key)"); in TopNav.tsx replace
// `openSettings(usageJump(provider))` by `openSettings("usage")` ⇒ (b) red ("the header rings do not jump via usageJump").
// A field removed from SUMS_FIELDS (lib/api/usage.ts) additionally turns tsc red (`USAGE_TYPES_BOUND`).

// Run:  node --test --test-reporter=tap web/test/usage-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as V from "../../server/backend/electron/server/account/usage-contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = (...p) => path.join(webDir, "src", ...p);
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (p) => fs.readFileSync(p, "utf8");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

// Every export of the contract has EXACTLY one place: mirrored in the web (name there) or named "server only" (with reason).
const MIRROR = {
  PROVIDER: "PROVIDER", SUBSCRIPTION_PROVIDER: "SUBSCRIPTION_PROVIDER", OPENROUTER_ID: "OPENROUTER_ID",
  USAGE_PAGE: "USAGE_PAGE", USAGE_SUBPAGES: "USAGE_SUBPAGES", WORKFLOWS_PAGE: "WORKFLOWS_PAGE",
  SUBSCRIPTION_WINDOW: "SUBSCRIPTION_WINDOW", OPENROUTER_WINDOW: "OPENROUTER_WINDOW", COST_ORIGIN: "COST_ORIGIN", ONCE_ROLES: "ONCE_ROLES",
  // The web calls this list differently: `CONSUMPTION_FIELDS` is already taken in the facade lib/api.ts (administration.ts, a
  // user container's consumption) — two `export *` with the same name would be ambiguous.
  CONSUMPTION_FIELDS: "USAGE_CONSUMPTION_FIELDS",
  SUMS_FIELDS: "SUMS_FIELDS", PARTS_FIELDS: "PARTS_FIELDS", ORIGIN_TALLY_FIELDS: "ORIGIN_TALLY_FIELDS",
  MODEL_FIELDS: "MODEL_FIELDS", CHAT_FIELDS: "CHAT_FIELDS", BACKGROUND_FIELDS: "BACKGROUND_FIELDS",
  HISTORY_FIELDS: "HISTORY_FIELDS", POINT_FIELDS: "POINT_FIELDS", CLAUDE_LIMITS_FIELDS: "CLAUDE_LIMITS_FIELDS",
  LIMIT_WINDOW_FIELDS: "LIMIT_WINDOW_FIELDS", CREDIT_FIELDS: "CREDIT_FIELDS",
  OPENROUTER_ACCESS_FIELDS: "OPENROUTER_ACCESS_FIELDS", OPENROUTER_PUT_REQUIRED: "OPENROUTER_PUT_REQUIRED",
};
const ONLY_SERVER = {
  OPENROUTER_BASE: "the clients only talk to /api/openrouter and /api/usage/* — only the server knows OpenRouter's base (test seam CBASE_OPENROUTER_BASE)",
};

// The UI words — iOS builds the SAME ones. A change here is a change in both clients; usage-binding-ios.test.mjs holds the iOS page.
const WORDS = {
  subpage: { overview: "Overview", claude: "Claude", codex: "Codex", openrouter: "OpenRouter", limit: "At the limit" },
  window: { session: "Current window", week: "Current week", "30d": "30 days", total: "All time" },
  // Without a snapshot `session`/`week` slide over the same length (contract: `windowKnown: false`).
  sliding: { session: "Last 5 hrs", week: "Last 7 days" },
  origin: { reported: "reported", inquired: "queried", estimated: "estimated", unknown: "unknown" },
  role: {
    categorization: "Classification", extraction: "Extraction", second_look: "Second look", compaction: "Compaction", title: "Chat title",
    target: "Goal check", workflow_verdict: "Workflow verdict", adjust: "Adjust", context_categorize: "Classify context",
    project_categorize: "Classify project", project_merge: "Merge project context", project_assign: "Assign project",
    context_maintain: "Curate context", services: "Detect services", retrieval: "Summary on request", outer_loop: "Outer loop",
  },
  equivalent: "Estimate at API list price — the subscription counts its quota itself.",
  // If web and iOS differ, the web wording wins.
  gate: "Do not start a new turn above {pct}%",
};

// ── (a) Web, executed ──────────────────────────────────────────────────────────────────────────

let web = null;
async function loadWeb() {
  if (web) return web;
  assert.ok(fs.existsSync(tsc), "web/node_modules is missing (tsc) — the binding cannot be checked without the compiler");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-usage-binding-"));
  execFileSync(process.execPath, [
    tsc, src("lib", "api", "usage.ts"), src("lib", "i18n-de.ts"),
    "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
    "--skipLibCheck", "--lib", "es2022,dom",
  ], { cwd: webDir, stdio: "pipe" });
  web = {
    ...(await import(pathToFileURL(path.join(tmp, "api", "usage.js")).href)),
    DE: (await import(pathToFileURL(path.join(tmp, "i18n-de.js")).href)).DE,
  };
  return web;
}

/** A version of lib/api/usage.ts with changed source — compiled next to the real one (same `./core.js` imports). */
async function loadWebSabotaged(change) {
  const real = await loadWeb();
  const ts = createRequire(path.join(webDir, "package.json"))("typescript");
  const source = change(read(src("lib", "api", "usage.ts")));
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  const file = path.join(tmp, "api", `usage-sabotage-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, js);
  return { ...real, ...(await import(pathToFileURL(file).href)) };
}

/** Example values per field — none is the normalizer's default (false, null, "", 0), else a lost field would look right. */
const TOKENS = { input: 1200, output: 340, cacheRead: 56000, cacheWrite: 7800 };
const EXAMPLE = {
  parts: { input: 0.0036, output: 0.0255, cacheRead: 0.0168, cacheWrite: 0.0468 },
  origin: { reported: 7, inquired: 3, estimated: 2, unknown: 1 },
  model: { model: "claude-opus-5-5", ...TOKENS, cacheUnsplit: 900, runs: 4, equivalentUsd: 0.0927, costUsd: 0.31, priceKnown: true },
  chat: { chatId: "c-1", title: "Usage rework", deleted: true, ...TOKENS, runs: 3, equivalentUsd: 0.05, costUsd: 0.12 },
  background: { ...TOKENS, runs: 9, equivalentUsd: 0.04, costUsd: 0.02 },
  point: { day: "2026-10-14", ...TOKENS, equivalentUsd: 1.25, costUsd: 0.5 },
  limit: { id: "weekly_opus", group: "weekly", area: "Opus", percent: 42, resetsAt: 1792000000000 },
  credit: { known: true, totalUsd: 25, consumedUsd: 10.5, restUsd: 14.5, keyLimitUsd: 20, keyRestUsd: 9.5, at: 1792001000000 },
  access: { keySet: true, onlyWithoutSaving: true, noDataUsage: false },
};
const fromFields = (fields, example, location) => Object.fromEntries(fields.map((f) => {
  assert.ok(Object.hasOwn(example, f), `the contract names "${f}" (${location}), this test has no example value for it — add one`);
  return [f, example[f]];
}));

/** An answer of GET /api/usage/consumption made of EXACTLY the contract's fields. */
function consumptionRaw(contract, provider, window) {
  const sums = fromFields(contract.SUMS_FIELDS, {
    ...TOKENS, cacheUnsplit: 900, runs: 12, equivalentUsd: 0.0927, equivalentComplete: true,
    partsUsd: fromFields(contract.PARTS_FIELDS, EXAMPLE.parts, "PARTS_FIELDS"), costUsd: 0.31,
    costOrigin: fromFields(contract.ORIGIN_TALLY_FIELDS, EXAMPLE.origin, "ORIGIN_TALLY_FIELDS"),
  }, "SUMS_FIELDS");
  return fromFields(contract.CONSUMPTION_FIELDS, {
    provider, window, from: 1791990000000, until: 1792008000000, windowKnown: true, sums,
    models: [fromFields(contract.MODEL_FIELDS, EXAMPLE.model, "MODEL_FIELDS")],
    chats: [fromFields(contract.CHAT_FIELDS, EXAMPLE.chat, "CHAT_FIELDS")],
    chatsAdditional: 4,
    background: contract.ONCE_ROLES.map((role) => fromFields(contract.BACKGROUND_FIELDS, { role, ...EXAMPLE.background }, "BACKGROUND_FIELDS")),
    subagentsShare: 0.25,
  }, "CONSUMPTION_FIELDS");
}

/** All deviations of the web side from the contract (empty = bound). */
async function webDeviations(m, contract = V) {
  const deviations = [];
  const equal = (holds, desired, what) => { try { assert.deepStrictEqual(holds, desired); } catch { deviations.push(`${what}: web ${JSON.stringify(holds)}, contract ${JSON.stringify(desired)}`); } };
  const raw = (x) => (Array.isArray(x) ? [...x] : x && typeof x === "object" ? { ...x } : x);
  const windowOf = (a) => (a === contract.OPENROUTER_ID ? contract.OPENROUTER_WINDOW : contract.SUBSCRIPTION_WINDOW);

  // Every export has its place, and the mirrored ones carry the same value.
  for (const name of Object.keys(contract).sort()) {
    if (Object.hasOwn(ONLY_SERVER, name)) continue;
    if (!Object.hasOwn(MIRROR, name)) { deviations.push(`contract exports "${name}" — neither mirrored in the web (MIRROR) nor named "server only"`); continue; }
    equal(raw(m[MIRROR[name]]), raw(contract[name]), `${name} (Web ${MIRROR[name]})`);
  }
  for (const name of [...Object.keys(MIRROR), ...Object.keys(ONLY_SERVER)]) {
    if (!Object.hasOwn(contract, name)) deviations.push(`this test lists "${name}", which the contract does not (any longer) export`);
  }
  equal([...contract.ORIGIN_TALLY_FIELDS], [...contract.COST_ORIGIN, "unknown"], "ORIGIN_TALLY_FIELDS = COST_ORIGIN + unknown");

  // Consumption: every field comes back, in contract order — for each provider with each of ITS windows.
  for (const provider of contract.PROVIDER) {
    for (const window of windowOf(provider)) {
      const r = consumptionRaw(contract, provider, window);
      const n = m.normUsageConsumption(r);
      const location = `normUsageConsumption(${provider}, ${window})`;
      equal(Object.keys(n), [...contract.CONSUMPTION_FIELDS], `${location}: keys`);
      equal(n?.sums && Object.keys(n.sums), [...contract.SUMS_FIELDS], `${location}.sums: keys`);
      equal(n?.sums?.partsUsd && Object.keys(n.sums.partsUsd), [...contract.PARTS_FIELDS], `${location}.sums.partsUsd: keys`);
      equal(n?.sums?.costOrigin && Object.keys(n.sums.costOrigin), [...contract.ORIGIN_TALLY_FIELDS], `${location}.sums.costOrigin: keys`);
      equal(n?.models?.[0] && Object.keys(n.models[0]), [...contract.MODEL_FIELDS], `${location}.models[]: keys`);
      equal(n?.chats?.[0] && Object.keys(n.chats[0]), [...contract.CHAT_FIELDS], `${location}.chats[]: keys`);
      equal(n?.background?.[0] && Object.keys(n.background[0]), [...contract.BACKGROUND_FIELDS], `${location}.background[]: keys`);
      equal(n, r, `${location}: values`);
    }
  }
  // A window the provider does not know is as unknown as a foreign provider.
  for (const provider of contract.PROVIDER) {
    for (const foreign of [...contract.SUBSCRIPTION_WINDOW, ...contract.OPENROUTER_WINDOW].filter((f) => !windowOf(provider).includes(f))) {
      equal(m.normUsageConsumption(consumptionRaw(contract, provider, foreign)).window, null, `window "${foreign}" at ${provider} ⇒ null`);
    }
  }
  equal(m.normUsageConsumption(consumptionRaw(contract, "nebius", "30d")).provider, null, "foreign provider ⇒ null");
  // Empty is not unknown: without an answer no number, nothing complete, the window not "known".
  const empty = m.normUsageConsumption({});
  equal([empty.sums, empty.windowKnown, empty.chatsAdditional, empty.subagentsShare], [null, false, null, null], "empty answer ⇒ nothing claimed");
  const without = m.normUsageConsumption({ sums: {} }).sums;
  equal([without?.input, without?.equivalentUsd, without?.equivalentComplete, without?.costUsd], [null, null, false, null], "empty sums ⇒ null instead of 0, not complete");

  // History, Claude limits, credit, access.
  const history = fromFields(contract.HISTORY_FIELDS, { provider: "codex", days: 30, offsetMin: 120, points: [fromFields(contract.POINT_FIELDS, EXAMPLE.point, "POINT_FIELDS")] }, "HISTORY_FIELDS");
  const nv = m.normHistory(history);
  equal(Object.keys(nv), [...contract.HISTORY_FIELDS], "normHistory: keys");
  equal(nv.points[0] && Object.keys(nv.points[0]), [...contract.POINT_FIELDS], "normHistory.points[]: keys");
  equal(nv, history, "normHistory: values");
  const limits = fromFields(contract.CLAUDE_LIMITS_FIELDS, { measuredAt: 1792000500000, window: [fromFields(contract.LIMIT_WINDOW_FIELDS, EXAMPLE.limit, "LIMIT_WINDOW_FIELDS")] }, "CLAUDE_LIMITS_FIELDS");
  const nl = m.normClaudeLimits(limits);
  equal(Object.keys(nl), [...contract.CLAUDE_LIMITS_FIELDS], "normClaudeLimits: keys");
  equal(nl.window[0] && Object.keys(nl.window[0]), [...contract.LIMIT_WINDOW_FIELDS], "normClaudeLimits.window[]: keys");
  equal(nl, limits, "normClaudeLimits: values");
  const credit = fromFields(contract.CREDIT_FIELDS, EXAMPLE.credit, "CREDIT_FIELDS");
  const ng = m.normOpenRouterCredit(credit);
  equal(Object.keys(ng), [...contract.CREDIT_FIELDS], "normOpenRouterCredit: keys");
  equal(ng, credit, "normOpenRouterCredit: values");
  const unknown = m.normOpenRouterCredit({ ...credit, known: false });
  equal(contract.CREDIT_FIELDS.filter((f) => f.endsWith("Usd")).map((f) => unknown[f]), contract.CREDIT_FIELDS.filter((f) => f.endsWith("Usd")).map(() => null), "known: false ⇒ no number (never 0)");
  const access = fromFields(contract.OPENROUTER_ACCESS_FIELDS, EXAMPLE.access, "OPENROUTER_ACCESS_FIELDS");
  const nz = m.normOpenRouterAccess(access);
  equal(Object.keys(nz), [...contract.OPENROUTER_ACCESS_FIELDS], "normOpenRouterAccess: keys");
  equal(nz, access, "normOpenRouterAccess: values");
  equal(Object.values(m.normOpenRouterAccess({})), contract.OPENROUTER_ACCESS_FIELDS.map(() => null), "missing toggle ⇒ null (neither on nor off)");

  // The routes as they go out (fetch intercepted).
  const sent = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ url: String(url), method: opts?.method ?? "GET", body: opts?.body ? JSON.parse(opts.body) : null });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await m.loadConsumption(contract.SUBSCRIPTION_PROVIDER[0], contract.SUBSCRIPTION_WINDOW[0]);
    await m.loadHistory(contract.SUBSCRIPTION_PROVIDER[1], 30, 120);
    await m.loadClaudeLimits();
    await m.loadOpenRouterCredit();
    await m.loadOpenRouterAccess();
    await m.setOpenRouterAccess({ onlyWithoutSaving: false, noDataUsage: false });
    await m.setOpenRouterAccess({ onlyWithoutSaving: true, noDataUsage: false }, "  sk-or-v1-abc  ");
    await m.setOpenRouterAccess({ onlyWithoutSaving: false, noDataUsage: true }, "   ");
    await m.removeOpenRouterKey();
  } catch (e) {
    deviations.push(`a route threw: ${e?.message || e}`);
  } finally { globalThis.fetch = old; }
  const [consumption, historyWay, claude, gh, accessWay, putFrom, putKey, putEmpty, del] = sent;
  equal(consumption && `${consumption.method} ${consumption.url}`, `GET /api/usage/consumption?provider=${contract.SUBSCRIPTION_PROVIDER[0]}&window=${contract.SUBSCRIPTION_WINDOW[0]}`, "route GET /api/usage/consumption");
  equal(historyWay && `${historyWay.method} ${historyWay.url}`, `GET /api/usage/history?provider=${contract.SUBSCRIPTION_PROVIDER[1]}&days=30&offsetMin=120`, "route GET /api/usage/history");
  equal(claude && `${claude.method} ${claude.url}`, "GET /api/usage/claude-limits", "route GET /api/usage/claude-limits");
  equal(gh && `${gh.method} ${gh.url}`, "GET /api/usage/openrouter-credit", "route GET /api/usage/openrouter-credit");
  equal(accessWay && `${accessWay.method} ${accessWay.url}`, "GET /api/openrouter", "route GET /api/openrouter");
  equal(putFrom && `${putFrom.method} ${putFrom.url}`, "PUT /api/openrouter", "route PUT /api/openrouter");
  equal(putFrom?.body, Object.fromEntries(contract.OPENROUTER_PUT_REQUIRED.map((f) => [f, false])), "PUT body /api/openrouter (both off)");
  equal(putKey && Object.keys(putKey.body ?? {}), [...contract.OPENROUTER_PUT_REQUIRED, "apiKey"], "PUT body /api/openrouter (with key): keys");
  equal(putKey?.body?.apiKey, "sk-or-v1-abc", "PUT body /api/openrouter: the key trimmed");
  equal(putEmpty && Object.keys(putEmpty.body ?? {}), [...contract.OPENROUTER_PUT_REQUIRED], "PUT body /api/openrouter (empty key): no apiKey — empty would be a 400");
  equal(del && `${del.method} ${del.url}`, "DELETE /api/openrouter", "route DELETE /api/openrouter");
  const off = m.offsetMinNow();
  if (!(Number.isInteger(off) && off >= -840 && off <= 840)) deviations.push(`offsetMinNow() = ${off} — the server only takes −840…840`);

  // The jump into a subpage and the windows per provider.
  for (const u of contract.USAGE_SUBPAGES) {
    equal(m.usageJump(u), `${contract.USAGE_PAGE}:${u}`, `usageJump(${u})`);
    equal(m.isSubpage(u), true, `isSubpage(${u})`);
  }
  equal(m.isSubpage("prices"), false, "isSubpage(foreign)");
  for (const a of contract.PROVIDER) equal([...m.windowOf(a)], [...windowOf(a)], `windowOf(${a})`);

  // The labels: tables over exactly the contract's lists, with exactly the words (the same on iOS), each in i18n-de.
  const table = (holds, key, words, what) => {
    equal(Object.keys(holds ?? {}), [...key], `${what}: keys`);
    for (const k of key) {
      if (!Object.hasOwn(words, k)) { deviations.push(`${what}: no word for "${k}" in WORDS — new in the contract? Label web AND iOS, enter it here`); continue; }
      equal(holds?.[k], words[k], `${what} "${k}"`);
      if (typeof holds?.[k] === "string" && typeof m.DE[holds[k]] !== "string") deviations.push(`${what} "${k}": "${holds[k]}" is not in i18n-de.ts`);
    }
  };
  table(m.SUBPAGE_LABEL, contract.USAGE_SUBPAGES, WORDS.subpage, "SUBPAGE_LABEL");
  table(m.WINDOW_LABEL, [...new Set([...contract.SUBSCRIPTION_WINDOW, ...contract.OPENROUTER_WINDOW])], WORDS.window, "WINDOW_LABEL");
  table(m.WINDOW_SLIDING_LABEL, contract.SUBSCRIPTION_WINDOW.filter((f) => f !== "30d"), WORDS.sliding, "WINDOW_SLIDING_LABEL");
  table(m.ORIGIN_LABEL, contract.ORIGIN_TALLY_FIELDS, WORDS.origin, "ORIGIN_LABEL");
  table(m.ONCE_ROLES_LABEL, contract.ONCE_ROLES, WORDS.role, "ONCE_ROLES_LABEL");
  for (const role of contract.ONCE_ROLES) equal(m.roleLabel(role), WORDS.role[role], `roleLabel(${role})`);
  equal(m.EQUIVALENT_HINT, WORDS.equivalent, "EQUIVALENT_HINT");
  if (typeof m.DE[WORDS.equivalent] !== "string") deviations.push("EQUIVALENT_HINT is not in i18n-de.ts");
  return deviations;
}

test("web: lib/api/usage.ts mirrors every contract export, normalization loses no field, routes, bodies and words match", async () => {
  const deviations = await webDeviations(await loadWeb());
  assert.deepEqual(deviations, [], `web ≠ usage-contract.js:\n${deviations.join("\n")}`);
});

// ── (b) Web, as text: the pages use the lists ───────────────────────────────────────────────────

const PAGES = {
  modal: src("components", "settings", "SettingsModal.tsx"),
  usage: src("components", "settings", "UsageSettings.tsx"),
  kit: src("components", "settings", "UsageKit.tsx"),
  subscription: src("components", "settings", "UsageSubscription.tsx"),
  openrouter: src("components", "settings", "UsageOpenRouter.tsx"),
  limit: src("components", "settings", "UsageLimit.tsx"),
  workflows: src("components", "settings", "WorkflowsSettings.tsx"),
  provider: src("components", "settings", "ProviderSettings.tsx"),
  topnav: src("components", "TopNav.tsx"),
};

/** Without comments — a route in explanatory text is no call (block and line comments; `://` stays). */
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** All .ts/.tsx under web/src except lib/api/usage.ts (without comments) — none may write a route of the seam itself. */
function otherSources() {
  const deviations = {};
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) run(p);
      else if (/\.tsx?$/.test(e.name) && p !== src("lib", "api", "usage.ts")) deviations[path.relative(webDir, p)] = withoutComments(read(p));
    }
  };
  run(src());
  return deviations;
}

const texts = () => ({ ...Object.fromEntries(Object.entries(PAGES).map(([k, p]) => [k, read(p)])), other: otherSources() });

function textDeviations(x, contract = V) {
  const deviations = [];
  const must = (bed, what) => { if (!bed) deviations.push(what); };
  const lit = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // SettingsModal: the Usage page passes the subpage through, the Workflows page sits in "Behavior" right after "Chats".
  must(new RegExp(`\\{ key: "${lit(contract.USAGE_PAGE)}", label: "Usage",[^\\n]*render: \\(under\\) => <UsageSettings start=\\{under\\} /> \\}`).test(x.modal),
    `SettingsModal: the page "${contract.USAGE_PAGE}" does not pass the subpage to UsageSettings (start)`);
  must(new RegExp(`\\{ key: "${lit(contract.WORKFLOWS_PAGE)}", label: "Workflows",[^\\n]*render: \\(\\) => <WorkflowsSettings /> \\}`).test(x.modal),
    `SettingsModal: the page "${contract.WORKFLOWS_PAGE}" is missing or does not draw WorkflowsSettings`);
  const behavior = /\{ title: "Behavior", keys: \[([^\]]*)\] \}/.exec(x.modal)?.[1]?.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
  must(behavior.indexOf(contract.WORKFLOWS_PAGE) === behavior.indexOf("chats") + 1 && behavior.includes("chats"),
    `SettingsModal: "${contract.WORKFLOWS_PAGE}" is not right after "chats" in "Behavior" (${behavior.join(", ")})`);
  must(x.workflows.includes("function WorkflowCapGroup(") && x.workflows.includes("function WorkflowSizeRow("),
    "WorkflowsSettings lacks one of the two parts of the dynamic workflows (cap, size)");

  // UsageSettings: the list from USAGE_SUBPAGES, the content as a Record over the subpages (tsc keeps it complete).
  must(/\{USAGE_SUBPAGES\.map\(\(u\) =>/.test(x.usage), "UsageSettings does not draw the list from USAGE_SUBPAGES");
  must(/const CONTENT: Record<UsageSubpage,/.test(x.usage), "UsageSettings: the content per subpage is no longer a Record over UsageSubpage");
  must(/data-usage-subpage=\{u\}/.test(x.usage), "UsageSettings: the buttons do not carry the subpage key (limit-strip probe)");
  must(/isSubpage\(start\) \? start/.test(x.usage), "UsageSettings: the start subpage (jump usage:<subpage>) is not checked");

  // The header rings jump to their provider's subpage.
  must(/openSettings\(usageJump\(provider\)\)/.test(x.topnav), "the header rings do not jump via usageJump");
  must(/provider: "claude" \| "codex"/.test(x.topnav) && contract.SUBSCRIPTION_PROVIDER.every((a) => contract.USAGE_SUBPAGES.includes(a)),
    "the ring knows a provider without its own subpage");

  // The window bars take their provider's list; the words come from the tables.
  must(/<WindowBar window=\{SUBSCRIPTION_WINDOW\}/.test(x.subscription), "UsageSubscription: the window bar does not take SUBSCRIPTION_WINDOW");
  must(/<WindowBar window=\{OPENROUTER_WINDOW\}/.test(x.openrouter), "UsageOpenRouter: the window bar does not take OPENROUTER_WINDOW");
  must(x.kit.includes("t(WINDOW_SLIDING_LABEL[f])") && x.kit.includes("t(WINDOW_LABEL[f])"), "UsageKit: the window bar does not take its words from the tables");
  must(x.kit.includes("t(roleLabel(z.role))"), "UsageKit: the background tasks are not shown via roleLabel");
  must(x.kit.includes("t(EQUIVALENT_HINT)"), "UsageKit: the equivalent value carries no hint");
  must(x.kit.includes('t("since {time}", { time: time })'), "UsageKit: the real window does not show \"since HH:MM\"");
  must(/t\(ORIGIN_LABEL\[h\]\)/.test(x.openrouter), "UsageOpenRouter: the origin is not shown via ORIGIN_LABEL");

  // At the limit: the wording fixed for both clients.
  must(x.limit.includes(`t("${WORDS.gate}", { pct: threshold })`), `UsageLimit: the toggle is not called "${WORDS.gate}"`);

  // The provider page writes via the seam's routes, never via a route of its own.
  for (const fn of ["loadOpenRouterAccess", "setOpenRouterAccess", "removeOpenRouterKey"]) {
    must(new RegExp(`\\b${fn}\\(`).test(x.provider), `ProviderSettings does not call ${fn}`);
  }
  for (const [file, text] of Object.entries(x.other)) {
    // The seam shares its prefix with the older routes `/api/usage`, `/api/usage/codex` — only the seam's own routes are meant.
    if (/["'`]\/api\/(?:usage\/(?:consumption|history|claude-limits|openrouter-credit)\b|openrouter\b)/.test(text)) deviations.push(`${file} writes a route of the seam itself — the routes live in lib/api/usage.ts`);
  }
  return deviations;
}

test("web: the pages use the lists — Usage with subpages, Workflows in \"Behavior\", rings jump, no route of their own", () => {
  const deviations = textDeviations(texts());
  assert.deepEqual(deviations, [], `web pages ≠ usage-contract.js:\n${deviations.join("\n")}`);
});

// ── (c) Counter-tests ───────────────────────────────────────────────────────────────────────────

test("web, counter-test: a renamed field, a PUT without the switched-off toggle, another word and a contract with a new role are noticed", async () => {
  const field = "    cacheUnsplit: count(r.cacheUnsplit),\n    runs: count(r.runs),";
  const a = await webDeviations(await loadWebSabotaged((q) => {
    assert.ok(q.includes(field), "the line for the sabotage is no longer in normSums — update it");
    return q.replace(field, "    cacheUnsplitX: count(r.cacheUnsplit),\n    runsX: count(r.runs),");
  }));
  assert.ok(a.some((z) => z.includes(".sums: keys")), `the renamed field went unnoticed:\n${a.join("\n")}`);

  const body = "noDataUsage: toggle.noDataUsage };";
  const b = await webDeviations(await loadWebSabotaged((q) => {
    assert.ok(q.includes(body), "the PUT body is no longer like this in openRouterBody — update it");
    return q.replace(body, "...(toggle.noDataUsage ? { noDataUsage: true } : {}) };");
  }));
  assert.ok(b.some((z) => z.startsWith("PUT body /api/openrouter (both off)")), `the body without the switched-off toggle went unnoticed:\n${b.join("\n")}`);

  const word = 'second_look: "Second look",';
  const c = await webDeviations(await loadWebSabotaged((q) => {
    assert.ok(q.includes(word), "the label for the sabotage is no longer like this in ONCE_ROLES_LABEL — update it");
    return q.replace(word, 'second_look: "Second check",');
  }));
  assert.ok(c.some((z) => z.startsWith('ONCE_ROLES_LABEL "second_look"')), c.join("\n"));
  assert.ok(c.some((z) => z.includes('"Second check" is not in i18n-de.ts')), c.join("\n"));

  const foreign = { ...V, ONCE_ROLES: [...V.ONCE_ROLES, "addendum"], NEW_FIELDS: ["x"] };
  const d = await webDeviations(await loadWeb(), foreign);
  assert.ok(d.some((z) => z.startsWith("ONCE_ROLES (Web")), d.join("\n"));
  assert.ok(d.some((z) => z.includes('no word for "addendum" in WORDS')), d.join("\n"));
  assert.ok(d.some((z) => z.includes('"NEW_FIELDS" — neither mirrored in the web')), d.join("\n"));
});

test("web, counter-test (text): a ring without jump, Workflows before Chats, a foreign wording and a route of its own are noticed", () => {
  const t = texts();
  const ring = "openSettings(usageJump(provider))";
  assert.ok(t.topnav.includes(ring), "the rings' jump is no longer like this in TopNav.tsx — update it");
  const a = textDeviations({ ...t, topnav: t.topnav.replace(ring, 'openSettings("usage")') });
  assert.ok(a.includes("the header rings do not jump via usageJump"), a.join("\n"));

  const group = '"chats", "workflows"';
  assert.ok(t.modal.includes(group), "the group \"Behavior\" is no longer like this in SettingsModal.tsx — update it");
  const b = textDeviations({ ...t, modal: t.modal.replace(group, '"workflows", "chats"') });
  assert.ok(b.some((z) => z.includes('is not right after "chats" in "Behavior"')), b.join("\n"));

  const c = textDeviations({ ...t, limit: t.limit.replace(WORDS.gate, "Do not start any new turn above {pct}%") });
  assert.ok(c.some((z) => z.startsWith("UsageLimit: the toggle is not called")), c.join("\n"));

  const d = textDeviations({ ...t, other: { ...t.other, "src/components/Foreign.tsx": 'api("/api/usage/consumption?provider=claude")' } });
  assert.ok(d.some((z) => z.startsWith("src/components/Foreign.tsx writes a route of the seam itself")), d.join("\n"));
});

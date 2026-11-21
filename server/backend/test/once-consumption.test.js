// Guard: EVERY one-off call books its consumption. Before, only retrieval (communication/retrieval.js) and the outer loop booked;
// title, target, compaction, categorization, extraction, second look, workflow verdicts, adjust, the context and project oneshots and
// service detection consumed invisibly, so a whole part of the quota was missing from the usage view.
//
// The guard reads SOURCE TEXT: every call site `runOnce(` under electron/server/ (except the definition and the dispatch
// `connector.runOnce(`) carries `atConsumption: onceBooking("<role>" …)` in its options with a role from ONCE_ROLES of the
// contract (account/usage-contract.js), or a named booker (`BOOKER`: retrieval books under its own source). If the options sit in a
// variable (`runOnce(prompt, options)`), the object of its `const` declaration in the same file counts. Conversely: every role of the
// contract has a call site, except `outer_loop` (the outer loop books through its core, runs/agents.js booking). Plus the booking
// itself (runs/booking.js onceBooking) against a real database.
//
// COUNTER-TESTS (each shown red once):
//   (a) runs/post-run.js: delete `atConsumption: onceBooking("title", chat.id)` => "every call site ..." red
//       ("runs/post-run.js:... without atConsumption") and "every role ..." red (title without a call site);
//   (b) claude.js: mistype the role "compaction" as "compacting" => "every call site ..." red (role not in the contract);
//   (c) runs/booking.js onceBooking without `source: "once"` => "the booking ..." red (source '').
// The built-in sabotages in the last test hold the analysis itself (a site without a callback, a foreign role, options in a variable
// without a callback), otherwise an empty findings list would say nothing.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ONCE_ROLES } from "../electron/server/account/usage-contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "../electron/server");

// Bookers that do not go through onceBooking, with the role they book under (the source of the row).
const BOOKER = { bookRetrieval: "retrieval" };
// Roles without a runOnce site, with the reason. The three roles of the filing chain are HISTORICAL: their sites went away with
// intake/, the contract keeps them for the old rows in `usage_events`, otherwise booked consumption would show without a label.
const HISTORICAL = "historical: the site went away with intake/, the role stays for old rows in usage_events";
const WITHOUT_PLACE = {
  outer_loop: "the outer loop runs an agent core, not runOnce; booked through the booking in runs/agents.js",
  categorization: HISTORICAL, extraction: HISTORICAL, second_look: HISTORICAL,
};

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

// The text from an opening bracket to its closing one (strings and templates skipped roughly).
function upTo(text, start, on = "(", to = ")") {
  let depth = 0;
  let q = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === on) depth++;
    else if (c === to && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

// The top-level arguments of a call (parentheses, square/curly brackets, strings).
function argsValue(call) {
  const inside = call.slice(call.indexOf("(") + 1, -1);
  const out = [];
  let depth = 0, q = null, from = 0;
  for (let i = 0; i < inside.length; i++) {
    const c = inside[i];
    if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) { out.push(inside.slice(from, i).trim()); from = i + 1; }
  }
  const rest = inside.slice(from).trim();
  if (rest) out.push(rest);
  return out;
}

/**
 * The runOnce sites of a source text with their role (or a finding). → `[{ row, role, finding }]`.
 * Comment lines, the definition (`function runOnce`) and the dispatch (`.runOnce(`) do not count.
 */
function placesIn(text) {
  const out = [];
  for (const m of text.matchAll(/(?<![.\w])runOnce\(/g)) {
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    const before = text.slice(lineStart, m.index);
    if (/^\s*(\/\/|\*)/.test(before) || /function\s*$/.test(before) || /\/\/.*$/.test(before)) continue;
    const row = text.slice(0, m.index).split("\n").length;
    const call = upTo(text, m.index + "runOnce".length);
    const args = argsValue(`runOnce${call}`);
    let options = args[1] || "";
    if (/^[A-Za-z_$][\w$]*$/.test(options)) {
      const decl = new RegExp(`(?:const|let)\\s+${options}\\s*=\\s*\\{`).exec(text);
      options = decl ? upTo(text, decl.index + decl[0].length - 1, "{", "}") : "";
    }
    const e = /atConsumption:\s*onceBooking\(\s*"([^"]*)"/.exec(options);
    const b = /atConsumption:\s*\([^)]*\)\s*=>\s*(\w+)\(/.exec(options);
    if (e) out.push({ row, role: e[1], finding: ONCE_ROLES.includes(e[1]) ? "" : `role "${e[1]}" is not in the contract (ONCE_ROLES)` });
    else if (b && BOOKER[b[1]]) out.push({ row, role: BOOKER[b[1]], finding: "" });
    else out.push({ row, role: "", finding: "without atConsumption carrying a role (onceBooking(\"<role>\") or a booker from BOOKER)" });
  }
  return out;
}

function allPlaces() {
  const out = [];
  for (const file of jsFiles(SERVER)) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("runOnce(")) continue;
    for (const s of placesIn(text)) out.push({ file: path.relative(SERVER, file), ...s });
  }
  return out;
}

test("every runOnce site under electron/server/ books with a role of the contract", () => {
  const places = allPlaces();
  console.log(`[once-consumption] ${places.length} sites: ${places.map((s) => `${s.file}:${s.row}=${s.role || "?"}`).join(", ")}`);
  // 12 sites: compactConversation (claude.js) calls runOnce at ONE site (the retry after a deadline goes through the same wrapper).
  assert.ok(places.length >= 12, `too few sites found (${places.length}); does the analysis still read?`);
  const findings = places.filter((s) => s.finding).map((s) => `${s.file}:${s.row} ${s.finding}`);
  assert.deepEqual(findings, [], findings.join("\n"));
});

test("every role of the contract has a site (except the named ones without runOnce)", () => {
  const found = new Set(allPlaces().map((s) => s.role).filter(Boolean));
  const missing = ONCE_ROLES.filter((r) => !found.has(r) && !WITHOUT_PLACE[r]);
  assert.deepEqual(missing, [], `roles without a site: ${missing.join(", ")}`);
  for (const r of Object.keys(WITHOUT_PLACE)) {
    assert.ok(ONCE_ROLES.includes(r), `${r}: not a role of the contract`);
    assert.ok(!found.has(r), `${r} has a site by now: remove it from WITHOUT_PLACE`);
  }
});

test("the booking: source 'once', agent_id = role, on the triggering chat; subscription in tally form, OpenRouter with amount and id", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-once-"));
  try {
    const store = await import("../electron/server/store.js");
    const dbModule = await import("../electron/server/store/db.js"); // `db` is a live binding: read it only after initStore
    const { onceBooking } = await import("../electron/server/runs/booking.js");
    store.initStore(dir);
    const row = () => ({ ...dbModule.db.prepare(`SELECT provider, model, billing, input, output, cached, cache_read AS read, cache_write AS write,
      chat_id AS chatId, source, agent_id AS agentId, cost_usd AS cost, cost_origin AS origin, generation_id AS gen, upstream_provider AS up
      FROM usage_events ORDER BY id DESC LIMIT 1`).get() });
    // Claude (subscription): the report in the engine contract (input FULL = 7 fresh + 100 read + 20 written) => tally form, cache separate.
    onceBooking("title", "chat-1")({ provider: "claude", model: "claude-haiku-4-5", input: 127, output: 5, cached: 100, cacheWrite: 20, billing: "subscription" });
    assert.deepEqual(row(), { provider: "claude", model: "claude-haiku-4-5", billing: "subscription", input: 7, output: 5, cached: 120, read: 100, write: 20,
      chatId: "chat-1", source: "once", agentId: "title", cost: null, origin: "", gen: "", up: "" });
    // OpenRouter (metered): amount reported, generation id and provider behind the router.
    onceBooking("categorization")({ provider: "openrouter", model: "m1", input: 50, output: 4, cached: 30, cacheWrite: 0, billing: "metered", cost: 0.002, generationId: "gen-7", upstream: "Novita" });
    assert.deepEqual(row(), { provider: "openrouter", model: "m1", billing: "metered", input: 50, output: 4, cached: 30, read: 30, write: 0,
      chatId: "", source: "once", agentId: "categorization", cost: 0.002, origin: "reported", gen: "gen-7", up: "Novita" });
    // No provider, no row; a throwing store does not topple the call (the callback never throws).
    const prior = dbModule.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n;
    onceBooking("target")({ model: "x", input: 1, output: 1 });
    onceBooking("target")(null);
    assert.equal(dbModule.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n, prior);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("built-in sabotage: the analysis finds a site without a callback, a foreign role and options in a variable", () => {
  const without = placesIn('const a = await runOnce(prompt, { timeoutMs: 1, ...sandboxed() });\n');
  assert.equal(without.length, 1);
  assert.match(without[0].finding, /without atConsumption/);
  const foreign = placesIn('await runOnce(p, { atConsumption: onceBooking("invented"), ...sandboxed() });\n');
  assert.match(foreign[0].finding, /not in the contract/);
  const variable = placesIn('const options = {\n  timeoutMs: 1,\n  ...sandboxed(),\n};\nlet out = await runOnce(prompt, options);\n');
  assert.match(variable[0].finding, /without atConsumption/);
  const gut = placesIn('const options = {\n  timeoutMs: 1, atConsumption: onceBooking("extraction"),\n  ...sandboxed(),\n};\nout = await runOnce(prompt, options);\n');
  assert.deepEqual(gut.map((s) => [s.role, s.finding]), [["extraction", ""]]);
  // Comment, definition and dispatch do not count.
  assert.deepEqual(placesIn("// runOnce(prompt, {})\nexport async function runOnce(prompt, opts = {}) {}\nreturn connector.runOnce(prompt, opt);\n"), []);
  // Retrieval books through its own booker.
  assert.deepEqual(placesIn("await runOnce(p, { atConsumption: (v) => bookRetrieval(leser.id, v) });").map((s) => [s.role, s.finding]), [["retrieval", ""]]);
});

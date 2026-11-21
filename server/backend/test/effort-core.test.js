// The effort core in the server.
//
// Two questions, ONE answer each:
//   • "May this level be saved?" — `effortSavable` (workflows.js), a pure verdict with the statements missing · empty ·
//     level · unknown (with wording). Asked by chat creation, chat change, run settings and workflow definition.
//   • "Which level really runs?" — `effortRunning` (providers/index.js): set => the provider's default level (chosen ->
//     catalog level -> medium; on the fallback MODEL the fallback level first, DEFAULT_EFFORT_FALLBACK) => clamp to the
//     model. Asked by main run, subagent and runOnce.
// Chat creation and chat change reject unknown values with a 400.
//
// This file holds: the two functions (pure, resp. against the real catalog), that NO place filters against the order
// itself any more (source guard), and at the server <-> connector seam that the run passes the RESOLVED level — with spy
// connectors that are the real ones except for `runChat`/`runOnce`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EFFORT_LEVELS, effortFallback, effortSavable, effortWording } from "../electron/server/workflows.js";
import { setUiLang } from "../electron/server/i18n.js";
import { DEFAULT_EFFORT_FALLBACK, DEFAULT_MODEL_FALLBACK, PROVIDERS, effortCatalogLevel, effortRunning, effortStandard, getConnector, registerConnector } from "../electron/server/providers/index.js";
import { CLAUDE_MODELS, buildClaudeChatArgs, claudeEfforts, mapClaudeEffort } from "../electron/server/providers/connectors/claude.js";
import { CODEX_MODELS, codexEffortFallback, resolveCodexModel } from "../electron/server/providers/connectors/codex.js";
import { replaceOpenRouter, openRouterSpy } from "./openrouter-spy.mjs";
import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { waitForQuiet } from "./quiet.mjs";
import { GAP, withGapsModel } from "./gaps-model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(here, "..", "electron", "server");

// ── "May be saved" ─────────────────────────────────────────────────────────────────────────────────
test("effortSavable: missing, empty, level and unknown are four answers — a missing field is no statement", () => {
  assert.deepEqual(effortSavable(undefined), { kind: "missing" });
  assert.deepEqual(effortSavable(""), { kind: "empty", level: "" });
  for (const level of EFFORT_LEVELS) assert.deepEqual(effortSavable(level), { kind: "level", level });
  // Unknown is everything else — also `null` (an explicit value, not a missing one) and non-strings. Not trimmed, not
  // lowercased: "HIGH" and " high" were never savable.
  for (const value of ["turbo", "HIGH", " high", "auto", null, 5, ["high"], {}]) {
    const u = effortSavable(value);
    assert.equal(u.kind, "unknown", `${JSON.stringify(value)} is no savable level`);
    assert.deepEqual(u.error, effortWording(value), "the verdict carries the wording of a rejection");
  }
  // The wording is the one the workflow definition has always sent (400) — German and English.
  const both = (value) => {
    const de = effortWording(value);
    setUiLang("en");
    try { return [de, effortWording(value)]; } finally { setUiLang("de"); }
  };
  assert.deepEqual(both("turbo"), ["Unbekannte Denkstufe „turbo“.", "Unknown effort level “turbo”."]);
  assert.deepEqual(both(""), ["Unbekannte Denkstufe „“.", "Unknown effort level “”."]);
  assert.equal(effortWording("x".repeat(90)), `Unbekannte Denkstufe „${"x".repeat(40)}“.`, "truncated to 40 characters");
});

// ── "Really runs" ──────────────────────────────────────────────────────────────────────────────────
test("effortRunning · Claude: set, empty and not supported — the same calculation as the clamp at spawn", () => {
  assert.equal(effortRunning("claude", "claude-sonnet-5", "high"), "high", "set and supported");
  // The default model is Sonnet 5.5 (catalog level medium). Without a stored default model and without a stored default
  // level the fallback level high applies (DEFAULT_EFFORT_FALLBACK). The default level hangs on the default, not on the
  // chat's model.
  assert.equal(effortRunning("claude", "claude-sonnet-5", ""), "high", "empty => default level (fallback level high)");
  assert.equal(effortRunning("claude", "claude-sonnet-5", "turbo"), "high", "unknown => default");
  // "Not supported" no longer exists for Claude: the CLI supports all five levels of the order. The former sixth level
  // (clamped to max until then) is NO level any more => default; stored old values migrate to max at start
  // (store/chats.js migrateUltraToMax, guard ultra-gone.test.js).
  assert.equal(effortRunning("claude", "claude-opus-5", "ultra"), "high", "the former sixth level is no level => default (fallback level high)");
  for (const mo of [...CLAUDE_MODELS, { id: "" }]) {
    for (const level of EFFORT_LEVELS) {
      assert.equal(effortRunning("claude", mo.id, level), mapClaudeEffort(level, mo.id), `claude ${mo.id || "(default)"} + ${level}`);
    }
  }
});

// ── Levels per Claude model, "no levels" is not "unknown" ─────────────────────────────────────────────
// Measured on the pinned CLI: five models support low … max, Haiku 4.5 NONE (never an `output_config` on the wire, every
// `--effort` fizzles silently). The table is a transcript of the measurement, not of the catalog — whoever changes the
// catalog without measuring anew turns this test red.
const CLAUDE_MEASURED = {
  "claude-fable-5-2": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  // Opus 5.5: model table `effort`/`xhigh_effort`/`max_effort`, on the wire every level as chosen.
  "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  // Sonnet 5.5 and Haiku 5.5: model table (`effort`/`xhigh_effort`/`max_effort`, `default_effort: "medium"`), on the wire
  // every level as chosen, without --effort "medium".
  "claude-sonnet-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-haiku-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-haiku-4-5-20251001": [],
};

test("Claude catalog: per model exactly the measured levels, Haiku 4.5 with an EMPTY list (not without the field)", () => {
  assert.deepEqual(Object.fromEntries(CLAUDE_MODELS.map((m) => [m.id, m.efforts])), CLAUDE_MEASURED);
  const haiku = CLAUDE_MODELS.find((m) => m.id === "claude-haiku-4-5-20251001");
  assert.ok(Array.isArray(haiku.efforts) && haiku.efforts.length === 0, "Haiku carries `efforts: []` — a missing field would mean \"unknown\"");
  // /api/providers passes on the same reference (see "the Claude catalog lives in the connector").
  assert.equal(PROVIDERS.claude.models, CLAUDE_MODELS);
});

test("no levels ≠ unknown: empty => no level, missing => pass through — at the rule, the connector and the run", () => {
  // The rule itself.
  for (const level of EFFORT_LEVELS) {
    assert.equal(effortFallback(level, []), "", `empty + ${level} => no level`);
    assert.equal(effortFallback(level, null), level, `missing + ${level} => pass through`);
    assert.equal(effortFallback(level, undefined), level, `undefined + ${level} => pass through`);
  }
  // The connector: Haiku empty, a model outside the catalog unknown (the example is an invented id that never becomes one).
  assert.deepEqual(claudeEfforts("claude-haiku-4-5-20251001"), []);
  assert.deepEqual(claudeEfforts("claude-opus-5-5"), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(claudeEfforts("claude-never-in-catalog"), null);
  assert.equal(claudeEfforts(""), null, "empty = the CLI's default, not named in the catalog => unknown");
  for (const level of EFFORT_LEVELS) {
    assert.equal(mapClaudeEffort(level, "claude-haiku-4-5-20251001"), "", `Haiku + ${level}: no flag`);
    assert.equal(effortRunning("claude", "claude-haiku-4-5-20251001", level), "", `Haiku + ${level}: the run carries no level`);
    assert.equal(effortRunning("claude", "claude-never-in-catalog", level), level, `unknown model + ${level}: pass through`);
  }
  const args = buildClaudeChatArgs({ cwd: "/tmp/x", model: "claude-haiku-4-5-20251001", effort: "high", permissionMode: "bypassPermissions" });
  assert.ok(!args.includes("--effort"), "Haiku with a set level: no --effort on the command line");
  const argsOpus = buildClaudeChatArgs({ cwd: "/tmp/x", model: "claude-opus-5", effort: "high", permissionMode: "bypassPermissions" });
  assert.equal(argsOpus[argsOpus.indexOf("--effort") + 1], "high");
});

test("effortRunning · Codex: set, empty and not supported — against the RESOLVED id as at spawn", () => withGapsModel(() => {
  assert.equal(effortRunning("codex", "gpt-5.6-sol", "max"), "max", "set and supported");
  assert.equal(effortRunning("codex", "gpt-5.6-sol", ""), "medium", "empty => default level (catalog level of Sol)");
  // No catalog model has a gap any more — the test model carries its numbers.
  assert.equal(effortRunning("codex", GAP, "max"), "xhigh", "a model without max => xhigh");
  // A Claude alias is resolved as at spawn (sonnet => gpt-6-sol) — without resolution the clamp would ask a model nobody
  // runs: `null` instead of the target's list.
  assert.equal(resolveCodexModel("claude-sonnet-5"), "gpt-6-sol");
  assert.deepEqual(getConnector("codex").efforts("claude-sonnet-5"), getConnector("codex").efforts("gpt-6-sol"), "the alias asks the levels of its target");
  assert.equal(effortRunning("codex", "claude-sonnet-5", "max"), "max", "the alias clamps like its target (Sol supports max)");
  // Outside the catalog the maximum is unknown: pass through. The retired gpt-5.5 runs as gpt-6-sol (providers/retired.js)
  // and clamps like its successor — which supports max.
  assert.equal(effortRunning("codex", "gpt-7-preview", "max"), "max");
  assert.equal(effortRunning("codex", "gpt-5.5", "max"), "max");
  for (const mo of [...CODEX_MODELS, { id: "claude-opus-5" }, { id: "" }]) {
    for (const level of EFFORT_LEVELS) {
      assert.equal(effortRunning("codex", mo.id, level), codexEffortFallback(level, resolveCodexModel(mo.id)), `codex ${mo.id || "(default)"} + ${level}`);
    }
  }
}));

test("effortRunning · OpenRouter: set, empty and not supported — against the wire's levels for THIS model", () => {
  // The only HTTP wire: without `efforts` on the entry a model carries all five (OpenRouter maps itself), with an entry
  // exactly what stands there (preset-levels.js). The spy replaces the built-in one.
  const back = replaceOpenRouter({ models: [
    { id: "m1", label: "M1", efforts: ["low", "medium", "high"] },
    { id: "m2", label: "M2", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "m3", label: "M3" },
  ] });
  try {
    const preset = getConnector("openrouter");
    assert.deepEqual(preset.efforts("m1"), ["low", "medium", "high"]);
    assert.deepEqual(preset.efforts("m2"), [...EFFORT_LEVELS]);
    assert.deepEqual(preset.efforts("m3"), [...EFFORT_LEVELS], "without an entry: all five (no generic clamp)");
    assert.equal(effortRunning("openrouter", "m1", "high"), "high", "set and supported");
    assert.equal(effortRunning("openrouter", "m1", "max"), "high", "not supported: max => high, already in the run's resolution");
    assert.equal(effortRunning("openrouter", "m2", "max"), "max", "explicitly supported");
    assert.equal(effortRunning("openrouter", "m3", "max"), "max", "supported without an entry");
    assert.equal(effortRunning("openrouter", "m1", ""), "medium", "empty => default: OpenRouter without a catalog level thinks with medium");
    // What is no level at all drops out as on the wire.
    assert.equal(effortRunning("openrouter", "m1", "turbo"), "medium", "no level => default");
    for (const id of ["m1", "m2", "m3"]) {
      for (const level of EFFORT_LEVELS) assert.equal(effortRunning("openrouter", id, level), effortFallback(level, preset.efforts(id)));
    }
  } finally { back(); }
});

test("effortRunning: without `efforts` on the connector it means \"unknown\", an unknown provider falls back to the global one, the default is empty", () => {
  // A connector without `efforts` (test fakes, future exotics) — standing in for OpenRouter (there is no fourth provider).
  const back = replaceOpenRouter({
    id: "openrouter", label: "Exotic", models: [], caps: { ownsAgentLoop: false },
    cleanEnv: () => ({}), resolveModel: (m) => m, runOnce: async () => "", complete: async () => ({}),
  });
  try {
    assert.equal(effortRunning("openrouter", "x", "max"), "max", "no catalog => pass through");
    // The test model without max tells the two apart: Claude does not know it (pass through => max), Codex clamps
    // (=> xhigh).
    withGapsModel(() => {
      assert.equal(effortRunning("exists-not", GAP, "max"), effortRunning("claude", GAP, "max"),
        "an unknown provider is the global one (here: claude)");
      assert.notEqual(effortRunning("claude", GAP, "max"), effortRunning("codex", GAP, "max"), "precondition: the case tells the providers apart");
    });
    for (const [id, level] of [["claude", "high"], ["codex", "medium"], ["openrouter", "medium"]]) assert.equal(effortStandard(id), level, `default level ${id} (fallback level): preset`);
  } finally { back(); }
});

test("effortRunning reports a clamp only on request — a display that asks writes nothing to the log", (t) => withGapsModel(() => {
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(effortRunning("codex", GAP, "max"), "xhigh");
  assert.equal(warn.mock.callCount(), 0, "without report: silent");
  assert.equal(effortRunning("codex", GAP, "max", { report: true }), "xhigh");
  assert.equal(warn.mock.callCount(), 1, "the run reports the clamp");
  assert.match(String(warn.mock.calls[0].arguments[0]), new RegExp(`^\\[codex\\] Effort "max" is not supported by ${GAP} .* "xhigh"`));
  assert.equal(effortRunning("codex", "gpt-5.6-sol", "max", { report: true }), "max");
  assert.equal(warn.mock.callCount(), 1, "no clamp, no line");
}));

// ── The catalog lives in the connector ───────────────────────────────────────────────────────────────
test("the Claude catalog lives in the connector, the index holds no second version", () => {
  assert.equal(PROVIDERS.claude.models, CLAUDE_MODELS, "/api/providers reads the same reference as the connector");
  assert.equal(PROVIDERS.codex.models, CODEX_MODELS);
  const index = fs.readFileSync(path.join(SERVER_DIR, "providers", "index.js"), "utf8");
  assert.doesNotMatch(index, /^\s*(?:export )?const (?:CLAUDE|CODEX)_MODELS\s*=/m, "no catalog declaration in the index");
});

// ── No place filters by itself any more ──────────────────────────────────────────────────────────────
// Outside workflows.js the order `EFFORT_LEVELS` may only be imported and enumerated in a wording
// (`EFFORT_LEVELS.join(…)` in the connectors' warnings). Any other use is a place that judges by itself again.
// Counter-test: `EFFORT_LEVELS.includes(b.effort)` back in chats/routes.js => red.
function serverSources() {
  return fs.readdirSync(SERVER_DIR, { recursive: true }).map(String)
    .filter((f) => f.endsWith(".js") && !f.split(path.sep).includes("node_modules"))
    .map((f) => ({ rel: f.split(path.sep).join("/"), text: fs.readFileSync(path.join(SERVER_DIR, f), "utf8") }));
}
const codeRows = (text) => text.split("\n").map((z, i) => ({ seq: i + 1, z })).filter(({ z }) => {
  const t = z.trim();
  return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
});

test("no place outside workflows.js filters against the level order itself", () => {
  const violations = [];
  for (const { rel, text } of serverSources()) {
    if (rel === "workflows.js") continue;
    for (const { seq, z } of codeRows(text)) {
      if (!/\bEFFORT_LEVELS\b/.test(z)) continue;
      if (/^\s*import\b/.test(z)) continue;
      if (z.replace(/EFFORT_LEVELS\.join\(/g, "").match(/\bEFFORT_LEVELS\b/)) violations.push(`${rel}:${seq}: ${z.trim().slice(0, 140)}`);
    }
  }
  assert.deepEqual(violations, [], `places that judge against EFFORT_LEVELS themselves — they ask effortSavable or effortRunning:\n  ${violations.join("\n  ")}`);
});

test("the places ask the two functions", () => {
  const source = (rel) => codeRows(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8")).map(({ z }) => z).join("\n");
  const count = (text, name) => (text.match(new RegExp(`\\b${name}\\(`, "g")) || []).length;
  // [file, function, minimum number of calls, place]
  const expected = [
    // The owner of the subagents (runs/agents.js) builds the subagent's spec.
    ["runs/do-run.js", "effortRunning", 1, "main run"],
    ["runs/agents.js", "effortRunning", 1, "subagent"],
    // Chat creation is its own calculation in chats/creation.js (POST /api/chats and the creation of a scheduled job go
    // through it); two files, one call each.
    ["chats/routes.js", "effortSavable", 1, "chat change"],
    ["chats/creation.js", "effortSavable", 1, "chat creation"],
    ["workflows/definitions.js", "effortSavable", 1, "workflow definition"],
  ];
  for (const [rel, fn, n, place] of expected) {
    assert.ok(count(source(rel), fn) >= n, `${place} (${rel}) does not call ${fn} ${n}×`);
  }
  // The normalization of the run settings stands next to the verdict in workflows.js.
  const wf = source("workflows.js");
  const norm = wf.slice(wf.indexOf("export function normalizeRunSettings("));
  assert.ok(count(norm.slice(0, norm.indexOf("\n}")), "effortSavable") >= 1, "normalizeRunSettings asks effortSavable");
});

// ── The seam: what the server passes to the connector ────────────────────────────────────────────────
// Real server; Claude and Codex are the real connectors except for `runChat` (remembers the spec) and `runOnce` (title).
// Waiting is for events, not for a clock — the emergency brake is the suite.
const wait = async (fn) => {
  for (;;) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-effort-core-"));
  const prior = { claude: process.env.CLAUDE_BIN, codex: process.env.CODEX_BIN, poll: process.env.CBASE_TRIGGER_POLL };
  const real = { claude: getConnector("claude"), codex: getConnector("codex") };
  const specs = [];
  const open = new Set();
  let server;
  let base = "";
  let finished = false;   // the body ran without a throw (see finally)
  try {
    // No child must ever start; if one does, it must fail at once instead of hitting a real CLI.
    process.env.CLAUDE_BIN = path.join(root, "claude-exists-not");
    process.env.CODEX_BIN = path.join(root, "codex-exists-not");
    process.env.CBASE_TRIGGER_POLL = "0";
    for (const id of ["claude", "codex"]) {
      registerConnector({
        ...real[id],
        runOnce: async () => "Title",
        runChat: ({ spec, onEvent, onSpawn }) => new Promise((resolve) => {
          const finished = () => {
            open.delete(finished);
            onEvent({ type: "result", result: "ok", session_id: `s-${id}` });
            resolve({ code: 0, sessionId: `s-${id}`, resultText: "ok", stderr: "" });
          };
          specs.push({ provider: id, sub: Number(spec.agentDepth) > 0, model: spec.model, effort: spec.effort, spec, finished });
          onSpawn?.({ pid: 0, kill() {}, cbaseInject: () => false, cbaseEndInput: () => {} });
          onEvent({ type: "system", subtype: "init", session_id: `s-${id}` });
          if (Number(spec.agentDepth) > 0) finished(); else open.add(finished);
        }),
      });
    }
    const wsPath = path.join(root, "ws");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const api = async (p, method = "GET", body) => {
      const res = await fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const ws = (await api("/api/workspaces", "POST", { name: "Effort core", path: wsPath })).body;
    await fn({ api, ws, specs, base });
    finished = true;
  } finally {
    for (const f of [...open]) f();
    // Quiet instead of an own idle copy (busy/runs): hooks and oneshots of the last run are through as well. Only when the
    // body passed (template: agent-harness.mjs) — after a failure a hanging run would otherwise stand without a deadline.
    if (base && finished) await waitForQuiet(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    registerConnector(real.claude);
    registerConnector(real.codex);
    for (const [k, v] of [["CLAUDE_BIN", prior.claude], ["CODEX_BIN", prior.codex], ["CBASE_TRIGGER_POLL", prior.poll]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

test("the saving places: chat creation and change reject unknown values, the workflow definition 400", async () => {
  await withServer(async ({ api, ws }) => {
    const createRaw = (extra) => api("/api/chats", "POST", { workspaceId: ws.id, provider: "claude", model: "claude-sonnet-5", ...extra });
    const create = async (extra) => (await createRaw(extra)).body;
    // Chat creation: a level is stored, missing is the default ("" — unknown is a 400; in detail effort-validation.test.js).
    assert.equal((await create({ effort: "high" })).effort, "high");
    assert.equal((await createRaw({ effort: "turbo" })).status, 400);
    assert.equal((await create({})).effort, "");
    // Chat change: missing => unchanged, unknown (also a non-string) => 400, nothing stored.
    const c = await create({ effort: "low" });
    const change = async (body) => { assert.equal((await api(`/api/chats/${c.id}`, "PATCH", body)).status, 200); return store.getChat(c.id).effort; };
    assert.equal(await change({ effort: "xhigh" }), "xhigh");
    assert.equal(await change({ title: "without level" }), "xhigh", "missing => unchanged");
    assert.equal((await api(`/api/chats/${c.id}`, "PATCH", { effort: 5 })).status, 400, "non-string => 400");
    assert.equal((await api(`/api/chats/${c.id}`, "PATCH", { effort: "turbo" })).status, 400, "unknown => 400");
    assert.equal(store.getChat(c.id).effort, "xhigh", "rejected means: nothing stored");
    // Workflow definition: a changed, unknown level is a 400 with wording; a level goes through.
    const flow = (await api(`/api/workspaces/${ws.id}/workflows`, "POST", { name: "Effort" })).body;
    const put = (run) => api(`/api/workspaces/${ws.id}/workflows/${flow.id}`, "PUT", { run });
    assert.equal((await put({ effort: "high" })).status, 200);
    const no = await put({ effort: "turbo" });
    assert.equal(no.status, 400);
    assert.match(String(no.body?.error), /turbo/, "the wording names the value");
    assert.equal(store.getWorkflow(flow.id).run.effort, "high", "rejected means: nothing stored");
    // Empty there is NO unknown value, but "back to default" (the three statements per field are held by
    // workflow-run-settings.test.js).
    assert.equal((await put({ effort: "" })).status, 200, "empty with a set old value => default, no 400");
    assert.equal(store.getWorkflow(flow.id).run.effort, "");
  });
});

test("main run and subagent pass the RESOLVED level — each clamped to its own model", async () => {
  // The model without max is a test model with the numbers of gpt-5.5 (gaps-model.mjs).
  await withGapsModel(() => withServer(async ({ api, ws, specs }) => {
    // A run with a subagent; returns both specs.
    const run = async ({ provider, model, effort, sub }) => {
      const c = (await api("/api/chats", "POST", { workspaceId: ws.id, provider, model, permissionMode: "bypassPermissions" })).body;
      store.updateChat(c.id, { effort });
      specs.length = 0;
      assert.equal((await api(`/api/chats/${c.id}/message`, "POST", { text: "go" })).status < 300, true);
      const main = await wait(() => specs.find((s) => !s.sub));
      const r = await api(`/api/chats/${c.id}/agent`, "POST", { prompt: "Check something.", description: "Help", model: sub, callId: "toolu_effort_core", run_in_background: false });
      assert.ok(r.status < 300, `subagent not started: ${r.status} ${JSON.stringify(r.body)}`);
      const kind = await wait(() => specs.find((s) => s.sub));
      main.finished();
      return { main, kind };
    };
    // Codex chat on the model without max with max: the main run gets xhigh, the subagent on Sol keeps max — the chat's
    // level, clamped to ITS model.
    const a = await run({ provider: "codex", model: GAP, effort: "max", sub: "codex::gpt-5.6-sol" });
    assert.deepEqual([a.main.model, a.main.effort], [GAP, "xhigh"]);
    assert.deepEqual([a.kind.provider, a.kind.model, a.kind.effort], ["codex", "gpt-5.6-sol", "max"]);
    // Reverse: Claude chat with max, subagent on the model without max => xhigh; the main run keeps max.
    const b = await run({ provider: "claude", model: "claude-sonnet-5", effort: "max", sub: `codex::${GAP}` });
    assert.deepEqual([b.main.model, b.main.effort], ["claude-sonnet-5", "max"]);
    assert.deepEqual([b.kind.provider, b.kind.model, b.kind.effort], ["codex", GAP, "xhigh"]);
    // Without a level (and with one that is none): the chat provider's default level (Claude: high), and the Codex
    // subagent INHERITS it instead of taking its own provider's default (medium). A CHOSEN Claude default high keeps the
    // case sharp, independent of the preset — afterwards back to "", the setting lives on in the process and would hit
    // the tests after it.
    assert.equal((await api("/api/default-effort", "PUT", { provider: "claude", effort: "high" })).status, 200);
    let c;
    try { c = await run({ provider: "claude", model: "claude-sonnet-5", effort: "turbo", sub: `codex::${GAP}` }); }
    finally { assert.equal((await api("/api/default-effort", "PUT", { provider: "claude", effort: "" })).status, 200); }
    assert.deepEqual([c.main.effort, c.kind.effort], ["high", "high"]);
    // A Haiku chat with a stored level runs WITHOUT a level (Haiku supports none) — and spawns without `--effort`; its
    // subagent on Sonnet keeps the chat's level.
    const h = await run({ provider: "claude", model: "claude-haiku-4-5-20251001", effort: "max", sub: "claude::claude-sonnet-5" });
    assert.deepEqual([h.main.model, h.main.effort], ["claude-haiku-4-5-20251001", ""]);
    assert.ok(!buildClaudeChatArgs(h.main.spec).includes("--effort"), "Haiku spawns without --effort");
    assert.deepEqual([h.kind.model, h.kind.effort], ["claude-sonnet-5", "max"]);
    const argsKind = buildClaudeChatArgs(h.kind.spec);
    assert.equal(argsKind[argsKind.indexOf("--effort") + 1], "max", "Sonnet supports max");
  }));
});

// ── Default level per provider ───────────────────────────────────────────────────────────────────────
// An empty level field means "default": the provider's chosen default level, otherwise — if the default model is the
// fallback model, stored or not — the fallback level (Claude only: high), otherwise the catalog level of the default
// model, otherwise medium — resolved in ONE place, in the run (`effortRunning`), not at the creators. Whichever creation
// path (composer, channel, workflow, app agent) writes a chat, every run goes through doRun and asks the same resolution.

test("default level: the preset is the fallback level resp. the catalog level of the default model, otherwise medium", () => {
  // The catalog levels (the CLI's account catalog resp. OpenAI's model list).
  assert.equal(effortCatalogLevel("claude", "claude-sonnet-5"), "high");
  assert.equal(effortCatalogLevel("claude", "claude-opus-5-5"), "medium");
  assert.equal(effortCatalogLevel("claude", "claude-haiku-4-5-20251001"), "", "Haiku supports no levels — so no catalog level either");
  assert.equal(effortCatalogLevel("codex", "gpt-6-astra"), "low");
  // The three new ones (account catalog `default_reasoning_level`); gpt-5.5 (xhigh) is gone and runs as its successor
  // (providers/retired.js) => the catalog level of gpt-6-sol.
  for (const fresh of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) assert.equal(effortCatalogLevel("codex", fresh), "medium", fresh);
  assert.equal(effortCatalogLevel("codex", "gpt-5.5"), "medium", "retired => the level its successor runs with without --effort");
  assert.equal(effortCatalogLevel("codex", "gpt-5.4"), "", "not in OpenAI's list => none");
  // Every catalog level is a level its model supports — otherwise the preset would already be clamped.
  for (const [prov, list] of [["claude", CLAUDE_MODELS], ["codex", CODEX_MODELS]]) {
    for (const mo of list) if (mo.catalogLevel) assert.ok(mo.efforts.includes(mo.catalogLevel), `${prov}/${mo.id}: ${mo.catalogLevel} is not supported`);
  }
  assert.equal(effortStandard("claude"), "high", "nothing stored => fallback level high");
  assert.equal(effortStandard("codex"), "medium", "default model Sol");
});

// Fallback level: without a stored default level the fallback MODEL (DEFAULT_MODEL_FALLBACK, Claude Sonnet 5.5) thinks with
// high (providers/index.js DEFAULT_EFFORT_FALLBACK) instead of its catalog level medium — regardless of whether it is
// stored as the default or applies only through the fallback: both look the same in the picker, and there is no way back
// to "nothing stored" (`PUT /api/default-model ""` is a 400). Any other stored default model brings its catalog level, a
// stored level beats everything; Codex stays at Sol's catalog level. The description side (/api/providers) and the
// execution side (the level at the spawn of a chat without a level) give the same answer.
// Counter-tests in effortStandard:
//   • the fallback line deleted => red (medium instead of high, display and spawn);
//   • the rule on the storage state instead of the model (high only without a stored default model) => red (Sonnet 5.5
//     stored shows medium);
//   • without the model comparison (high for every default model without a level) => red (Opus 5.5 stored shows high).
test("fallback level: nothing stored => high; Sonnet 5.5 stored => high; another default model => its catalog level; default level stored => that; Codex unchanged", async () => {
  assert.deepEqual({ ...DEFAULT_EFFORT_FALLBACK }, { claude: "high" }, "ONE entry, Claude only");
  await withServer(async ({ api, ws, specs, base }) => {
    // Only the two native providers — earlier tests of this file leave their own connectors registered.
    const standard = async () => Object.fromEntries((await api("/api/providers")).body.providers
      .filter((p) => p.id === "claude" || p.id === "codex").map((p) => [p.id, p.defaultEffort]));
    const run = async (chatId) => {
      specs.length = 0;
      assert.ok((await api(`/api/chats/${chatId}/message`, "POST", { text: "go" })).status < 300);
      const main = await wait(() => specs.find((s) => !s.sub));
      main.finished();
      await waitForQuiet(base);
      return main.effort;
    };
    const defaultModel = async (model) => assert.equal((await api("/api/default-model", "PUT", { provider: "claude", model })).status, 200);
    // A Claude chat without a level on the fallback model, one on Opus 5.5 and a Codex chat without a level.
    const fresh = async (provider, model) => (await api("/api/chats", "POST", { workspaceId: ws.id, provider, model, permissionMode: "bypassPermissions" })).body.id;
    const sonnet = await fresh("claude", "claude-sonnet-5-5");
    const opus = await fresh("claude", "claude-opus-5-5");
    const sol = await fresh("codex", "gpt-5.6-sol");
    assert.equal(store.getSetting("default_model_claude", ""), "", "precondition: no default model stored");
    assert.equal(store.getSetting("default_effort_claude", ""), "", "precondition: no default level stored");
    assert.equal(DEFAULT_MODEL_FALLBACK.claude, "claude-sonnet-5-5", "precondition: the fallback model");
    assert.equal(effortCatalogLevel("claude", "claude-sonnet-5-5"), "medium", "precondition: its catalog level differs from the fallback level");
    assert.equal(effortCatalogLevel("claude", "claude-opus-5-5"), "medium", "precondition: Opus 5.5 separates catalog level and fallback level");
    try {
      // 1) Nothing stored: high — although the fallback MODEL Sonnet 5.5 (catalog level medium) runs.
      assert.deepEqual(await standard(), { claude: "high", codex: "medium" });
      assert.equal(effortStandard("claude"), "high");
      assert.equal(await run(sonnet), "high", "spawn of a Claude chat without a level");
      assert.equal(await run(sol), "medium", "Codex unchanged: catalog level of Sol");
      // 2) The fallback model stored explicitly: the SAME as nothing stored — no hidden state.
      await defaultModel("claude-sonnet-5-5");
      assert.deepEqual(await standard(), { claude: "high", codex: "medium" }, "Sonnet 5.5 stored => high as unstored");
      assert.equal(await run(sonnet), "high", "spawn with the stored default model Sonnet 5.5");
      // 3) Another default model with a catalog level: its level — for every chat without a level, also on Sonnet 5.5
      //    (the default level hangs on the provider's default, not on the chat's model).
      await defaultModel("claude-opus-5-5");
      assert.deepEqual(await standard(), { claude: "medium", codex: "medium" }, "Opus 5.5 stored => its catalog level medium");
      assert.equal(await run(opus), "medium");
      assert.equal(await run(sonnet), "medium");
      // Back to Sonnet 5.5: high again, not medium.
      await defaultModel("claude-sonnet-5-5");
      assert.equal((await standard()).claude, "high", "Opus -> back to Sonnet 5.5 => high again");
      // 4) Default level stored: it counts — on the fallback model (stored and not), on another model.
      assert.equal((await api("/api/default-effort", "PUT", { provider: "claude", effort: "low" })).status, 200);
      assert.equal((await standard()).claude, "low");
      assert.equal(await run(sonnet), "low");
      await defaultModel("claude-opus-5-5");
      assert.equal((await standard()).claude, "low", "the stored level beats the catalog level");
      store.setSetting("default_model_claude", "");
      assert.equal((await standard()).claude, "low", "the stored level beats the fallback level");
      assert.equal(await run(sonnet), "low");
      // 5) Level back to the preset: the rule on the model again.
      assert.equal((await api("/api/default-effort", "PUT", { provider: "claude", effort: "" })).status, 200);
      assert.deepEqual(await standard(), { claude: "high", codex: "medium" });
      assert.equal(await run(sonnet), "high");
      assert.equal(await run(sol), "medium", "Codex unchanged");
    } finally {
      store.setSetting("default_model_claude", "");
      store.setSetting("default_effort_claude", "");
    }
  });
});

test("default level: an OpenRouter chat without a catalog level goes onto the wire with medium — in the field reasoning_effort", async () => {
  // Only the openai-chat wire exists, and only the built-in OpenRouter runs over it (the spy replaces it with the same factory).
  const body = async (conn, args) => {
    const calls = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (_url, init) => { calls.push(init); throw new Error("intercepted — the body is available"); };
    try { await conn.complete({ messages: [{ role: "user", content: "hi" }], ...args }).catch(() => {}); }
    finally { globalThis.fetch = orig; }
    return JSON.parse(calls[0]?.body || "{}");
  };
  const model = "z-ai/glm-5.3-flash";
  const back = replaceOpenRouter(openRouterSpy({ baseUrl: "https://example.test/v1", models: [{ id: model, label: "M" }] }));
  try {
    const running = effortRunning("openrouter", model, "");
    assert.equal(running, "medium", "an empty level is OpenRouter's default");
    assert.equal((await body(getConnector("openrouter"), { model, effort: running })).reasoning_effort, "medium", "medium is on the wire");
  } finally { back(); }
});

test("default level: /api/providers delivers it, the write route requires the field, and it takes effect on empty fields at the next run", async () => {
  await withServer(async ({ api, ws, specs, base }) => {
    const standard = async () => Object.fromEntries((await api("/api/providers")).body.providers.map((p) => [p.id, p.defaultEffort]));
    assert.equal((await standard()).claude, "high", "preset: fallback level high (nothing stored)");
    assert.equal((await standard()).codex, "medium");
    // A missing field is no statement, an unknown level none — both 400, nothing stored.
    for (const [body, reason] of [
      [{ provider: "claude" }, "effort missing"], [{ provider: "claude", effort: "turbo" }, "unknown level"],
      [{ provider: "claude", effort: null }, "null is no level"], [{ provider: "claude", effort: "ultra" }, "the former sixth level"],
      [{ provider: "exists-not", effort: "low" }, "unknown provider"],
    ]) assert.equal((await api("/api/default-effort", "PUT", body)).status, 400, reason);
    assert.equal((await standard()).claude, "high", "rejected means: nothing stored");

    const idle = () => waitForQuiet(base);
    const run = async (chatId) => {
      specs.length = 0;
      assert.ok((await api(`/api/chats/${chatId}/message`, "POST", { text: "go" })).status < 300);
      const main = await wait(() => specs.find((s) => !s.sub));
      main.finished();
      await idle();
      return main;
    };
    const chat = async (provider, model, effort) => {
      const c = (await api("/api/chats", "POST", { workspaceId: ws.id, provider, model, permissionMode: "bypassPermissions", ...(effort === undefined ? {} : { effort }) })).body;
      return c.id;
    };
    const empty = await chat("claude", "claude-sonnet-5");
    const set = await chat("claude", "claude-sonnet-5", "max");
    const haiku = await chat("claude", "claude-haiku-4-5-20251001");
    assert.equal(store.getChat(empty).effort, "", "creation without a level stores none — the run resolves it");
    assert.equal((await run(empty)).effort, "high", "empty => default level (preset: fallback level)");
    assert.equal((await run(haiku)).effort, "", "a model without levels runs without — also with a default level");

    assert.equal((await api("/api/default-effort", "PUT", { provider: "claude", effort: "low" })).status, 200);
    assert.equal((await standard()).claude, "low");
    assert.equal((await run(empty)).effort, "low", "a changed default takes effect at the NEXT run on the empty field");
    assert.equal((await run(set)).effort, "max", "a chat with a set level stays untouched");
    assert.equal(store.getChat(empty).effort, "", "the default is not written into the chat");

    // "" is the return to the preset, and that hangs on the default MODEL: on the fallback model (stored or not) the
    // fallback level, on every other its catalog level.
    assert.equal((await api("/api/default-effort", "PUT", { provider: "claude", effort: "" })).status, 200);
    assert.equal((await standard()).claude, "high");
    // A stored default model with a DIFFERENT catalog level: Opus 5.5 (medium).
    assert.equal((await api("/api/default-model", "PUT", { provider: "claude", model: "claude-opus-5-5" })).status, 200);
    assert.equal((await standard()).claude, "medium", "Opus 5.5: catalog level medium");
    // The fallback's model stored explicitly: the fallback level as unstored (the route takes no empty model — back only via
    // the store; the setting would otherwise live on in the process).
    assert.equal((await api("/api/default-model", "PUT", { provider: "claude", model: "claude-sonnet-5-5" })).status, 200);
    assert.equal((await standard()).claude, "high", "Sonnet 5.5 stored: the fallback level, as unstored");
    store.setSetting("default_model_claude", "");
    assert.equal((await standard()).claude, "high", "nothing stored any more => the same fallback level");

    // The clamp to the run's model: Codex default max on a model without max (test model) => xhigh.
    assert.equal((await api("/api/default-effort", "PUT", { provider: "codex", effort: "max" })).status, 200);
    assert.equal(await withGapsModel(async () => (await run(await chat("codex", GAP))).effort), "xhigh");
  });
});

// ── Ultracode: a switch beside the level, never a level (independent of the level) ────────────────────
// Switching on and off leaves the level; a new level, a model without levels and a model change leave the switch. An
// unknown value is a 400, a missing field leaves the switch. Only the level goes to the CLI.

test("ultracode on the chat: PATCH, creation and fork store switch and level independently", async () => {
  await withServer(async ({ api, ws }) => {
    const create = async (extra) => (await api("/api/chats", "POST", { workspaceId: ws.id, provider: "claude", model: "claude-opus-5-5", ...extra }));
    const c = (await create({ effort: "low" })).body;
    assert.equal(c.ultracode, false, "off by default");
    const patch = (body) => api(`/api/chats/${c.id}`, "PATCH", body);
    const read = async () => { const g = (await api(`/api/chats/${c.id}`)).body; return [g.ultracode, g.effort]; };

    assert.equal((await patch({ ultracode: true })).status, 200);
    assert.deepEqual(await read(), [true, "low"], "on => switch stored, the level stays low");
    assert.equal((await patch({ title: "without field" })).status, 200);
    assert.deepEqual(await read(), [true, "low"], "missing => switch unchanged");
    // Switch off first: an unknown value must not silently switch it on.
    assert.equal((await patch({ ultracode: false })).status, 200);
    for (const wrong of ["yes", 1, null, "true"]) {
      const r = await patch({ ultracode: wrong });
      assert.equal(r.status, 400, `${JSON.stringify(wrong)} => 400`);
      assert.match(String(r.body?.error), /Ultracode/);
    }
    assert.deepEqual(await read(), [false, "low"], "rejected means: nothing written; off => the level stays");
    // A level sent along counts beside the switch.
    await patch({ ultracode: true, effort: "high" });
    assert.deepEqual(await read(), [true, "high"]);
    // A new level does not switch off.
    assert.equal((await patch({ effort: "max" })).status, 200);
    assert.deepEqual(await read(), [true, "max"]);
    // A model change leaves both; a model without levels (Haiku) carries the switch too.
    await patch({ model: "claude-sonnet-5" });
    assert.deepEqual(await read(), [true, "max"]);
    await patch({ model: "claude-haiku-4-5-20251001" });
    assert.deepEqual(await read(), [true, "max"], "Haiku: switch stays, so does the stored level (none goes on the wire)");
    await patch({ model: "claude-opus-5-5" });
    assert.deepEqual(await read(), [true, "max"]);
    // The fork inherits both.
    const fork = await api(`/api/chats/${c.id}/fork`, "POST", {});
    assert.ok(fork.status < 300, JSON.stringify(fork.body));
    const f = (await api(`/api/chats/${fork.body.id}`)).body;
    assert.deepEqual([f.ultracode, f.effort], [true, "max"], "the fork carries switch and level");

    // Creation: the switch beside the level sent along, also on a model without levels.
    const fresh = async (extra) => { const r = await create(extra); assert.equal(r.status, 201); return [r.body.ultracode, r.body.effort]; };
    assert.deepEqual(await fresh({ ultracode: true, effort: "low" }), [true, "low"]);
    assert.deepEqual(await fresh({ ultracode: true, model: "claude-haiku-4-5-20251001" }), [true, ""], "no levels => no level, but the switch");
    assert.deepEqual(await fresh({ ultracode: false, effort: "max" }), [false, "max"]);
    assert.equal((await create({ ultracode: "yes" })).status, 400, "creation: unknown => 400");
    // The list carries the field likewise (the web client reads the chat from it). It lists only a chat with at least one
    // message — this test's chat gets one.
    store.addMessage(c.id, "user", "Hello");
    const list = (await api(`/api/chats?workspaceId=${ws.id}`)).body;
    assert.ok(list.length && list.every((x) => typeof x.ultracode === "boolean"), "every row of the list carries ultracode");
  });
});

test("ultracode on the wire: the run gets the chat's level, never the word — and without levels no --effort", async () => {
  await withServer(async ({ api, ws, specs }) => {
    const run = async (model) => {
      const c = (await api("/api/chats", "POST", { workspaceId: ws.id, provider: "claude", model, effort: "medium", ultracode: true, permissionMode: "bypassPermissions" })).body;
      specs.length = 0;
      assert.ok((await api(`/api/chats/${c.id}/message`, "POST", { text: "go" })).status < 300);
      const main = await wait(() => specs.find((s) => !s.sub));
      main.finished();
      return { effort: main.effort, args: buildClaudeChatArgs(main.spec) };
    };
    const opus = await run("claude-opus-5-5");
    assert.equal(opus.effort, "medium", "the switch does not raise the level");
    assert.equal(opus.args[opus.args.indexOf("--effort") + 1], "medium");
    const haiku = await run("claude-haiku-4-5-20251001");
    assert.equal(haiku.effort, "");
    assert.ok(!haiku.args.includes("--effort"), "Haiku spawns without --effort");
    for (const { args } of [opus, haiku]) assert.ok(!args.some((a) => /ultracode/i.test(String(a))), "\"ultracode\" is never on the command line");
  });
});

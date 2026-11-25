import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { accountRoutes } from "../electron/server/account/routes.js";
import { CODEX_EFFORTS, CODEX_MODELS, buildCodexChatArgs, codexContextWindow, codexEffortFallback, codexEfforts, codexRateLimitSnapshot, codexUsage, readCodexTokenSnapshot, resolveCodexModel, resolveCodexTurnUsage, runChatCodex, setCodexHomeSource } from "../electron/server/providers/connectors/codex.js";
import { DIRS, setDirs } from "../electron/server/app-state.js";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentHosts, getConnector, setAccountKind, visibleModels, forgetAccountKind } from "../electron/server/providers/index.js";
import { GAP, withGapsModel } from "./gaps-model.mjs";
import { EFFORT_LEVELS, effortFallback } from "../electron/server/workflows.js";
import * as store from "../electron/server/store.js";

// OpenAI's catalog allows Astra/Sol/Terra/Luna 872k (max_context_window), but the CLI starts with 272k (context_window). cbase
// raises the window with -c model_context_window - and ONLY where the catalog allows more: for 272k models (the 5.4 family) and
// for foreign ids the call stays as it was. GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna (account catalog 872k) are raised too.
test("context window: -c model_context_window only for models whose catalog value is above the CLI default", () => {
  const argsFor = (model) => buildCodexChatArgs({ cwd: "/tmp/x", model, permissionMode: "bypassPermissions" });
  const winFlag = (args) => args.filter((a, i) => args[i - 1] === "-c" && /^model_context_window=/.test(a));

  assert.equal(codexContextWindow("gpt-6-astra"), 872_000);
  assert.deepEqual(winFlag(argsFor("gpt-6-astra")), ["model_context_window=872000"]);
  assert.deepEqual(winFlag(argsFor("gpt-5.6-sol")), ["model_context_window=872000"]);
  for (const fresh of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) {
    assert.deepEqual(winFlag(argsFor(fresh)), ["model_context_window=872000"], `${fresh}: the window of the account catalog`);
  }
  // 5.4 is at 272k in the catalog - nothing to raise.
  assert.equal(codexContextWindow("gpt-5.4"), 0);
  assert.deepEqual(winFlag(argsFor("gpt-5.4")), []);
  // An id outside the catalog passes through raw (resolveCodexModel), without an invented window.
  assert.deepEqual(winFlag(argsFor("gpt-7-preview")), []);
  assert.ok(argsFor("gpt-7-preview").includes("gpt-7-preview"));
  // Order: -c flags belong BEFORE the resume subcommand.
  const withResume = buildCodexChatArgs({ cwd: "/tmp/x", model: "gpt-6-astra", sessionId: "abc", permissionMode: "bypassPermissions" });
  assert.ok(withResume.indexOf("resume") > withResume.indexOf("model_context_window=872000"));
});

// ── The stdio MCP servers of a Codex run in B ──
// The Codex CLI gives a stdio MCP server only its standard names (HOME, PATH, ...), what is in `env.<k>` and what `env_vars`
// names (measured at 0.151.0: npm_config_cache & co. arrived at the server as null although the Codex process carried them). In
// operation and WITHOUT an instance (Codex in B) every stdio server therefore needs (a) the four package caches of B as
// `env_vars` - else an npx/uvx server loaded from the SHARED caches of the project containers - and (b) the git folder at the
// front of PATH (else a `git` of the server bypassed the project container). With an instance and without the operation mark
// the argv stays as it was.
// Counter-tests: codex.js without env_vars at the Playwright server => red; only PATH raw again => red ("PATH without the git
// folder at the front").
test("Codex in B in operation: every stdio MCP server inherits B's package caches via env_vars and has the git folder at the front of PATH; with an instance and without the mark as before", async () => {
  const { B_OWN_ENV, GIT_WRAPPER_FOLDER } = await import("../electron/server/runtime/inProject.js");
  const values = { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_GIT_WRAPPER_FOLDER: undefined, PATH: "/usr/local/bin:/usr/bin:/bin",
    npm_config_cache: "/home/agent/.cache/cbase-b/npm", UV_CACHE_DIR: "/home/agent/.cache/cbase-b/uv",
    PIP_CACHE_DIR: "/home/agent/.cache/cbase-b/pip", PLAYWRIGHT_BROWSERS_PATH: "/home/agent/.cache/cbase-b/ms-playwright" };
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  const set = (w) => { for (const [k, v] of Object.entries(w)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  const mcpServers = {
    cbase: { command: process.execPath, args: ["/app/electron/mcp/cbase-mcp.js"], env: { CBASE_BASE_URL: "http://127.0.0.1:7718", CBASE_TOKEN: "secret" } },
    playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.84"] },
  };
  const argv = (instance) => buildCodexChatArgs({ cwd: "/tmp/x", model: "gpt-5.6-sol", permissionMode: "bypassPermissions", mcpServers, ...(instance ? { instance } : {}) });
  const value = (args, key) => args.filter((a, i) => args[i - 1] === "-c" && a.startsWith(`${key}=`)).map((a) => a.slice(key.length + 1));
  set(values);
  try {
    const b = argv(null);
    const caches = JSON.stringify(B_OWN_ENV);
    assert.deepEqual(value(b, "mcp_servers.playwright.env_vars"), [caches], `Playwright without the caches of B: ${b.join(" ")}`);
    assert.deepEqual(value(b, "mcp_servers.cbase.env_vars"), [JSON.stringify(["CBASE_TOKEN", ...B_OWN_ENV])]);
    assert.deepEqual(value(b, "mcp_servers.playwright.env.PATH"), [JSON.stringify(`${GIT_WRAPPER_FOLDER}:/usr/local/bin:/usr/bin:/bin`)], "PATH without the git folder at the front");
    assert.ok(!b.some((a) => a.includes("cbase-b/")), "a VALUE of the caches is in the argv");
    // With an instance (Codex in the project container): as before - only the token as a name, B's PATH raw.
    const i = argv("p1/main");
    assert.deepEqual(value(i, "mcp_servers.playwright.env_vars"), []);
    assert.deepEqual(value(i, "mcp_servers.cbase.env_vars"), [JSON.stringify(["CBASE_TOKEN"])]);
    assert.deepEqual(value(i, "mcp_servers.playwright.env.PATH"), [JSON.stringify("/usr/local/bin:/usr/bin:/bin")]);
    // Without the operation mark (local): as before.
    set({ CBASE_CONTAINER: undefined, CBASE_DIND: undefined });
    const s = argv(null);
    assert.deepEqual(value(s, "mcp_servers.playwright.env_vars"), []);
    assert.deepEqual(value(s, "mcp_servers.cbase.env_vars"), [JSON.stringify(["CBASE_TOKEN"])]);
    assert.deepEqual(value(s, "mcp_servers.playwright.env.PATH"), [JSON.stringify("/usr/local/bin:/usr/bin:/bin")]);
  } finally { set(saved); }
});

// ── Effort grades per model ────────────────────────────────────────────────────────────────────
// The same family as the context window above: the catalog carries a MEASURED number per model, and the spawn follows it.
// Measured with real oneshots (ChatGPT account): `max` on gpt-5.5 => HTTP 400 "Unsupported value: 'max' is not supported with
// the 'gpt-5.5' model." All lists end at max (5.5: at xhigh) - Codex' level above it switches on its own delegation and is not
// offered. gpt-5.5 is gone, and no catalog model carries a gap any more - the clamp is run by the tests on a test model with
// EXACTLY the numbers of 5.5 (`gaps-model.mjs`, GAP).
const effortFlag = (args) => args.filter((a, i) => args[i - 1] === "-c" && /^model_reasoning_effort=/.test(a));
const argsForValue = (model, effort) => buildCodexChatArgs({ cwd: "/tmp/x", model, effort, permissionMode: "bypassPermissions" });
function withWarnings(fn) {
  const rows = [];
  const orig = console.warn;
  console.warn = (...a) => rows.push(a.map(String).join(" "));
  try { return { value: fn(), rows }; } finally { console.warn = orig; }
}

test("effort clamp: max falls to xhigh on a model without max (test model, numbers of gpt-5.5) - and the clamp says to what", () => withGapsModel(() => {
  const { value: args, rows } = withWarnings(() => argsForValue(GAP, "max"));
  // The rule stands once, in workflows.js:effortFallback: the highest carried grade that is NOT ABOVE the wanted one. For 5.5 that
  // means `max` => `xhigh` (no max, measured HTTP 400). Downwards, never upwards: one more grade costs thinking tokens against
  // the subscription limit, and nobody asked for it.
  assert.deepEqual(effortFlag(args), ['model_reasoning_effort="xhigh"']);
  // A list that cuts silently is indistinguishable from a complete one - and a message that names only the loss leaves open what
  // the run now thinks with.
  assert.equal(rows.length, 1);
  assert.match(rows[0], /\[codex\]/);
  assert.match(rows[0], /max/);
  assert.ok(rows[0].includes(GAP), `the line does not name the model: ${rows[0]}`);
  assert.match(rows[0], /xhigh/, "the line must name the REPLACEMENT, not only the loss");
  // The rest of the call stays untouched - the grade is clamped, not the run.
  assert.ok(args.includes(GAP));
  // What the model carries passes.
  assert.deepEqual(effortFlag(argsForValue(GAP, "xhigh")), ['model_reasoning_effort="xhigh"']);
}));

// The calculation is a function of its own without side effects - ONCE in `workflows.js:effortFallback`, where the order of the
// grades (EFFORT_LEVELS) also stands. All five clamps call it, web and iOS mirror it (`effortFallback` in web/src/lib/effort.ts),
// so that the surface can NAME the grade that really thinks. `web/test/effort.test.mjs` computes both sides against each other
// pair by pair.
test("effort replacement: the highest carried grade BELOW the wanted one - and what stays character-identical", () => withGapsModel(() => {
  assert.equal(codexEffortFallback("max", GAP), "xhigh", "the replacement is never above the wish");
  assert.equal(codexEffortFallback("max", "gpt-5.4"), "max", "the 5.4 family carries max");
  assert.equal(codexEffortFallback("high", GAP), "high", "what is carried stays");
  // Foreign id: the maximum is not known, and guessing would be worse than passing through.
  assert.equal(codexEffortFallback("max", "gpt-7-preview"), "max");
  // What is no grade at all (not in EFFORT_LEVELS) drops out - the same everywhere, see below. The former sixth grade belongs
  // to it: unmigrated it would run without a flag, hence the migration at start (store/chats.js, guard ultra-gone.test.js).
  assert.equal(codexEffortFallback("cozy", GAP), "");
  assert.equal(codexEffortFallback("ultra", "gpt-5.6-sol"), "");
  assert.equal(codexEffortFallback("", GAP), "");
  // The rule itself, measured against the order of EFFORT_LEVELS and not against the spelling of the catalog list: it is sorted
  // before searching. A catalog entered unsorted must not tip the clamp.
  assert.equal(effortFallback("max", ["high", "low", "xhigh"]), "xhigh");
  // ... and with a list that REALLY shows the difference: the one above gives "xhigh" with and without sorting - it NAMES the
  // promise but does not measure it. Here the writing order turns the result (without `sort` it would be "medium"), and that is
  // how the error arises: someone measures a grade afterwards and appends it at the end of `efforts`.
  assert.equal(effortFallback("max", ["low", "xhigh", "medium"]), "xhigh", "ordering is by EFFORT_LEVELS, not by the writing order of the catalog");
  // If there is nothing BELOW the wish, it is the lowest carried - the only case in which the replacement goes up, and it goes up
  // as little as possible.
  assert.equal(effortFallback("low", ["medium", "high"]), "medium");
  // A GAP in the list (a model does not carry xhigh, but max): the replacement goes down, not up across the gap.
  assert.equal(effortFallback("xhigh", ["low", "medium", "high", "max"]), "high");
  // No list (nobody measured) => character-identical; an EMPTY list means "no grades" => "" (no flag). Capitalization is no
  // other grade.
  assert.equal(effortFallback("high", null), "high");
  assert.equal(effortFallback("high", undefined), "high");
  assert.equal(effortFallback("high", []), "");
  assert.equal(effortFallback("MAX", ["xhigh"]), "xhigh");
}));

test("effort: max passes on Sol, and codexEfforts is the source for it", () => {
  const { value: args, rows } = withWarnings(() => argsForValue("gpt-5.6-sol", "max"));
  assert.deepEqual(effortFlag(args), ['model_reasoning_effort="max"']);
  assert.deepEqual(rows, []);
  assert.deepEqual(codexEfforts("gpt-5.6-sol"), ["low", "medium", "high", "xhigh", "max"]);
  // gpt-5.5 is gone: outside the catalog, hence unknown.
  assert.equal(codexEfforts("gpt-5.5"), null);
  // Foreign id => `null` (unknown, the grade passes) - NOT `[]`, which would mean "no grades".
  assert.equal(codexEfforts("gpt-7-preview"), null);
  assert.deepEqual(effortFlag(argsForValue("gpt-7-preview", "max")), ['model_reasoning_effort="max"'], "an unknown model keeps its grade");
  // The caller must not turn the list out of the catalog.
  withGapsModel(() => {
    codexEfforts(GAP).push("max");
    assert.deepEqual(codexEfforts(GAP), ["low", "medium", "high", "xhigh"]);
  });
  // Aliases are resolved BEFORE the clamp - else it would clamp against an id that does not exist. "sonnet" points to gpt-6-sol;
  // without resolution the clamp would ask "claude-sonnet-5" and get `null`.
  assert.equal(resolveCodexModel("claude-sonnet-5"), "gpt-6-sol");
  assert.equal(codexEfforts("claude-sonnet-5"), null, "without resolution: unknown");
  assert.deepEqual(getConnector("codex").efforts("claude-sonnet-5"), codexEfforts("gpt-6-sol"), "the connector asks the RESOLVED id");
  assert.deepEqual(effortFlag(argsForValue("claude-sonnet-5", "max")), ['model_reasoning_effort="max"']);
});

// ── The alias "haiku" asks the same visibility as everything else ─────────────────────────────
// `onlyApiKey` is expressly a RUNTIME property - the alias was not. Written fixed to gpt-5.5 it made the cheapest subagent
// tier disappear on an API-KEY ACCOUNT, where gpt-5.4-mini runs, and "haiku" and "sonnet" pointed to the SAME model: three tiers
// became two. Twenty subagents of the tier "haiku" then cost more, and nothing reports it. The setter is wired when
// providers/index.js loads - this test therefore measures the path the run also takes, not a second version beside it.
test("alias: \"haiku\" takes gpt-5.4-mini where it runs, and gpt-6-sol where the account rejects it", () => {
  const haiku = () => resolveCodexModel("claude-haiku-4-5-20251001");
  try {
    setAccountKind("codex", "apikey");
    assert.equal(haiku(), "gpt-5.4-mini", "on the API-key account the cheapest tier stays the cheapest");
    assert.notEqual(haiku(), resolveCodexModel("claude-sonnet-5"), "three alias tiers, three different models");

    setAccountKind("codex", "chatgpt");
    assert.equal(haiku(), "gpt-6-sol", "on the ChatGPT account gpt-5.4-mini dies in the measured 400");
    // The alias NEVER returns something that the picker does not show too - a second version of this decision would be exactly
    // the error this test closes.
    assert.ok(visibleModels("codex", CODEX_MODELS).map((mo) => mo.id).includes(haiku()));

    // Unknown means show EVERYTHING - so here too the cheapest tier.
    forgetAccountKind("codex");
    assert.equal(haiku(), "gpt-5.4-mini");
  } finally {
    forgetAccountKind("codex");
  }
});

test("effort: a model outside the catalog stays character-identical", () => {
  const { value: args, rows } = withWarnings(() => argsForValue("gpt-7-preview", "max"));
  // cbase knows nothing about foreign ids - an invented block would be worse than none, and nothing can be raised there either:
  // nobody knows the maximum of an unknown model.
  assert.deepEqual(effortFlag(args), ['model_reasoning_effort="max"']);
  assert.deepEqual(rows, []);
  // And nonsense stays nonsense: what is no Codex level drops silently as before.
  assert.deepEqual(effortFlag(argsForValue("gpt-7-preview", "cozy")), []);
});

test("uses last_token_usage instead of the aggregate agent-turn total", () => {
  const aggregate = { input_tokens: 1_700_000, cached_input_tokens: 1_550_000, output_tokens: 20_000 };
  const snapshot = {
    last: { input: 100_000, cached: 92_000, output: 700 },
    total: { input: 3_400_000, cached: 3_100_000, output: 40_000 },
  };

  const usage = resolveCodexTurnUsage(aggregate, snapshot, {
    input: 1_000_000,
    cached: 900_000,
    output: 10_000,
  });

  assert.deepEqual(usage, {
    current: { input: 1_700_000, cached: 1_550_000, output: 20_000 },
    input: 100_000,
    cached: 92_000,
    output: 700,
    source: "last_token_usage",
    // The consumption is a DIFFERENT number than the context: the difference of the thread states, all calls of the turn.
    consumption: { input: 700_000, cached: 650_000, output: 10_000 },
  });
});

test("consumption of the turn: new thread = its state, state below the baseline = itself", () => {
  // A fresh exec (workflow agent, oneshot-like subagent): no baseline, the turn is the whole state - measured on a real run:
  // 255,045 input, of which 210,944 from the cache, 2,246 output (4 were displayed).
  const fresh = resolveCodexTurnUsage({ input_tokens: 255_045, cached_input_tokens: 210_944, output_tokens: 2_246 },
    { last: { input: 30_000, cached: 29_000, output: 4 } });
  assert.deepEqual(fresh.consumption, { input: 255_045, cached: 210_944, output: 2_246 });
  assert.equal(fresh.output, 4, "the context stays the last call");
  // A baseline ABOVE the new state does not fit this thread - clamped it would be 0, the state itself is counted.
  const mismatched = resolveCodexTurnUsage({ input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 50 }, null,
    { input: 9_000, cached: 8_000, output: 600 });
  assert.deepEqual(mismatched.consumption, { input: 1_000, cached: 400, output: 50 });
});

test("reads the latest token snapshot from an explicit CODEX_HOME", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-usage-"));
  try {
    const sessionId = "019f90e4-4195-7d33-bab6-f92dd92eaba4";
    const dir = path.join(root, "sessions", "2026", "07", "23");
    fs.mkdirSync(dir, { recursive: true });
    const rollout = path.join(dir, `rollout-2026-07-23T21-31-45-${sessionId}.jsonl`);
    fs.writeFileSync(rollout, [
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
        total_token_usage: { input_tokens: 2_000_000, cached_input_tokens: 1_800_000, output_tokens: 10_000 },
        last_token_usage: { input_tokens: 90_000, cached_input_tokens: 80_000, output_tokens: 500 },
        model_context_window: 258_400,
      } } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
        total_token_usage: { input_tokens: 3_489_569, cached_input_tokens: 3_330_560, output_tokens: 12_003 },
        last_token_usage: { input_tokens: 128_981, cached_input_tokens: 126_720, output_tokens: 139 },
        model_context_window: 258_400,
      } } }),
    ].join("\n"));

    const snapshot = readCodexTokenSnapshot(sessionId, root);
    assert.deepEqual(snapshot?.last, { input: 128_981, cached: 126_720, output: 139 });
    assert.deepEqual(snapshot?.total, { input: 3_489_569, cached: 3_330_560, output: 12_003 });
    assert.equal(snapshot?.contextWindow, 258_400);
    assert.equal(snapshot?.path, rollout);
  } finally {
    // A test must not fail because its temp directory does not go away (a child still writing causes ENOTEMPTY); it is
    // reported nevertheless, so that no garbage piles up in /tmp unnoticed.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
});

test("consumption from the rollout file: the calls since the last task_started - cumulative (0.162.1) as well as per process (0.153.1)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-turn-"));
  try {
    const dir = path.join(root, "sessions", "2026", "10", "14");
    fs.mkdirSync(dir, { recursive: true });
    const row = (tot, last) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
      total_token_usage: { input_tokens: tot[0], cached_input_tokens: tot[1], output_tokens: tot[2] },
      last_token_usage: { input_tokens: last[0], cached_input_tokens: last[1], output_tokens: last[2] } } } });
    const task = JSON.stringify({ type: "event_msg", payload: { type: "task_started" } });
    const write = (id, rows) => fs.writeFileSync(path.join(dir, `rollout-2026-10-14T13-09-51-${id}.jsonl`), rows.join("\n"));
    // 0.162.1, measured: the state counts on across the thread. A repeated token_count row with the same state is no call.
    write("tid-cumulative", [task, row([12_622, 11_392, 41], [12_622, 11_392, 41]), row([25_308, 23_808, 46], [12_686, 12_416, 5]),
      task, row([38_028, 36_352, 106], [12_720, 12_544, 60]), row([38_028, 36_352, 106], [12_720, 12_544, 60]),
      row([50_866, 48_896, 111], [12_838, 12_544, 5])]);
    const kum = readCodexTokenSnapshot("tid-cumulative", root);
    assert.deepEqual(kum.turn, { input: 25_558, cached: 25_088, output: 65 });
    // The same as the difference of the turn.completed states would give - the rollout source changes nothing at 0.162.1.
    const u = resolveCodexTurnUsage({ input_tokens: 50_866, cached_input_tokens: 48_896, output_tokens: 111 }, kum, { input: 25_308, cached: 23_808, output: 46 });
    assert.deepEqual(u.consumption, { input: 25_558, cached: 25_088, output: 65 });
    // 0.153.1 (rollouts in the container): the continued process counts from 0. The difference to the previous state (17,235)
    // would have cut the turn to 24,903 instead of 42,138 input; the rollout source counts both calls.
    write("tid-process", [task, row([17_235, 16_000, 19], [17_235, 16_000, 19]),
      task, row([20_992, 19_000, 30], [20_992, 19_000, 30]), row([42_138, 40_000, 134], [21_146, 21_000, 104])]);
    const procSnapshot = readCodexTokenSnapshot("tid-process", root);
    assert.deepEqual(procSnapshot.turn, { input: 42_138, cached: 40_000, output: 134 });
    const v = resolveCodexTurnUsage({ input_tokens: 42_138, cached_input_tokens: 40_000, output_tokens: 134 }, procSnapshot, { input: 17_235, cached: 16_000, output: 19 });
    assert.deepEqual(v.consumption, { input: 42_138, cached: 40_000, output: 134 });
    // Without task_started (old rollouts, the fixtures above): no rollout number, the caller computes with the difference.
    write("tid-without", [row([9_000, 8_000, 70], [9_000, 8_000, 70])]);
    assert.equal(readCodexTokenSnapshot("tid-without", root).turn, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to a cumulative delta when no rollout snapshot exists", () => {
  const usage = resolveCodexTurnUsage(
    { input_tokens: 1_700_000, cached_input_tokens: 1_500_000, output_tokens: 20_000 },
    null,
    { input: 1_590_000, cached: 1_400_000, output: 19_400 },
  );

  assert.equal(usage.source, "cumulative_delta");
  assert.equal(usage.input, 110_000);
  assert.equal(usage.cached, 100_000);
  assert.equal(usage.output, 600);
});

test("runChatCodex emits the rollout context instead of turn.completed aggregate usage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-e2e-"));
  const bin = path.join(root, "fake-codex");
  const sessionId = "019f90ff-1111-7222-8333-444444444444";
  const previousBin = process.env.CODEX_BIN;
  // The rollout reader looks in CODEX_HOME (or ~/.codex). The real environment is set - else the fake would write into the REAL
  // ~/.codex.
  const previousHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = root;
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const id = ${JSON.stringify(sessionId)};
const dir = path.join(process.env.CODEX_HOME, "sessions", "2026", "07", "23");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "rollout-2026-07-23T23-59-00-" + id + ".jsonl"), JSON.stringify({
  type: "event_msg",
  payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: 3400000, cached_input_tokens: 3100000, output_tokens: 40000 },
    last_token_usage: { input_tokens: 100000, cached_input_tokens: 92000, output_tokens: 700 },
    model_context_window: 258400
  } }
}) + "\\n");
console.log(JSON.stringify({ type: "thread.started", thread_id: id }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "answer", type: "agent_message", text: "OK" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1700000, cached_input_tokens: 1550000, output_tokens: 20000 } }));
`);
    fs.chmodSync(bin, 0o755);
    process.env.CODEX_BIN = bin;

    let handle;
    let input = 0;
    let output = 0;
    let consumption = null;
    const markers = [];
    const result = await runChatCodex({
      spec: {
        cwd: root,
        input: "test",
        systemPrompt: "",
        model: "",
        effort: "",
        permissionMode: "bypassPermissions",
        sessionId: "",
        forkPending: false,
        addDirs: [],
        mcpServers: {},
      },
      onSpawn: (h) => { handle = h; },
      onEvent: (evt) => {
        const kind = evt?.event?.type;
        if (kind === "message_start" || kind === "message_delta") markers.push(evt.event.onlyContext === true);
        const start = kind === "message_start" ? evt.event.message?.usage : null;
        if (start) input = (start.input_tokens || 0) + (start.cache_read_input_tokens || 0);
        if (kind === "message_delta") output = evt.event.usage?.output_tokens || 0;
        if (kind === "consumption") consumption = evt.event.usage;
        if (evt.type === "result") handle.cbaseEndInput();
      },
    });

    assert.equal(result.code, 0);
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.resultText, "OK");
    assert.equal(input, 100_000);
    assert.equal(output, 700);
    // The context pair carries the mark (the counter skips it), the turn comes as `consumption` - in the Claude form, fresh = input
    // - cached. The baseline from the rollout (3.4 M) is above the turn state: it is counted itself.
    assert.deepEqual(markers, [true, true]);
    assert.deepEqual(consumption, { input_tokens: 150_000, cache_read_input_tokens: 1_550_000, cache_creation_input_tokens: 0, output_tokens: 20_000 });
  } finally {
    if (previousBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousBin;
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    // A test must not fail because its temp directory does not go away (a child still writing causes ENOTEMPTY); it is
    // reported nevertheless, so that no garbage piles up in /tmp unnoticed.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
});

// ── Rate limits for the display ──────────────────────────────────────────────
// At the limit the Codex CLI wrote the exhausted window as `null` and named only the kind. The reader then kept looking in OLDER
// rollouts - and the header showed either a stale value or no ring at all although 100 % was reached.
const rateLimitRollout = (dir, name, rl, { mtime }) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: {}, last_token_usage: {} }, rate_limits: rl },
  })}\n`);
  // Force the order through the modification time: the reader takes the newest rollout first, and there are rollouts in the real
  // ~/.codex of this machine too.
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
};

test("at the limit without a window: 100 % instead of nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-limit-"));
  const soon = Math.floor(Date.now() / 1000) + 3600;
  try {
    // older state WITH a window (90 %) ...
    rateLimitRollout(path.join(root, "sessions", "2026", "08", "10"), "rollout-2026-08-10T10-00-00-019fe689-0838-7320-b3cb-d2f563ccc543.jsonl", {
      primary: { used_percent: 90, window_minutes: 10080, resets_at: soon }, secondary: null, plan_type: "team", rate_limit_reached_type: null,
    }, { mtime: Date.now() + 3_600_000 });
    // ... and the newest state: limit reached, window null (real form of the CLI 0.145.0)
    rateLimitRollout(path.join(root, "sessions", "2026", "08", "11"), "rollout-2026-08-11T20-00-00-019fe689-0838-7320-b3cb-d2f563ccc544.jsonl", {
      limit_id: "codex", primary: null, secondary: null, credits: { has_credits: false, unlimited: false, balance: null },
      plan_type: "team", rate_limit_reached_type: "primary",
    }, { mtime: Date.now() + 7_200_000 });

    const u = codexUsage(root);
    assert.equal(u.connected, true);
    assert.equal(u.reachedType, "primary");
    assert.equal(u.primary?.usedPercent, 100, "a reached window is reported as full");
    assert.equal(u.planType, "team");
  } finally {
    // A test must not fail because its temp directory does not go away (a child still writing causes ENOTEMPTY); it is
    // reported nevertheless, so that no garbage piles up in /tmp unnoticed.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
});

test("credits exhausted: the state arrives although there is no time window", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-credits-"));
  try {
    rateLimitRollout(path.join(root, "sessions", "2026", "08", "11"), "rollout-2026-08-11T21-00-00-019fe689-0838-7320-b3cb-d2f563ccc545.jsonl", {
      limit_id: "codex", primary: null, secondary: null, credits: { has_credits: false, unlimited: false, balance: 0 },
      plan_type: "plus", rate_limit_reached_type: "credits",
    }, { mtime: Date.now() + 7_200_000 });

    const u = codexUsage(root);
    assert.equal(u.reachedType, "credits");
    assert.equal(u.primary, null);
    assert.equal(u.secondary, null);
  } finally {
    // A test must not fail because its temp directory does not go away (a child still writing causes ENOTEMPTY); it is
    // reported nevertheless, so that no garbage piles up in /tmp unnoticed.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
});

test("normal operation stays normal (no invented limit)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-normal-"));
  const soon = Math.floor(Date.now() / 1000) + 3600;
  try {
    rateLimitRollout(path.join(root, "sessions", "2026", "08", "11"), "rollout-2026-08-11T21-30-00-019fe689-0838-7320-b3cb-d2f563ccc546.jsonl", {
      primary: { used_percent: 8, window_minutes: 10080, resets_at: soon }, secondary: null, plan_type: "team", rate_limit_reached_type: null,
    }, { mtime: Date.now() + 7_200_000 });

    const u = codexUsage(root);
    assert.equal(u.reachedType, "");
    assert.equal(u.primary?.usedPercent, 8);
  } finally {
    // A test must not fail because its temp directory does not go away (a child still writing causes ENOTEMPTY); it is
    // reported nevertheless, so that no garbage piles up in /tmp unnoticed.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
});

// ── File limits: rollouts from a project home ─────────────────────────────────────────────────────────────────────────────
// A project home (`<data>/projects/<pid>/home/.codex`) lies in the runtime folder that the project container mounts rw. What lies
// there is a CLAIM: (a) a FIFO as rollout-*.jsonl, (b) a sparse file of 1.9 GB, (c) a rollout with mtime 2030 and an invented
// `rate_limit_reached_type`. Expected: (a) the readers return (in a CHILD PROCESS - a hang there stays one of the child; the
// test opens the writer itself, a blocking reader would get content and end, red at the result), (b) only the end is read (the
// read seam counts at most ROLLOUT_ENDE_MAX), and the snapshot at the end is found, (c) no limit window from the future, and a
// foreign thread of a project does not stop the limit gate. Counter-case: a regular file in B's home is read as before (even
// with mtime in the future - B is no attacker).
// Counter-tests: codex.js without the size cap => (b) red (ERR_STRING_TOO_LONG, no snapshot, 1.9 GB counted); without the mtime
// filter or without the filter "own thread only" => (c) red; the O_NONBLOCK|O_NOFOLLOW open closes the race between list and
// read for (a).
const CODEX_SOURCE = new URL("../electron/server/providers/connectors/codex.js", import.meta.url).href;
const APP_STATE = new URL("../electron/server/app-state.js", import.meta.url).href;
function withProjectHome(fn) {
  const old = DIRS;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-pr-")));
  const data = path.join(root, "data");
  const projHome = path.join(data, "projects", "p1", "home", ".codex");
  const bHome = path.join(root, "b", ".codex");
  fs.mkdirSync(path.join(projHome, "sessions", "2026", "10", "01"), { recursive: true });
  fs.mkdirSync(path.join(bHome, "sessions", "2026", "10", "01"), { recursive: true });
  setDirs({ data });
  setCodexHomeSource(() => [projHome]);
  // Keep the real rollouts of this machine (~/.codex) out: HOME to an empty folder, CODEX_HOME removed.
  const savedEnv = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = path.join(root, "home");
  delete process.env.CODEX_HOME;
  const finished = () => {
    setCodexHomeSource(null); setDirs(old);
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  };
  let r;
  try { r = fn({ root, data, projHome, bHome, tag: (h) => path.join(h, "sessions", "2026", "10", "01") }); } catch (e) { finished(); throw e; }
  return Promise.resolve(r).finally(finished);
}
const snapRow = (n) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: n, output_tokens: 1, cached_input_tokens: 0 }, total_token_usage: { input_tokens: n, output_tokens: 1, cached_input_tokens: 0 }, model_context_window: 272000 } } });
async function readCodex(fn) {
  const old = { readFileSync: fs.readFileSync, readSync: fs.readSync };
  let bytes = 0;
  fs.readFileSync = function (p, ...rest) {
    try { bytes += (typeof p === "number" ? fs.fstatSync(p) : fs.statSync(p)).size; } catch { /* does not count */ }
    return old.readFileSync.call(fs, p, ...rest);
  };
  fs.readSync = function (...a) { const n = old.readSync.apply(fs, a); bytes += n; return n; };
  let value;
  try { value = await fn(); } finally { fs.readFileSync = old.readFileSync; fs.readSync = old.readSync; }
  return { bytes, value };
}

test("file limits (a): a FIFO as rollout in the project home stops no reader (in a child process)", async () => {
  await withProjectHome(async ({ data, projHome, tag }) => {
    const fifo = path.join(tag(projHome), "rollout-2026-10-01T10-00-00-tid-fifo.jsonl");
    execFileSync("mkfifo", [fifo]);
    const writer = fs.promises.open(fifo, "w").then(async (fh) => {
      try { await fh.write(`${snapRow(77)}\n`); } catch { /* reader gone */ } finally { await fh.close(); }
    });
    const script = `const c = await import(process.env.SOURCE); const a = await import(process.env.APP);
      a.setDirs({ data: process.env.DATA }); c.setCodexHomeSource(() => [process.env.PH]);
      const snap = c.readCodexTokenSnapshot("tid-fifo", process.env.PH + "-b");
      const u = c.codexUsage(process.env.PH + "-b");
      const rl = c.codexRateLimitSnapshot({ threadId: "tid-fifo", codexHome: process.env.PH + "-b" });
      process.stdout.write(JSON.stringify({ snap, u, rl })); process.exit(0);`;
    const subprocess = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, SOURCE: CODEX_SOURCE, APP: APP_STATE, DATA: data, PH: projHome }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    subprocess.stdout.on("data", (d) => { out += d; });
    subprocess.stderr.on("data", (d) => { err += d; });
    const code = await new Promise((r) => subprocess.on("close", (c) => r(c)));
    const fd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try { await writer; } finally { fs.closeSync(fd); }
    assert.equal(code, 0, `child: ${code} ${err}`);
    const r = JSON.parse(out);
    assert.equal(r.snap, null, "a snapshot was read from a FIFO");
    assert.equal(r.rl, null);
  });
});

test("file limits (b): a sparse rollout file of 1.9 GB - only the end is read, the snapshot there arrives", async () => {
  await withProjectHome(async ({ projHome, bHome, tag }) => {
    const p = path.join(tag(projHome), "rollout-2026-10-01T10-00-00-tid-large.jsonl");
    fs.writeFileSync(p, "");
    fs.truncateSync(p, 1_900_000_000);
    fs.appendFileSync(p, `\n${snapRow(4242)}\n`);
    const r = await readCodex(() => readCodexTokenSnapshot("tid-large", bHome));
    assert.equal(r.value?.last?.input, 4242, "the snapshot at the end of the file did not arrive");
    assert.ok(r.bytes <= 1024 * 1024, `${r.bytes} bytes read over the read seam`);
    const u = await readCodex(() => codexUsage(bHome));
    assert.ok(u.bytes <= 1024 * 1024, `codexUsage read ${u.bytes} bytes`);
  });
});

test("file limits (c): a rollout with mtime 2030 and an invented limit in the project home => no limit window; a foreign thread does not stop the gate; B as before", async () => {
  await withProjectHome(async ({ projHome, bHome, tag }) => {
    const soon = Math.floor(Date.now() / 1000) + 3600;
    const future = Date.parse("2030-01-01T00:00:00Z");
    rateLimitRollout(tag(projHome), "rollout-2026-10-01T10-00-00-tid-foreign.jsonl", {
      primary: { used_percent: 100, window_minutes: 300, resets_at: Math.floor(future / 1000) }, secondary: null, plan_type: "pro", rate_limit_reached_type: "primary",
    }, { mtime: future });
    // Display and gate: the window from the future arrives nowhere.
    assert.notEqual(codexUsage(bHome).reachedType, "primary", "the display shows the invented limit of 2030");
    assert.notEqual(codexRateLimitSnapshot({ threadId: "tid-own", codexHome: bHome })?.rate_limit_reached_type, "primary", "the limit gate stops at the rollout of 2030");
    // A FOREIGN thread of a project with a current mtime: not for the gate (only its own), but for the display.
    rateLimitRollout(tag(projHome), "rollout-2026-10-01T10-00-01-tid-other.jsonl", {
      primary: { used_percent: 100, window_minutes: 300, resets_at: soon }, secondary: null, plan_type: "pro", rate_limit_reached_type: "primary",
    }, { mtime: Date.now() - 1000 });
    assert.notEqual(codexRateLimitSnapshot({ threadId: "tid-own", codexHome: bHome })?.rate_limit_reached_type, "primary", "the rollout of a foreign thread in the project stops the gate");
    assert.equal(codexUsage(bHome, { projectHomes: false }).connected, false, "the fallback of the gate reads only B (nothing lies there)");
    assert.equal(codexRateLimitSnapshot({ threadId: "tid-other", codexHome: bHome })?.rate_limit_reached_type, "primary", "the OWN thread in the project counts");
    // Counter-case B: a regular file in B's home - even with mtime in the future - is read as before.
    rateLimitRollout(tag(bHome), "rollout-2026-10-01T10-00-02-tid-b.jsonl", {
      primary: { used_percent: 33, window_minutes: 300, resets_at: soon }, secondary: null, plan_type: "pro", rate_limit_reached_type: null,
    }, { mtime: Date.now() + 3_600_000 });
    assert.equal(codexUsage(bHome).primary?.usedPercent, 33, "B is no longer read");
    assert.equal(codexUsage(bHome, { projectHomes: false }).primary?.usedPercent, 33);
    assert.equal(codexRateLimitSnapshot({ threadId: "tid-own", codexHome: bHome })?.primary?.used_percent, 33);
  });
});

// (d) The NUMBER of rollouts of a project home must be capped - readdir and lstat per file, before the filter (measured: 100,000
// empty rollouts => codexUsage about 350 ms synchronous). Newest first, at most ROLLOUTS_PER_HOME rollouts looked at (lstat) and
// ROLLOUT_ENTRIES_PER_HOME entries read (opendir), one message per home. The newest rollout still supplies the display, and the OWN
// thread of a run is found for the gate even behind 1,000 newer ones (the filter applies when listing). Counted only under the
// project home: lstat, readdir entries and Dir.readSync.
// Counter-tests: without the two caps => red (1002 lstat); only the cap of the entries removed => red (12008 entries);
// codexRateLimitSnapshot without the filter when listing => red (the own, older rollout is missing).
test("file limits (d): 1,000 rollouts and 11,000 entries in the project home - at most the caps are read, newest first; the own thread is found; one message", async () => {
  const { ROLLOUTS_PER_HOME, ROLLOUT_ENTRIES_PER_HOME } = await import("../electron/server/providers/connectors/codex.js");
  await withProjectHome(async ({ projHome, bHome, tag }) => {
    const sessions = path.join(projHome, "sessions");
    const soon = Math.floor(Date.now() / 1000) + 3600;
    const now = Date.now();
    rateLimitRollout(tag(projHome), "rollout-2026-10-01T10-00-00-tid-new.jsonl", {
      primary: { used_percent: 42, window_minutes: 300, resets_at: soon }, secondary: null, plan_type: "pro", rate_limit_reached_type: null,
    }, { mtime: now - 1000 });
    const old = path.join(sessions, "2026", "09", "30");
    fs.mkdirSync(old, { recursive: true });
    for (let i = 0; i < 1000; i++) {
      const f = path.join(old, `rollout-2026-09-30T00-00-00-empty-${String(i).padStart(4, "0")}.jsonl`);
      fs.writeFileSync(f, "");
      fs.utimesSync(f, (now - 100_000) / 1000, (now - 100_000) / 1000); // older than the two with content (sorted by mtime)
    }
    rateLimitRollout(path.join(sessions, "2026", "09", "28"), "rollout-2026-09-28T10-00-00-tid-old.jsonl", {
      primary: { used_percent: 77, window_minutes: 300, resets_at: soon }, secondary: null, plan_type: "pro", rate_limit_reached_type: "primary",
    }, { mtime: now - 5000 });
    const count = async (fn) => {
      const raw = { lstatSync: fs.lstatSync, readdirSync: fs.readdirSync, dirRead: fs.Dir.prototype.readSync };
      const under = (p) => String(p).startsWith(projHome + path.sep);
      const z = { lstat: 0, entries: 0 };
      fs.lstatSync = function (p, ...r) { if (under(p)) z.lstat++; return raw.lstatSync.call(fs, p, ...r); };
      fs.readdirSync = function (p, ...r) { const l = raw.readdirSync.call(fs, p, ...r); if (under(p)) z.entries += l.length; return l; };
      fs.Dir.prototype.readSync = function (...r) { const e = raw.dirRead.apply(this, r); if (e && under(this.path)) z.entries++; return e; };
      try { return { value: await fn(), ...z }; } finally {
        fs.lstatSync = raw.lstatSync; fs.readdirSync = raw.readdirSync; fs.Dir.prototype.readSync = raw.dirRead;
      }
    };
    const warnings = [];
    const rawWarn = console.warn;
    console.warn = (...a) => { warnings.push(a.join(" ")); };
    try {
      const u = await count(() => codexUsage(bHome));
      assert.ok(u.lstat <= ROLLOUTS_PER_HOME, `codexUsage: ${u.lstat} lstat in the project home`);
      assert.equal(u.value.primary?.usedPercent, 42, "the newest rollout no longer supplies the display");
      const g = await count(() => codexRateLimitSnapshot({ threadId: "tid-old", codexHome: bHome }));
      assert.equal(g.value?.rate_limit_reached_type, "primary", "the own, older rollout was not found for the gate");
      assert.ok(g.lstat <= ROLLOUTS_PER_HOME, `codexRateLimitSnapshot: ${g.lstat} lstat`);
      // The entries: the NEWEST day folder with 11,000 names (no rollout - the rollout cap never applies there) - at most the cap is
      // read (one more to recognize it). What lies behind it this call no longer sees: a project that fills its home like that loses
      // its own display, not B's time.
      const full = path.join(sessions, "2026", "10", "02");
      fs.mkdirSync(full, { recursive: true });
      for (let i = 0; i < 11_000; i++) fs.writeFileSync(path.join(full, `x-${i}`), "");
      const e = await count(() => codexUsage(bHome));
      assert.ok(e.entries <= ROLLOUT_ENTRIES_PER_HOME + 1, `codexUsage read ${e.entries} entries in the project home`);
      assert.ok(e.lstat <= ROLLOUTS_PER_HOME, `${e.lstat} lstat`);
      // One message per home, not per call.
      codexUsage(bHome);
      assert.equal(warnings.filter((w) => w.includes(projHome) && w.includes("(cap)")).length, 1, warnings.join("\n"));
    } finally { console.warn = rawWarn; }
  });
});

// A store is bound only here: `initStore` rebinds the module-wide `db`, so this test stands at the end of the file and all the
// others manage without a database.
test("/api/providers hides the onlyApiKey models on the ChatGPT account and shows them on the API key", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-providers-"));
  const priorCodex = process.env.CODEX_BIN;
  const priorClaude = process.env.CLAUDE_BIN;
  try {
    store.initStore(dir);
    // The Claude branch of the route should just fail fast - it does not matter here.
    process.env.CLAUDE_BIN = path.join(dir, "claude-exists-not");
    const codexFake = (row) => {
      const bin = path.join(dir, `codex-${Buffer.from(row).toString("hex").slice(0, 8)}.sh`);
      fs.writeFileSync(bin, `#!/bin/sh\necho '${row}'\n`);
      fs.chmodSync(bin, 0o755);
      return bin;
    };
    const fetchCodex = async () => {
      const res = { code: 0, body: null, writeHead(c) { this.code = c; }, end(s) { this.body = JSON.parse(s); } };
      await accountRoutes({ req: {}, res, url: {}, p: "/api/providers", m: "GET" });
      assert.equal(res.code, 200);
      return res.body.providers.find((pv) => pv.id === "codex");
    };

    process.env.CODEX_BIN = codexFake("Logged in using ChatGPT");
    const chatgpt = await fetchCodex();
    assert.equal(chatgpt.authMethod, "chatgpt");
    const ids = chatgpt.models.map((mo) => mo.id);
    // gpt-5.4 and -mini answer on a ChatGPT account with 400 ("not supported when using Codex with a ChatGPT account") - the
    // picker has no free text, so they must go.
    assert.deepEqual(ids, ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    // What the client needs: the measured effort list. What it must never see: the mark.
    assert.deepEqual(chatgpt.models.find((mo) => mo.id === "gpt-6-luna").efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.ok(chatgpt.models.every((mo) => !("onlyApiKey" in mo)));

    process.env.CODEX_BIN = codexFake("Logged in using an API key");
    const apikey = await fetchCodex();
    assert.equal(apikey.authMethod, "apikey");
    // The 400 names the ACCOUNT, not the model - with a key both stay selectable.
    assert.deepEqual(apikey.models.map((mo) => mo.id).slice(-2), ["gpt-5.4", "gpt-5.4-mini"]);
    assert.ok(apikey.models.every((mo) => !("onlyApiKey" in mo)));
    // The catalog in the server keeps them in EVERY case: /api/default-model checks against it, and a chat that already stands on
    // gpt-5.4 should keep running on a key account.
    assert.deepEqual(codexEfforts("gpt-5.4"), ["low", "medium", "high", "xhigh", "max"]);
  } finally {
    if (priorCodex === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = priorCodex;
    if (priorClaude === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = priorClaude;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn("Cleanup failed:", e?.message || e); }
  }
});

// ── Three lists, one truth ─────────────────────────────────────────────────────────────────────
// An effort grade stands in THREE places: `efforts` per model (CODEX_MODELS - what this model measurably carries),
// `CODEX_EFFORTS` (what Codex carries overall) and `EFFORT_LEVELS` in workflows.js (what a chat/run may store). If a grade
// falls out of one of the three, it disappears SILENTLY: the picker would offer it, the PATCH route would write "" - or the
// other way round. No path there carries an error message. `CODEX_EFFORTS` is no gate any more: whether something is a grade at
// all is decided for all five clamps by `EFFORT_LEVELS`. The binding stays nevertheless - it is the place where a new
// measurement and the catalog would drift apart.
test("three lists, one truth: efforts per model == CODEX_EFFORTS subset of EFFORT_LEVELS", () => {
  const fromModels = new Set();
  for (const mo of CODEX_MODELS) {
    assert.ok(Array.isArray(mo.efforts) && mo.efforts.length, `${mo.id} carries no measured effort list`);
    for (const level of mo.efforts) fromModels.add(level);
  }
  // Direction 1: what a model carries must be known to the measurement and storable by the chat.
  for (const level of [...fromModels].sort()) {
    assert.ok(CODEX_EFFORTS.has(level), `"${level}" stands at a model, but not in CODEX_EFFORTS - the measurement and the catalog then say different things`);
    assert.ok(EFFORT_LEVELS.includes(level), `"${level}" stands at a model, but not in EFFORT_LEVELS - chats/routes.js would store ""`);
  }
  // Direction 2: a grade in CODEX_EFFORTS that NO model carries is a measurement without object - either the catalog row is
  // missing, or the set claims more than was ever measured.
  for (const level of [...CODEX_EFFORTS].sort()) {
    assert.ok(fromModels.has(level), `"${level}" stands in CODEX_EFFORTS, but at no model - either the measurement is missing or the grade is dead`);
  }
  // Direction 3: every grade of the order is measured for Codex too. Without this direction a grade that stands only in
  // EFFORT_LEVELS (not removed there, removed at the models) would stay green - it would still be stored, offered nowhere.
  for (const level of EFFORT_LEVELS) {
    assert.ok(CODEX_EFFORTS.has(level), `"${level}" stands in EFFORT_LEVELS, but in no Codex list - one side was cut, the other not`);
  }
});

// ── The list of five ───────────────────────────────────────────────────────────────────────────
// The order stands here LITERALLY and not through the constant: a test that reads the constant would stay green if someone
// appended a grade. The former sixth grade meant something different per provider and is gone; Codex' `none`/`minimal` was never
// offered by cbase - this test holds both, for the order AND for every measured model list.
test("the list of five: low < medium < high < xhigh < max - no sixth grade, no none/minimal, in no Codex list", () => {
  assert.deepEqual(EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual([...CODEX_EFFORTS], ["low", "medium", "high", "xhigh", "max"]);
  for (const mo of CODEX_MODELS) {
    for (const never of ["ultra", "none", "minimal"]) {
      assert.ok(!mo.efforts.includes(never), `${mo.id} offers "${never}"`);
    }
  }
  // GPT-6 Luna carries low...max without the level above it per the account catalog - cbase's list is the same.
  assert.deepEqual(codexEfforts("gpt-6-luna"), ["low", "medium", "high", "xhigh", "max"]);
});

// ── The default must be RUNNABLE ───────────────────────────────────────────────────────────────
// `default_model_codex` is a free setting. If gpt-5.4-mini stood there (set nowhere today, but storable), /api/providers would
// deliver a `defaultModel` that is missing from its OWN models list - the settings page then silently shows the first entry, and
// every chat without a model of its own spawns the measured 400. Both ways there are closed here: the fallback and the route.
test("default model: a default that cannot run on the ChatGPT account falls back, and the route rejects it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-default-"));
  const priorCodex = process.env.CODEX_BIN;
  const priorClaude = process.env.CLAUDE_BIN;
  try {
    store.initStore(dir);
    process.env.CLAUDE_BIN = path.join(dir, "claude-exists-not");
    const bin = path.join(dir, "codex-chatgpt.sh");
    fs.writeFileSync(bin, "#!/bin/sh\necho 'Logged in using ChatGPT'\n");
    fs.chmodSync(bin, 0o755);
    process.env.CODEX_BIN = bin;

    const call = async (p, m, body) => {
      const res = { code: 0, body: null, writeHead(c) { this.code = c; }, end(s) { this.body = JSON.parse(s); } };
      // With the JSON type: readBody reads a body only under application/json, else 415.
      const req = { headers: { "content-type": "application/json" }, on: (ev, fn) => { if (ev === "data" && body !== undefined) fn(Buffer.from(JSON.stringify(body))); if (ev === "end") fn(); return req; } };
      await accountRoutes({ req, res, url: {}, p, m });
      return res;
    };

    // The unrunnable default is set past the setting - exactly how it would come from an old DB.
    store.setSetting("default_model_codex", "gpt-5.4-mini");
    const providers = (await call("/api/providers", "GET")).body.providers;
    const codex = providers.find((pv) => pv.id === "codex");
    assert.equal(codex.authMethod, "chatgpt");
    assert.ok(!codex.models.some((mo) => mo.id === "gpt-5.4-mini"), "the unrunnable model still stands in the picker");
    // The default now points to something that stands in its own list.
    assert.equal(codex.defaultModel, "gpt-5.6-sol");
    assert.ok(codex.models.some((mo) => mo.id === codex.defaultModel), "defaultModel is missing from its own models list");

    // And the way that writes it in at all is closed - with a reason one can read: "unknown" would be wrong, the model exists.
    const rejected = await call("/api/default-model", "PUT", { provider: "codex", model: "gpt-5.4" });
    assert.equal(rejected.code, 400);
    assert.match(rejected.body.error, /Konto/);
    assert.equal(store.getSetting("default_model_codex", ""), "gpt-5.4-mini", "the rejected route must not have written anything");
    // A really unknown model stays at the old wording - two cases, two sentences.
    const unknown = await call("/api/default-model", "PUT", { provider: "codex", model: "gpt-9-nonexistent" });
    assert.equal(unknown.code, 400);
    assert.match(unknown.body.error, /Unbekanntes Modell/);
    // The switched-off gpt-5.5 is unknown - nobody sets it as the default any more.
    const gone = await call("/api/default-model", "PUT", { provider: "codex", model: "gpt-5.5" });
    assert.equal(gone.code, 400);
    assert.match(gone.body.error, /Unbekanntes Modell/);
    // A visible one passes.
    const ok = await call("/api/default-model", "PUT", { provider: "codex", model: "gpt-6-sol" });
    assert.equal(ok.code, 200);
    assert.equal(store.getSetting("default_model_codex", ""), "gpt-6-sol");
  } finally {
    if (priorCodex === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = priorCodex;
    if (priorClaude === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = priorClaude;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn("Cleanup failed:", e?.message || e); }
  }
});

// ── The block applies to the agent as to the human ─────────────────────────────────────────────
// The visibility first stood only on the way to the picker. `agentHosts()` kept reading the raw catalog - and through it
// "codex::gpt-5.4, codex::gpt-5.4-mini" ended up in EVERY system prompt with subagents (runs/system-prompt.js), in the task
// description of the loop engine and in three error hints. A main agent that follows it starts a subagent that dies with HTTP 400:
// execution side and description side gave different answers.
test("visibility: agentHosts follows the same decision as the picker - and unknown shows EVERYTHING", () => {
  const codexModels = () => agentHosts().find((h) => h.id === "codex")?.models.map((mo) => mo.id) || [];
  // Own store: the account kind survives the restart, so it lies in the settings - without a fresh database this test would read
  // what an earlier test left behind.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-view-"));
  try {
    store.initStore(dir);
    // Account kind unknown (no /api/providers run): show everything. "I do not know" must not become "does not apply" - the
    // default of the setter is an ANSWER, not a gap.
    forgetAccountKind("codex");
    assert.ok(codexModels().includes("gpt-5.4"), "without a known account kind nothing may be missing");
    // And an EMPTY account kind is no statement, but exactly this not-knowing: `codex login status` reports it even without the
    // CLI, and for claude the route always sends it.
    setAccountKind("codex", "");
    assert.ok(codexModels().includes("gpt-5.4"), "an empty account kind must hide nothing");

    setAccountKind("codex", "chatgpt");
    assert.deepEqual(codexModels(), ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    // And at the SAME place as the picker - a second version of this decision would be exactly the error this test closes.
    assert.deepEqual(visibleModels("codex", CODEX_MODELS).map((mo) => mo.id), codexModels());
    // The mark is a cbase measurement, no contract: it never leaves the server.
    assert.ok(visibleModels("codex", CODEX_MODELS).every((mo) => !("onlyApiKey" in mo)));
    // The catalog itself stays complete - a key account runs both, and a chat that already stands on gpt-5.4 should keep running
    // there.
    assert.equal(CODEX_MODELS.length, 12);

    setAccountKind("codex", "apikey");
    assert.ok(codexModels().includes("gpt-5.4-mini"), "on the API key both stay selectable");
  } finally {
    forgetAccountKind("codex");
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn("Cleanup failed:", e?.message || e); }
  }
});

// ── The account kind survives the restart ─────────────────────────────────────────────
// `setAccountKind` is filled EXCLUSIVELY by GET /api/providers. If the answer lived only in the process, the block would apply
// only from the first poll - and a backend that the gateway wakes two minutes before a schedule keeps naming "codex::gpt-5.4,
// codex::gpt-5.4-mini" in EVERY system prompt with subagents until then. An agent that follows it starts a subagent that dies in
// the measured 400; no picker appears in such a run.
//
// The restart is reproduced honestly here: the process memory is emptied (forgetAccountKind) and only what the PREVIOUS process
// would have left behind is written to the settings.
test("account kind: what the last process saw applies again at start", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-account-kind-"));
  try {
    store.initStore(dir);
    const showsOld54 = () => visibleModels("codex", CODEX_MODELS).some((mo) => mo.id === "gpt-5.4");

    // 1. The setter remembers beyond the process.
    forgetAccountKind("codex");
    setAccountKind("codex", "chatgpt");
    assert.equal(store.getSetting("account_kind_codex", ""), "chatgpt", "the setter writes the account kind to the settings");

    // 2. An EMPTY account kind is no statement and must not delete what was remembered - `codex login status` reports it even
    //    without the CLI, and for claude the route sends it in every poll.
    setAccountKind("codex", "");
    assert.equal(store.getSetting("account_kind_codex", ""), "chatgpt", "empty is not unknown, and unknown is not \"no longer applies\"");

    // 3. The fresh process: nothing seen, but the memory of the last one is there.
    forgetAccountKind("codex");
    assert.ok(showsOld54(), "without any memory it still holds: unknown means show everything");
    store.setSetting("account_kind_codex", "chatgpt");
    assert.ok(!showsOld54(), "the last seen account kind must survive the restart");
    // And on ALL paths, not only in the picker - the alias and the agent hosts hang on the same calculation.
    assert.equal(resolveCodexModel("claude-haiku-4-5-20251001"), "gpt-6-sol");
    assert.ok(!(agentHosts().find((h) => h.id === "codex")?.models || []).some((mo) => mo.id === "gpt-5.4"));

    // 4. After a logout the memory no longer applies: nobody knows which account logs in next, and a block left standing would
    //    take two models from a key account without reason. (This is called at /api/account/codex/logout.)
    forgetAccountKind("codex");
    assert.equal(store.getSetting("account_kind_codex", ""), "");
    assert.ok(showsOld54());
  } finally {
    forgetAccountKind("codex");
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn("Cleanup failed:", e?.message || e); }
  }
});

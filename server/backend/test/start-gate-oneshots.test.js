// The start gate at the SPAWN layer and the error path of a subagent: "from 99 % no new turn" used to be checked only in doRun —
// but `runOnce` has about twenty callers (verdicts, titles, target gate, compaction, `adjust`), and none passed there. runOnce
// asks the hook `gateVerdictHook` BEFORE the connector; an intercepted call throws `limits.gateLimitText(window)`. The turn's
// release is an ARGUMENT (`release`) that doRun gives only to its own trailing jobs (title, curator) — the verdicts AFTER the
// turn ask the gate themselves, and "Start anyway" passes `overruled` through the verdict chain up to the next turn.
//
// Every test here ENTERS the path where the finding arose — not the composer path that credit-gate.test.js already drives many
// times: runOnce without a chat, `adjust`, a workflow's node turn, a oneshot IN THE MIDDLE of a turn (title), the target verdict
// AFTER the turn and the own subagent whose CLI dies at the limit (foreground and background).
//
// ── Why a file of its own, and why the order of the tests is not arbitrary ──────────────────
// The gate reads the usage through `fetchUsageLimits({force:false})`; without credentials the server falls back to the state
// PERSISTED in `app_settings` — which this file seeds. This fallback is read only ONCE per process (`usageCacheLoaded` in
// account/usage.js is module-wide, and the error path then passes the SAME object on indefinitely). Consequences, both measured:
//   1. All tests of this file share ONE seed (session window 100 %). It cannot be set to 10 % at run time — "the window is free
//      again" is therefore played through the gate itself (off), not through the number.
//   2. The seed carries its measuring time; after CREDIT_GATE_MAX_AGE_MS (5 min) the gate considers the value stale and STARTS.
//      The whole file must be through within five minutes; `seedFresh()` says so in plain words if not.
//   3. The seed's reset lies ahead (SEED_RESET_S). The gate tests run FIRST, as long as it is not reached — that is a CONDITION,
//      not a convenience: an exhausted window whose reset has passed makes the gate consider the number stale and it no longer
//      blocks (limits.gateWindow, the same rule as stillBlocked; before, it parked on it anew every two seconds, each with a gate
//      row and a notification). `seedFresh()` therefore ALSO checks that the reset is still pending. The subagent tests run after
//      that, because they need the reset (continuation after the minimum wait instead of after the window).
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as limits from "../electron/server/limits.js";
import { runOnce } from "../electron/server/providers/index.js";
import { liveAgents } from "../electron/server/runs/agents.js";
import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { RIPCORD } from "./ripcord.mjs";
import { readJsonl as readJsonlValue } from "./jsonl.mjs";
import { waitForQuiet } from "./quiet.mjs";

// Fast deadlines: `./check` sets them; called alone, every reset case would otherwise wait 45 s grace plus 20 s minimum
// wait of real wall clock (see limits.js, envMs).
//
// CBASE_EMBED_OFFLINE: `isolateCredentials` points HOME at a temp directory where no embedding model lies — without the line
// EVERY server of this file would fetch ~130 MB from the network (embeddings.js, cache under $HOME), called alone as well as in
// the gate (check.mjs sets it there). With it the server loads from the cache under node_modules or stays lexical.
for (const [k, v] of [["CBASE_LIMIT_GRACE_MS", "2000"], ["CBASE_LIMIT_MIN_WAIT_MS", "2000"], ["CBASE_EMBED_OFFLINE", "1"]]) {
  if (!process.env[k]) process.env[k] = v;
}

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`${res.status}: ${JSON.stringify(body)}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for an event — WITHOUT a deadline (the emergency brake is the suite deadline). Every 30 s a line on stderr so that a hang
// says what it waits for; `what` may be an (async) function that reads the situation only when reporting. The end of the work is
// measured by waitForQuiet (quiet.mjs).
async function waitFor(fn, what = "", every = 40) {
  const begin = Date.now();
  let reported = begin;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - reported >= 30_000) {
      reported = Date.now();
      let text = what;
      if (typeof what === "function") { try { text = await what(); } catch (e) { text = `(Situation not readable: ${e?.message || e})`; } }
      console.error(`[waiting] for ${Math.round((reported - begin) / 1000)} s: ${text || String(fn).replace(/\s+/g, " ").slice(0, 160)}`);
    }
    await sleep(every);
  }
}
// KNOWN TRAP: startServer({port:0}) sets BASE_URL to "…:0" — every run's MCP config would then point into the void, and the
// subagent path (fake CLI → MCP server → HTTP) would break silently.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const port = srv.address().port; srv.close(() => resolve(port)); });
  });
}

// Keep the Anthropic usage endpoint out of the test (empty HOME, `security` that finds nothing, no OAuth token). The live fetch
// then fails at once — and exactly then the persisted state that the seed supplies applies.
function isolateCredentials(root) {
  const binDir = path.join(root, "shim");
  fs.mkdirSync(binDir, { recursive: true });
  const security = path.join(binDir, "security");
  fs.writeFileSync(security, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(security, 0o755);
  // `npx` as a no-op: every server loads the Playwright MCP into the npx cache of the redirected HOME at start — over the
  // network, up to 300 s (toolchain/playwright.js), and the grandchild keeps the test process open that long. No test here
  // needs the browser.
  const npx = path.join(binDir, "npx");
  fs.writeFileSync(npx, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(npx, 0o755);
  process.env.NPX_BIN = npx;
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

// ── The seed, ONE PER TEST ────────────────────────────────────────────────────────────────────
// Session window 100 %, measured NOW, reset in SEED_RESET_S seconds. Built in `withServer`, so anew for EVERY test (`newSeed()`);
// `seed()` always returns the same one within a test.
//
// One seed for the whole file would force the tests into a particular ORDER, the whole file to be through within five minutes,
// and the reset to lie far ahead because it had to outlast the gate tests — under high test concurrency the predecessors became
// slower, used the time up, and the last gate test reported a functional error where only the clock had run out. A test that
// measures how fast its predecessors finished. The separation works because `account/usage.js` re-reads the persisted state as
// long as no live fetch has succeeded — and in the test none ever does.
//
// The reset may therefore be short: it only has to outlast ONE test. And it is short only where a test NEEDS it (subagents,
// counter-proof — `resetS: SEED_RESET_S` on the test): the gate tests take an hour. With 20 s even "outlast one test" was still a
// clock — a gate test that took longer under load saw the reset pass, the gate no longer blocked (point 3 in the header), and it
// reported a functional error where only the machine was slow.
const SEED_RESET_S = 20;
const GATE_RESET_S = 3600;
let SEED = null;
let seedResetS = GATE_RESET_S;
function newSeed(resetS = GATE_RESET_S) {
  SEED = null;
  seedResetS = resetS;
  return seed();
}
function seed() {
  if (SEED) return SEED;
  const at = Date.now();
  const resetAt = at + seedResetS * 1000;
  const iso = new Date(resetAt).toISOString();
  SEED = {
    at, resetAt,
    data: {
      fiveHour: { utilization: 100, resetsAt: iso },
      sevenDay: { utilization: 4, resetsAt: null },
      limits: [
        { kind: "session", group: "session", percent: 100, resets_at: iso },
        { kind: "weekly", group: "weekly", percent: 4, resets_at: null },
      ],
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25, currency: "USD", disabled_reason: "", spend_limit_reached: false },
      at,
    },
  };
  return SEED;
}
// Precondition of every gate test: the seed is still "fresh" for the gate (5 min, see header). Without this check a run that is
// too slow would report "the gate did not park" — a functional error where only the clock had run out.
function seedFresh() {
  // Since the seed per test, both checks measure only THIS test, no longer its predecessors. They stay anyway: a single test that
  // uses up the 20 s should say so in plain words instead of reporting "the gate did not park".
  const ages = Date.now() - seed().at;
  assert.ok(ages < 4 * 60_000, `seed is ${Math.round(ages / 1000)} s old — the gate would consider it stale and start. THIS test is too slow.`);
  const untilReset = seed().resetAt - Date.now();
  assert.ok(untilReset > 3_000, `the seed's reset is ${untilReset <= 0 ? "past" : `in ${Math.round(untilReset / 1000)} s`} — the gate does not block on a window whose reset has passed (point 3 in the header). THIS test takes longer than its reset (resetS).`);
}
const graceMs = () => limits.defaultGraceMs();

// ── Fake Claude: ONE CLI for all roles of this file ───────────────────────────────────────────
// Told apart by `--append-system-prompt` (buildClaudeChatArgs sets it on EVERY chat and on no oneshot — an image oneshot uses
// `--input-format` just the same). What it does is steered by environment variables and marker files so that one script is enough:
//   CBASE_TEST_ONESHOTS / _TURNS   recording (JSONL) — the main measurement: "parked" means the CLI was not even called. The
//                                    oneshot branch records TOO (in credit-gate.test.js it does not).
//   CBASE_TEST_TITLE_MARKER        the title oneshot answers EMPTY as long as the file is missing — so the chat stays untitled,
//                                    and the second title oneshot at the turn END is the one that is measured (turn release).
//   CBASE_TEST_FREE_MARKER         the main turn answers only when the file is there — the window in which the test switches the
//                                    gate ON.
//   CBASE_TEST_PARENT              "agent" | "agent-bg": the main agent starts a subagent through the REAL MCP server
//                                    (foreground/background) and mirrors the MCP result's `isError` as `is_error` — exactly what
//                                    the real CLI does with an MCP error result.
//   CBASE_TEST_SUB                 "limit": the subagent CLI dies with exit 1 and the real CLI's wording (counter
//                                    CBASE_TEST_SUB_STATE, cap CBASE_TEST_SUB_LIMIT); "domain-text": a clean report in which
//                                    "Rate Limit" stands as DATA (counter-proof).
const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
const env = process.env;
const argv = process.argv.slice(2);
const isChat = argv.includes("--append-system-prompt");
const jsonl = (file, o) => { if (!file) return; try { fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\\n"); } catch {} };
const short = (s) => String(s || "").replace(/\\s+/g, " ").slice(0, 160);

if (!isChat) {
  // Oneshot: plain text arrives raw via stdin ({result} answer), material as a stream-json row.
  const streamMode = argv.includes("--input-format");
  let stdin = ""; process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    let prompt = stdin;
    if (streamMode) {
      try {
        const msg = JSON.parse(stdin.trim().split("\\n")[0]);
        prompt = ((msg.message && msg.message.content) || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      } catch { /* unreadable — then the raw text */ }
    }
    let kind = "otherwise", result = "Title";
    if (/compacting the chat history/i.test(prompt)) { kind = "compact"; result = "SUMMARY: state of the history"; }
    else if (/overarching target/i.test(prompt)) { kind = "target"; result = JSON.stringify({ achieved: true, note: "goal achieved" }); }
    else if (/ONE condition in a workflow/i.test(prompt)) { kind = "turnout"; result = JSON.stringify({ yes: true, note: "test default" }); }
    else if (/work step is DONE/i.test(prompt)) { kind = "gate"; result = JSON.stringify({ done: true, note: "" }); }
    else if (/rephrase a given text/i.test(prompt)) { kind = "adjust"; result = "REPHRASED"; }
    else if (prompt.includes("<chat>")) {
      kind = "title";
      const marker = env.CBASE_TEST_TITLE_MARKER || "";
      result = marker && !fs.existsSync(marker) ? "" : "Title";
    }
    jsonl(env.CBASE_TEST_ONESHOTS, { kind, argv, prompt: short(prompt), response: result.slice(0, 60) });
    if (streamMode) say({ type: "result", result, session_id: "oneshot-fake" });
    else process.stdout.write(JSON.stringify({ result }));
    process.exit(0);
  });
} else {
  const isSub = argv.join(" ").includes("SUBAGENT of cbase");
  const cfgPath = argv[argv.indexOf("--mcp-config") + 1] || "";
  let done = false, turns = 0;
  process.stdin.on("end", () => process.exit(done ? 0 : 3));

  // A REAL MCP call: start the cbase MCP server named in the config and speak tools/call — the same way a model takes.
  // The tool use id goes along as _meta like with the real CLI.
  function mcpCall(name, args, toolUseId) {
    return new Promise((resolve, reject) => {
      let cfg;
      try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase; }
      catch (e) { return reject(new Error("MCP config unreadable: " + e.message)); }
      const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...(cfg.env || {}) }, stdio: ["pipe", "pipe", "inherit"] });
      let buf = "";
      // No deadline of its own (a 30 s "MCP timeout" used to be used up by a foreground subagent under load, and the test reported
      // a functional error): if the call hangs, the fake ends at its ripcord.
      child.stdout.on("data", (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.id === 2) { try { child.stdin.end(); } catch {} resolve(m); }
        }
      });
      child.on("error", (e) => reject(e));
      const send = (o) => child.stdin.write(JSON.stringify(o) + "\\n");
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args, ...(toolUseId ? { _meta: { "claudecode/toolUseId": toolUseId } } : {}) } });
    });
  }
  const textOf = (m) => (m && m.result && m.result.content && m.result.content[0] && m.result.content[0].text) || "";
  const response = (id, out) => {
    say({ type: "assistant", message: { id, usage: { input_tokens: 11, output_tokens: 5 }, content: [{ type: "text", text: out }] } });
    done = true;
    say({ type: "result", result: out, session_id: isSub ? "sub-session" : "main-session" });
  };

  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
    jsonl(env.CBASE_TEST_TURNS, { role: isSub ? "sub" : "main", text: short(text), pid: process.pid });

    if (isSub) {
      const mode = env.CBASE_TEST_SUB || "";
      if (mode === "limit") {
        let n = 0;
        try { n = Number(fs.readFileSync(env.CBASE_TEST_SUB_STATE, "utf8")) || 0; } catch {}
        if (n < (Number(env.CBASE_TEST_SUB_LIMIT) || 1)) {
          try { fs.writeFileSync(env.CBASE_TEST_SUB_STATE, String(n + 1)); } catch {}
          // The real CLI's wording, exit ≠ 0 — exactly the case of the finding: this subagent used to count as "completed" with
          // "(no report)".
          process.stderr.write("Claude usage limit reached · resets at " + new Date(Date.now() + 2000).toISOString() + "\\n");
          setTimeout(() => process.exit(1), 30);
          return;
        }
      }
      const report = mode === "domain-text"
        ? "I set the Rate Limit to 100 req/s and tested it — the Rate Limit is reached, 429 Too Many Requests comes as expected."
        : "Finding 42";
      setTimeout(() => response("sub-1", report), 30);
      return;
    }

    const mode = env.CBASE_TEST_PARENT || "";
    if (mode === "agent" || mode === "agent-bg") {
      turns += 1;
      // The completion notice is a run of its own, so a new process — recognized by its marker, not by the counter.
      if (!String(text).startsWith("<task-notification>")) {
        const bg = mode === "agent-bg";
        const input = { description: "subtask", prompt: "Look into it and report the finding.", run_in_background: bg };
        // The call block MUST be in the stream before the tool call: that is how the server recognizes under which block it hangs
        // the subagent's events (parentToolUseId).
        say({ type: "assistant", message: { id: "main-1", usage: { input_tokens: 20, output_tokens: 8 },
          content: [{ type: "tool_use", id: "toolu_agent_call", name: "mcp__cbase__cbase_agent", input }] } });
        let res = null, t = "";
        try { res = await mcpCall("cbase_agent", input, "toolu_agent_call"); t = textOf(res); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
        const error = Boolean(res && res.result && res.result.isError === true);
        say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_agent_call", content: t, ...(error ? { is_error: true } : {}) }] } });
        // Stay honest: an MCP error (timeout, config) must not look like a finding — "DONE" exists only for a report with
        // status completed.
        let report = null; try { report = JSON.parse(t); } catch {}
        const out = bg ? "Subagent running on the side" : error ? "The subagent could not work." : (report && report.status === "completed") ? "DONE with finding" : "ERROR: " + short(t).slice(0, 120);
        say({ type: "assistant", message: { id: "main-2", content: [{ type: "text", text: out }] } });
        done = true; // the turn does not hold: the report arrives as a run of its own (completion notice)
        say({ type: "result", result: out, session_id: "main-session" });
        return;
      }
      // Second turn: arises ONLY if the server delivered the background agent's report.
      response("main-3", "Delivered: " + String(text || "").replace(/\\s+/g, " ").slice(0, 4000));
      return;
    }

    const marker = env.CBASE_TEST_FREE_MARKER || "";
    const finished = () => response("main-1", "DONE " + short(text).slice(0, 60));
    if (marker && !fs.existsSync(marker)) {
      const t = setInterval(() => { if (fs.existsSync(marker)) { clearInterval(t); finished(); } }, 50);
      return;
    }
    setTimeout(finished, 20);
  });
}
`;

// Fake Codex: only the oneshot branch (-o <file>) — for the counter-proof "Codex is not gated at the spawn layer".
const fakeCodex = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const i = args.indexOf("-o");
if (i >= 0 && args[i + 1]) { try { fs.writeFileSync(args[i + 1], "Codex title"); } catch {} }
try { fs.appendFileSync(process.env.CBASE_TEST_ONESHOTS, JSON.stringify({ kind: "codex", argv: args }) + "\\n"); } catch {}
process.exit(0);
`;

// Only completed lines (jsonl.mjs): the fake CLI writes the log while the test reads.
const readJsonl = readJsonlValue;

async function withServer(fn, { env = {}, codex = false, resetS = GATE_RESET_S } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-startgate-"));
  const oneshotLog = path.join(root, "oneshots.jsonl");
  const turnLog = path.join(root, "turns.jsonl");
  const keys = ["CLAUDE_BIN", "CODEX_BIN", "NPX_BIN", "CBASE_TRIGGER_POLL", "CBASE_TEST_ONESHOTS", "CBASE_TEST_TURNS",
    "CBASE_RESTART_GRACE_MS", "HOME", "PATH", "CLAUDE_CODE_OAUTH_TOKEN",
    "CBASE_TEST_TITLE_MARKER", "CBASE_TEST_FREE_MARKER", "CBASE_TEST_PARENT", "CBASE_TEST_SUB",
    "CBASE_TEST_SUB_STATE", "CBASE_TEST_SUB_LIMIT", ...Object.keys(env)];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  let server, base = "";
  let finished = false;   // the body ran through without a throw (see finally)
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) if (v !== undefined && !k.startsWith("CBASE_TEST_")) process.env[k] = v;
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_TEST_ONESHOTS = oneshotLog;
    process.env.CBASE_TEST_TURNS = turnLog;
    // No test here restarts: the restart (resumeInterruptedWork, queue) stays off.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3600_000);
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    isolateCredentials(root);
    const bin = path.join(root, "fake-claude");
    fs.writeFileSync(bin, fakeClaude);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    if (codex) {
      const cbin = path.join(root, "fake-codex");
      fs.writeFileSync(cbin, fakeCodex);
      fs.chmodSync(cbin, 0o755);
      process.env.CODEX_BIN = cbin;
    }
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    const port = await freePort();
    server = await startServer({ port, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${port}`;
    // Seed BEFORE the first model call, and fresh for EVERY test: `fetchUsageLimits` re-reads the persisted state as long as no
    // live fetch has succeeded, so the new seed really takes effect.
    store.setSetting("usage_cache_v1", JSON.stringify(newSeed(resetS).data));
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Start-Gate", path: wsPath }) });
    await fn({ base, ws, root, server, oneshots: () => readJsonl(oneshotLog), turns: () => readJsonl(turnLog) });
    finished = true;
  } finally {
    // Wait for quiet only if the body passed (template: agent-harness.mjs) — after a failure a hanging run would otherwise stand
    // without a deadline, and the error above would never arrive.
    if (base && finished) await waitForQuiet(base);
    if (server) await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // A failure while cleaning up is a statement about the cleanup, not about the product. NOT patient: npm still writes into the
    // faked HOME (`.npm/_cacache`) when the server is long closed, and rmSync retries on EVERY level — with 20×150 ms that cost a
    // measured 30 s per test. Better a corpse in /tmp that the system cleans up itself.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — the test is unaffected.`); }
  }
}

const newChat = (base, ws) =>
  json(`${base}/api/chats`, {
    method: "POST",
    body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
  });
const send = (base, id, text) => json(`${base}/api/chats/${id}/message`, { method: "POST", body: JSON.stringify({ text }) });
const waitState = (base, id) => json(`${base}/api/chats/${id}/auto-continue`);
const log = (base, id) => json(`${base}/api/chats/${id}/log`);
const limitKinds = async (base, id) => (await log(base, id)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text).kind);
const gateOn = (base, on = true) => json(`${base}/api/credit-gate`, { method: "PUT", body: JSON.stringify({ enabled: on }) });
const autoContinue = (base, on) => json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: on }) });
const dismiss = (base, id) => json(`${base}/api/chats/${id}/auto-continue`, { method: "DELETE" });
const waitRow = (base, id) => waitFor(async () => (await waitState(base, id)).wait || null, `wait row of ${id}`);
const mainTurns = (turns) => turns().filter((t) => t.role === "main");
// A chat's queue is in no GET answer, only in the stream's `connected` event — read ONE event, then close the connection (an
// open stream would hold server.close() forever).
async function queue(base, id) {
  const ac = new AbortController();
  try {
    const res = await fetch(`${base}/api/chats/${id}/stream`, { signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return [];
      buf += dec.decode(value, { stream: true });
      for (const line of buf.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const evt = JSON.parse(line.slice(6));
        if (evt.type === "harness" && evt.subtype === "connected") return evt.queued || [];
      }
    }
  } finally { ac.abort(); }
}

// ── runOnce without a chat ───────────────────────────────────────────────────────────────────
// The hook sits in providers/index.js and is installed by startServer (setStartGate). A call WITHOUT a chat has no turn release
// it could slip past: it must fail with the canonical wording that every limit detection reads and from which it reads back the
// reset. Counter-proofs: gate off ⇒ the oneshot runs (the fake CLI answers); Codex ⇒ no gate at the spawn layer, even with a
// full Claude window.
test("runOnce without a chat: the start gate throws the limit wording — gate off and Codex run", async () => {
  await withServer(async ({ base, ws, root, oneshots }) => {
    seedFresh();
    await gateOn(base);
    // Without a deadline of its own: the product's applies (runOnceClaude, 90 s).
    const opts = { model: "claude::claude-haiku-4-5-20251001", cwd: root };
    let error = null;
    try { await runOnce("Say OK", opts); } catch (e) { error = e; }
    assert.ok(error, "runOnce slipped past the gate — no error");
    assert.ok(error.gate, "the error carries no `gate` information");
    assert.ok(error.gate.percent >= 99, `gate percent: ${error.gate.percent}`);
    assert.equal(error.gate.window?.group, "session");
    assert.equal(error.message, limits.gateLimitText(error.gate.window), "the wording is THE ONE from limits.js");
    // The wording is built so that the existing detection reads it as a limit AND reads the reset back to the millisecond — only
    // that way does every caller end up parking without a special path.
    const hit = limits.detectLimitHit({ stderr: error.message });
    assert.equal(hit.hit, true, `detectLimitHit does not recognize the gate wording: ${error.message}`);
    assert.equal(hit.credits, false, "\"credit gate\" must not be read as a credit case — then nobody would wait for the reset");
    assert.ok(Math.abs((hit.resetAt || 0) - seed().resetAt) < 1000, `reset from the text (${hit.resetAt}) ≠ the seed's reset (${seed().resetAt})`);
    // With a chat id too, but without a running turn: no release, so checked.
    const chat = await newChat(base, ws);
    await assert.rejects(runOnce("Say OK", { ...opts, chatId: chat.id }), /credit gate/, "a oneshot with a chat id but without a running turn ran through");
    assert.equal(oneshots().length, 0, `the CLI was called despite the gate: ${JSON.stringify(oneshots())}`);

    // Counter-proof gate off: the same call runs, the CLI answers.
    await gateOn(base, false);
    assert.equal(await runOnce("Say OK", opts), "Title");
    assert.equal(oneshots().length, 1);

    // Counter-proof Codex: the gate is Claude-only — no query endpoint, no gate.
    await gateOn(base);
    assert.equal(await runOnce("Say OK", { ...opts, model: "codex::gpt-5.6-sol" }), "Codex title", "Codex was gated at the spawn layer");
    assert.equal(oneshots().filter((o) => o.kind === "codex").length, 1);
  }, { codex: true });
});

// ── adjust ───────────────────────────────────────────────────────────────────────────────────
// `POST /api/adjust` is a oneshot without a chat and without a parking path: at the gate the user should see the limit message
// ("honest, not secret") — no empty success, no silent run on credit.
test("adjust at the gate: HTTP error with the limit wording, no empty success — gate off runs", async () => {
  await withServer(async ({ base, oneshots }) => {
    seedFresh();
    await gateOn(base);
    const body = JSON.stringify({ text: "The test system is up.", prompt: "More formal" });
    const error = await json(`${base}/api/adjust`, { method: "POST", body }).then(() => null, (e) => e);
    assert.ok(error, "adjust answered success at the gate");
    assert.equal(error.status, 502);
    assert.match(error.body.error, /credit gate/, `the user does not see the reason: ${error.body.error}`);
    assert.equal(limits.detectLimitHit({ stderr: error.body.error }).hit, true);
    assert.equal(oneshots().length, 0, "the CLI ran despite the gate");
    // An instruction that delivered nothing is NOT remembered (route: remember only after success).
    assert.deepEqual((await json(`${base}/api/adjust/prompts`)).items, []);

    await gateOn(base, false);
    const ok = await json(`${base}/api/adjust`, { method: "POST", body });
    assert.equal(ok.fresh, "REPHRASED");
    assert.deepEqual(oneshots().map((o) => o.kind), ["adjust"]);
  });
});

// ── A workflow's node turn ───────────────────────────────────────────────────────────────────
// The driver starts a step's turn through doRun — there the gate acts like with the composer, but the row carries
// `workflow: true`, and the overview must show the chat as WAITING, not as "running", and only ONCE (before: two entries, above
// "running", below without a workflow reference). If the user discards the row, the workflow ends — a "running" workflow without
// a driver is never a usable state.
test("workflow node at the gate: parked with workflow:true — /api/active-runs shows it ONCE as waiting", async () => {
  await withServer(async ({ base, ws, turns }) => {
    seedFresh();
    await gateOn(base);
    const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name: "Gate-Flow" }) });
    await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ run: { doneAll: false }, graph: {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Work", text: "THE NODE NOW", x: 200, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }],
    } }) });
    const chat = await newChat(base, ws);
    const r = await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id, input: "my job" }) });
    const runId = r.run.id;

    const wait = await waitRow(base, chat.id);
    assert.equal(wait.kind, "run");
    assert.equal(wait.reason, "credit");
    assert.equal(wait.gate, true);
    assert.equal(wait.workflow, true, "the row does not know that a workflow hangs on it");
    await waitForQuiet(base);
    assert.deepEqual(mainTurns(turns), [], `the node turn ran despite the gate: ${JSON.stringify(turns())}`);
    assert.equal((await json(`${base}/api/workflow-runs/${runId}`)).run.status, "running", "parked means: the run is open, not finished");

    // The overview: ONE entry for this chat, and it says "waiting" (phase limit) with the row.
    const items = (await json(`${base}/api/active-runs`)).items.filter((i) => i.chatId === chat.id);
    assert.equal(items.length, 1, `the chat appears ${items.length}× in the overview: ${JSON.stringify(items.map((i) => [i.kind, i.phase]))}`);
    const [entry] = items;
    assert.equal(entry.kind, "workflow");
    assert.equal(entry.phase, "limit", `a parked workflow chat was led as "${entry.phase}"`);
    assert.ok(entry.limit, "the wait row is missing on the workflow entry");
    assert.equal(entry.limit.reason, "credit");
    assert.equal(entry.limit.gate, true);
    assert.equal(entry.workflow?.runId, runId);
    assert.equal(entry.background?.wakeupAt, wait.dueAt, "the entry's wakeup time is not the row's");

    // Discarding ends the workflow: no driver any more, no lock, no zombie.
    await dismiss(base, chat.id);
    await waitFor(async () => ((await json(`${base}/api/workflow-runs/${runId}`)).run.status === "failed" ? true : null), "workflow run failed");
    assert.equal((await waitState(base, chat.id)).wait, null);
    assert.equal((await json(`${base}/api/active-runs`)).items.some((i) => i.chatId === chat.id), false, "the ended run is still in the overview");
    assert.deepEqual(mainTurns(turns), [], "discarding started the node turn");
  });
});

// ── The turn release covers the turn's oneshots ──────────────────────────────────────────────
// The gate decides at the turn START; the turn's trailing jobs (title, curator) get its release as an argument (`release:true`
// from doRun, nowhere else). Measured on the title oneshot that starts at the turn end from doRun: the gate is switched ON
// while the turn runs — the oneshot runs anyway. After the turn there is no release: a `/compact` (same chat, same chat id on the
// oneshot) is intercepted and parked as a compaction.
//
// Why the title oneshot is measured at the END and not the one at the first message: there it runs BEFORE doRun, without a
// release. The fake CLI answers it empty (marker missing), the chat stays untitled, and the second attempt at the turn end is the
// one under the release.
test("turn release: the title oneshot at the turn end runs despite the gate — the compaction afterwards parks", async () => {
  const marker = path.join(os.tmpdir(), `cbase-startgate-free-${process.pid}-${Date.now()}`);
  try {
    await withServer(async ({ base, ws, oneshots, turns }) => {
      seedFresh();
      assert.equal((await json(`${base}/api/credit-gate`)).enabled, false, "precondition: the gate is OFF when the turn starts");
      const chat = await newChat(base, ws);
      await send(base, chat.id, "Please do something");
      // The turn runs (the CLI has the message) and waits for the marker.
      await waitFor(async () => (mainTurns(turns).length === 1 ? true : null), "the turn runs");
      // The first title attempt (at the message, without a release) came out empty.
      await waitFor(async () => (oneshots().some((o) => o.kind === "title") ? true : null), "first title oneshot");
      assert.equal((await json(`${base}/api/chats/${chat.id}`)).titled, false, "the chat is already titled — the turn-end oneshot would find nothing to do");

      // NOW switch the gate on — in the middle of the turn — and let the turn end.
      await gateOn(base);
      fs.writeFileSync(marker, "free");
      await waitFor(async () => {
        const l = await log(base, chat.id);
        return l.some((e) => e.role === "assistant" && e.text.startsWith("DONE")) ? true : null;
      }, "answer of the turn");
      await waitForQuiet(base);
      // The title oneshot at the turn end: called (second entry) AND effective.
      const title = await waitFor(async () => {
        const c = await json(`${base}/api/chats/${chat.id}`);
        return c.titled ? c : null;
      }, "title at the turn end");
      assert.equal(title.title, "Title", "the title oneshot under the turn release did not arrive");
      const titleCalls = oneshots().filter((o) => o.kind === "title");
      assert.equal(titleCalls.length, 2, `title oneshots: ${JSON.stringify(titleCalls.map((o) => o.response))}`);
      assert.equal(titleCalls[1].response, "Title");
      assert.equal((await limitKinds(base, chat.id)).includes("gate"), false, "the running turn was gated afterwards");
      assert.equal((await waitState(base, chat.id)).wait, null, "after a cleanly ended turn nothing waits");

      // After the turn: no release any more. The compaction goes through runOnce WITH a chat id — and is intercepted, as a wait
      // row of kind compact, without the CLI running.
      const out = await json(`${base}/api/chats/${chat.id}/compact`, { method: "POST" });
      assert.equal(out.ok, false);
      assert.equal(out.limited, true, `the compaction slipped past the gate or failed otherwise: ${JSON.stringify(out)}`);
      const wait = await waitRow(base, chat.id);
      assert.equal(wait.kind, "compact");
      assert.equal(oneshots().some((o) => o.kind === "compact"), false, "the compaction CLI ran despite the gate");
      assert.ok(!(await json(`${base}/api/chats/${chat.id}`)).contextSummary, "the history was touched although nothing was summarized");
      await dismiss(base, chat.id);
    }, { env: { CBASE_TEST_TITLE_MARKER: marker, CBASE_TEST_FREE_MARKER: marker } });
  } finally {
    try { fs.rmSync(marker, { force: true }); } catch {}
  }
});

// ── The target verdict AFTER the turn ────────────────────────────────────────────────────────
// The release ends with the turn (doRun removes the chat in the finally) — the target gate deliberately runs only AFTERWARDS
// (behind the compaction). Its verdict is thus a oneshot outside the turn: the gate checks it itself, and at the limit it is
// PARKED (isLimitError ⇒ parkJudge) — not silently "unchecked" as before, and not waved through. The turn itself is through; only
// the verdict waits.
test("target gate after the turn: the verdict has no release any more and parks (judge) — the turn itself ran", async () => {
  const marker = path.join(os.tmpdir(), `cbase-startgate-target-${process.pid}-${Date.now()}`);
  try {
    await withServer(async ({ base, ws, oneshots, turns }) => {
      seedFresh();
      const chat = await newChat(base, ws);
      await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ goal: "Bring the thing to an end" }) });
      await send(base, chat.id, "First message");
      await waitFor(async () => (mainTurns(turns).length === 1 ? true : null), "the turn runs");
      await gateOn(base);
      fs.writeFileSync(marker, "free");

      const wait = await waitRow(base, chat.id);
      assert.equal(wait.kind, "judge", `what was parked is not the verdict: ${JSON.stringify(wait)}`);
      const l = await log(base, chat.id);
      assert.ok(l.some((e) => e.role === "assistant" && e.text.startsWith("DONE")), "the turn's answer is missing — the turn should have run");
      assert.equal(l.some((e) => e.role === "goal"), false, "before the reset there must be no verdict");
      assert.equal(oneshots().some((o) => o.kind === "target"), false, "the verdict CLI ran despite the gate");
      assert.equal((await json(`${base}/api/chats/${chat.id}`)).goal, "Bring the thing to an end", "the goal was cleared without a verdict");
      await dismiss(base, chat.id);
    }, { env: { CBASE_TEST_FREE_MARKER: marker } });
  } finally {
    try { fs.rmSync(marker, { force: true }); } catch {}
  }
});

// ── The verdicts AFTER the turn are starts of their own — and park as a GATE row ───────────────
// Two root findings, one test:
//   · The turn release ended at a random boundary: the FIRST attempt of the completion gate still ran under it (reached
//     synchronously from the run), its retry and every switch after it did not. Now the release is an argument (`release` for
//     title and curator, nothing else): the completion gate after the turn asks the start gate ITSELF — and is intercepted.
//   · An intercepted verdict ended up as a TIME-LIMIT row: with A=off the workflow ended at the first verdict point as "failed",
//     with A=on the row lacked the gate marker. Now `err.gate` carries the origin up to maybeAutoContinue: row `reason:"credit"`,
//     switch A has nothing to say, and "Start anyway" releases the WHOLE verdict chain up to the next turn (gate → switch), which
//     asks its gate itself again.
// Counter-proof against the old state: there the oneshot "gate" ran despite the gate (release), and the switch after it ended the
// run with an `off` row as "failed".
test("A=off, B=on: the completion gate after the turn parks as a GATE row — \"Start anyway\" releases gate and switch, the next turn asks itself", async () => {
  const marker = path.join(os.tmpdir(), `cbase-startgate-verdict-${process.pid}-${Date.now()}`);
  try {
    await withServer(async ({ base, ws, oneshots, turns }) => {
      seedFresh();
      await autoContinue(base, false);
      const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name: "Verdict-Flow" }) });
      await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ run: { doneAll: false }, graph: {
        nodes: [
          { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
          { id: "n1", type: "instruction", title: "Work", text: "DO THE WORK", doneCheck: true, doneText: "Is the work done?", x: 200, y: 0 },
          { id: "c1", type: "condition", title: "Done?", text: "Is it done?", x: 400, y: 0 },
          { id: "n2", type: "instruction", title: "Afterwards", text: "AFTERWARDS", x: 600, y: 0 },
          { id: "e0", type: "end", title: "End", x: 800, y: 0 },
        ],
        edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "c1" }, { from: "c1", to: "n2", branch: "true" }, { from: "c1", to: "e0", branch: "false" }, { from: "n2", to: "e0" }],
      } }) });
      const chat = await newChat(base, ws);
      const r = await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id, input: "my job" }) });
      const runId = r.run.id;
      // The node turn runs (gate off) and waits for the marker — NOW switch the gate on.
      await waitFor(async () => (mainTurns(turns).length === 1 ? true : null), "the node turn runs");
      await gateOn(base);
      fs.writeFileSync(marker, "free");

      // After the turn: the completion gate is a start of its own — intercepted, parked as GATE.
      const wait = await waitRow(base, chat.id);
      assert.equal(wait.kind, "judge", `what was parked is not the verdict: ${JSON.stringify(wait)}`);
      assert.equal(wait.reason, "credit", "the row of an intercepted verdict belongs to switch B");
      assert.equal(wait.gate, true);
      assert.equal(wait.workflow, true);
      assert.match(wait.text, /Urteil wartet/, `the strip does not name the kind: ${wait.text}`);
      assert.equal((await json(`${base}/api/workflow-runs/${runId}`)).run.status, "running", "A=off: the workflow ended at the gate as failed instead of waiting (old regression)");
      assert.equal(oneshots().some((o) => o.kind === "gate" || o.kind === "turnout"), false, `a verdict ran despite the gate: ${JSON.stringify(oneshots().map((o) => o.kind))}`);
      const kinds = await limitKinds(base, chat.id);
      assert.ok(kinds.includes("gate"), `no gate row: ${JSON.stringify(kinds)}`);
      assert.equal(kinds.includes("off"), false, "the row of an intercepted verdict is no time-limit row");
      // Switch A cannot discard it — it is not its own.
      await autoContinue(base, false);
      assert.equal((await waitState(base, chat.id)).wait?.kind, "judge", "A=off discarded the verdict's gate row");

      // "Start anyway": completion gate AND switch run (one chain up to the next turn) — n2's turn asks the gate itself and
      // parks.
      const now = await json(`${base}/api/chats/${chat.id}/auto-continue/now`, { method: "POST", body: JSON.stringify({ anyway: true }) });
      assert.equal(now.ok, true, JSON.stringify(now));
      // Without a deadline; if it hangs, the report line names the situation.
      const next = await waitFor(async () => {
        const w = (await waitState(base, chat.id)).wait;
        return w && w.kind === "run" ? w : null;
      }, async () => `run row of n2 — situation: run=${JSON.stringify((await json(`${base}/api/workflow-runs/${runId}`)).run.status)} rows=${JSON.stringify(await limitKinds(base, chat.id))} oneshots=${JSON.stringify(oneshots().map((o) => o.kind))} turns=${JSON.stringify(mainTurns(turns).map((t) => t.text))} wait=${JSON.stringify((await waitState(base, chat.id)).wait)}`);
      assert.equal(next.reason, "credit");
      assert.equal(next.workflow, true);
      assert.deepEqual(oneshots().map((o) => o.kind).filter((a) => a === "gate" || a === "turnout"), ["gate", "turnout"], "the chain did not run completely under the release");
      assert.equal(mainTurns(turns).length, 1, `n2's turn slipped past the gate: ${JSON.stringify(mainTurns(turns))}`);
      const kinds2 = await limitKinds(base, chat.id);
      assert.ok(kinds2.includes("gate-free"), `no gate-free row for the released verdict: ${JSON.stringify(kinds2)}`);
      assert.equal(kinds2.includes("resume"), false, "\"Start anyway\" is no reset — no resume row");
      assert.equal((await json(`${base}/api/workflow-runs/${runId}`)).run.status, "running");
      await dismiss(base, chat.id);
      await waitFor(async () => ((await json(`${base}/api/workflow-runs/${runId}`)).run.status === "failed" ? true : null), "workflow run failed");
    }, { env: { CBASE_TEST_FREE_MARKER: marker } });
  } finally {
    try { fs.rmSync(marker, { force: true }); } catch {}
  }
});

// ── "Start anyway" releases ONE turn — not the queue behind it ───────────────────────────────
// Measured on the web test bench: the queued second job was injected at the `result` of the released turn into the SAME CLI
// process — two turns, one pid, no second gate row. A click on "costs credit" silently released everything behind the row. Now:
// the marker `runOverruled` stops the injection, the second job starts as a run of its own from the finally — and that one asks the
// gate, which parks it.
test("\"Start anyway\" releases exactly the one turn — the queued job does NOT run along but parks itself", async () => {
  await withServer(async ({ base, ws, turns }) => {
    seedFresh();
    await gateOn(base);
    const chat = await newChat(base, ws);
    await send(base, chat.id, "JOB-ONE");
    const first = await waitRow(base, chat.id);
    assert.equal(first.reason, "credit");
    const second = await send(base, chat.id, "JOB-TWO");
    assert.equal(second.parked, true, JSON.stringify(second));
    const now = await json(`${base}/api/chats/${chat.id}/auto-continue/now`, { method: "POST", body: JSON.stringify({ anyway: true }) });
    assert.equal(now.ok, true, JSON.stringify(now));
    // The second job ends up parked again — as a row of its own.
    const again = await waitFor(async () => {
      const w = (await waitState(base, chat.id)).wait;
      return w && w.kind === "run" && w.createdAt !== first.createdAt ? w : null;
    }, "own row of the second job");
    assert.equal(again.reason, "credit");
    await waitForQuiet(base);
    const main = mainTurns(turns);
    assert.deepEqual(main.map((t) => t.text), ["JOB-ONE"], `the queued job ran along under the first one's release: ${JSON.stringify(main.map((t) => [t.text, t.pid]))}`);
    const kinds = await limitKinds(base, chat.id);
    assert.equal(kinds.filter((a) => a === "gate").length, 2, `one gate decision per job: ${JSON.stringify(kinds)}`);
    assert.equal(kinds.filter((a) => a === "gate-free").length, 1);
    assert.equal(kinds.includes("resume"), false, "\"Start anyway\" is no reset");
    assert.deepEqual(await queue(base, chat.id), [], "the second job is still in the queue although it is parked");
    await dismiss(base, chat.id);
  });
});

// ── "Steer" on a parked chat ─────────────────────────────────────────────────────────────────
// Since "parked is like running", a queue gathers behind a wait row — and so "Steer" is offered on a chat without a process too.
// It used to start the collecting run NEXT TO the row, and when it ran through, its end silently cleared the foreign row: the
// parked job was gone, without a word. Now the row is treated like the running turn: it is discarded explicitly (cancel row),
// and the collecting run asks the gate itself.
test("\"Steer\" on a parked chat discards the wait row EXPLICITLY — the parked job never runs silently, the steered one asks the gate", async () => {
  await withServer(async ({ base, ws, turns }) => {
    seedFresh();
    await gateOn(base);
    const chat = await newChat(base, ws);
    await send(base, chat.id, "JOB-A");
    await waitRow(base, chat.id);
    assert.equal((await send(base, chat.id, "JOB-B")).parked, true);
    const r = await json(`${base}/api/chats/${chat.id}/control`, { method: "POST" });
    assert.equal(r.ok, true, JSON.stringify(r));
    const rows = (await log(base, chat.id)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text));
    const cancel = rows.find((z) => z.kind === "cancel");
    assert.ok(cancel, `no cancel row — the wait row was discarded silently: ${JSON.stringify(rows.map((z) => z.kind))}`);
    assert.match(cancel.text, /Gesteuert/);
    // The steered job asks the gate — and parks as a NEW row.
    const fresh = await waitFor(async () => {
      const w = (await waitState(base, chat.id)).wait;
      return w && w.kind === "run" && w.createdAt > cancel.at - 1 ? w : null;
    }, "new row of the steered job");
    assert.equal(fresh.reason, "credit");
    assert.deepEqual(mainTurns(turns), [], "a turn slipped past the gate");
    // Gate off, release: ONLY the steered job runs — A is discarded, not lost (the cancel row says so), and never runs "by itself"
    // afterwards.
    // Gate off releases the rows parked by the gate ITSELF (route PUT /api/credit-gate).
    await gateOn(base, false);
    await waitFor(async () => (mainTurns(turns).length ? true : null), "the released turn");
    // Quiet: whatever could still have run after the release (A "by itself" afterwards) has run by then.
    await waitForQuiet(base);
    assert.deepEqual(mainTurns(turns).map((t) => t.text), ["JOB-B"], JSON.stringify(mainTurns(turns)));
  });
});

// ── Skipping a node parked at the gate ──────────────────────────────────────────────────────
// The node turn's run row belongs to the node. Skipping used to clear only a judge row; the run row stayed, fired the SKIPPED node
// at the reset, its result went through the gate as the successor's, and the successor (queued behind the row) then ran a second
// time.
test("skipping a node parked at the gate discards its wait row — the skipped node never runs", async () => {
  await withServer(async ({ base, ws, turns }) => {
    seedFresh();
    await gateOn(base);
    const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name: "Skip-Flow" }) });
    await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ run: { doneAll: false }, graph: {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Work", text: "FIRST NODE", x: 200, y: 0 },
        { id: "n2", type: "instruction", title: "Afterwards", text: "SECOND NODE", x: 400, y: 0 },
        { id: "e0", type: "end", title: "End", x: 600, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
    } }) });
    const chat = await newChat(base, ws);
    const r = await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id, input: "go" }) });
    const runId = r.run.id;
    const first = await waitRow(base, chat.id);
    assert.equal(first.workflow, true);
    const skip = await json(`${base}/api/chats/${chat.id}/workflow/skip`, { method: "POST" });
    assert.equal(skip.ok, true, JSON.stringify(skip));
    const rows = (await log(base, chat.id)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text));
    assert.ok(rows.some((z) => z.kind === "cancel" && /übersprungen/.test(z.text)), `no history line for the discarding: ${JSON.stringify(rows.map((z) => z.kind))}`);
    // n2 parks as its OWN row (not queued behind the old one).
    const second = await waitFor(async () => {
      const w = (await waitState(base, chat.id)).wait;
      return w && w.kind === "run" && w.createdAt !== first.createdAt ? w : null;
    }, "own row of n2");
    assert.equal(second.reason, "credit");
    assert.deepEqual(await queue(base, chat.id), [], "n2 was queued behind n1's row instead of replacing it");
    await gateOn(base, false);
    await waitFor(async () => ((await json(`${base}/api/workflow-runs/${runId}`)).run.status === "done" ? true : null), "workflow run done");
    await waitForQuiet(base);
    assert.deepEqual(mainTurns(turns).map((t) => /SECOND NODE/.test(t.text) ? "n2" : /FIRST NODE/.test(t.text) ? "n1" : "?"), ["n2"], `the skipped node ran: ${JSON.stringify(mainTurns(turns).map((t) => t.text))}`);
  });
});

// ── The own subagent dies at the limit — and PARKS ITSELF ────────────────────────────────────
// The whole path, no shortcut: the main agent's fake CLI calls `cbase_agent` through the REAL MCP server; the server starts a
// second CLI run (the same fake CLI in the subagent role) whose process dies with exit 1 and the real CLI's wording. The agent
// parks itself (this file's window: 100 %, dated): no wait row in the chat, the main agent runs ONCE, after the reset the agent
// continues and its report arrives as a turn at the main agent (the foreground call too returns with "parked" instead of sitting
// out the wait). The whole mechanism: agent-limit-parking.test.js.
async function subagentAtLimit({ base, ws, turns }, { background }) {
  const chat = await newChat(base, ws);
  await send(base, chat.id, "Please work with subagents");
  let parked = false;
  await waitFor(async () => {
    if (liveAgents().some((z) => z.chatId === chat.id && z.status === "parked")) parked = true;
    const l = await log(base, chat.id);
    return l.some((e) => e.role === "assistant" && /Delivered:.*<status>(completed|failed)<\/status>/.test(e.text)) ? true : null;
  }, "subagent report delivered", 20);
  assert.ok(parked, "the subagent did not park itself at the limit");
  const l = await log(base, chat.id);
  assert.ok(l.some((e) => e.role === "assistant" && /Delivered:.*<status>completed<\/status>/.test(e.text)), "the report after the reset is not \"completed\"");
  if (!background) {
    // The foreground call came back with "parked" — no error, no finding.
    const first = l.filter((e) => e.role === "tool_result").map((e) => JSON.parse(e.text)).find((r) => r.id === "toolu_agent_call");
    assert.equal(JSON.parse(first.result).status, "parked", first.result);
    assert.notEqual(first.isError, true);
  }
  await waitForQuiet(base);
  assert.equal((await waitState(base, chat.id)).wait, null, "the pause belongs to the agent — the chat has no wait row");
  assert.deepEqual(await limitKinds(base, chat.id), [], "no limit row in the history");
  const main = mainTurns(turns).filter((t) => /work with subagents/.test(t.text));
  assert.equal(main.length, 1, `the main agent's job did not run exactly once: ${JSON.stringify(main)}`);
  assert.equal(turns().filter((t) => t.role === "sub").length, 2, "the subagent did not run exactly twice (once at the limit, once after the reset)");
}

test("subagent (foreground) dies at the limit: it parks itself, the parent run does not — after the reset its report arrives", async () => {
  await withServer(async (ctx) => {
    await subagentAtLimit(ctx, { background: false });
  }, { env: { CBASE_TEST_PARENT: "agent", CBASE_TEST_SUB: "limit", CBASE_TEST_SUB_STATE: path.join(os.tmpdir(), `cbase-startgate-sub-${process.pid}-${Date.now()}`) }, resetS: SEED_RESET_S });
});

test("subagent (background) dies at the limit: it parks itself, the parent run does not — after the reset its report arrives", async () => {
  await withServer(async (ctx) => {
    await subagentAtLimit(ctx, { background: true });
  }, { env: { CBASE_TEST_PARENT: "agent-bg", CBASE_TEST_SUB: "limit", CBASE_TEST_SUB_STATE: path.join(os.tmpdir(), `cbase-startgate-subbg-${process.pid}-${Date.now()}`) }, resetS: SEED_RESET_S });
});

// ── Counter-proof: a report is data ──────────────────────────────────────────────────────────
// The same path, only the subagent ends CLEANLY — and writes "the Rate Limit is reached" and "429 Too Many Requests" into its
// report as domain text. The server used to search the report for the wording and took it for a hit; with this file's window at
// 100 % the run would have been parked and repeated at the reset. Now only the error marker counts — and it is missing.
test("counter-proof: a successful subagent with \"Rate Limit\" domain text in the report does NOT park", async () => {
  await withServer(async ({ base, ws, turns }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please work with subagents");
    await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.some((e) => e.role === "assistant" && e.text === "DONE with finding") ? true : null;
    }, "answer of the main agent", 100);
    await waitForQuiet(base);
    const rows = (await log(base, chat.id)).filter((e) => e.role === "tool_result").map((e) => JSON.parse(e.text));
    const report = rows.find((r) => r.id === "toolu_agent_call");
    assert.ok(report, "the result of the cbase_agent call is missing in the history");
    assert.equal(report.isError, false);
    assert.equal(JSON.parse(report.result).status, "completed");
    assert.match(JSON.parse(report.result).report, /Rate Limit/, "precondition: the wording is in the report");
    // No waiting "longer than the minimum wait" any more: parking would be decided at the run end, BEFORE the quiet above — a wait
    // row or limit row would already stand (the repetition would only come from it).
    assert.equal((await waitState(base, chat.id)).wait, null, "a report without an error marker parked the run");
    assert.deepEqual(await limitKinds(base, chat.id), [], "and wrote a limit row");
    assert.equal(mainTurns(turns).length, 1, `the job ran more than once: ${JSON.stringify(mainTurns(turns))}`);
  }, { env: { CBASE_TEST_PARENT: "agent", CBASE_TEST_SUB: "domain-text" }, resetS: SEED_RESET_S });
});

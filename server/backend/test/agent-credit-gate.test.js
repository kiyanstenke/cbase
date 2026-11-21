// The credit gate before EVERY subagent start and the cleanup at agent end — at the main seam (real server, real cbase
// MCP server, real core runs/agents.js + providers/agent-runtime.js, fake provider of the agent harness).
//
// Before this, only runOnce asked the start gate (spawn layer, oneshots) and doRun the gate of the turn — subagents run
// through runChat and so bypassed both: at 99 % `cbase_agent` started every child.
//
// The utilization comes from the PERSISTED state (`usage_cache_v1`), which this file seeds — without credentials (empty
// HOME, a `security` that finds nothing, no OAuth token) no live fetch succeeds, and the server re-reads it on every
// call (account/usage.js). The reset lies an hour ahead: no test depends on how fast it is.
//
// A running turn at the gate arises as in start-gate-oneshots.test.js: gate OFF when sending, the main agent waits at a
// gate file, then gate ON, then the file opens — the turn has passed its gate, the subagent asks it itself.
//
// Counter-tests (each shown red once):
//   - `startGate` in the core back to the old state (always null) => tests 1, 2 and 3 start the child and fail.
//   - provider of the CHAT instead of the subagent and the release dropped => tests 2 and 3 fail.
//   - `cleanUpAgent(...)` commented out in onFinish => test 4 finds profile and MCP file after the end and fails.
//   - the try/catch in cleanUpAgent removed => test 5 throws ENOTEMPTY and fails.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { cleanUpAgent } from "../electron/server/runs/agents.js";
import { setDirs } from "../electron/server/app-state.js";

const CLAUDE_SUB = "claude::claude-haiku-4-5-20251001";
const CODEX_SUB = "codex::gpt-5.6-sol";

// Main agent (Claude): runs the commands of its input in order, one tool call with its own block each.
//   OP-GATE:t        waits at gate t (the test flips the gate there)
//   OP-START:X      cbase_agent in the foreground, Claude subagent, task "[X]" (reports at once)
//   OP-LANG:X       the same, the subagent waits at gate "subX" (it LIVES until the test opens)
//   OP-CODEX:X      cbase_agent in the foreground with a Codex subagent
//   OP-SEND:X:Y    cbase_agent_send to X, message "[Y]" with gate "subY"
// An error result of the MCP server is prefixed with "FEHLER " in the tool result.
const claude = fakeClaude({
  sub: `
    const m = /\\[([A-Z])\\]/.exec(text);
    try { fs.appendFileSync(path.join(LOCATION, "sub-start-" + (m ? m[1] : "x")), "1"); } catch {}
    if (m && text.includes("WAIT")) await gate("sub" + m[1]);
    say({ type: "assistant", message: { id: "sub-t-" + turn, content: [{ type: "text", text: "Finding " + (m ? m[1] : "x") }] } });
    finished();
    say({ type: "result", result: "Finding " + (m ? m[1] : "x"), session_id: "sub-session-" + (m ? m[1] : "x") });`,
  main: `
  const calls = async (name, args, id) => {
    say({ type: "assistant", message: { id: "m-" + id, content: [{ type: "tool_use", id, name: "mcp__cbase__" + name, input: args }] } });
    let t = "";
    try { const r = await mcpCall(name, args); t = (r && r.result && r.result.isError ? "FEHLER " : "") + textOf(r); }
    catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  };
  for (const op of text.match(/\\bOP-(GATE|START|LANG|CODEX|SEND):[A-Za-z0-9:]+/g) || []) {
    const [kind, x, y] = op.slice(3).split(":");
    const id = "toolu_" + op.replace(/[^A-Za-z0-9]/g, "_");
    if (kind === "GATE") await gate(x);
    else if (kind === "START") await calls("cbase_agent", { description: "Part " + x, name: x, prompt: "Task [" + x + "].", model: ${JSON.stringify(CLAUDE_SUB)}, run_in_background: false }, id);
    else if (kind === "LANG") await calls("cbase_agent", { description: "Long " + x, name: x, prompt: "Task [" + x + "] WAIT.", model: ${JSON.stringify(CLAUDE_SUB)}, run_in_background: false }, id);
    else if (kind === "CODEX") await calls("cbase_agent", { description: "Codex " + x, name: x, prompt: "Task [" + x + "].", model: ${JSON.stringify(CODEX_SUB)}, run_in_background: false }, id);
    else if (kind === "SEND") await calls("cbase_agent_send", { agentId: x, message: "Continue [" + y + "] WAIT.", run_in_background: true }, id);
  }
  say({ type: "assistant", message: { id: "main-end-" + turn, content: [{ type: "text", text: "Turn " + turn + " done" }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
});

// Fake Codex (pattern of parent-id.test.js, `codex exec --json` 0.153.1): with "CODEX-CALLS-CLAUDE" in the prompt it
// starts a Claude subagent through the real MCP server (open block, Codex `_meta` without toolUseId) and writes the
// result to `codex-result.json`; otherwise (as a subagent) it only answers.
const codex = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for the EXISTENCE of a file and then reads it — without the rename it read an empty one
// under load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".part-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
const joined = argv.join(" ");
const cfg = { env: {} };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "-c") continue;
  const m = /^mcp_servers\\.cbase\\.(command|args|env\\.(\\w+))=(.*)$/.exec(argv[i + 1] || "");
  if (!m) continue;
  const value = JSON.parse(m[3]);
  if (m[1] === "command") cfg.command = value; else if (m[1] === "args") cfg.args = value; else cfg.env[m[2]] = value;
}
function mcpCall(name, args, meta) {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.command, cfg.args || [], { env: { ...process.env, ...cfg.env }, stdio: ["pipe", "pipe", "inherit"], detached: true });
    try { fs.writeFileSync(path.join(LOCATION, "pids", "g" + child.pid), "mcp"); } catch {}
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) { try { child.stdin.end(); } catch {} resolve(m.result || {}); }
      }
    });
    child.on("error", reject);
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args, _meta: meta } });
  });
}
(async () => {
  say({ type: "thread.started", thread_id: "codex-thread" });
  say({ type: "turn.started" });
  if (joined.includes("CODEX-CALLS-CLAUDE")) {
    const a = { description: "Part H", prompt: "Task [H].", model: ${JSON.stringify(CLAUDE_SUB)}, run_in_background: false };
    say({ type: "item.started", item: { id: "item_1", type: "mcp_tool_call", server: "cbase", tool: "cbase_agent", arguments: a, status: "in_progress" } });
    const r = await mcpCall("cbase_agent", a, { callId: "call_1", itemId: "fc_1", threadId: "codex-thread", "x-codex-turn-metadata": { turn_id: "t1" } });
    fs.writeFileSync(path.join(LOCATION, "codex-result.json"), JSON.stringify(r));
    say({ type: "item.completed", item: { id: "item_1", type: "mcp_tool_call", server: "cbase", tool: "cbase_agent", arguments: a,
      result: { content: r.content || [], structured_content: null }, status: r.isError ? "failed" : "completed" } });
  }
  say({ type: "item.completed", item: { id: "response", type: "agent_message", text: "Codex done" } });
  say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
})();
`;

// Without an account: otherwise the utilization would come from the developer's REAL account (pattern: withoutAccount in agent-limit-parking.test.js).
async function withoutAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-gate-account-"));
  const prior = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  try {
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    for (const d of ["home", "codex-home"]) fs.mkdirSync(path.join(root, d));
    process.env.HOME = path.join(root, "home");
    process.env.CODEX_HOME = path.join(root, "codex-home");
    process.env.PATH = `${shim}:${process.env.PATH}`;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`cleanup of ${root}: ${e.code || e.message}`); }
  }
}

// Session window 100 %, measured now, reset in one hour (field names as in fetchUsageLimits).
function seedFullSession() {
  const at = Date.now();
  const iso = new Date(at + 3_600_000).toISOString();
  store.setSetting("usage_cache_v1", JSON.stringify({
    fiveHour: { utilization: 100, resetsAt: iso },
    sevenDay: { utilization: 4, resetsAt: null },
    limits: [
      { kind: "session", group: "session", percent: 100, resets_at: iso },
      { kind: "weekly", group: "weekly", percent: 4, resets_at: null },
    ],
    at,
  }));
}

const withGateServer = (fn, opts = {}) => withoutAccount(() => withAgentsServer(async (ctx) => { seedFullSession(); await fn(ctx); }, { claude, ...opts }));

const gate = (base, on) => json(`${base}/api/credit-gate`, { method: "PUT", body: JSON.stringify({ enabled: on }) });
const autoContinue = (base, on) => json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: on }) });
const message = (base, chatId, text) => json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
const blockId = (op) => `toolu_${op.replace(/[^A-Za-z0-9]/g, "_")}`;
const result = (waitForLog, chatId, op) => waitForLog(chatId, (l) => l.some((m) => m.role === "tool_result" && JSON.parse(m.text).id === blockId(op)))
  .then((l) => String(JSON.parse(l.find((m) => m.role === "tool_result" && JSON.parse(m.text).id === blockId(op)).text).result));
const startedOf = (root, x) => fs.existsSync(path.join(root, `sub-start-${x}`));
const startCount = (root, x) => (fs.existsSync(path.join(root, `sub-start-${x}`)) ? fs.readFileSync(path.join(root, `sub-start-${x}`), "utf8").length : 0);
// Everything under the data folder that belongs to this agent — independent of the product's list (agentTraces): every
// entry whose name carries `agent-<id>` (MCP file, Chromium profile, Playwright configs). The output file is called
// `<id>.output` and does not count.
function lanes(dataRoot, agentId) {
  const out = [];
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.name.includes(`agent-${agentId}`)) out.push(path.relative(dataRoot, p));
      else if (e.isDirectory()) run(p);
    }
  };
  run(dataRoot);
  return out.sort();
}
const gateError = (t) => {
  assert.match(t, /^FEHLER /, `no tool error: ${t.slice(0, 300)}`);
  assert.match(t, /Guthaben-Gate|Credit gate/, t);
  assert.match(t, /100 %/, `the reason does not name the level: ${t}`);
  assert.match(t, /99 %/, `the reason does not name the threshold: ${t}`);
};
const started = (t) => assert.doesNotMatch(t, /^FEHLER /, `abgewiesen: ${t.slice(0, 300)}`);

// A running turn that has already passed its gate, then gate ON: gate off when sending, file, gate on, file opens.
async function turnBehindTheGate({ base, chat, gate: gateState }, gateName, ops) {
  await gate(base, false);
  await message(base, chat.id, `OP-GATE:${gateName} ${ops}`);
  await gateState.reached(gateName);
  await gate(base, true);
  gateState.open(gateName);
}

test("Gate on, 99 % threshold reached (Claude): cbase_agent returns the gate reason as a tool error, no child starts; with the gate off the same call starts — the question belongs to the credit switch, not auto-continue", async () => {
  await withGateServer(async (ctx) => {
    const { base, chat, root, dataRoot, waitForLog, waitForIdle } = ctx;
    // Auto-continue OFF, credit gate ON ⇒ blocked: auto-continue decides nothing here.
    await autoContinue(base, false);
    await turnBehindTheGate(ctx, "t1", "OP-START:A");
    gateError(await result(waitForLog, chat.id, "OP-START:A"));
    await waitForIdle();
    assert.equal(startedOf(root, "A"), false, "subagent A was started despite the gate");
    assert.deepEqual(fs.readdirSync(path.join(dataRoot, "data", "scratch")).filter((n) => n.includes(".agent-")), [], "an agent MCP file appeared despite the gate");

    // Auto-continue ON, credit gate OFF ⇒ the same call starts.
    await autoContinue(base, true);
    await gate(base, false);
    await message(base, chat.id, "OP-START:B");
    started(await result(waitForLog, chat.id, "OP-START:B"));
    assert.equal(startCount(root, "B"), 1);
  });
});

test("\"Start anyway\" applies to the subagents of THIS turn (as an argument) and not to those of a later one", async () => {
  await withGateServer(async (ctx) => {
    const { base, chat, root, waitForTruthy, waitForLog } = ctx;
    await gate(base, true);
    await message(base, chat.id, "OP-START:C");
    const row = await waitForTruthy(async () => (await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait, "Gate-Zeile");
    assert.equal(row.reason, "credit", JSON.stringify(row));
    const now = await json(`${base}/api/chats/${chat.id}/auto-continue/now`, { method: "POST", body: JSON.stringify({ anyway: true }) });
    assert.equal(now.ok, true, JSON.stringify(now));
    started(await result(waitForLog, chat.id, "OP-START:C"));
    assert.equal(startCount(root, "C"), 1, "the subagent of the released turn did not run");

    // A later turn (passed its own gate, then gate on) carries no release — its subagent stays at the gate.
    await turnBehindTheGate(ctx, "t2", "OP-START:D");
    gateError(await result(waitForLog, chat.id, "OP-START:D"));
    assert.equal(startedOf(root, "D"), false, "the release of the earlier turn applied to a later one");
  });
});

test("The question is asked for the provider of the SUBAGENT: a Codex subagent from a Claude chat at the Claude gate starts, a Claude subagent from a Codex chat does not", async () => {
  await withGateServer(async (ctx) => {
    const { base, ws, chat, root, waitForTruthy, waitForLog } = ctx;
    // a) Claude chat, gate on: the Codex subagent runs (Codex has no credit gate).
    await turnBehindTheGate(ctx, "t3", "OP-CODEX:E");
    const e = await result(waitForLog, chat.id, "OP-CODEX:E");
    started(e);
    assert.match(e, /Codex done/, `no report from the Codex subagent: ${e.slice(0, 300)}`);

    // b) Codex chat, gate on (its own turn runs: no Claude turn): the Claude subagent stays at the gate.
    const cx = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "codex", model: "gpt-5.6-sol", permissionMode: "bypassPermissions" }) });
    await json(`${base}/api/chats/${cx.id}`, { method: "PATCH", body: JSON.stringify({ title: "Codex" }) });
    await message(base, cx.id, "CODEX-CALLS-CLAUDE");
    const file = path.join(root, "codex-result.json");
    await waitForTruthy(() => fs.existsSync(file), "Codex-Ergebnis");
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    const text = (r.content || []).map((c) => c.text || "").join("");
    assert.equal(r.isError, true, `no tool error: ${text.slice(0, 300)}`);
    gateError(`FEHLER ${text}`);
    assert.equal(startedOf(root, "H"), false, "the Claude subagent of the Codex chat started despite the Claude gate");
  }, { codex });
});

test("At agent end Chromium profile and MCP file are gone, the output file stays readable; cbase_agent_send then continues and recreates both; deleting the chat takes the output file with it", async () => {
  await withGateServer(async (ctx) => {
    const { base, chat, dataRoot, gate: gateState, waitForTruthy, waitForLog, waitForIdle } = ctx;
    const live = async () => (await json(`${base}/api/runs/active`)).agents.filter((a) => a.chatId === chat.id);
    await message(base, chat.id, "OP-LANG:F");
    await gateState.reached("subF");
    const [f] = await live();
    assert.ok(f?.agentId, "no living agent F");
    // Proof that the path is entered: while F runs, it HAS a profile and an MCP file.
    const during = lanes(dataRoot, f.agentId);
    assert.ok(during.some((p) => p.endsWith(".mcp.json")), `no MCP file during the run: ${JSON.stringify(during)}`);
    assert.ok(during.some((p) => p.includes("playwright-profiles")), `no Chromium profile during the run: ${JSON.stringify(during)}`);
    gateState.open("subF");
    const report = JSON.parse((await result(waitForLog, chat.id, "OP-LANG:F")).replace(/^FEHLER /, ""));
    assert.equal(report.status, "completed", JSON.stringify(report));
    await waitForIdle();
    assert.deepEqual(lanes(dataRoot, f.agentId), [], "traces of the agent remain after the end");
    assert.match(fs.readFileSync(report.outputFile, "utf8"), /Finding F/, "the output file named by the report is not readable");

    // Continuation via cbase_agent_send: it runs, and MCP file and profile are recreated for it.
    await message(base, chat.id, "OP-SEND:F:G");
    started(await result(waitForLog, chat.id, "OP-SEND:F:G"));
    await gateState.reached("subG");
    const fresh = lanes(dataRoot, f.agentId);
    assert.ok(fresh.some((p) => p.endsWith(".mcp.json")) && fresh.some((p) => p.includes("playwright-profiles")), `the continuation ran without a new MCP file/profile: ${JSON.stringify(fresh)}`);
    gateState.open("subG");
    await waitForTruthy(async () => (await live()).length === 0, "Fortsetzung beendet");
    await waitForIdle();
    assert.deepEqual(lanes(dataRoot, f.agentId), [], "traces of the agent remain after the continuation");
    assert.match(fs.readFileSync(report.outputFile, "utf8"), /Finding G/, "the output file does not carry the continuation");

    // The closing path takes the output file with it.
    await json(`${base}/api/chats/${chat.id}`, { method: "DELETE" });
    assert.equal(fs.existsSync(report.outputFile), false, "the output file survived the deletion of the chat");
  });
});

test("A child that is still writing does not make cleanup fail: ENOTEMPTY is caught and warned about", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-clean-up-"));
  try {
    setDirs({ data: path.join(root, "data"), scratch: path.join(root, "scratch") });
    const warned = [];
    const removed = [];
    const rm = (p) => {
      if (p.includes("playwright-profiles")) { const e = new Error(`ENOTEMPTY: directory not empty, rmdir '${p}'`); e.code = "ENOTEMPTY"; throw e; }
      removed.push(p);
    };
    const w = cleanUpAgent("c1", "a1-1", { rm, warn: (t) => warned.push(t) });
    assert.equal(w.length, 1, JSON.stringify(w));
    assert.deepEqual(warned, w, "the warning did not go out");
    assert.match(w[0], /ENOTEMPTY/);
    assert.match(w[0], /playwright-profiles/);
    // The remaining traces go anyway: the MCP file and both Playwright configs.
    assert.equal(removed.length, 3, JSON.stringify(removed));
    assert.ok(removed.some((p) => p.endsWith("c1.agent-a1-1.mcp.json")), JSON.stringify(removed));
    assert.equal(removed.filter((p) => p.includes("playwright-configs")).length, 2, `cleanup did not continue after the error: ${JSON.stringify(removed)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

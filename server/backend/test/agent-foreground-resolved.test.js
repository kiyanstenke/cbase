// `foreground` means "a call is waiting". Main seam with the harness: real server, real cbase MCP server, real routes,
// only the providers are faked.
//
// The waiting call of a foreground agent used to be resolved not only by the deadline or the button, but also by
// parking at the limit (park() answers it with "resumes after the reset") and by the end of the turn (also through
// `run_error`: the main agent is gone, nobody waits any more). `rec.background` stayed false: the row kept carrying
// `foreground: true` (web and iOS offered "Move to background — the waiting call returns at once"), "Stop all
// background agents" skipped it, and a human single stop took it for delivered and left no silent hint. Now every
// resolver goes through the SAME transition (providers/agent-runtime.js toBackground; end of turn: runs/agents.js
// releaseFromTurn).
//
// This file covers FOUR of the FIVE resolvers (deadline, button, parking, end of turn). The fifth — parent end: when
// the parent agent itself ends (not the turn), its still-waiting foreground grandchild goes through the same
// `toBackground` transition, reason `"parent-end"` — is covered in `agent-parent-chain.test.js`.
//
// No time window: the reset lies an hour away, the parked state stands until the test stops; the subagent of the
// end-of-turn case waits at its gate until the stop ends it.
//
// Counter-tests (each shown red once):
//   - `toBackground(rec, "parking")` left out in park() => the three parking tests red (row carries `foreground`,
//     "stop all" hits nothing, no hint);
//   - the loop in releaseFromTurn left out => "run_error" red (row carries `foreground`).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { agentsList, liveAgents, parkWakeupCount } from "../electron/server/runs/agents.js";
import { hintPreamble } from "../electron/server/runs/hints.js";

// The subagent: "{LIMIT}" fails at the limit (CLI wording, reset in an hour) and parks; otherwise it waits at gate
// "sub" and reports afterwards.
const SUB = `
    if (text.includes("{LIMIT}")) {
      say({ type: "system", subtype: "init", session_id: "sub-limit-session" });
      process.stderr.write("Claude usage limit reached · resets at " + new Date(Date.now() + 3600 * 1000).toISOString() + "\\n");
      setTimeout(() => process.exit(1), 30);
      return;
    }
    await gate("sub");
    finished();
    say({ type: "result", result: "Finding", session_id: "sub-session" });`;

// The main agent calls ONE foreground agent (task from "TASK:<prompt>"). With "CRASH" it does not wait for the call
// but waits at gate "crash" and then dies with exit 1 (run_error) while the call is still waiting. Otherwise it writes
// the result to `result` and waits at gate "main" (the turn goes on).
const MAIN = `
  const prompt = /TASK:(.*)$/.exec(text)[1];
  const args = { description: "Vorn", prompt, run_in_background: false };
  say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_front", name: "mcp__cbase__cbase_agent", input: args }] } });
  const call = mcpCall("cbase_agent", args);
  if (text.includes("CRASH")) {
    call.catch(() => {});
    await gate("crash");
    process.stderr.write("main agent crashed\\n");
    process.exit(1);
  }
  let t = "";
  try { t = textOf(await call); } catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
  fs.writeFileSync(path.join(LOCATION, "result"), t);
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_front", content: t }] } });
  await gate("main");
  say({ type: "assistant", message: { id: "main-e", content: [{ type: "text", text: "finished" }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

const fake = fakeClaude({ sub: SUB, main: MAIN });

// The limit windows would otherwise come from the developer's REAL account — as in agent-limit-parking.test.js: empty HOME and
// CODEX_HOME, a `security` that finds nothing, no OAuth token. Then the reset from the wording applies.
async function withoutAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-front-account-"));
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

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const read = (root, file) => { try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; } };
// The rows that web and iOS read (SSE `background`) — only there the `foreground` marker appears.
const rowsOf = (chatId) => liveAgents().filter((a) => a.chatId === chatId);
const inCore = (chatId, agentId) => agentsList(chatId).find((a) => a.agentId === agentId);

// A foreground agent parks at the limit WHILE the turn runs (the main agent then waits at gate "main").
async function parkedForeground({ base, chat, root, gate, waitForTruthy }) {
  await post(`${base}/api/chats/${chat.id}/message`, { text: "Go TASK:Look at {LIMIT}." });
  await gate.reached("main");
  const t = read(root, "result");
  const agentId = JSON.parse(t).agentId;
  const z = await waitForTruthy(() => rowsOf(chat.id).find((a) => a.agentId === agentId && a.status === "parked") || null, "parked");
  const active = await json(`${base}/api/runs/active`);
  assert.equal(active.runs, 1, "the turn is still running");
  return { agentId, t, z };
}

test("Parking: the waiting call returns with \"resumes after the reset\", and the agent is in the background from then on", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, gate } = ctx;
    try {
      const { agentId, t, z } = await parkedForeground(ctx);
      // The answer fits the background: the report follows by itself, not "done".
      assert.match(t, /"status": "parked"/, t.slice(0, 400));
      assert.match(t, /"background": true/);
      assert.match(t, /"intoTheBackground": "parking"/);
      assert.match(t, /Its report is then delivered to you automatically/);
      assert.equal(z.foreground, undefined, `the row no longer carries a foreground marker: ${JSON.stringify(z)}`);
      assert.equal(inCore(chat.id, agentId)?.background, true, "the agent is a background agent");
      // The button finds the requested state.
      const r = await post(`${base}/api/chats/${chat.id}/agent/background`, { agentId });
      assert.deepEqual(r, { ok: true, agentId, background: true, already: true });
      await post(`${base}/api/chats/${chat.id}/agents/stop`, { from: "human" });
      assert.equal(parkWakeupCount(), 0);
    } finally {
      gate.open("main");
    }
    await ctx.waitForIdle();
  }, { claude: fake }));
});

test("Parking: \"Stop all background agents\" reaches the parked foreground agent in the running turn", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, gate } = ctx;
    try {
      const { agentId } = await parkedForeground(ctx);
      const r = await post(`${base}/api/chats/${chat.id}/agents/stop`, { from: "human" });
      assert.deepEqual(r.stopped, [agentId], JSON.stringify(r));
      assert.equal(parkWakeupCount(), 0, "the reset alarm is gone with the stop");
      assert.deepEqual(rowsOf(chat.id), []);
    } finally {
      gate.open("main");
    }
    await ctx.waitForIdle();
  }, { claude: fake }));
});

test("Parking: a human single stop leaves the silent hint — the waiting call has long returned", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, gate } = ctx;
    try {
      const { agentId } = await parkedForeground(ctx);
      const r = await post(`${base}/api/chats/${chat.id}/agent/stop`, { agentId, from: "human" });
      assert.equal(r.ok, true, JSON.stringify(r));
      const { preamble } = hintPreamble(chat.id);
      assert.equal((preamble.match(/stopped by the human/g) || []).length, 1, `exactly one hint: ${preamble}`);
      assert.ok(preamble.includes(agentId), preamble);
    } finally {
      gate.open("main");
    }
    await ctx.waitForIdle();
  }, { claude: fake }));
});

test("run_error: a foreground agent that outlives the end of the turn is in the background afterwards — \"stop all\" reaches it and leaves the hint", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, gate, waitForTruthy } = ctx;
    try {
      await post(`${base}/api/chats/${chat.id}/message`, { text: "Go CRASH TASK:Look." });
      await gate.reached("sub");
      const [prior] = rowsOf(chat.id);
      assert.equal(prior?.foreground, true, "before the crash the call is waiting");
      await gate.reached("crash");
      gate.open("crash");
      await waitForTruthy(async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null), "the turn is over");
      const z = rowsOf(chat.id);
      assert.deepEqual(z.map((a) => [a.agentId, a.foreground]), [[prior.agentId, undefined]], `no foreground marker after the end of the turn: ${JSON.stringify(z)}`);
      assert.equal(inCore(chat.id, prior.agentId)?.background, true);
      // "Stop all" hits it and leaves the hint (like every human stop that nobody delivers).
      const s = await post(`${base}/api/chats/${chat.id}/agents/stop`, { from: "human" });
      assert.deepEqual(s.stopped, [prior.agentId], JSON.stringify(s));
      const { preamble } = hintPreamble(chat.id);
      assert.equal((preamble.match(/stopped by the human/g) || []).length, 1, `exactly one hint: ${preamble}`);
    } finally {
      gate.open("sub");
      gate.open("crash");
    }
    await ctx.waitForIdle();
  }, { claude: fake });
});

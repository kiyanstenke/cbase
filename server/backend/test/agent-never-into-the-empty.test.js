// A report never goes into the void. If a subagent cannot accept anything in the middle of the turn (Codex has no
// `controlCbase`), the core stores the report of its grandchild, or a message from cbase_agent_send, in `rec.supplyLater`
// (answer "afterEnd"). If it then failed or was stopped, `settle` emptied the list without delivery — against
// GRANDCHILD_REPORT_SET ("if you end before, they go to the main agent") and "never into the void". Now the entries go to the
// MAIN AGENT: the grandchild report as its completion notice (the same way as without a living parent agent), the message as
// the system message "not delivered" — exactly once each.
//
// Main seam with the agent harness (real server, real cbase MCP server, fake Claude as main agent and grandchild, fake Codex
// as parent agent). No clock: the Codex parent waits at a gate, events are waited for.
//
// Counter-test: the hand-over of `info.undelivered` in runs/agents.js onFinish removed => all three tests red (the main agent
// gets nothing), none hangs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { isCompletionNotice } from "../electron/server/runs/completionNotice.js";

const CODEX = "codex::gpt-5.6-sol";
const HAIKU = "claude::claude-haiku-4-5-20251001";

// The main agent runs the calls from "OPS:[…]" (pattern agent-readjust.test.js); it only reads a completion notice.
const MAIN = `
  if (text.includes("<task-notification>")) { // a silent hint (human stop) may stand in front
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  const ops = JSON.parse(/OPS:(\\[.*\\])/.exec(text)[1]);
  for (const op of ops) {
    const args = { ...op.args };
    if (op.to) args.agentId = fs.readFileSync(path.join(LOCATION, "id-" + op.to), "utf8");
    const id = "toolu_" + op.tag;
    say({ type: "assistant", message: { id: "main-" + op.tag, content: [{ type: "tool_use", id, name: "mcp__cbase__" + op.w, input: args }] } });
    let t = "";
    try { const m = await mcpCall(op.w, args); t = (m.result && m.result.isError ? "FEHLER " : "") + textOf(m); } catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    if (op.saveAs) { try { fs.writeFileSync(path.join(LOCATION, "id-" + op.saveAs), JSON.parse(t).agentId); } catch {} }
    fs.writeFileSync(path.join(LOCATION, "result-" + op.tag), t);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

// The grandchild (Claude subagent) reports at once.
const SUB = `
    say({ type: "system", subtype: "init", session_id: "grandchild-session" });
    finished();
    say({ type: "result", result: "Grandchild finding", session_id: "grandchild-session" });`;

// Fake Codex as parent agent (pattern agent-depth.test.js fakeCodexKind, `exec --json` 0.153.1). Markers in the task:
//   {GRANDCHILD}  starts a Claude grandchild in the background through a real mcp_tool_call, stores the result under
//                 `grandchild-start-<x>`
//   {GATE:x}      then waits at gate "codex-x" (the test releases it or stops it there)
//   {FAIL}        ends after the gate with exit 1 — the parent agent fails
// A continuation (`exec … resume <id>`) reports its message; every call is in `codex-calls`.
const CODEX_FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for the EXISTENCE of a file and then reads it — without the rename it read an empty one
// under load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
const ri = argv.indexOf("resume");
const message = argv[argv.length - 1].split("[END SYSTEM-DEFAULTS]").pop().trim();
fs.appendFileSync(path.join(LOCATION, "codex-calls"), JSON.stringify({ resume: ri >= 0 ? argv[ri + 1] : "", message }) + "\\n");
const cfg = { env: {} };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "-c") continue;
  const m = /^mcp_servers\\.cbase\\.(command|args|env\\.(\\w+))=(.*)$/.exec(argv[i + 1] || "");
  if (!m) continue;
  const value = JSON.parse(m[3]);
  if (m[1] === "command") cfg.command = value; else if (m[1] === "args") cfg.args = value; else cfg.env[m[2]] = value;
}
function rpc(method, params) {
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
        if (m.id === 2) { try { child.stdin.end(); } catch {} resolve(m); }
      }
    });
    child.on("error", reject);
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", id: 2, method, params });
  });
}
function gate(name) {
  const file = path.join(LOCATION, "gates", name);
  try { fs.writeFileSync(file + ".waiting", String(process.pid)); } catch {}
  return new Promise((r) => { const t = setInterval(() => { if (fs.existsSync(file)) { clearInterval(t); r(); } }, 20); });
}
(async () => {
  say({ type: "thread.started", thread_id: ri >= 0 ? argv[ri + 1] : "codex-parent" });
  say({ type: "turn.started" });
  const x = (/\\{GATE:([a-z0-9]+)\\}/.exec(message) || [])[1] || "";
  if (ri < 0 && message.includes("{GRANDCHILD}")) {
    const a = { description: "Grandchild author " + x, prompt: "Look.", model: ${JSON.stringify(HAIKU)} };
    say({ type: "item.started", item: { id: "item_grandchild_" + x, type: "mcp_tool_call", server: "cbase", tool: "cbase_agent", arguments: a, status: "in_progress" } });
    const r = await rpc("tools/call", { name: "cbase_agent", arguments: a, _meta: { callId: "call_" + x, itemId: "fc_" + x, threadId: "codex-parent" } });
    const res = r.result || { isError: true, content: [{ type: "text", text: JSON.stringify(r.error || "") }] };
    fs.writeFileSync(path.join(LOCATION, "grandchild-start-" + x), (res.content || [])[0]?.text || "");
    say({ type: "item.completed", item: { id: "item_grandchild_" + x, type: "mcp_tool_call", server: "cbase", tool: "cbase_agent", arguments: a,
      result: { content: res.content || [], structured_content: null }, status: res.isError ? "failed" : "completed" } });
  }
  if (ri < 0 && x) await gate("codex-" + x);
  if (ri < 0 && message.includes("{FAIL}")) { console.error("Codex broken"); process.exit(1); }
  say({ type: "item.completed", item: { id: "answer-1", type: "agent_message", text: ri >= 0 ? "Codex resumed: " + message : "Codex finding" } });
  say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
})();
`;

const fake = fakeClaude({ sub: SUB, main: MAIN });
const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const read = (root, file) => { try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; } };
const job = (ops) => `Go OPS:${JSON.stringify(ops)}`;
const result = (waitForTruthy, root, tag) => waitForTruthy(() => read(root, `result-${tag}`) || null, `result ${tag}`);
const idOf = (root, name) => read(root, `id-${name}`);
const turnPast = (base) => async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null);
const noticesOf = (log, agentId) => log.filter((m) => m.role === "user" && isCompletionNotice(m.text) && m.text.includes(`<task-id>${agentId}</task-id>`));
const START = (tag, prompt) => ({ w: "cbase_agent", tag, args: { description: `Agent ${tag}`, prompt, model: CODEX } });
const SEND = (tag, to, message) => ({ w: "cbase_agent_send", tag, to, args: { message } });
const live = async (base, chatId) => (await json(`${base}/api/runs/active`)).agents.filter((a) => a.chatId === chatId).map((a) => a.agentId);

// A Codex parent starts a grandchild and waits at the gate; the grandchild reports, its report is supplied to the parent later
// (Codex accepts nothing mid-turn) — it is NOT at the main agent then.
async function parentWithSuppliedLaterGrandchild({ base, chat, root, gate, waitForTruthy }, x, markers) {
  await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START(`${x}1`, `Work {GRANDCHILD} {GATE:${x}}${markers}.`), saveAs: x }]) });
  await result(waitForTruthy, root, `${x}1`);
  await gate.reached(`codex-${x}`);
  const grandchild = JSON.parse(read(root, `grandchild-start-${x}`)).agentId;
  assert.ok(grandchild, `no grandchild started: ${read(root, `grandchild-start-${x}`).slice(0, 300)}`);
  await waitForTruthy(async () => (!(await live(base, chat.id)).includes(grandchild) ? true : null), "the grandchild is done");
  await waitForTruthy(turnPast(base), "the turns are over");
  const log = await json(`${base}/api/chats/${chat.id}/log`);
  assert.equal(noticesOf(log, grandchild).length, 0, "the grandchild report went to the main agent instead of the living parent");
  return { parent: idOf(root, x), grandchild };
}

test("Grandchild report to a Codex parent that cannot accept it and then FAILS => the main agent gets it, exactly once", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, gate, waitForLog, waitForIdle } = ctx;
    try {
      const { parent, grandchild } = await parentWithSuppliedLaterGrandchild(ctx, "p", " {FAIL}");
      gate.open("codex-p");
      const log = await waitForLog(chat.id, (l) => noticesOf(l, parent).length >= 1);
      assert.match(noticesOf(log, parent)[0].text, /<status>failed<\/status>/, "the parent agent failed");
      await waitForIdle();
      const after = await json(`${base}/api/chats/${chat.id}/log`);
      const m = noticesOf(after, grandchild);
      assert.equal(m.length, 1, `the grandchild report reached the main agent ${m.length} times`);
      assert.match(m[0].text, /<result>Grandchild finding<\/result>/);
    } finally {
      gate.open("codex-p");
    }
  }, { claude: fake, codex: CODEX_FAKE });
});

test("Grandchild report to a Codex parent that a HUMAN stops => the main agent gets it, exactly once", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, gate, waitForIdle } = ctx;
    try {
      const { parent, grandchild } = await parentWithSuppliedLaterGrandchild(ctx, "q", "");
      const stop = await post(`${base}/api/chats/${chat.id}/agent/stop`, { agentId: parent, from: "human" });
      assert.ok(stop.ok !== false, JSON.stringify(stop));
      await waitForIdle();
      const log = await json(`${base}/api/chats/${chat.id}/log`);
      assert.equal(noticesOf(log, parent).length, 0, "a human stop reports silently, not as a completion notice");
      const m = noticesOf(log, grandchild);
      assert.equal(m.length, 1, `the grandchild report reached the main agent ${m.length} times`);
      assert.match(m[0].text, /<result>Grandchild finding<\/result>/);
    } finally {
      gate.open("codex-q");
    }
  }, { claude: fake, codex: CODEX_FAKE });
});

test("A cbase_agent_send message acknowledged \"after the end\" whose recipient fails => the main agent gets it as \"not delivered\", exactly once — and a later continuation does not carry it again", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForTruthy, waitForLog, waitForIdle }) => {
    try {
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([
        { ...START("x1", "Work {GATE:x} {FAIL}."), saveAs: "X" },
        SEND("x2", "X", "Late question"),
      ]) });
      const x2 = await result(waitForTruthy, root, "x2");
      assert.match(x2, /"afterEnd": true/, x2.slice(0, 300));
      await waitForTruthy(turnPast(base), "turn 1 is over");
      await gate.reached("codex-x");
      const X = idOf(root, "X");
      gate.open("codex-x");
      await waitForLog(chat.id, (l) => noticesOf(l, X).some((m) => /<status>failed<\/status>/.test(m.text)));
      await waitForIdle();
      const log = await json(`${base}/api/chats/${chat.id}/log`);
      const hint = noticesOf(log, X).filter((m) => m.text.includes("not delivered"));
      assert.equal(hint.length, 1, `the message arrived ${hint.length} times as "not delivered"`);
      assert.match(hint[0].text, /<result>Late question<\/result>/);
      assert.match(hint[0].text, /it failed before it could read it/);

      // A continuation of the same agent starts with an empty list — the message does not come over a second path.
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([SEND("x3", "X", "New question")]) });
      assert.match(await result(waitForTruthy, root, "x3"), /"resumed": true/);
      await waitForLog(chat.id, (l) => noticesOf(l, X).some((m) => /Codex resumed: New question/.test(m.text)));
      await waitForIdle();
      // `codex-calls` is written by the fake Codex (a child process) — only completed lines (jsonl.mjs).
      const resumptions = readJsonl(path.join(root, "codex-calls")).filter((a) => a.resume);
      assert.deepEqual(resumptions.map((a) => a.message), ["New question"], "the continuation carried the old message along");
    } finally {
      gate.open("codex-x");
    }
  }, { claude: fake, codex: CODEX_FAKE });
});

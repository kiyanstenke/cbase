// `/name <rest>` of a saved dynamic workflow in the coding chat (server/backend/electron/server/dynworkflows/slash.js,
// called at the message route runs/routes.js messageChatRoutes). The route refuses the line (404 `dyn_slash`) — nothing
// reaches the CLI, no run starts; the former start cases are refusal cases here; `slashCall` stays. Main seam with the agent
// harness: real server, real cbase MCP server, real routes, real agent core; only the providers are faked.
//
// The main agent stores EVERY text it gets in prompts.jsonl: that is the prompt log showing that the CLI never sees a
// leading `/name`.
//
// Counter-test: remove the block `if (dynRefusal) …` in runs/routes.js => "refusal", "display text" and "mid-turn" fall
// (202, the line goes to the CLI as a prompt).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { slashCall } from "../electron/server/dynworkflows/slash.js";
import { nameForbidden } from "../electron/server/dynworkflows/names.js";
import * as store from "../electron/server/store.js";
import { db } from "../electron/server/store/db.js";

// The main agent: "GATE:x" holds it at gate x; "WF[<tag>]:{json}:FW" calls cbase_dynamic_workflow and stores the result under
// wf-<tag>. Every text goes into the prompt log first.
const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "prompts.jsonl"), JSON.stringify({ text }) + "\\n");
  const gateName = (String(text).match(/GATE:(\\w+)/) || [])[1];
  if (gateName) await gate(gateName);
  const i = text.indexOf("WF[");
  if (i >= 0) {
    const tag = text.slice(i + 3, text.indexOf("]:", i));
    const args = JSON.parse(text.slice(text.indexOf("]:", i) + 2, text.indexOf(":FW", i)));
    const id = "toolu_wf_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_dynamic_workflow", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_dynamic_workflow", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); } // atomic: the test only waits for the file to exist
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "ok" }] } });
  finished();
  say({ type: "result", result: "ok", session_id: "main-session" });`;
// A workflow agent: stores its task and reports "Finding <tag>".
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    fs.writeFileSync(path.join(LOCATION, "sub-job-" + tag), job);
    say({ type: "assistant", message: { id: "s-" + tag, content: [{ type: "text", text: "Finding " + tag }] } });
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag });`;
const claude = fakeClaude({ main: MAIN, sub: SUB });

// The saved workflow (`args` used to be the rest of the line; today only the tool starts it here).
const MEINWF = "export const meta = { name: 'mywf', description: 'Checks something', phases: [{ title: 'Check' }] }\nreturn await agent('Check: ' + args + ' {TAG:a}');\n";

async function raw(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close" } });
  return { status: res.status, body: await res.json() };
}
const send = (base, chatId, body) => raw(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify(body) });
async function save(base, chatId) {
  const r = await raw(`${base}/api/chats/${chatId}/dyn-workflows`, { method: "POST", body: JSON.stringify({ script: MEINWF }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
// The fakes (child processes) write the logs while the test reads — only completed lines (jsonl.mjs).
const prompts = (root) => readJsonl(path.join(root, "prompts.jsonl")).map((z) => z.text);
const runCount = () => db.prepare("SELECT COUNT(*) n FROM dyn_workflow_runs").get().n;
const noSlashAtTheCli = (root) => {
  for (const p of prompts(root)) assert.ok(!/^\s*\/mywf/m.test(p), `the CLI saw a leading /mywf: ${JSON.stringify(p.slice(0, 200))}`);
};

test("detection: `/name` with the form of saved names, the rest is everything after it; `workflows` is reserved", () => {
  assert.deepEqual(slashCall("/mywf check till"), { name: "mywf", rest: "check till" });
  assert.deepEqual(slashCall("  /MyWF  "), { name: "MyWF", rest: "" });
  assert.deepEqual(slashCall("/goal-x -y"), { name: "goal-x", rest: "-y" }, "\"/goal-x\" is the name goal-x, not /goal with \"-x\"");
  assert.deepEqual(slashCall("/a.b_c\nsecond line"), { name: "a.b_c", rest: "second line" });
  for (const no of ["mywf", "/", "/ mywf", "/Users/maintainer/file", "//x", "/-x", ""]) assert.equal(slashCall(no), null, JSON.stringify(no));
  assert.equal(nameForbidden("workflows"), "reserved", "no workflow is called /workflows (the CLI's command)");
});

test("refusal: \"/mywf <rest>\" no longer starts anything — 404 dyn_slash, no history row, no turn, no run", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await save(base, chat.id);
    const r = await send(base, chat.id, { text: "/mywf check till" });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.reason, "dyn_slash");
    assert.match(r.body.error, /„\/mywf“ ist kein Befehl/);
    assert.match(r.body.error, /cbase_dynamic_workflow/);
    assert.match(r.body.error, /Nichts wurde gesendet/);
    // In capitals the same name matches (the library compares regardless of spelling).
    assert.equal((await send(base, chat.id, { text: "/MyWF" })).body.reason, "dyn_slash");
    // After QUIET, not right after the answer: a turn that would start after all would be through by then.
    const active = await ctx.waitForQuiet();
    assert.equal(active.runs | 0, 0, "no turn");
    assert.deepEqual(store.listMessages(chat.id).filter((m) => m.role === "user"), [], "nothing in the history");
    assert.deepEqual(prompts(root), [], "the CLI got nothing");
    assert.equal(runCount(), 0, "no dynamic run");
  }, { claude });
});

test("display text: the refusal also applies when the client sends `display` — `text` is what is read", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await save(base, chat.id);
    const r = await send(base, chat.id, { text: "/mywf with display", display: "something else" });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.reason, "dyn_slash");
    await ctx.waitForQuiet();
    assert.deepEqual(prompts(root), []);
    assert.equal(runCount(), 0);
  }, { claude });
});

test("mid-turn: the line is not queued — refusal, the turn keeps running undisturbed", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate } = ctx;
    await save(base, chat.id);
    await send(base, chat.id, { text: "Lead-in GATE:v" });
    await gate.reached("v");
    const r = await send(base, chat.id, { text: "/mywf in turn" });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.reason, "dyn_slash");
    gate.open("v");
    await ctx.waitForIdle();
    assert.equal(runCount(), 0);
    noSlashAtTheCli(root);
  }, { claude });
});

test("channel and schedule: the same line is no opt-in and starts no run — a tool start from it gets the card", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await save(base, chat.id);
    for (const [tag, cause] of [["k", "channel"], ["z", "schedule"]]) {
      const text = `/mywf from ${cause} WF[${tag}]:${JSON.stringify({ name: "mywf", args: cause })}:FW`;
      deliverUserPrompt(store.getChat(chat.id), { prompt: text, display: text, cause });
      const file = path.join(root, `wf-${tag}`);
      await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
      const e = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(e.status, "awaiting_approval", `${cause}: ${JSON.stringify(e)}`);
      await ctx.waitForIdle();
    }
    assert.equal(runCount(), 0, "no run past the card");
  }, { claude });
});

test("the route no longer reads the field `dynWorkflow`: a deleted workflow is an arbitrary `/word` (no refusal, no run)", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws } = ctx;
    const w = await save(base, chat.id);
    const way = await raw(`${base}/api/workspaces/${ws.id}/dyn-workflows/${w.id}`, { method: "DELETE" });
    assert.equal(way.status, 200);
    const r = await send(base, chat.id, { text: "/mywf after deleting", dynWorkflow: "mywf" });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.dynWorkflow, undefined);
    await ctx.waitForIdle();
    assert.equal(runCount(), 0);
  }, { claude });
});

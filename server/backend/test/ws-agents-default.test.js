// Workspace agents in NEW projects: on by default.
//
// The promise has three sides, and they must give the same answer (rule "execution side and description side"):
//   · the UI                  GET /api/projects/:id/agents (field `enabled`, plus `wsAgentsDefault`),
//   · the chat's selection    GET /api/chats/:id/agents (cbase_agents_list),
//   · the run                 the "# Subagents of this run" selection in the system prompt at the CLI spawn.
// All three read through store/toolchain.js wsAgentsInProject; this test measures them at the main seam (agent harness:
// real server, real routes, fake Claude writes out its system prompt).
//
// Measured:
//   1. a new project sees a workspace agent without any action;
//   2. switched off in the new project it stays off — a neighbor project is untouched, and a workspace agent created
//      LATER is on there (opt-out, not "copy at creation");
//   3. an existing project stays opt-in exactly as it was: the column is retrofitted through the real ALTER (old
//      storage, restart on the same data folder), and only the previously activated agent applies;
//   4. the switch route requires `enabled` as a boolean and switches only workspace agents;
//   5. and 6. a workspace agent whose definition names workspace skills brings those skills along in the new project
//      (skills of a subagent are resolved against the project's agent stock, not only the chat's set; the main chat's
//      catalog stays as it is). A name that exists nowhere still breaks the start — and the description says so instead
//      of calling it "loaded". Both tests START the agent: 5 via cbase_agent from the Claude main chat, 6 as `agent()`
//      of a dynamic workflow on Claude, Codex and the loop engine.
//
// Counter-tests (each shown red once and reverted):
//   · addProject writes `'off'` instead of `'on'`            ⇒ 1–4 red;
//   · effectiveAgents filters over the old list again         ⇒ 1–3 red, at selection and run, the UI green —
//     exactly the gap between description and execution that the test binds;
//   · DEFAULT 'on' instead of 'off' in the ALTER              ⇒ only 3 red (the never-activated agent would apply);
//   · resolveSkills in runs/agents.js back to the chat's set (`skillsResolve(names, tools.skills)` without `skillStock`) ⇒ 5 and 6 red at the start;
//   · subagentChoicePrompt without `skillStock`               ⇒ 5 red at the "broken" line ("[loaded skills rules, nonexistent]");
//   · listTypes back to `skills: toolList(d.skills)`          ⇒ 5 red at cbase_agents_list in the run.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { isCompletionNotice } from "../electron/server/runs/completionNotice.js";
import * as store from "../electron/server/store.js";

// The main agent only writes out its system prompt — under the marker from its message — and ends.
const fake = fakeClaude({
  main: `
  const marker = (/MARKER:([a-z0-9-]+)/.exec(text) || [])[1] || "x";
  fs.writeFileSync(path.join(LOCATION, "sys-" + marker + ".txt"), arg("--append-system-prompt"));
  say({ type: "assistant", message: { id: "m-" + marker, content: [{ type: "text", text: "done " + marker }] } });
  finished();
  say({ type: "result", result: "done " + marker, session_id: "s-" + marker });`,
});

async function project({ base, ws, root }, name) {
  const filePath = path.join(root, "workspace", name);
  fs.mkdirSync(filePath, { recursive: true });
  return json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name, path: filePath }) });
}
const wsAgent = ({ base, ws }, name) => json(`${base}/api/workspaces/${ws.id}/agents`, {
  method: "POST", body: JSON.stringify({ name, description: `Purpose of ${name}.`, body: `You are ${name}.` }),
});
async function projectChat({ base, ws }, proj) {
  const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({
    workspaceId: ws.id, projectId: proj.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions",
  }) });
  await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: `Chat ${proj.name}` }) });
  return chat;
}
const toggle = ({ base }, proj, agent, enabled) =>
  json(`${base}/api/projects/${proj.id}/agents/${agent.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled }) });

// The three answers to "does this workspace agent apply in this project?" — UI, selection, run. The run is a
// real turn; we wait for its answer in the log and then for idle, never for a duration.
let markersCounter = 0;
async function threePages(ctx, proj, chat) {
  const marker = `t${++markersCounter}`;
  const ui = await json(`${ctx.base}/api/projects/${proj.id}/agents`);
  const selection = await json(`${ctx.base}/api/chats/${chat.id}/agents`);
  await json(`${ctx.base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: `MARKER:${marker}` }) });
  await ctx.waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === `done ${marker}`));
  await ctx.waitForIdle();
  const sys = fs.readFileSync(path.join(ctx.root, `sys-${marker}.txt`), "utf8");
  assert.match(sys, /# Subagents of this run \(cbase_agent\)/, "the selection stands in the system prompt");
  return {
    standard: ui.wsAgentsDefault,
    applies: (name) => {
      const row = ui.workspaceAgents.find((a) => a.name === name);
      assert.ok(row, `${name} is missing in the UI list: ${JSON.stringify(ui.workspaceAgents.map((a) => a.name))}`);
      return {
        ui: row.enabled === true,
        selection: selection.types.some((t) => t.name === name && !t.builtin),
        run: sys.includes(`\n- ${name}: Purpose of ${name}.`),
      };
    },
  };
}
const everywhere = (value) => ({ ui: value, selection: value, run: value });

test("1. new project: a workspace agent applies without action — UI, selection and run say the same", async () => {
  await withAgentsServer(async (ctx) => {
    await wsAgent(ctx, "checker");
    const till = await project(ctx, "till");
    const chat = await projectChat(ctx, till);
    const s = await threePages(ctx, till, chat);
    assert.equal(s.standard, "on");
    assert.deepEqual(s.applies("checker"), everywhere(true));
  }, { claude: fake });
});

test("2. switched off in the new project stays off; the neighbor project is untouched; a workspace agent created later is on", async () => {
  await withAgentsServer(async (ctx) => {
    const checker = await wsAgent(ctx, "checker");
    const till = await project(ctx, "till");
    const shop = await project(ctx, "shop");
    const tillChat = await projectChat(ctx, till);
    const shopChat = await projectChat(ctx, shop);

    await toggle(ctx, till, checker, false);
    await wsAgent(ctx, "later");
    const k = await threePages(ctx, till, tillChat);
    assert.deepEqual(k.applies("checker"), everywhere(false), "switched off stays off");
    assert.deepEqual(k.applies("later"), everywhere(true), "a workspace agent created later applies in the new project");
    const sh = await threePages(ctx, shop, shopChat);
    assert.deepEqual(sh.applies("checker"), everywhere(true), "switching off in “till” applies only there");

    // On again — same switch, same list.
    await toggle(ctx, till, checker, true);
    const k2 = await threePages(ctx, till, tillChat);
    assert.deepEqual(k2.applies("checker"), everywhere(true));
  }, { claude: fake });
});

test("3. an existing project stays opt-in: the ALTER retrofits the column with “off”, only the previously activated agent applies", async () => {
  await withAgentsServer(async (ctx) => {
    const activated = await wsAgent(ctx, "activated");
    await wsAgent(ctx, "never-activated");
    const old = await project(ctx, "old");
    const chat = await projectChat(ctx, old);

    // This is how old storage looked on disk: no column, no exceptions table, the project's choice
    // in project_agent_enabled. Written over a second connection while the server rests.
    await ctx.waitForIdle();
    const raw = new DatabaseSync(path.join(ctx.dataRoot, "data", "automater.db"));
    try {
      raw.exec(`ALTER TABLE projects DROP COLUMN ws_agents_default;
        DROP TABLE project_agent_excluded;`);
      raw.prepare("INSERT INTO project_agent_enabled (project_id, agent_id) VALUES (?, ?)").run(old.id, activated.id);
    } finally { raw.close(); }
    await ctx.restart();

    const s = await threePages(ctx, old, chat);
    assert.equal(s.standard, "off", "the existing project stays opt-in");
    assert.deepEqual(s.applies("activated"), everywhere(true), "the previously activated agent keeps applying");
    assert.deepEqual(s.applies("never-activated"), everywhere(false), "a never-activated one does not apply — no reinterpreting the existing state");

    // In the existing project the switch still switches ON (same list as before) — and a workspace agent
    // created later stays off there.
    const later = await wsAgent(ctx, "later");
    const s2 = await threePages(ctx, old, chat);
    assert.deepEqual(s2.applies("later"), everywhere(false));
    await toggle(ctx, old, later, true);
    const s3 = await threePages(ctx, old, chat);
    assert.deepEqual(s3.applies("later"), everywhere(true));

    // A project created AFTER the retrofit takes over all again.
    const fresh = await project(ctx, "fresh");
    const newChat = await projectChat(ctx, fresh);
    const n = await threePages(ctx, fresh, newChat);
    assert.equal(n.standard, "on");
    assert.deepEqual(n.applies("never-activated"), everywhere(true));
  }, { claude: fake });
});

test("4. the switch route: `enabled` is required and a boolean, and only a workspace agent can be switched", async () => {
  await withAgentsServer(async (ctx) => {
    const checker = await wsAgent(ctx, "checker");
    const till = await project(ctx, "till");
    const own = await json(`${ctx.base}/api/projects/${till.id}/agents`, {
      method: "POST", body: JSON.stringify({ name: "own", description: "Project agent", body: "x" }),
    });
    const patch = (id, body) => fetch(`${ctx.base}/api/projects/${till.id}/agents/${id}/enabled`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body),
    });
    // A missing field is no statement — `!!undefined` would have silently switched the agent off in this project.
    assert.equal((await patch(checker.id, {})).status, 400);
    assert.equal((await patch(checker.id, { enabled: "false" })).status, 400);
    assert.equal((await patch(own.id, { enabled: false })).status, 404, "a project agent is not a workspace agent");
    assert.equal((await patch("00000000-0000-0000-0000-000000000000", { enabled: false })).status, 404);
    const ui = await json(`${ctx.base}/api/projects/${till.id}/agents`);
    assert.equal(ui.workspaceAgents.find((a) => a.id === checker.id)?.enabled, true, "the rejected bodies switched nothing");
  }, { claude: fake });
});

// ── 5./6. The skills of a workspace agent in the new project ────────────────────────────────────────────────────────────
// Main agent: writes out its system prompt, starts each type named by "START:<type>" through cbase_agent in the foreground
// (result to result-<type>.txt) and with "LIST" fetches cbase_agents_list (WHILE the core is open: ctl.types()).
// Subagent and workflow agent write their whole call line (the system prompt within) to sub-<tag>.txt.
const fakeStart = fakeClaude({
  sub: `
    const front = text.lastIndexOf("Here is the task:");
    const job = front >= 0 ? text.slice(front) : text;
    const tag = (/\\{TAG:([a-z0-9-]+)\\}/.exec(job) || [])[1] || "x";
    fs.writeFileSync(path.join(LOCATION, "sub-" + tag + ".txt"), joined);
    say({ type: "assistant", message: { id: "s-" + tag, content: [{ type: "text", text: "Report " + tag }] } });
    finished();
    say({ type: "result", result: "Report " + tag, session_id: "sub-" + tag });`,
  main: `
  const marker = (/MARKER:([a-z0-9-]+)/.exec(text) || [])[1] || "x";
  fs.writeFileSync(path.join(LOCATION, "sys-" + marker + ".txt"), arg("--append-system-prompt"));
  const calls = async (name, args, id) => {
    say({ type: "assistant", message: { id: "m-" + id, content: [{ type: "tool_use", id, name: "mcp__cbase__" + name, input: args }] } });
    let t = "";
    try { const r = await mcpCall(name, args); t = (r && r.result && r.result.isError ? "ERROR " : "") + textOf(r); }
    catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
    return t;
  };
  for (const type of (text.match(/\\bSTART:[a-z-]+/g) || []).map((o) => o.slice(6))) {
    const t = await calls("cbase_agent", { subagent_type: type, description: "Check " + type, prompt: "Job {TAG:" + type + "}.", run_in_background: false }, "toolu_" + marker + "_" + type);
    fs.writeFileSync(path.join(LOCATION, "result-" + type + ".txt"), t);
  }
  if (text.includes("LIST")) fs.writeFileSync(path.join(LOCATION, "list-" + marker + ".txt"), await calls("cbase_agents_list", { view: "start" }, "toolu_" + marker + "_list"));
  say({ type: "assistant", message: { id: "m-" + marker, content: [{ type: "text", text: "done " + marker }] } });
  finished();
  say({ type: "result", result: "done " + marker, session_id: "s-" + marker });`,
});

// Fake Codex for the workflow agent: the job including the system prompt stands in the last argument (codex.js codexPrompt).
const fakeCodexStart = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const LOCATION = ${JSON.stringify(LOCATION)};
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const argv = process.argv.slice(2);
const text = argv[argv.length - 1] || "";
const tag = (/\\{TAG:([a-z0-9-]+)\\}/.exec(text) || [])[1] || "x";
fs.writeFileSync(path.join(LOCATION, "sub-" + tag + ".txt"), text);
const say = (o) => console.log(JSON.stringify(o));
say({ type: "thread.started", thread_id: "cx-" + tag });
say({ type: "turn.started" });
say({ type: "item.completed", item: { id: "answer", type: "agent_message", text: "Report " + tag } });
say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
`;

// The workspace: a workspace skill "rules", HIDDEN in the new project (workspace coding skills apply in every project
// until it hides them — the stock of a workspace agent takes them "no matter whether hidden in the project"), a
// workspace agent "checker" that names it, and "broken" that additionally names a name that exists nowhere. Plus a NEW project.
async function skillSituation(ctx) {
  const rules = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/skills`, { method: "POST", body: JSON.stringify({
    name: "rules", area: "coding", description: "House rules of the company.", body: "GUIDE-RULES: short sentences.",
  }) });
  for (const [name, skills] of [["checker", ["rules"]], ["broken", ["rules", "nonexistent"]]]) {
    await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/agents`, { method: "POST", body: JSON.stringify({
      name, description: `Purpose of ${name}.`, body: `You are ${name}.`, skills,
    }) });
  }
  const till = await project(ctx, "till");
  const out = await json(`${ctx.base}/api/projects/${till.id}/workspace-skills/${rules.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  assert.deepEqual(out, { ok: true }, "hide “rules” in the project");
  const chat = await projectChat(ctx, till);
  const ui = await json(`${ctx.base}/api/projects/${till.id}/agents`);
  assert.equal(ui.wsAgentsDefault, "on");
  assert.ok(ui.workspaceAgents.every((a) => a.enabled), "both workspace agents apply in the new project");
  return { till, chat };
}
const read = (ctx, name) => fs.readFileSync(path.join(ctx.root, name), "utf8");
const typeOf = (list, name) => list.types.find((t) => t.name === name && !t.builtin);

test("5. a workspace agent brings its workspace skills along in the new project: cbase_agent starts it WITH the skill, the main chat catalog stays, and a missing name is described as missing", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat } = await skillSituation(ctx);
    await json(`${ctx.base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "MARKER:s1 START:checker START:broken LIST" }) });
    await ctx.waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === "done s1"));
    await ctx.waitForIdle();

    // Execution: the start loads the workspace skill completely into the subagent's system prompt.
    const checker = read(ctx, "result-checker.txt");
    assert.doesNotMatch(checker, /^ERROR /, `the start of the workspace agent fails: ${checker}`);
    assert.match(checker, /Report checker/);
    const sub = read(ctx, "sub-checker.txt");
    assert.match(sub, /# Loaded skills/);
    assert.match(sub, /## Skill: rules — House rules of the company\./);
    assert.match(sub, /GUIDE-RULES: short sentences\./);
    // A name that exists nowhere breaks the start — no subagent without the guide it is meant to have.
    const broken = read(ctx, "result-broken.txt");
    assert.match(broken, /^ERROR /, broken);
    assert.match(broken, /Skill "nonexistent" not found/, broken);
    assert.equal(fs.existsSync(path.join(ctx.root, "sub-broken.txt")), false, "the broken type has no process");

    // Description in the system prompt: the same answer as the start. The main chat's catalog stays the chat's set —
    // "rules" is hidden in the project, so it is not there.
    const sys = read(ctx, "sys-s1.txt");
    assert.ok(!sys.includes("- rules:"), "the main chat catalog does not take the workspace skill");
    assert.ok(!sys.includes("## Available skills"), "the chat has no skill — hence no catalog");
    assert.ok(sys.includes("\n- checker: Purpose of checker. [loaded skills rules]"), sys);
    assert.ok(sys.includes("\n- broken: Purpose of broken. [loaded skills rules, missing skills nonexistent — a start fails on that]"), sys);

    // cbase_agents_list in the run (ctl.types()) and the route without a run: the same answer.
    const inRun = JSON.parse(read(ctx, "list-s1.txt"));
    const withoutRun = await json(`${ctx.base}/api/chats/${chat.id}/agents`);
    for (const [where, list] of [["in run", inRun], ["without run", withoutRun]]) {
      const p = typeOf(list, "checker");
      const k = typeOf(list, "broken");
      assert.deepEqual([p?.skills, p?.skillsMissing ?? []].map(String), ["rules", ""], `${where}: ${JSON.stringify(p)}`);
      assert.deepEqual([k?.skills, k?.skillsMissing].map(String), ["rules", "nonexistent"], `${where}: ${JSON.stringify(k)}`);
    }
  }, { claude: fakeStart });
});

test("6. dynamic workflow: agent({agentType}) of a workspace agent loads its workspace skill on Claude, Codex and the loop engine; a missing name throws", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat } = await skillSituation(ctx);
    await json(`${ctx.base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
    const script = [
      "export const meta = { name: 'skills', description: 'ws-agents-default', phases: [{ title: 'Work' }] }",
      "const c = await agent('Job {TAG:wfc}', { agentType: 'checker' });",
      "const x = await agent('Job {TAG:wfx}', { agentType: 'checker', model: 'codex::gpt-5.6-sol' });",
      `const e = await agent('Job {TAG:wfe}', { agentType: 'checker', model: ${JSON.stringify(ctx.engine.model)} });`,
      "let k = 'no throw';",
      "try { await agent('Job {TAG:wfk}', { agentType: 'broken' }); } catch (err) { k = err.message; }",
      "return { c, x, e, k };",
    ].join("\n");
    const r = await json(`${ctx.base}/api/chats/${chat.id}/dyn-workflows/run`, { method: "POST", body: JSON.stringify({ script }) });
    assert.equal(r.status, "started", JSON.stringify(r));
    const end = await waitForTruthy(() => (store.readDynRun(r.runId)?.status !== "running" ? store.readDynRun(r.runId) : null), `run ${r.runId}`);
    await ctx.waitForLog(chat.id, (l) => l.some((m) => m.role === "user" && isCompletionNotice(m.text) && m.text.includes(r.runId)));
    await ctx.waitForIdle();

    assert.equal(end.status, "finished", end.error);
    const { c, x, k } = end.returnValue;
    assert.deepEqual([c, x], ["Report wfc", "Report wfx"]);
    for (const tag of ["wfc", "wfx"]) {
      const sys = read(ctx, `sub-${tag}.txt`);
      assert.match(sys, /You are checker\./, tag);
      assert.match(sys, /GUIDE-RULES: short sentences\./, `${tag}: the workspace skill is missing in the system prompt`);
    }
    const engineSys = ctx.engine.requests.map((b) => (b.messages || []).filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n")).filter((s) => s.includes("You are checker."));
    assert.ok(engineSys.length > 0, "the loop engine got the agent type");
    assert.ok(engineSys.every((s) => s.includes("GUIDE-RULES: short sentences.")), "loop engine: the workspace skill is missing in the system prompt");
    assert.match(k, /Skill "nonexistent" not found/, k);
    assert.equal(fs.existsSync(path.join(ctx.root, "sub-wfk.txt")), false, "the broken type has no process");
  }, { claude: fakeStart, codex: fakeCodexStart, engine: { text: "Engine done" } });
});

// The ONE skill way.
//
// Formerly there were three loading ways: a staged plugin directory for the Claude CLI, a staged CODEX_HOME for Codex, and a
// `Skill` tool of its own in the loop engine for all the others — three implementations of the same thing with three
// behaviours.
//
// Now the catalog (name + purpose) stands in the system prompt, which cbase writes the same for every provider; loading goes
// through the MCP tool `cbase_skill`. So the checks run AGAINST THE REAL RUN — on the arguments the CLI gets and on the MCP
// config next to it. Every promise has its counter-proof: a set without a mark must make the block AND the tool disappear,
// otherwise the rule would be a mere claim.
//
// OWN file: `initStore` rebinds the module-wide `db`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { readJsonl as readJsonlValue } from "./jsonl.mjs";
import { waitForQuiet } from "./quiet.mjs";

const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));

const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
if (!argv.includes("--append-system-prompt")) {
  let stdin = "";
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    if (argv.includes("--input-format")) say({ type: "result", result: "Title", session_id: "oneshot-fake" });
    else process.stdout.write(JSON.stringify({ result: "Title" }));
    process.exit(0);
  });
} else {
  process.stdin.on("end", () => process.exit(0));
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
    fs.appendFileSync(process.env.CBASE_TEST_TURNS, JSON.stringify({ argv, text }) + "\\n");
    const respond = () => {
      say({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
      say({ type: "result", result: "Done.", session_id: "skill-fake" });
    };
    // A turn with "HOLD-UNTIL-GATE" answers only once the gate file lies next to the log: the only reliable way to queue a
    // SECOND message (a fixed response time would be a bet under load).
    if (!text.includes("HOLD-UNTIL-GATE")) { setTimeout(respond, 30); return; }
    const gate = require("node:path").join(require("node:path").dirname(process.env.CBASE_TEST_TURNS), "gate");
    const wait = () => (fs.existsSync(gate) ? respond() : setTimeout(wait, 20));
    wait();
  });
}
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function ok(url, init) {
  const r = await json(url, init);
  assert.equal(r.status < 400, true, `${init?.method || "GET"} ${url} → ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}
// Waiting WITHOUT a deadline (house rule: no clock a test turns red on — the emergency brake is the suite deadline).
// One line on stderr every 30 s so that a hang says what it is waiting for.
async function waitFor(check, what) {
  const since = Date.now();
  let reported = 0;
  for (;;) {
    const got = await check();
    if (got) return got;
    const n = Math.floor((Date.now() - since) / 30_000);
    if (n > reported) { reported = n; console.error(`[waiting] for ${n * 30} s: ${what}`); }
    await new Promise((r) => setTimeout(r, 25));
  }
}
// After a FAILURE only a few looks at quiet, without throwing: the error above counts, and an open run from the failed body
// must not replace it with a hang (pattern: server-harness.mjs).
async function quietAfterFailure(base) {
  let s = null;
  for (let i = 0; i < 200; i++) {
    s = (await json(`${base}/api/runs/active`).catch(() => null))?.body || null;
    if (!s || s.quiet !== false) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  console.warn(`[test] server not quiet after the failure (${JSON.stringify(s.open)}) — the error above counts`);
}
// Only completed lines (jsonl.mjs): the fake CLI writes the log while the test reads.
const readJsonl = readJsonlValue;
const argOf = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-skills-way-"));
  const bin = path.join(root, "fake-claude");
  const turnLog = path.join(root, "turns.jsonl");
  const KEYS = ["CLAUDE_BIN", "CBASE_TRIGGER_POLL", "CBASE_TEST_TURNS", "CBASE_DEPOSIT_TICK_MS", "CBASE_SCHEDULE_TICK_MS"];
  const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  let server, base = "", finished = false;
  // The gate of the fake CLI (HOLD-UNTIL-GATE) — also opened in the finally, otherwise a turn held at the gate would keep the run open.
  const openGate = () => { try { fs.writeFileSync(path.join(root, "gate"), "1"); } catch { /* directory already gone */ } };
  try {
    fs.writeFileSync(bin, fakeClaude);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_TEST_TURNS = turnLog;
    process.env.CBASE_DEPOSIT_TICK_MS = "3600000";
    process.env.CBASE_SCHEDULE_TICK_MS = "3600000";
    const wsPath = path.join(root, "workspace");
    const projPath = path.join(wsPath, "till");
    fs.mkdirSync(projPath, { recursive: true });
    const port = await freePort();
    server = await startServer({ port, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${port}`;
    const ws = await ok(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Skill workspace", path: wsPath }) });
    const project = await ok(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Shop", path: projPath }) });
    await run({
      base, ws, project, openGate,
      turns: () => readJsonl(turnLog),
      mcpEnv: (chatId) => JSON.parse(fs.readFileSync(path.join(root, "data-root", "data", "scratch", `${chatId}.mcp.json`), "utf8")).mcpServers.cbase.env,
    });
    finished = true;
  } finally {
    openGate();
    // QUIET (quiet.mjs) instead of busy/runs: the auto title (a oneshot) is done too.
    if (base) { if (finished) await waitForQuiet(base); else await quietAfterFailure(base); }
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

// A skill belongs to exactly ONE area; since the managing teardown there is only coding (the default here is explicitly
// coding); a project skill is always coding.
const skill = (base, scope, id, name, description) =>
  ok(`${base}/api/${scope}/${id}/skills`, { method: "POST", body: JSON.stringify({ name, description, body: `Instructions for ${name}.`, ...(scope === "workspaces" ? { area: "coding" } : {}) }) });
// A managing skill and a manager chat are only legacy data now — no way creates them; the test puts them into the store (the
// server of this file runs in the same process), as they stand in an old database until the teardown removes them.
const oldManaging = (ws, name, description) => {
  const t = Date.now();
  return store.createSkill({ id: crypto.randomUUID(), workspaceId: ws.id, name, description, body: `Instructions for ${name}.`, area: "managing", createdAt: t, updatedAt: t });
};
const oldManagerChat = (ws, title = "Situation") => {
  const t = Date.now();
  return store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", agentId: "ag-old", title, provider: "claude", model: "", createdAt: t, updatedAt: t }).id;
};

// Run one turn and fetch the arguments the CLI got.
async function runArgv({ base, turns, chatId }) {
  const prior = turns().length;
  await ok(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text: "los" }) });
  const all = await waitFor(() => { const t = turns(); return t.length > prior ? t : null; }, "the fake CLI was started");
  await waitForQuiet(base);
  return all[all.length - 1].argv;
}

test("One way: the catalog stands in the system prompt, the plugin directory is gone, the native Skill tool is disallowed", async () => {
  await withServer(async ({ base, ws, project, turns, mcpEnv }) => {
    await skill(base, "workspaces", ws.id, "grill", "Puts a plan to the test.");
    await skill(base, "projects", project.id, "till-receipt", "Formats a till receipt.");
    const chat = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) });

    const argv = await runArgv({ base, turns, chatId: chat.id });
    const sys = argOf(argv, "--append-system-prompt") || "";

    // The catalog: heading, one line per skill with its purpose, and the origin on the project skill.
    assert.match(sys, /## Available skills/);
    assert.match(sys, /- grill: Puts a plan to the test\./);
    assert.match(sys, /- till-receipt \(from project Shop\): Formats a till receipt\./);
    // It names the tool to load with — otherwise the list would be an enumeration without a handle.
    assert.match(sys, /cbase_skill/);
    // And NOT the body: that costs only when loading.
    assert.ok(!sys.includes("Instructions for grill."), "the body does not belong in the catalog");

    // The three old ways are gone or disallowed.
    assert.ok(!argv.includes("--plugin-dir"), "no staged plugin directory any more");
    assert.equal(argOf(argv, "--setting-sources"), "user", "the isolation against .claude/skills stays");
    assert.match(argOf(argv, "--disallowedTools") || "", /\bSkill\b/, "the native Skill tool is disallowed");

    // The loading way itself: the names lie in the MCP config, they are the enumeration of the tool.
    assert.deepEqual(JSON.parse(mcpEnv(chat.id).CBASE_SKILLS).sort(), ["grill", "till-receipt"]);
  });
});

// Formerly the skills of an agent type stood COMPLETELY in its --agents definition to the Claude CLI. That way is gone: the
// type runs only through cbase_agent, where the CORE loads the skills (proof at the main seam: agents-types.test.js). What
// stays here is what the MAIN run sees of it.
test("skills of an agent type: the main run keeps only the catalog, and --agents is gone", async () => {
  await withServer(async ({ base, ws, project, turns }) => {
    await skill(base, "workspaces", ws.id, "checklist", "Checks step by step.");
    await skill(base, "projects", project.id, "till-receipt", "Formats a till receipt.");
    const ag = await ok(`${base}/api/workspaces/${ws.id}/agents`, { method: "POST", body: JSON.stringify({
      name: "checker", description: "Checks", body: "You check.", skills: ["checklist", "nonexistent"],
    }) });
    assert.equal(ag.skills, "checklist, nonexistent", "the route stores the comma list — array like string");
    const chat = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) });

    const argv = await runArgv({ base, turns, chatId: chat.id });
    assert.ok(!argv.includes("--agents"), "no Claude spawn carries --agents any more");
    const sys = argOf(argv, "--append-system-prompt") || "";
    assert.match(sys, /- checklist: Checks step by step\./);
    assert.ok(!sys.includes("Instructions for checklist."), "the body does not belong in the main run");
    assert.ok(!sys.includes("Loaded skills"), "the main run loads nothing completely");
    // And the selection in the system prompt names what the type brings along — "loaded" only what the start loads; a name that
    // exists nowhere stands as missing (same resolution as at the start: skill-catalog.js definitionsSkills).
    assert.match(sys, /- checker: Checks \[loaded skills checklist, missing skills nonexistent — a start fails on that\]/);
  });
});

test("counter-proof: without coding skills there is neither catalog nor tool", async () => {
  await withServer(async ({ base, ws, turns, mcpEnv }) => {
    // A skill exists — but an old managing skill. That makes the set of THIS chat empty, and an empty set must make both
    // disappear: a tool that answers "no skills available" would be a promise it does not keep.
    oldManaging(ws, "only-manager", "Only for managing.");
    const chat = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) });

    const argv = await runArgv({ base, turns, chatId: chat.id });
    assert.ok(!(argOf(argv, "--append-system-prompt") || "").includes("Available skills"), "no catalog block");
    assert.equal(mcpEnv(chat.id).CBASE_SKILLS, undefined, "no CBASE_SKILLS, so no tool");
    // The isolation does NOT hang on the catalog — it must stand without skills too.
    assert.equal(argOf(argv, "--setting-sources"), "user");
  });
});

// Formerly "the manager chat gets the managing skills of the workspace — not coding and project skills" (measured on the
// run). Since the managing teardown no turn of a manager chat begins (runs/manager-lock.js), and its catalog is empty — even
// with an old managing skill in the workspace.
test("an old manager chat has no catalog: neither coding, project nor old managing skills — and its turn does not begin", async () => {
  await withServer(async ({ base, ws, project, turns }) => {
    oldManaging(ws, "situation", "For managing.");
    await skill(base, "workspaces", ws.id, "only-code", "Only for coding.");
    await skill(base, "projects", project.id, "till-receipt", "Project.");
    const mgr = oldManagerChat(ws);

    assert.deepEqual(await ok(`${base}/api/chats/${mgr}/skills`), [], "the catalog of the manager chat is empty");
    const prior = turns().length;
    const r = await json(`${base}/api/chats/${mgr}/message`, { method: "POST", body: JSON.stringify({ text: "los" }) });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.managerLocked, true);
    assert.equal(turns().length, prior, "no CLI started");
  });
});

test("loading: the route delivers the instructions — and only what stands in the catalog of this chat", async () => {
  await withServer(async ({ base, ws, project }) => {
    await skill(base, "workspaces", ws.id, "grill", "Coding.");
    oldManaging(ws, "situation", "Managing.");
    await skill(base, "projects", project.id, "till-receipt", "Project.");
    const chat = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) });

    const loaded = await ok(`${base}/api/chats/${chat.id}/skills/grill`);
    assert.equal(loaded.name, "grill");
    assert.equal(loaded.body, "Instructions for grill.");
    const projectSkill = await ok(`${base}/api/chats/${chat.id}/skills/till-receipt`);
    assert.equal(projectSkill.originProject, "Shop", "the origin says what the skill applies for");

    // A name that does not exist — and one that does but does not belong in THIS catalog: both must run into a wall,
    // otherwise the enumeration in the schema would be mere decoration.
    assert.equal((await json(`${base}/api/chats/${chat.id}/skills/nonexistent`)).status, 404);
    assert.equal((await json(`${base}/api/chats/${chat.id}/skills/situation`)).status, 404, "the coding chat cannot load an old managing skill");

    // An old manager chat loads nothing at all any more.
    const mgr = oldManagerChat(ws);
    for (const name of ["grill", "till-receipt", "situation"]) {
      assert.equal((await json(`${base}/api/chats/${mgr}/skills/${name}`)).status, 404, `the manager chat does not load ${name}`);
    }
  });
});

// The MCP server is a process of its own; its tool set arises at the start from the environment. Without this test
// "the tool is missing for an empty catalog" would be a statement about the environment from
// `toolchain/mcp-config.js:writeMcpConfig`, not about what the model sees.
async function toolsList(env) {
  const subprocess = spawn(process.execPath, [MCP_SCRIPT], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  subprocess.stdout.on("data", (c) => { out += c; });
  subprocess.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  const result = await new Promise((resolve, reject) => {
    // Without a deadline: it has answered or it has ended — both report themselves.
    // Wait for a COMPLETE line: the answer is over 60 kB and arrives in pieces; a `startsWith("{")` on the buffer would
    // otherwise hit half a JSON.
    subprocess.stdout.on("data", () => {
      const nl = out.indexOf("\n");
      if (nl < 0) return;
      try { const m = JSON.parse(out.slice(0, nl)); subprocess.kill(); resolve(m); }
      catch (e) { subprocess.kill(); reject(e); }
    });
    subprocess.on("exit", (code) => { if (!out.includes("\n")) reject(new Error(`MCP server ended with ${code}: ${out.slice(0, 400)}`)); });
  });
  return result.result.tools;
}

test("the tool hangs on the catalog alone — in the full set as in an explicit choice", async () => {
  const including = { CBASE_CHAT_ID: "c1", CBASE_SKILLS: JSON.stringify(["grill", "till-receipt"]) };

  // Full catalog of a coding chat.
  const full = await toolsList(including);
  const skillTool = full.find((t) => t.name === "cbase_skill");
  assert.ok(skillTool, "cbase_skill is missing in the full set");
  // WITHOUT an enumeration: a skill the main agent creates in the same turn with cbase_skill_write would otherwise not be
  // loadable. A remembered name still runs into a wall — in the SERVER (GET /api/chats/:id/skills/:name checks against
  // chatSkills, 404), no longer at the schema.
  assert.equal(skillTool.inputSchema.properties.name.enum, undefined, "no fixed name list in the schema any more");
  assert.equal(skillTool.inputSchema.properties.name.type, "string");

  // Explicit choice (e.g. of an agent definition): cbase_skill is NOT in it and is there anyway.
  const choice = await toolsList({ ...including, CBASE_TOOLS: JSON.stringify(["cbase_projects_list"]) });
  assert.ok(choice.some((t) => t.name === "cbase_skill"), "in an explicit choice it is missing");
  assert.ok(choice.some((t) => t.name === "cbase_projects_list"));

  // Counter-proof, twofold: without a catalog the tool exists nowhere.
  for (const [what, env] of [
    ["full set", { CBASE_CHAT_ID: "c1" }],
    ["explicit choice", { CBASE_CHAT_ID: "c1", CBASE_TOOLS: JSON.stringify(["cbase_projects_list"]) }],
  ]) {
    const without = await toolsList(env);
    assert.ok(!without.some((t) => t.name === "cbase_skill"), `without a catalog it must not stand in the ${what}`);
  }
  // Whoever may write skills (mark CBASE_SKILL_WRITE) has the reading tool even with an empty catalog — only it delivers id
  // and version for change and delete, and a just-created skill would otherwise not be loadable.
  const writer = await toolsList({ CBASE_CHAT_ID: "c1", CBASE_SKILL_WRITE: "1" });
  assert.ok(writer.some((t) => t.name === "cbase_skill"), "with the write mark the reading tool is missing");
  assert.ok(writer.some((t) => t.name === "cbase_skill_write"), "with the write mark the writing tool is missing");
});

// ── The slash resolver ───────────────────────────────────────────────────────────────────────
//
// The Claude CLI used to parse "/skillname" itself — it knew the skills because they lay next to it as a plugin directory.
// Over MCP it no longer does. So the server resolves at SENDING, against the fresh catalog, using the separation the
// delivery knows anyway: `prompt` is what the model reads, `display` stays the typed line. Both are checked against each
// other here — at one place alone it would not be visible that they diverge.
test("slash: the server resolves /skillname, the display stays the typed line", async () => {
  await withServer(async ({ base, ws, turns }) => {
    await skill(base, "workspaces", ws.id, "grill", "Puts a plan to the test.");
    const chat = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) });

    const prior = turns().length;
    await ok(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "/grill check the plan" }) });
    const turn = (await waitFor(() => { const t = turns(); return t.length > prior ? t : null; }, "the turn reaches the CLI")).at(-1);
    await waitForQuiet(base);

    assert.match(turn.text, /Use the skill `grill`/, "the model gets a task, not a slash");
    assert.match(turn.text, /cbase_skill/, "and the way to load it");
    assert.match(turn.text, /check the plan/, "the rest of the line is kept");
    assert.ok(!turn.text.startsWith("/"), "the slash does NOT go to the provider");

    const log = await ok(`${base}/api/chats/${chat.id}/log`);
    const user = log.find((m) => m.role === "user");
    assert.equal(user.content ?? user.text, "/grill check the plan",
      "the history shows what was typed — otherwise nobody would know what the run was started with");
  });
});

test("slash: a name without a hit passes through unchanged", async () => {
  await withServer(async ({ base, ws, turns }) => {
    await skill(base, "workspaces", ws.id, "grill", "Coding.");
    // A skill that exists — but not in THIS catalog (an old managing skill). It must not resolve either, otherwise the
    // enumeration in the tool schema would be mere decoration.
    oldManaging(ws, "only-manager", "Only for managing.");
    const chat = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) });

    for (const row of ["/unknown do something", "/only-manager do something"]) {
      const prior = turns().length;
      await ok(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: row }) });
      const turn = (await waitFor(() => { const t = turns(); return t.length > prior ? t : null; }, `turn for ${row}`)).at(-1);
      await waitForQuiet(base);
      assert.equal(turn.text, row, `"${row}" goes to the provider unchanged`);
    }
  });
});

test("slash: a display sent along belongs to the client — the resolver does not touch it", async () => {
  await withServer(async ({ base, ws, turns }) => {
    await skill(base, "workspaces", ws.id, "grill", "Coding.");
    const chat = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) });

    // This is how the client sends "/goal <text>" today: display and prompt are already separated. A second resolver on top
    // would overwrite a decision already made.
    const prior = turns().length;
    await ok(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "/grill raw", display: "/goal something" }) });
    const turn = (await waitFor(() => { const t = turns(); return t.length > prior ? t : null; }, "turn")).at(-1);
    await waitForQuiet(base);
    assert.equal(turn.text, "/grill raw", "the text of the client passes through unchanged");
    const log = await ok(`${base}/api/chats/${chat.id}/log`);
    assert.equal((log.find((m) => m.role === "user")?.text ?? ""), "/goal something");
  });
});

// A QUEUED message must be resolved just like one that starts the run: the slash picker also stands in the composer while the
// agent is still working. Resolution happens in ONE place (at sending), the queue then carries the finished prompt — this is
// the proof, since a second resolution place would be the next kind that diverges.
test("slash: the queued message reaches the model as a task too", async () => {
  await withServer(async ({ base, ws, turns, openGate }) => {
    await skill(base, "workspaces", ws.id, "grill", "Puts a plan to the test.");
    const chat = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) });

    // The first turn is held at the gate so that the second message falls into the queue instead of starting a run of its own —
    // a gate instead of a response time.
    await ok(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "HOLD-UNTIL-GATE: first message" }) });
    await waitFor(() => (turns().length >= 1 ? true : null), "the first turn reaches the CLI");

    const response = await ok(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "/grill and then go on" }) });
    assert.equal(response.queued, true, "the second message must be queued, otherwise the test checks the direct way");
    openGate();

    const second = await waitFor(() => { const t = turns(); return t.length >= 2 ? t[1] : null; }, "the queued turn reaches the CLI");
    assert.match(second.text, /Use the skill `grill`/, "the task also comes from the queue, not the slash");
    assert.match(second.text, /and then go on/, "the rest of the line is kept");

    await waitForQuiet(base);
    // And the history still shows what was typed.
    const log = await ok(`${base}/api/chats/${chat.id}/log`);
    assert.ok(log.some((m) => m.role === "user" && (m.text || "") === "/grill and then go on"),
      `the typed line is missing in the history: ${JSON.stringify(log.filter((m) => m.role === "user").map((m) => m.text))}`);
  });
});

// ── Opt-out in the run and the cost line against the real catalog ─────────────────────────────
//
// A workspace coding skill applies in every project until the project hides it, and every skills view names "n skills · ~X
// tokens per request" from `GET …/skill-catalog` — calculated like the catalog in the system prompt. Both are checked on the
// RUN: on the arguments of the CLI and the MCP config next to it, not on the route alone — otherwise the route would only
// prove itself.

// The catalog block as it stands in the system prompt (runs/do-run.js appends it as `"\n\n" + skillCatalog(…)`): from the
// heading to the end of the list.
function catalogBlock(sys) {
  const start = sys.indexOf("## Available skills");
  if (start < 0) return "";
  const list = sys.indexOf("\n- ", start);
  const end = sys.indexOf("\n\n", list);
  return sys.slice(start, end < 0 ? sys.length : end);
}
const catalogRows = (block) => block.split("\n").filter((z) => z.startsWith("- ")).map((z) => z.slice(2).split(/[: ]/)[0]).sort();

test("opt-out in the run: a project chat sees the workspace skills by default — hidden ones drop out of catalog, tool and loading", async () => {
  await withServer(async ({ base, ws, project, turns, mcpEnv }) => {
    const grill = await skill(base, "workspaces", ws.id, "grill", "Puts a plan to the test.");
    await skill(base, "workspaces", ws.id, "check", "Checks step by step.");
    oldManaging(ws, "situation", "The situation.");
    await skill(base, "projects", project.id, "till-receipt", "Formats a till receipt.");
    const chat = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, projectId: project.id }) });

    const run = async () => {
      const sys = argOf(await runArgv({ base, turns, chatId: chat.id }), "--append-system-prompt") || "";
      return { catalog: catalogRows(catalogBlock(sys)), tool: JSON.parse(mcpEnv(chat.id).CBASE_SKILLS || "[]").sort() };
    };
    // By default: own + all workspace CODING skills (opt-out) — never an old managing skill.
    assert.deepEqual(await run(), { catalog: ["check", "grill", "till-receipt"], tool: ["check", "grill", "till-receipt"] });

    // Hidden: gone from catalog AND tool enumeration, and loading runs into a wall.
    await ok(`${base}/api/projects/${project.id}/workspace-skills/${grill.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(await run(), { catalog: ["check", "till-receipt"], tool: ["check", "till-receipt"] });
    assert.equal((await json(`${base}/api/chats/${chat.id}/skills/grill`)).status, 404, "a hidden skill is not loadable");

    // Counter-proof: shown again it is back.
    await ok(`${base}/api/projects/${project.id}/workspace-skills/${grill.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    assert.deepEqual(await run(), { catalog: ["check", "grill", "till-receipt"], tool: ["check", "grill", "till-receipt"] });
  });
});

// Formerly an additional level "manager chat" (?area=managing) — it fell; an old managing skill counts in no level.
test("skill-catalog = the catalog in the system prompt: count and tokens per level (workspace chat, project chat with a hide)", async () => {
  await withServer(async ({ base, ws, project, turns }) => {
    const grill = await skill(base, "workspaces", ws.id, "grill", "Puts a plan to the test.");
    await skill(base, "workspaces", ws.id, "check", "Checks   step\nby step.");
    oldManaging(ws, "situation", "The situation of the workspace.");
    await skill(base, "projects", project.id, "till-receipt", "Formats a till receipt.");
    await ok(`${base}/api/projects/${project.id}/workspace-skills/${grill.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });

    const levels = [
      ["workspace chat", (await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) })).id, "?area=coding", 3],
      ["project chat", (await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, projectId: project.id }) })).id, `?area=coding&projectId=${project.id}`, 2],
    ];
    for (const [where, chatId, query, n] of levels) {
      const block = catalogBlock(argOf(await runArgv({ base, turns, chatId }), "--append-system-prompt") || "");
      assert.ok(block, `${where}: no catalog in the system prompt`);
      const route = await ok(`${base}/api/workspaces/${ws.id}/skill-catalog${query}`);
      assert.deepEqual(route, { count: catalogRows(block).length, token: Math.round(block.length / 4) }, `${where}: route and prompt calculate differently`);
      assert.equal(route.count, n, where);
    }
  });
});

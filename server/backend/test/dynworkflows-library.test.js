// Dynamic workflows, library on the server.
//
// Main seam: a real server plus a real cbase MCP server (spawned by path, as the app starts it). The tool
// cbase_dynamic_workflow_save stores through the chat route, the workspace route lists it, the project route adopts it.
// Also the tool sets: what a run really sees, measured with the MCP environment carried by the golden recordings of the
// real run kinds (fixtures/golden/<scenario>/spawn.json) — a coding chat and a graph step see both tools, subagents do not.
//
// Counter-tests (which sabotage turns which test red):
//   · Remove the name check (`nameForbidden`) in dynworkflows/routes.js => "goal" & co. land in the library.
//   · Replace `typeof b.enabled !== "boolean"` by `!!b.enabled` as in the neighbouring routes => a body without the field is 200.
//   · Take a name out of `VIEW_BY_DEPTH.alwaysLocked` => the subagent sees the tool.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { db as rawDb } from "../electron/server/store/db.js";
import { RESERVED_NAMES } from "../electron/server/dynworkflows/names.js";
import { CODING_TOOLS } from "../electron/server/toolchain/tool-catalog.js";
import { AGENT_DEPTH_MAX } from "../electron/mcp/visibility.js";

const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));
const GOLDEN = fileURLToPath(new URL("./fixtures/golden/", import.meta.url));
// Also the run and its stop — the same tool sets (opt-in and graph lock are checked by the server, dynworkflows-run.test.js).
const TOOLS = ["cbase_dynamic_workflow_list", "cbase_dynamic_workflow_save", "cbase_dynamic_workflow", "cbase_dynamic_workflow_stop"];

// A cbase MCP server with this environment. No deadline: an answer that never comes stops the suite (emergency brake).
async function withMcp(env, run) {
  const child = spawn(process.execPath, [MCP_SCRIPT], {
    env: { ...process.env, CBASE_TOOLS: undefined, CBASE_TOOLSET: undefined, CBASE_SKILLS: undefined, CBASE_AGENT_DEPTH: undefined, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const open = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const z = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!z) continue;
      const msg = JSON.parse(z);
      open.get(msg.id)?.(msg);
      open.delete(msg.id);
    }
  });
  let n = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = n++;
    open.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name, args = {}) => {
    const r = (await rpc("tools/call", { name, arguments: args })).result || {};
    const text = r.content?.[0]?.text || "";
    let data = null;
    try { data = JSON.parse(text); } catch { /* error text */ }
    return { isError: r.isError === true, text, data };
  };
  const list = async () => ((await rpc("tools/list", {})).result?.tools || []).map((t) => t.name);
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18" });
    return await run({ call, list });
  } finally {
    child.stdin.end();
    child.kill();
  }
}

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dynwf-bib-"));
  let server;
  try {
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = async (method, filePath, body) => {
      const res = await fetch(`${base}${filePath}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    };
    await run({ base, req, root });
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const script = (name, { body = "const a = await agent('read the diff');\nreturn a;\n" } = {}) =>
  `export const meta = {\n  name: '${name}',\n  description: 'Checks changes',\n  whenToUse: 'after a refactor',\n  phases: [{ title: 'Read' }, { title: 'Judge', detail: 'brief' }],\n};\n\n${body}`;

test("main seam: save via tool, names, duplicates, project adoption, view, delete", async () => {
  await withServer(async ({ base, req, root }) => {
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    const ws = (await req("POST", "/api/workspaces", { name: "Bib", path: wsPath })).data;
    const project = (await req("POST", `/api/workspaces/${ws.id}/projects`, { name: "Till", path: path.join(wsPath, "till") })).data;
    assert.ok(project.id, JSON.stringify(project));
    const wsChat = (await req("POST", "/api/chats", { workspaceId: ws.id, provider: "claude" })).data;
    const pChat = (await req("POST", "/api/chats", { workspaceId: ws.id, projectId: project.id, provider: "claude" })).data;
    assert.equal(pChat.projectId, project.id);
    assert.equal((await req("POST", `/api/workspaces/${ws.id}/skills`, { name: "deploy-check", area: "coding", description: "d", body: "b" })).status, 201);
    assert.equal((await req("POST", `/api/projects/${project.id}/skills`, { name: "till-check", description: "d", body: "b" })).status, 201);
    const library = async () => (await req("GET", `/api/workspaces/${ws.id}/dyn-workflows`)).data.map((w) => w.name);

    const env = (chat) => ({ CBASE_BASE_URL: base, CBASE_CHAT_ID: chat.id, CBASE_WORKSPACE_ID: ws.id });

    // ── From the workspace chat: stored byte-equal, meta parsed; only in the workspace ─────────────────────────
    const text = script("review-changes");
    await withMcp(env(wsChat), async ({ call }) => {
      const r = await call("cbase_dynamic_workflow_save", { script: text });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.name, "review-changes");
      assert.equal(r.data.takenOverIn, null);

      // Non-literal meta: tool error with the parser's wording, no entry.
      for (const wrong of [
        "export const meta = { name: `x${1}`, description: 'd' };\nreturn 1;\n",
        "const n = 'x';\nexport const meta = { name: n, description: 'd' };\nreturn 1;\n",
        "export const meta = { name: 'kaputt', description: 'd' };\nreturn (;\n",
      ]) {
        const f = await call("cbase_dynamic_workflow_save", { script: wrong });
        assert.equal(f.isError, true, `accepted: ${wrong}`);
        assert.match(f.text, /meta must be a pure literal|FIRST statement|parse error/);
      }

      // Reserved names (local slash commands and `workflows`), also in other spelling, and skill names.
      for (const name of [...RESERVED_NAMES, "Goal", "WORKFLOWS"]) {
        const f = await call("cbase_dynamic_workflow_save", { script: script(name) });
        assert.equal(f.isError, true, `reserved name "${name}" was saved`);
        assert.match(f.text, /reserviert|reserved/);
      }
      for (const name of ["deploy-check", "Till-Check"]) {
        const f = await call("cbase_dynamic_workflow_save", { script: script(name) });
        assert.equal(f.isError, true, `skill name "${name}" was saved`);
        assert.match(f.text, /Skill/);
      }
      const form = await call("cbase_dynamic_workflow_save", { script: script("two words") });
      assert.equal(form.isError, true);

      // Duplicate: never overwrite silently — not even in another spelling.
      const second = script("Review-Changes", { body: "return 'different';\n" });
      const d = await call("cbase_dynamic_workflow_save", { script: second });
      assert.equal(d.isError, true);
      assert.match(d.text, /existiert|already exists/);

      const l = await call("cbase_dynamic_workflow_list");
      assert.equal(l.isError, false);
      assert.deepEqual(l.data.map((w) => w.name), ["review-changes"]);
    });
    assert.deepEqual(await library(), ["review-changes"], "failed attempts stored something");
    const duplicate = await req("POST", `/api/chats/${wsChat.id}/dyn-workflows`, { script: script("review-changes") });
    assert.equal(duplicate.status, 409);

    const [entry] = (await req("GET", `/api/workspaces/${ws.id}/dyn-workflows`)).data;
    const view = (await req("GET", `/api/workspaces/${ws.id}/dyn-workflows/${entry.id}`)).data;
    assert.equal(view.script, text, "the script is not byte-equal");
    assert.deepEqual(view.meta, { name: "review-changes", description: "Checks changes", whenToUse: "after a refactor", phases: [{ title: "Read" }, { title: "Judge", detail: "brief" }] });
    assert.equal(view.whenToUse, "after a refactor");
    assert.equal(view.phases.length, 2);

    // Invisible in the project chat: not adopted (default off).
    await withMcp(env(pChat), async ({ call }) => {
      assert.deepEqual((await call("cbase_dynamic_workflow_list")).data, []);
      // ── From the project chat: in the workspace AND in this project ───────────────────────────────────────────
      const r = await call("cbase_dynamic_workflow_save", { script: script("till-reconcile") });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.takenOverIn, project.id);
      assert.deepEqual((await call("cbase_dynamic_workflow_list")).data.map((w) => w.name), ["till-reconcile"]);
    });
    assert.deepEqual(await library(), ["review-changes", "till-reconcile"]);
    await withMcp(env(wsChat), async ({ call }) => {
      assert.deepEqual((await call("cbase_dynamic_workflow_list")).data.map((w) => w.name), ["review-changes", "till-reconcile"]);
    });

    // ── Adoption route: the field is required ────────────────────────────────────────────────────────────────
    const takeover = (name) => `/api/projects/${project.id}/workspace-dyn-workflows/${encodeURIComponent(name)}/enabled`;
    assert.equal((await req("PATCH", takeover("review-changes"), {})).status, 400, "without enabled");
    assert.equal((await req("PATCH", takeover("review-changes"), { enabled: "true" })).status, 400, "enabled as a string");
    assert.equal((await req("PATCH", takeover("exists-not"), { enabled: true })).status, 404);
    assert.equal((await req("PATCH", takeover("Review-Changes"), { enabled: true })).status, 200);
    const state = async () => Object.fromEntries((await req("GET", `/api/projects/${project.id}/workspace-dyn-workflows`)).data.map((w) => [w.name, w.enabled]));
    assert.deepEqual(await state(), { "till-reconcile": true, "review-changes": true });
    assert.equal((await req("PATCH", takeover("till-reconcile"), { enabled: false })).status, 200);
    assert.deepEqual(await state(), { "till-reconcile": false, "review-changes": true });
    const projectList = async () => (await req("GET", `/api/chats/${pChat.id}/dyn-workflows`)).data.map((w) => w.name);
    assert.deepEqual(await projectList(), ["review-changes"]);

    // ── Delete: entry and adoptions ─────────────────────────────────────────────────────────────────────
    assert.equal((await req("DELETE", `/api/workspaces/${ws.id}/dyn-workflows/${entry.id}`)).status, 200);
    assert.equal((await req("GET", `/api/workspaces/${ws.id}/dyn-workflows/${entry.id}`)).status, 404);
    assert.deepEqual(await library(), ["till-reconcile"]);
    // Saved again under the same name: the old adoption must not revive.
    assert.equal((await req("POST", `/api/chats/${wsChat.id}/dyn-workflows`, { script: text })).status, 201);
    assert.deepEqual(await projectList(), [], "the adoption survived the deletion");
    // A foreign workspace does not see the entries.
    const foreignPath = path.join(root, "foreign");
    fs.mkdirSync(foreignPath);
    const foreign = (await req("POST", "/api/workspaces", { name: "Foreign", path: foreignPath })).data;
    const [fresh] = (await req("GET", `/api/workspaces/${ws.id}/dyn-workflows`)).data.filter((w) => w.name === "review-changes");
    assert.equal((await req("GET", `/api/workspaces/${foreign.id}/dyn-workflows/${fresh.id}`)).status, 404);
    assert.deepEqual((await req("GET", `/api/workspaces/${foreign.id}/dyn-workflows`)).data, []);
  });
});

// The cbase server's MCP environment per spawn of a golden recording, placeholders replaced by something unreachable
// (only tools/list matters).
function goldenEnvironments(scenario) {
  const spawns = JSON.parse(fs.readFileSync(path.join(GOLDEN, scenario, "spawn.json"), "utf8"));
  return spawns.filter((s) => s.genus === "chat" && s.mcpConfig?.mcpServers?.cbase).map((s) => {
    const env = { ...s.mcpConfig.mcpServers.cbase.env };
    env.CBASE_BASE_URL = "http://127.0.0.1:1";
    return env;
  });
}

test("tool sets: coding chat and graph step see both tools; subagents do not", async () => {
  const looks = async (env) => withMcp(env, ({ list }) => list());
  const row = [];
  for (const [scenario, expected, selection] of [
    ["run", true, (u) => u],
    ["targetGate", true, (u) => u],
    ["workflow", true, (u) => u],
    ["subagent", false, (u) => u.filter((e) => e.CBASE_AGENT_DEPTH)],
    ["subagent", true, (u) => u.filter((e) => !e.CBASE_AGENT_DEPTH)],
  ]) {
    const environments = selection(goldenEnvironments(scenario));
    assert.ok(environments.length > 0, `${scenario}: no chat recording — did the golden scenario move?`);
    for (const env of environments) {
      const names = await looks(env);
      assert.ok(names.includes("cbase_projects_list"), `${scenario}: empty list — does the test still measure?`);
      for (const w of TOOLS) assert.equal(names.includes(w), expected, `${scenario}${env.CBASE_AGENT_DEPTH ? ` (Depth ${env.CBASE_AGENT_DEPTH})` : ""}: ${w}`);
    }
    row.push(`${scenario}${expected ? "+" : "−"}${environments.length}`);
  }
  // Every depth of a subagent, also under the full catalog.
  for (let t = 1; t <= AGENT_DEPTH_MAX; t++) {
    const names = await looks({ CBASE_BASE_URL: "http://127.0.0.1:1", CBASE_CHAT_ID: "c", CBASE_AGENT_DEPTH: String(t) });
    for (const w of TOOLS) assert.equal(names.includes(w), false, `Tiefe ${t}: ${w}`);
  }
  // None is selectable: the tool catalog of the agent choice does not know the tools, and a list built from it does not show them.
  for (const w of TOOLS) assert.equal(CODING_TOOLS.includes(w), false, `the agent-choice catalog knows ${w}`);
  const everything = await looks({ CBASE_BASE_URL: "http://127.0.0.1:1", CBASE_CHAT_ID: "c", CBASE_TOOLS: JSON.stringify(CODING_TOOLS) });
  for (const w of TOOLS) assert.equal(everything.includes(w), false, `list from the whole catalog: ${w}`);
  console.log(`[library] tool sets measured: ${row.join(" ")}, Tiefe 1–${AGENT_DEPTH_MAX} −`);
});

// "Save as workflow" at the end marker is gone: saving only goes through the tool (above, "main seam"). The guard keeps the
// old route from silently coming back — even on a FINISHED run of the own chat it stores nothing.
test("saving from a run no longer exists: the old route stores nothing", async () => {
  await withServer(async ({ req, root }) => {
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    const ws = (await req("POST", "/api/workspaces", { name: "Bib", path: wsPath })).data;
    const chat = (await req("POST", "/api/chats", { workspaceId: ws.id, provider: "claude" })).data;
    const runId = "wf_gone_1";
    const scriptPath = path.join(root, `${runId}.js`);
    fs.writeFileSync(scriptPath, script("from-the-run"));
    store.createDynRun({ runId, taskId: "task_gone_1", chatId: chat.id, name: "from-the-run", meta: {}, scriptPath, outputPath: path.join(root, `${runId}.json`) });
    store.endDynRun(runId, { status: "finished", stoppedOf: "" });
    const r = await req("POST", `/api/chats/${chat.id}/dyn-workflows/runs/${runId}/save`, {});
    assert.ok(r.status >= 400, `the old route answers ${r.status}: ${JSON.stringify(r.data)}`);
    assert.deepEqual((await req("GET", `/api/workspaces/${ws.id}/dyn-workflows`)).data, [], "the old route stored something");
  });
});

// Storing and deleting run in ONE transaction, and the rollback is protected: if SQLite already ended the transaction itself
// (disk full, IOERR, a RAISE(ROLLBACK)), a second ROLLBACK would throw "no transaction is active" and REPLACE the real error;
// a delete without a transaction would lose the entry but keep its adoptions if the second statement failed. The errors come
// from TEMP triggers on the store's own connection (standing in for SQLITE_FULL).
test("rollback: if SQLite rolls the store back itself, the ORIGINAL error propagates and nothing stays; a delete that fails midway leaves the entry whole", async () => {
  await withServer(async ({ req, root }) => {
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    const ws = (await req("POST", "/api/workspaces", { name: "Transaction", path: wsPath })).data;
    const project = (await req("POST", `/api/workspaces/${ws.id}/projects`, { name: "Till", path: path.join(wsPath, "till") })).data;
    const create = (name) => store.createDynWorkflow({ id: crypto.randomUUID(), workspaceId: ws.id, name, meta: { name }, script: "return 1;\n", projectId: project.id });

    rawDb.exec("CREATE TEMP TRIGGER poison_rollback BEFORE INSERT ON project_dyn_workflow_enabled BEGIN SELECT RAISE(ROLLBACK, 'POISON-ROLLBACK'); END");
    try {
      assert.throws(() => create("rolls-back"), (e) => {
        assert.match(String(e?.message), /POISON-ROLLBACK/, `the original error is hidden: "${e?.message}"`);
        return true;
      });
    } finally { rawDb.exec("DROP TRIGGER IF EXISTS temp.poison_rollback"); }
    assert.ok(!store.getDynWorkflowByName(ws.id, "rolls-back"), "an entry without its adoption stayed");
    // The connection did not stay in an open transaction afterwards: the next transaction goes through.
    const w = create("stays-whole");
    assert.deepEqual([...store.listEnabledDynWorkflowNames(project.id)], ["stays-whole"]);

    rawDb.exec("CREATE TEMP TRIGGER poison_delete BEFORE DELETE ON project_dyn_workflow_enabled BEGIN SELECT RAISE(ABORT, 'POISON-DELETE'); END");
    try {
      assert.throws(() => store.deleteDynWorkflow(w.id), /POISON-DELETE/);
    } finally { rawDb.exec("DROP TRIGGER IF EXISTS temp.poison_delete"); }
    assert.ok(store.getDynWorkflow(w.id), "the entry is gone, its project adoption stayed — a half delete");
    assert.deepEqual([...store.listEnabledDynWorkflowNames(project.id)], ["stays-whole"]);
    assert.equal(store.deleteDynWorkflow(w.id), true);
    assert.deepEqual([...store.listEnabledDynWorkflowNames(project.id)], []);
  });
});

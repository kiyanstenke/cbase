import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";

// Workspace MCP servers apply in every project: opt-out like the credentials (vars-free-text.test.js) and the coding skills
// (chat-skills.test.js); `project_mcp_excluded` carries only the exceptions (it used to be opt-in, a new project had no workspace
// server). Checked on BOTH sides, the computation a run hooks in (`store.effectiveMcpServers`) and the route web and iOS show,
// because one side alone can be green while the other says the opposite.
// Counter-tests: with the old opt-in line in effectiveMcpServers the first test is red (the new project sees no workspace
// server); with `!!b.enabled` instead of the check for a boolean the second one (a body without the field silently hides).
async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-mcp-optout-"));
  let server;
  try {
    server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data-root"),
      webDir: path.join(root, "web"),
      pickDirectory: null,
      notify: null,
    });
    await run({ base: `http://127.0.0.1:${server.address().port}`, root });
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}); test unaffected.`); }
  }
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

// An http server on a port nobody listens on: creating it fetches no tools, and an attempt fails at once.
const server = (name) => JSON.stringify({ name, transport: "http", url: "http://127.0.0.1:9/mcp" });

async function creation(base, root) {
  const ws = await ok(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "WS", path: path.join(root, "ws") }) });
  const project = async (name) => {
    const filePath = path.join(root, "ws", name.toLowerCase());
    fs.mkdirSync(filePath, { recursive: true });
    return ok(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name, path: filePath }) });
  };
  return { ws, project };
}

const names = (list) => list.map((s) => s.name).sort();

test("a workspace server applies at once in every project, also one created afterwards; hiding acts only in the project", async () => {
  await withServer(async ({ base, root }) => {
    const { ws, project } = await creation(base, root);
    const till = await project("Till");
    const teams = await ok(`${base}/api/workspaces/${ws.id}/mcp-servers`, { method: "POST", body: server("teams") });
    const orbit = await project("Orbit");

    // The computation a run hooks in: in both projects without further ado, the one created before and the one after.
    assert.deepEqual(names(store.effectiveMcpServers(ws.id, till.id)), ["teams"], "project before the server");
    assert.deepEqual(names(store.effectiveMcpServers(ws.id, orbit.id)), ["teams"], "project after the server");
    // The route web and iOS show says the same.
    const list = await ok(`${base}/api/projects/${orbit.id}/mcp-servers`);
    assert.deepEqual(list.workspaceServers.map((s) => [s.name, s.enabled, s.inWorkspaceActive]), [["teams", true, true]]);

    // Hiding in ONE project: gone there, unchanged in the other and in the workspace chat.
    await ok(`${base}/api/projects/${till.id}/mcp-servers/${teams.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(names(store.effectiveMcpServers(ws.id, till.id)), [], "gone in the hiding project");
    assert.deepEqual(names(store.effectiveMcpServers(ws.id, orbit.id)), ["teams"], "untouched in the other project");
    assert.deepEqual(names(store.effectiveMcpServers(ws.id, null)), ["teams"], "the workspace chat is untouched");
    assert.equal((await ok(`${base}/api/projects/${till.id}/mcp-servers`)).workspaceServers[0].enabled, false);
    // Show again.
    await ok(`${base}/api/projects/${till.id}/mcp-servers/${teams.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    assert.deepEqual(names(store.effectiveMcpServers(ws.id, till.id)), ["teams"], "shown again");

    // Switched off workspace-wide => gone everywhere, also where the project has not hidden it. The route names the reason
    // separately: not hidden, but off in the workspace.
    await ok(`${base}/api/mcp-servers/${teams.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    for (const pid of [till.id, orbit.id, null]) assert.deepEqual(names(store.effectiveMcpServers(ws.id, pid)), [], `switched off in ${pid ?? "workspace"}`);
    assert.deepEqual((await ok(`${base}/api/projects/${orbit.id}/mcp-servers`)).workspaceServers.map((s) => [s.enabled, s.inWorkspaceActive]), [[true, false]]);
    await ok(`${base}/api/mcp-servers/${teams.id}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });

    // A project server of the same name wins in the project; the workspace server stays in the others.
    const own = await ok(`${base}/api/projects/${orbit.id}/mcp-servers`, { method: "POST", body: server("teams") });
    const inOrbit = store.effectiveMcpServers(ws.id, orbit.id);
    assert.deepEqual(inOrbit.map((s) => s.id), [own.id], "the project server wins on the same name");
    assert.deepEqual(store.effectiveMcpServers(ws.id, till.id).map((s) => s.id), [teams.id], "the other project keeps the workspace server");
  });
});

test("PATCH .../enabled requires a boolean; exceptions fall with project and server", async () => {
  await withServer(async ({ base, root }) => {
    const { ws, project } = await creation(base, root);
    const till = await project("Till");
    const teams = await ok(`${base}/api/workspaces/${ws.id}/mcp-servers`, { method: "POST", body: server("teams") });
    const url = `${base}/api/projects/${till.id}/mcp-servers/${teams.id}/enabled`;

    // A missing field is no instruction: under `!!b.enabled` an empty body silently hid, "false" as text showed.
    for (const body of [{}, { enabled: "false" }, { enabled: 0 }, { enabled: null }]) {
      const r = await json(url, { method: "PATCH", body: JSON.stringify(body) });
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`);
    }
    assert.deepEqual(names(store.effectiveMcpServers(ws.id, till.id)), ["teams"], "no rejected body changed anything");
    // A project-own server cannot be switched here (it has its own toggle).
    const own = await ok(`${base}/api/projects/${till.id}/mcp-servers`, { method: "POST", body: server("own") });
    assert.equal((await json(`${base}/api/projects/${till.id}/mcp-servers/${own.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status, 404);

    // Exceptions do not live longer than their project or their server.
    await ok(url, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    assert.deepEqual([...store.listExcludedMcpServerIds(till.id)], [teams.id]);
    await ok(`${base}/api/mcp-servers/${teams.id}`, { method: "DELETE" });
    assert.deepEqual([...store.listExcludedMcpServerIds(till.id)], [], "gone with the server");
    const second = await ok(`${base}/api/workspaces/${ws.id}/mcp-servers`, { method: "POST", body: server("second") });
    await ok(`${base}/api/projects/${till.id}/mcp-servers/${second.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    await ok(`${base}/api/projects/${till.id}`, { method: "DELETE" });
    assert.deepEqual([...store.listExcludedMcpServerIds(till.id)], [], "gone with the project");
  });
});

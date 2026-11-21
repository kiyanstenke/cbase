import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";

// The fourth kind "freeText": a multi-line block for a whole access copied from somewhere. Proves that it keeps its line
// structure unchanged (an access without its line breaks is useless), that the discovery list names it like any other
// entry WITHOUT a value, and that the lock and the kind switch hold.
async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-vars-"));
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
    if (server) await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
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

const ACCESS = [
  "Name: OrbitSQL@ExamplecorpAzure",
  "Host: 203.0.113.45   Port: 1433",
  "User: lurch",
  "Password: s3hr-secret",
  "",
  "URL: jdbc:sqlserver://203.0.113.45:1433",
].join("\n");

test("free text: one block for a whole access — lines stay, discovery stays valueless", async () => {
  await withServer(async ({ base, root }) => {
    const ws = await ok(`${base}/api/workspaces`, {
      method: "POST",
      body: JSON.stringify({ name: "WS", path: path.join(root, "ws") }),
    });
    const vars = `${base}/api/workspaces/${ws.id}/vars`;
    const v = await ok(vars, {
      method: "POST",
      body: JSON.stringify({ key: "ORBIT_SQL", kind: "freeText", value: ACCESS, description: "Azure SQL", mcpAccess: true }),
    });
    assert.equal(v.kind, "freeText");
    // Verbatim, blank line included: an access without its line breaks is useless.
    assert.equal(v.value, ACCESS);
    assert.equal(v.value.split("\n").length, 6);

    // The agent sees in the list THAT it exists — and not a letter of it.
    const disc = await ok(`${vars}?mcp=1`);
    assert.deepEqual(disc, [{ key: "ORBIT_SQL", kind: "freeText", description: "Azure SQL", access: true, origin: "workspace" }]);
    assert.equal(JSON.stringify(disc).includes("s3hr-secret"), false);

    // And fetches it by key as a whole.
    assert.equal((await ok(`${vars}/by-key/ORBIT_SQL?mcp=1`)).value, ACCESS);

    // Locked means locked.
    await ok(`${vars}/${v.id}`, { method: "PUT", body: JSON.stringify({ mcpAccess: false }) });
    assert.equal((await json(`${vars}/by-key/ORBIT_SQL?mcp=1`)).status, 403);
    // The switch alone does not touch the text.
    assert.equal((await ok(vars))[0].value, ACCESS);
  });
});

test("free text: validation, kind switch and project level", async () => {
  await withServer(async ({ base, root }) => {
    const ws = await ok(`${base}/api/workspaces`, {
      method: "POST",
      body: JSON.stringify({ name: "WS", path: path.join(root, "ws") }),
    });
    const vars = `${base}/api/workspaces/${ws.id}/vars`;

    // An unknown kind used to be silently reinterpreted as "variable" — which hid a typo in the seed of the UI test rig.
    assert.equal((await json(vars, { method: "POST", body: JSON.stringify({ key: "A", kind: "connection", value: "x" }) })).status, 400);
    assert.equal((await json(vars, { method: "POST", body: JSON.stringify({ key: "A", kind: "freeText", value: "   " }) })).status, 400, "empty block");

    // Kind switch in both directions: the value moves along, the kind only decides how it is read and displayed.
    const s = await ok(vars, { method: "POST", body: JSON.stringify({ key: "TOKEN", kind: "secret", value: "glpat-xyz" }) });
    assert.equal((await ok(`${vars}/${s.id}`, { method: "PUT", body: JSON.stringify({ kind: "freeText", value: ACCESS }) })).value, ACCESS);
    const back = await ok(`${vars}/${s.id}`, { method: "PUT", body: JSON.stringify({ kind: "secret", value: "glpat-new" }) });
    assert.equal(back.kind, "secret");
    assert.equal(back.value, "glpat-new");

    // Project level: its own free text plus one taken over from the workspace.
    const proj = await ok(`${base}/api/workspaces/${ws.id}/projects`, {
      method: "POST",
      body: JSON.stringify({ name: "P", path: path.join(root, "ws", "p") }),
    });
    const wsFree = await ok(vars, { method: "POST", body: JSON.stringify({ key: "WS_DB", kind: "freeText", value: ACCESS }) });
    await ok(`${base}/api/projects/${proj.id}/vars`, {
      method: "POST",
      body: JSON.stringify({ key: "PROJ_DB", kind: "freeText", value: "Host: db.intern\nUser: app" }),
    });
    // A workspace credential is available in EVERY project without taking it over.
    const view = await ok(`${base}/api/projects/${proj.id}/vars?mcp=1`);
    // TOKEN is the workspace secret from above — it is in the project too, without taking it over.
    assert.deepEqual(view.map((x) => x.key).sort(), ["PROJ_DB", "TOKEN", "WS_DB"], "visible in the project without taking over");
    assert.equal(view.every((x) => x.value === undefined), true, "the list never carries a value");
    assert.deepEqual(view.filter((x) => x.kind === "freeText").map((x) => x.key).sort(), ["PROJ_DB", "WS_DB"]);
    assert.equal(
      (await ok(`${base}/api/projects/${proj.id}/vars/by-key/WS_DB?mcp=1`)).value,
      ACCESS,
      "a workspace access is readable in the project",
    );
    const list = await ok(`${base}/api/projects/${proj.id}/workspace-vars`);
    assert.equal(list.find((x) => x.id === wsFree.id)?.enabled, true, "the project list reports it as available");
    // Opt-out: a project hides the entry on purpose — then it is neither visible nor readable there.
    await ok(`${base}/api/projects/${proj.id}/workspace-vars/${wsFree.id}/enabled`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    assert.deepEqual((await ok(`${base}/api/projects/${proj.id}/vars?mcp=1`)).map((x) => x.key).sort(), ["PROJ_DB", "TOKEN"], "hidden => not in the list");
    const way = await fetch(`${base}/api/projects/${proj.id}/vars/by-key/WS_DB?mcp=1`);
    assert.equal(way.status, 404, "hidden => not readable");
    assert.equal((await ok(`${base}/api/projects/${proj.id}/workspace-vars`)).find((x) => x.id === wsFree.id)?.enabled, false);
    // … and show it again.
    await ok(`${base}/api/projects/${proj.id}/workspace-vars/${wsFree.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    assert.equal((await ok(`${base}/api/projects/${proj.id}/vars/by-key/WS_DB?mcp=1`)).value, ACCESS, "shown again => readable");
  });
});

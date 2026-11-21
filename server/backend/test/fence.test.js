// Guard for the API fence and the backend address (projectbox/fence.js, fence-table.js, token.js).
//
// The promises, each with the way that breaks it:
//   (1) The verdict (pure): outside the project networks without a valid token "as before"; from `10.230.0.0/16` without a valid
//       token 401; a valid token gives the scope of ITS instance — from outside always, from a project network only from the /24
//       of its instance (a foreign token from the own network is 401). Matrix source x token.
//   (2) The table: first row wins, no row => 403, "rejected" => 403 with reason; every row complete (rule, filter, body check,
//       reason, mcp XOR withoutMcp), every parameter name checked or free — with sabotage.
//   (3) The seam guard: every `api(` call of the cbase MCP (lib.js AND tools/*.js, fence-seam.mjs) has a row, every mcp row has a
//       call, and no row with `withoutMcp` is hit by a tool after all — with built-in sabotage on a copy (call without row, row
//       without call, row with the wrong marker, new form).
//   (4) The checks in scope (parameter, query, fixing, body) and the filters (same shape, only the own; the counters of
//       /api/active-runs by the SAME rule as runs/routes.js — bound on the real server in (6)).
//   (5) writeMcpConfig: without access byte-equal to the old state 17bb7a6, with access address and token in the environment of the
//       cbase server; backendUrlFor computes from the instance's gateway.
//   (6) The dispatcher on the real server (operation mark, fake docker, two converted projects): 401 without token from the project
//       network (also /api/health, static files, /api/runs/active), foreign token 401, own token filtered or 403 (neighbour
//       project, DELETE of the own project, project switch of the chat, agent of a neighbour chat, language service on a
//       neighbour file, tunnel, event stream, unknown), /api/runs/active from outside open as before; without operation mark
//       nothing changes.
//   (7) Both upgrade paths: /api/tunnel and /api/browsers/:id/devtools — from the project network 401/403, from outside as before
//       (101 and echo); the browser of the own project works, the neighbour's does not. An error IN the verdict rejects (403)
//       instead of letting the upgrade listener throw (a throw there takes the process down). Every opened WebSocket is closed in
//       the finally BEFORE server.close() — otherwise a failed expectation turns into a hang. Also: dot segments (`..`, `%2e%2e`)
//       and `%2f` in the raw path of an upgrade are 400 in scope — the fence judged the normalized address, the proxy connected to
//       the browser from the raw one; a "filtered" row does not apply to an upgrade (403).
//   (8) The cbase MCP in the project container: the MCP file carries token and address, `cbase_projects_list` sees only the own
//       project and gets the second text block, `cbase_project_delete`/`cbase_chat_set_project` fail as "Unknown tool": with a
//       token the MCP server does not offer what the fence always rejects (mcp/visibility.js FENCE_LOCKED, guard
//       fence-tools.test.js); a run without instance writes no token and sees everything as before. Also: a tool with an unfiltered
//       answer (`cbase_context_list`) gets no second text block although it resolves (resolve) and checks the project
//       (assertInScope) — both read filtered lists.
//   (9) Codex: the token is NEVER in argv — `-c mcp_servers.cbase.env_vars=["CBASE_TOKEN"]`, the value in the environment of the
//       Codex process (in the project container through `-e CBASE_TOKEN` without `=`).
//   (10) The language service from the project container reads and writes only under the project folder: the language server runs
//       in the project's container; a definition in the neighbour project is only a place (`external`), never content; a rename
//       that reaches there is 403 OUTSIDE and writes NOWHERE; a new name that is no identifier is 400; a rename across two files of
//       the project writes both (against test/fake-lsp.mjs).
//   (11) Project switch beside living work: the chat switches project beside its living subagent (200); its calls with A's token
//       onto the routes of THIS chat succeed, a foreign chat (from B, without project) stays 403, and after the work ends the chat
//       is closed for A again.
//   (12) Project switch mid-turn (200) — the turn keeps running in A, projectIdle(A) is false until its end (reason "running",
//       projectLocks refuses), its chat calls from A succeed, a foreign chat stays 403; the next turn runs in B and carries ONE
//       silent hint (`instance-switch`) where the previous one ran — the one after that none.
//   (13) The route of the git access for cbase-project hands out the workspace's stored access ONLY with operation mark (else
//       404), from loopback (the gateway: 403) and with the key of this start (else 403; the key lies 0600 under <data>, under no
//       mount of a project container, and a new start invalidates the old one); from a project network without token 401, with
//       token 403. The REAL file server/backend/cbase-project fetches against the real server only the access of the hosts of its
//       targets: a remote (or insteadOf) onto a foreign host gets no access of another host, another workspace's access never. The
//       list for cbase-git carries the worktree folder of the runtime folder, and the workspace level assigns a linked worktree
//       outside to the project through its common .git.
//
// COUNTER-TESTS (each shown red, then restored):
//   tunnel.js and browsers.js in the old state 17bb7a6 => (7) red (101 instead of 401); the fence line in the dispatcher of server.js
//   removed => (6), (7), (8) red (200 instead of 401); fence.js without the binding to the source /24 => (1) and (6) red (scope pB
//   instead of 401); connectors/codex.js in the old state => (9) red (token in argv); mcp/lib.js and mcp/cbase-mcp.js in the old
//   state => (8) red (neighbour project visible); runs/do-run.js without `...backendAccessFor(instance)` => (8) and (9) red (no
//   token in the MCP file); fence.js without the catch around the upgrade verdict => (7) red (the throw goes through). Dot segments
//   and `%2f` in fence.js => (7) red with "…/../../../../<A>/devtools/page/1: HTTP/1.1 101 Switching Protocols" and "{"ok":true}"
//   for the filtered row; lsp/limit.js `checkEdit` without the check of the places outside => (10) red (the places outside fell
//   away silently and the rest was written); lsp/ without the read limit of the host => (10) red at definition, the rename then 403
//   "1 of 2 files … writes nothing" (the pre-check holds alone, not partially); mcp/lib.js => (8) red (the hint hangs on an unfiltered
//   answer), likewise with auxQuery ONLY in resolve (assertInScope reads /api/projects too).
//   Seam guard and table: stacks.js with the fetch URL ending differently (`…/holt`, no row) => seam guard red; clear-away with PATCH
//   instead of DELETE (no row for the method) => seam guard red. fence-table.js: the catch-all row "project-stack-copies" (rejected)
//   back before the list => table, table guard and seam guard red; the list row without `mcp` (with `withoutMcp`) => seam guard red,
//   likewise the create row — the third direction: a row that a tool hits must carry `mcp: true` (`seamFinding` returns
//   `withoutMarker`). A row "project-create" with `mcp: true` whose tool is gone => seam guard red ("mcp rows without call").
//   The copy needs server/backend/cbase-wrapper (fake-docker.mjs), otherwise every turn hangs in the container.
//
// No clock: waiting is on gates, files and states (waitForTruthy, no deadline); the scanner of the agent browsers ticks every 3 s —
// waiting is until the browser is in the list.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { FREE_PARAMETER, FENCE_TABLE, patternMatches, parameterOf, rowFor } from "../electron/server/projectbox/fence-table.js";
import {
  FILTER, FENCED_HEADER, PARAMETER, BODY, TOKEN_HEADER, countActiveRuns, inNetwork, checkScope, setFenceSource, uncheckedParameter, fenceUpgrade, fenceVerdict,
} from "../electron/server/projectbox/fence.js";
import { backendUrlFor, identifierForToken, mcpAccessFor, tokenFor, forgetToken } from "../electron/server/projectbox/token.js";
import { backendAccessFor, setBackendAccess } from "../electron/server/runs/backend-access.js";
import { writeMcpConfig } from "../electron/server/toolchain/mcp-config.js";
import { WRAPPER_PATH } from "../electron/server/runtime/inProject.js";
import { attachTunnel } from "../electron/server/tunnel.js";
import { allLocations, locationFor, playwrightProfileRoot } from "../electron/server/runs/runtime-location.js";
import { DIRS } from "../electron/server/app-state.js";
import { mountRules } from "../electron/server/projectbox/creation.js";
import { GIT_ACCESS_HEADER, gitInstanceForWorkspace, writeGitProjects, createGitAccessKey, gitAccessKeyPath } from "../electron/server/projectbox/git-assignment.js";
import { projectLocked, projectIdle, projectLocks } from "../electron/server/projectbox/idle.js";
import { LOCATION, fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker, secondLoopback } from "./fake-docker.mjs";
import { mcpApiCalls } from "./fence-seam.mjs";

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws");

const TESTDIR = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(TESTDIR, "..", "..", "..");
const SERVER_DIR = path.resolve(TESTDIR, "..", "electron", "server");
const MCP_DIR = path.resolve(TESTDIR, "..", "electron", "mcp");
const FENCE_HINT = "filtered: only the project of this container and the workspace-wide items without a project reference";

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200" });
const withoutOps = { CBASE_CONTAINER: undefined, CBASE_DIND: undefined };
function containerStart(fd, name) {
  execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
}
// The source of a test request: the server listens only on 127.0.0.1, so a header says which network it "comes" from. Requests
// without it (the harness, the MCP server of the runs) come from 127.0.0.1 as in reality.
const SOURCE_HEADER = "x-cbase-test-source";
const testSource = (req) => req.headers?.[SOURCE_HEADER] || req.socket?.remoteAddress;
const NETWORK_A = "10.230.5.2";
const NETWORK_B = "10.230.6.2";

async function request(base, filePath, { method = "GET", source = null, token = null, body } = {}) {
  const headers = { Connection: "close" };
  if (source) headers[SOURCE_HEADER] = source;
  if (token) headers[TOKEN_HEADER] = token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${filePath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, fenced: res.headers.get(FENCED_HEADER), data };
}

// A WebSocket attempt: 101 (open) or the rejection status, 0 for a torn socket. Every opened socket stays in `openWs` until it is
// closed: if an expectation fails (101 instead of 401), it would otherwise hold `server.close()` open and the red test would turn
// into a hang — `allWsShut()` in the finally.
const openWs = new Set();
function wsAttempt(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    let finished = false;
    const end = (r) => { if (!finished) { finished = true; resolve(r); } };
    ws.on("open", () => {
      openWs.add(ws);
      ws.once("close", () => openWs.delete(ws));
      end({ status: 101, ws });
    });
    ws.on("unexpected-response", (_req, res) => {
      let b = "";
      res.on("data", (c) => { b += c; });
      res.on("end", () => end({ status: res.statusCode, body: b }));
      res.on("error", () => end({ status: res.statusCode, body: b }));
    });
    ws.on("error", (e) => end({ status: 0, error: e.message }));
  });
}
// An upgrade with a RAW path: the ws client normalizes the address (new URL), dot segments would never arrive. Returns the status of
// the first response line (0 for a torn socket) and closes the socket at once — it never stays open, not even after a 101.
function rawUpgrade(port, rawPath, header = {}) {
  return new Promise((resolve) => {
    let finished = false;
    let buffer = "";
    const s = net.connect(Number(port), "127.0.0.1");
    const end = (status) => { if (finished) return; finished = true; s.destroy(); resolve({ status, first: buffer.split("\r\n")[0] }); };
    s.on("connect", () => {
      const rows = [`GET ${rawPath} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="];
      for (const [k, v] of Object.entries(header)) rows.push(`${k}: ${v}`);
      s.write(`${rows.join("\r\n")}\r\n\r\n`);
    });
    s.on("data", (d) => { buffer += d; const m = /^HTTP\/1\.1 (\d{3})/.exec(buffer); if (m) end(Number(m[1])); });
    s.on("error", () => end(0));
    s.on("close", () => end(0));
  });
}
const echo = (ws, text) => new Promise((resolve, reject) => {
  ws.once("message", (d) => resolve(String(d)));
  ws.once("error", reject);
  ws.send(text);
});
const execCalls = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec");
const shut = (ws) => new Promise((resolve) => { if (ws.readyState === WebSocket.CLOSED) return resolve(); ws.once("close", resolve); ws.terminate(); });
const allWsShut = async () => { for (const w of [...openWs]) await shut(w); };

// Two converted projects A and B in the test's workspace, each with a container in the fake docker and an instance row (gateway
// 127.0.0.1: the test server listens only there; the networks 10.230.5.0/24 and 10.230.6.0/24), plus a chat per project and one
// without project. The projects are created BEFORE the operation mark (as in real life), the instances after. `ipA`: a reachable
// address for A's instance (the second loopback) when a test needs its browser.
async function twoProjects(ctx, fd, { ipA = null } = {}) {
  const { base, ws } = ctx;
  const project = async (name) => {
    const filePath = path.join(ctx.root, "workspace", name);
    fs.mkdirSync(filePath, { recursive: true });
    return json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name, path: filePath }) });
  };
  const A = await project("till");
  const B = await project("storage");
  const chat = async (projectId, title) => {
    const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, projectId, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
    await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
    return c;
  };
  await json(`${base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: A.id }) });
  const cA = ctx.chat;
  const cB = await chat(B.id, "Storage chat");
  const cO = await chat(null, "No project");
  const instance = (p, n) => {
    const name = `cbase-p-${p.id}`;
    containerStart(fd, name);
    return store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name,
      subnet: `10.230.${n}.0/24`, gateway: "127.0.0.1", ip: n === 5 && ipA ? ipA : `10.230.${n}.2`, bridge: `cbp-${n}`, hostname: `cbp-${n}` });
  };
  const iA = instance(A, 5);
  const iB = instance(B, 6);
  return { A, B, cA, cB, cO, iA, iB, tA: tokenFor(iA), tB: tokenFor(iB) };
}

// ── (1) The verdict ──────────────────────────────────────────────────────────────────────────────
const IA = Object.freeze({ projectId: "pA", instance: "main", identifier: "pA/main", subnet: "10.230.5.0/24", gateway: "10.230.5.1", ip: "10.230.5.2" });
const IB = Object.freeze({ projectId: "pB", instance: "main", identifier: "pB/main", subnet: "10.230.6.0/24", gateway: "10.230.6.1", ip: "10.230.6.2" });
const TOKENS = { tA: "pA/main", tB: "pB/main" };
const identifierOfToken = (t) => TOKENS[t] || null;

test("verdict, matrix source × token: outside as before, from the project network only with the token of the instance of the source /24", () => {
  const sources = {
    "127.0.0.1": "outside", "::ffff:127.0.0.1": "outside", "172.17.0.1": "outside", "::1": "outside", "10.231.5.2": "outside",
    [NETWORK_A]: "A", [`::ffff:${NETWORK_A}`]: "A", [NETWORK_B]: "B", "10.230.99.2": "foreign-network", "10.230.5.200": "A",
  };
  const expected = (situation, token) => {
    const inst = token === "tA" ? "pA" : token === "tB" ? "pB" : null;
    if (situation === "outside") return inst ? `scope:${inst}` : "as-today";
    if (!inst) return "401";
    if (situation === "A") return inst === "pA" ? "scope:pA" : "401";
    if (situation === "B") return inst === "pB" ? "scope:pB" : "401";
    return "401"; // a /24 without instance: no token fits
  };
  let n = 0;
  for (const [source, situation] of Object.entries(sources)) {
    for (const token of ["", "wrong", "tA", "tB"]) {
      const u = fenceVerdict({ source, token, method: "GET", path: "/api/projects", instances: [IA, IB], identifierOfToken });
      const got = u.verdict === "scope" ? `scope:${u.instance.projectId}` : u.verdict;
      assert.equal(got, expected(situation, token), `source ${source}, token ${token || "(none)"}: ${JSON.stringify(u)}`);
      if (u.verdict === "401") assert.match(u.reason, /Fence/);
      n++;
    }
  }
  // The instance no longer exists (row gone, operation off): its token is invalid — from outside as before, from the network 401.
  assert.equal(fenceVerdict({ source: "127.0.0.1", token: "tA", method: "GET", path: "/api/projects", instances: [], identifierOfToken }).verdict, "as-today");
  assert.equal(fenceVerdict({ source: NETWORK_A, token: "tA", method: "GET", path: "/api/projects", instances: [], identifierOfToken }).verdict, "401");
  // The instance without subnet (row mid-creation): no scope from the project network.
  assert.equal(fenceVerdict({ source: NETWORK_A, token: "tA", method: "GET", path: "/api/projects", instances: [{ ...IA, subnet: "" }], identifierOfToken }).verdict, "401");
  // inNetwork: IPv6 other than ::ffff: is never in the IPv4 network; neither is anything unreadable.
  assert.equal(inNetwork("::ffff:10.230.5.9", "10.230.0.0/16"), true);
  assert.equal(inNetwork("fe80::1", "10.230.0.0/16"), false);
  assert.equal(inNetwork("10.230.5.9", ""), false);
  assert.equal(inNetwork(undefined, "10.230.0.0/16"), false);
  assert.ok(n >= 40);
});

test("token: 32 bytes per identifier and backend start, memory only; the address comes from the instance's gateway", () => {
  const inst = { projectId: "pT", instance: "main", identifier: "pT/main", gateway: "10.230.7.1" };
  const t = tokenFor(inst);
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(tokenFor({ ...inst }), t, "same identifier, same token");
  assert.equal(identifierForToken(t), "pT/main");
  assert.equal(identifierForToken(t.slice(0, 63)), null);
  assert.equal(identifierForToken(t.toUpperCase()), null);
  assert.notEqual(tokenFor({ ...inst, identifier: "pT/copy-x" }), t);
  assert.match(backendUrlFor(inst), /^http:\/\/10\.230\.7\.1:\d+$/);
  assert.equal(backendUrlFor({ ...inst, gateway: "fd00::1" }).startsWith("http://[fd00::1]:"), true, "IPv6 bracketed");
  const z = mcpAccessFor(inst);
  assert.deepEqual(Object.keys(z).sort(), ["backendUrl", "token"]);
  assert.deepEqual(mcpAccessFor(null), {});
  assert.equal(forgetToken("pT/main"), true);
  assert.equal(identifierForToken(t), null, "forgotten means invalid");
  assert.notEqual(tokenFor(inst), t, "a new token after forgetting");
  forgetToken("pT/main");
  forgetToken("pT/copy-x");
  // The path to runs/: without source and without instance an empty object (writeMcpConfig then writes as before).
  setBackendAccess(null);
  assert.deepEqual(backendAccessFor(inst), {});
  setBackendAccess(() => ({ backendUrl: "http://x:1", token: "t" }));
  try {
    assert.deepEqual(backendAccessFor(null), {});
    // The instance identifier travels along (CBASE_INSTANCE, which the MCP port tools send).
    assert.deepEqual(backendAccessFor(inst), { backendUrl: "http://x:1", token: "t", instance: "pT/main" });
  } finally { setBackendAccess(null); }
});

// ── (2) The table ─────────────────────────────────────────────────────────────────────────────
test("table: first row wins, no row => 403, rejected => 403 with reason", () => {
  const u = (method, filePath) => fenceVerdict({ source: NETWORK_A, token: "tA", method, path: filePath, instances: [IA], identifierOfToken });
  assert.equal(u("DELETE", "/api/projects/pA").verdict, "403");
  assert.match(u("DELETE", "/api/projects/pA").reason, /project-delete.*caller runs in/);
  assert.equal(u("PATCH", "/api/projects/pA").verdict, "scope");
  for (const [m, p] of [["GET", "/api/ui-lang"], ["POST", "/api/chats"], ["GET", "/"], ["GET", "/index.html"], ["GET", "/api/projects/pA/unknown"],
    ["POST", "/api/workspaces"], ["GET", "/api/openrouter"], ["DELETE", "/api/chats/c1"], ["GET", "/api/health/x"]]) {
    const r = u(m, p);
    assert.equal(r.verdict, "403", `${m} ${p}`);
    assert.match(r.reason, /no row in the fence table/);
  }
// The copies of a stack go from the project network within the scope of the own project (the project-copy rows, matrix in
// fence-stacks.test.js); anything without a row — another method, a subroute — is 403 like anything unknown.
  for (const [m, p, row] of [["GET", "/api/projects/pA/stack-copies", "project-copies"], ["POST", "/api/projects/pA/stack-copies", "project-copy-create"],
    ["GET", "/api/projects/pA/stack-copies/k1", "project-copy"], ["POST", "/api/projects/pA/stack-copies/k1/fetch", "project-copy-fetch"], ["DELETE", "/api/projects/pA/stack-copies/k1", "project-copy-clear-away"]]) {
    const r = u(m, p);
    assert.equal(r.verdict, "scope", `${m} ${p}`);
    assert.equal(r.row.family, row, `${m} ${p}`);
  }
  for (const [m, p] of [["PUT", "/api/projects/pA/stack-copies"], ["PATCH", "/api/projects/pA/stack-copies/k1"], ["GET", "/api/projects/pA/stack-copies/k1/fetch"], ["POST", "/api/projects/pA/stack-copies/k1"],
    ["POST", "/api/projects/pA/stack-copies/k1/x"], ["DELETE", "/api/projects/pA/stack-copies"]]) {
    const r = u(m, p);
    assert.equal(r.verdict, "403", `${m} ${p}`);
    assert.match(r.reason, /no row in the fence table/, `${m} ${p}`);
  }
// Project-creation setup and rules, the pieces of an archive and the layout: rejected with reason (without these rows `r.row`
  // would be missing and the verdict 403 "no row").
  for (const [m, p, row] of [["POST", "/api/projects/pA/setup/again", "project-setup"], ["POST", "/api/projects/pA/setup/sources/1/begin", "project-setup"],
    ["GET", "/api/projectCreation/rules", "projectCreation"], ["POST", "/api/projects/pA/archive", "project-archive"], ["POST", "/api/projects/pA/archive/unpack", "project-archive"],
    // Upload afterwards.
    ["POST", "/api/projects/pA/upload/begin", "project-upload"], ["POST", "/api/projects/pA/upload/0f0e0d0c-0b0a-4908-8706-050403020100/finished", "project-upload"],
    ["DELETE", "/api/projects/pA/upload/0f0e0d0c-0b0a-4908-8706-050403020100", "project-upload"], ["POST", "/api/projects/pA/archive/check", "project-archive"],
    // Layout of an existing project — `**` hits `/layout` itself (GET of the level) and every route below it.
    ["GET", "/api/projects/pA/layout", "project-layout"], ["POST", "/api/projects/pA/layout/check", "project-layout"],
    ["GET", "/api/projects/pA/layout/check/0e2c7c33-3f42-4e47-9a5b-5f0b7f7a1c11", "project-layout"],
    // "Remove old containers" — row project-superseded, `**` hits the inventory itself and the removal.
    ["GET", "/api/projects/pA/superseded", "project-superseded"], ["POST", "/api/projects/pA/superseded/remove", "project-superseded"],
    // The actions on an instance — one row per route, rejected with reason.
    ["GET", "/api/projects/pA/instances/main/repos", "project-instance-repos"], ["POST", "/api/projects/pA/instances/copy-k1/branch", "project-instance-branch"],
    ["POST", "/api/projects/pA/instances/main/dismiss", "project-instance-dismiss"], ["POST", "/api/projects/pA/instances/copy-k1/stack-restart", "project-instance-stack-restart"],
    // Stop, start, abort the start wait — one row each, rejected with reason.
    ["POST", "/api/projects/pA/instances/main/stop", "project-instance-stop"], ["POST", "/api/projects/pA/instances/copy-k1/start", "project-instance-start"],
    ["POST", "/api/projects/pA/instances/main/start-abort", "project-instance-start-abort"],
    // The tree of instances — rejected with reason.
    ["GET", "/api/projects/pA/instances", "project-instances"],
    // Git overview: `**` hits the overview itself, the fetch, the detail and the diff — rejected with reason.
    ["GET", "/api/projects/pA/gitView", "project-git-view"], ["POST", "/api/projects/pA/gitView/fetch", "project-git-view"],
    ["GET", "/api/projects/pA/gitView/branch", "project-git-view"], ["GET", "/api/projects/pA/gitView/diff", "project-git-view"]]) {
    const r = u(m, p);
    assert.equal(r.verdict, "403", `${m} ${p}`);
    assert.equal(r.row?.family, row, `${m} ${p}`);
    assert.ok(r.reason.includes(row), `${m} ${p}`);
  }
  // The LFS access is ALLOWED from the project network — POST only, scope the own project (the check of `:project` is in "checks in
  // scope"), copies included; every other method has no row. "git-access" (VS Code in B) stays rejected.
  const lfs = u("POST", "/api/projects/pA/lfs-access");
  assert.deepEqual([lfs.verdict, lfs.row?.family, lfs.row?.rule, Boolean(lfs.row?.onlyFromMain), Boolean(lfs.row?.mcp)], ["scope", "lfs-access", "allowed", false, false]);
  for (const m of ["GET", "PUT", "DELETE", "PATCH"]) {
    const r = u(m, "/api/projects/pA/lfs-access");
    assert.equal(r.verdict, "403", `${m} …/lfs-access`);
    assert.match(r.reason, /no row in the fence table/, `${m} …/lfs-access`);
  }
  for (const m of ["GET", "POST"]) {
    const r = u(m, "/api/workspaces/w1/git-access");
    assert.deepEqual([r.verdict, r.row?.family], ["403", "git-access"], `${m} git-access stays rejected`);
  }
  for (const p of ["/api/projects/pA/relocation", "/api/projects/pA/relocation/plan", "/api/tunnel", "/api/events", "/api/workspaces/w1/vars", "/api/workspaces/w1/vars/by-key/K"]) {
    const r = u("GET", p);
    assert.equal(r.verdict, "403", p);
    assert.ok(r.row && r.reason.includes(r.row.family), p);
  }
  // The manager layer, the todos and the manager workflows of a chat are gone with their rows (workspace-manager, manager, todos,
  // chat-todos, chat-manager-workflows) — they are 403 like anything unknown.
  for (const p of ["/api/manager/facts", "/api/manager/docs/x", "/api/workspaces/w1/manager/proposals", "/api/todos", "/api/todos/t1", "/api/chats/cA/todos", "/api/chats/cA/manager-workflows"]) {
    const r = u("GET", p);
    assert.deepEqual([r.verdict, r.row ?? null], ["403", null], p);
    assert.match(r.reason, /no row in the fence table/, p);
  }
  // The ops status names projects — rejected with reason; the route of the removed relocation tick has no row any more (403 like
  // anything unknown).
  assert.deepEqual([u("GET", "/api/projectbox/ops-status").verdict, u("GET", "/api/projectbox/ops-status").row?.family], ["403", "ops-status"]);
  assert.match(u("GET", "/api/projectbox/ops-status").reason, /ops-status.*the user.s projects by name/);
  assert.match(u("GET", "/api/projectbox/relocation-tick").reason, /no row in the fence table/);
  assert.equal(u("GET", "/api/runs/active").row.rule, "filtered");
  assert.equal(u("GET", "/api/health").verdict, "scope");
  // Pattern matching: `**` also for nothing, `:x` never empty, decoded, the query does not count.
  assert.deepEqual(patternMatches("/api/chats/:chat/graph-workflows/**", "/api/chats/c1/graph-workflows"), { chat: "c1" });
  assert.deepEqual(patternMatches("/api/chats/:chat/graph-workflows/**", "/api/chats/c1/graph-workflows/a/b"), { chat: "c1" });
  assert.equal(patternMatches("/api/chats/:chat", "/api/chats/"), null);
  assert.equal(patternMatches("/api/chats/:chat", "/api/chats//"), null);
  assert.deepEqual(patternMatches("/api/projects/:project/context/by-slug/:slug", "/api/projects/p%2F1/context/by-slug/a%20b?x=1"), { project: "p/1", slug: "a b" });
  assert.equal(patternMatches("/api/projects/:project", "/api/projects/%E0%A4%A"), null, "broken encoding does not match");
});

test("table guard: every row complete, every parameter checked or free — with sabotage", () => {
  const families = new Set();
  for (const z of FENCE_TABLE) {
    assert.ok(!families.has(z.family), `duplicate family: ${z.family}`);
    families.add(z.family);
    assert.ok(["allowed", "filtered", "rejected"].includes(z.rule), `${z.family}: rule ${z.rule}`);
    assert.ok(z.methods.length && z.methods.every((m) => ["*", "GET", "POST", "PUT", "PATCH", "DELETE"].includes(m)), z.family);
    assert.ok(z.pattern.startsWith("/api/"), z.family);
    assert.ok(Boolean(z.mcp) !== Boolean(z.withoutMcp), `${z.family}: exactly one of mcp and withoutMcp`);
    if (z.rule === "filtered") assert.equal(typeof FILTER[z.filter], "function", `${z.family}: filter ${z.filter}`);
    else assert.equal(z.filter, undefined, `${z.family}: filter on a row without filter rule`);
    if (z.rule === "rejected") assert.ok(z.reason && z.reason.length > 20, `${z.family}: reason`);
    if (z.body) assert.equal(typeof BODY[z.body], "function", `${z.family}: body ${z.body}`);
    for (const kind of [...Object.values(z.query || {}), ...Object.values(z.enforce || {})]) assert.equal(typeof PARAMETER[kind], "function", `${z.family}: ${kind}`);
    for (const n of parameterOf(z.pattern)) assert.ok(PARAMETER[n] || FREE_PARAMETER.includes(n), `${z.family}: :${n}`);
  }
  assert.deepEqual(uncheckedParameter(), []);
  for (const n of FREE_PARAMETER) assert.equal(PARAMETER[n], undefined, `:${n} is free AND checked`);
  // Sabotage: a new parameter name without a check shows up.
  const sabotaged = [...FENCE_TABLE, { family: "fresh", methods: ["GET"], pattern: "/api/fresh/:unknown", rule: "allowed", mcp: true }];
  assert.deepEqual(uncheckedParameter(sabotaged), ["unknown"]);
});

// ── (3) The seam guard ─────────────────────────────────────────────────────────────────────────
function seamFinding(calls, table = FENCE_TABLE) {
  const withoutRow = [];
  const hit = new Set();
  for (const a of calls) {
    const t = rowFor(a.method, a.path, table);
    if (!t) withoutRow.push(`${a.file}:${a.place} ${a.method} ${a.path}`);
    else hit.add(t.row.family);
  }
  const withoutCall = table.filter((z) => z.mcp && !hit.has(z.family)).map((z) => z.family);
  // The third direction — a row that a tool hits carries `mcp: true` (a row with `withoutMcp` claims the opposite).
  const withoutMarker = table.filter((z) => !z.mcp && hit.has(z.family)).map((z) => z.family);
  return { withoutRow, withoutCall, withoutMarker };
}
function mcpCopy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-fence-seam-"));
  fs.mkdirSync(path.join(d, "tools"));
  fs.copyFileSync(path.join(MCP_DIR, "lib.js"), path.join(d, "lib.js"));
  for (const f of fs.readdirSync(path.join(MCP_DIR, "tools"))) fs.copyFileSync(path.join(MCP_DIR, "tools", f), path.join(d, "tools", f));
  return d;
}

test("seam guard: every api( call of the cbase MCP has a row, every mcp row has a call — with built-in sabotage", (t) => {
  const calls = mcpApiCalls(MCP_DIR);
  const places = new Set(calls.map((a) => `${a.file}:${a.place}`));
  t.diagnostic(`api( calls: ${places.size} sites, ${calls.length} paths (ternary and varsBase expanded), from ${new Set(calls.map((a) => a.file)).size} files`);
  assert.ok(calls.some((a) => a.file === "lib.js"), "lib.js is read too");
  assert.ok(calls.every((a) => a.path.startsWith("/api/")), JSON.stringify(calls.filter((a) => !a.path.startsWith("/api/"))));
  const finding = seamFinding(calls);
  assert.deepEqual(finding.withoutRow, [], "calls without a row — they would be 403 from every project chat");
  assert.deepEqual(finding.withoutCall, [], "mcp rows without a call — either `withoutMcp` with a reason or remove the row");
  assert.deepEqual(finding.withoutMarker, [], "rows with `withoutMcp` that a tool does hit — set `mcp: true`");
  // Built-in sabotage of the third direction: the row of the copies list claims `withoutMcp`, the tool cbase_copy_stack_list hits it.
  const reflagged = FENCE_TABLE.map((z) => (z.family === "project-copies" ? { ...z, mcp: false, withoutMcp: "x" } : z));
  assert.deepEqual(seamFinding(calls, reflagged).withoutMarker, ["project-copies"]);
  // The expanded forms are there (otherwise the guard would check less than it says).
  assert.ok(calls.some((a) => a.path === "/api/workspaces/X/vars") && calls.some((a) => a.path === "/api/projects/X/vars"), "varsBase: both prefixes");
  assert.ok(calls.some((a) => a.path === "/api/projects/X/context/by-slug/X") && calls.some((a) => a.path === "/api/projects/X/context/X"), "ternary: both branches");

  const d = mcpCopy();
  try {
    // Sabotage 1: a new call without a row.
    fs.appendFileSync(path.join(d, "lib.js"), '\nasync function newWay() { return api("GET", `/api/new-without-row/${enc("x")}`); }\n');
    assert.deepEqual(seamFinding(mcpApiCalls(d)).withoutRow.map((s) => s.replace(/^lib\.js:\d+ /, "")), ["GET /api/new-without-row/X"]);
    // Sabotage 2: a row loses its only call (the table without it: the call has no row).
    const withoutSchema = FENCE_TABLE.filter((z) => z.family !== "context-schema");
    assert.deepEqual(seamFinding(mcpApiCalls(MCP_DIR), withoutSchema).withoutRow.map((s) => s.replace(/^[^ ]+ /, "")), ["GET /api/project-context/schema"]);
    const source = fs.readdirSync(path.join(d, "tools")).find((f) => fs.readFileSync(path.join(d, "tools", f), "utf8").includes('"/api/project-context/schema"'));
    const file = path.join(d, "tools", source);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"/api/project-context/schema"', '"/api/projects"'));
    assert.ok(seamFinding(mcpApiCalls(d)).withoutCall.includes("context-schema"));
    // Sabotage 3: a form the guard does not know, and a method without literal — both throw.
    fs.appendFileSync(path.join(d, "lib.js"), '\nasync function free(p) { return api("GET", p); }\n');
    assert.throws(() => mcpApiCalls(d), /unbekannte Form/);
    fs.copyFileSync(path.join(MCP_DIR, "lib.js"), path.join(d, "lib.js"));
    fs.appendFileSync(path.join(d, "lib.js"), '\nasync function free2(m) { return api(m, "/api/projects"); }\n');
    assert.throws(() => mcpApiCalls(d), /ohne Methoden-Literal/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── (4) Checks in scope and filters ───────────────────────────────────────────────────────────
function testView(root) {
  const pA = path.join(root, "a");
  const pB = path.join(root, "b");
  for (const p of [pA, pB]) fs.mkdirSync(p, { recursive: true });
  const projects = { pA: { id: "pA", workspaceId: "w1", path: pA }, pB: { id: "pB", workspaceId: "w1", path: pB } };
  const chats = { cA: { id: "cA", projectId: "pA" }, cB: { id: "cB", projectId: "pB" }, cO: { id: "cO", projectId: null }, cKind: { id: "cKind", projectId: null }, cKindB: { id: "cKindB", projectId: null } };
  const starts = { cKind: { chatId: "cA" }, cKindB: { chatId: "cB" } };
  const services = { dA: { id: "dA", projectId: "pA" }, dB: { id: "dB", projectId: "pB" } };
  const channels = { kA: [{ chatId: "cA" }, { chatId: "cO" }], kB: [{ chatId: "cB" }] };
  // Every browser carries its debug host — the IP of its instance or 127.0.0.1 (B). `brAinB`/`brAgAinB` are A's sessions that still run
  // in B (started before the move): key and chat match, the container does not.
  const browser = { brA: { scopeKey: "proj:pA", kind: "user", debugHost: "10.230.5.2" }, brB: { scopeKey: "proj:pB", kind: "user", debugHost: "10.230.6.2" }, brAgA: { kind: "agent", chatId: "cA", scopeKey: "agent:chat-cA:1", debugHost: "10.230.5.2" }, brAgB: { kind: "agent", chatId: "cB", scopeKey: "agent:chat-cB:1", debugHost: "10.230.6.2" }, brWs: { kind: "user", scopeKey: "w1", debugHost: "127.0.0.1" },
    brAinB: { scopeKey: "proj:pA", kind: "user", debugHost: "127.0.0.1" }, brAgAinB: { kind: "agent", chatId: "cA", scopeKey: "agent:chat-cA:2", debugHost: "127.0.0.1" } };
  return {
    pA, pB,
    view: {
      project: (id) => projects[id] || null, chat: (id) => chats[id] || null, graphStartOfChild: (id) => starts[id] || null,
      service: (id) => services[id] || null, channelParticipants: (id) => channels[id] || [],
      browser: (id) => browser[id] || null,
      // every chat of this view lives in the main of its project (the copy is checked by fence-instance.test.js)
      instanceForChat: (c, location) => ({ instance: {}, identifier: `${location?.projectId || c.projectId}/main`, locked: false }),
    },
  };
}

test("checks in scope: parameter, query, fixing, body — against a test view", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-fence-view-"));
  try {
    const { pA, pB, view } = testView(root);
    fs.writeFileSync(path.join(pA, "x.ts"), "export {};\n");
    fs.writeFileSync(path.join(pB, "y.ts"), "export {};\n");
    fs.symlinkSync(path.join(pB, "y.ts"), path.join(pA, "out.ts"));
    const check = (method, pathWithQuery, body) => {
      const url = new URL(pathWithQuery, "http://x");
      const u = fenceVerdict({ source: NETWORK_A, token: "tA", method, path: url.pathname, instances: [IA], identifierOfToken });
      if (u.verdict !== "scope") return { ok: false, reason: u.reason, verdict: u.verdict, url };
      return { ...checkScope({ instance: IA, row: u.row, params: u.params, method, query: url.searchParams, body }, view), url };
    };
    const yes = (m, p, r) => { const x = check(m, p, r); assert.equal(x.ok, true, `${m} ${p} ${JSON.stringify(r) ?? ""}: ${x.reason}`); return x; };
    const no = (m, p, r, pattern) => { const x = check(m, p, r); assert.equal(x.ok, false, `${m} ${p} ${JSON.stringify(r) ?? ""} went through`); if (pattern) assert.match(x.reason, pattern); return x; };

    // Chats: own project and graph children of its chats; no chat without project, none of the neighbour.
    yes("GET", "/api/chats/cA");
    yes("GET", "/api/chats/cKind/log");
    no("GET", "/api/chats/cB", undefined, /not a chat of this project/);
    no("GET", "/api/chats/cO");
    no("GET", "/api/chats/cKindB");
    no("POST", "/api/chats/unknown/agent");
    no("POST", "/api/chats/cB/agent/send");
    // No project switch from the container, whatever the value.
    for (const r of [{ projectId: null }, { projectId: "" }, { projectId: "pA" }, { projectId: "pB" }, { title: "x", projectId: null }]) no("PATCH", "/api/chats/cA", r, /project assignment from a project container/);
    yes("PATCH", "/api/chats/cA", { title: "fresh" });
    // Services.
    yes("POST", "/api/project-services", { projectId: "pA", name: "web" });
    no("POST", "/api/project-services", { projectId: "pB" });
    no("POST", "/api/project-services", {});
    yes("PATCH", "/api/project-services/dA");
    no("DELETE", "/api/project-services/dB");
    no("GET", "/api/project-services/dB/command-history");
    yes("POST", "/api/projects/pA/services/dA/start");
    no("POST", "/api/projects/pA/services/dB/start");
    no("GET", "/api/projects/pB/context");
    // The LFS access only for the own project — the body (host) is the route's business, the fence checks none.
    yes("POST", "/api/projects/pA/lfs-access", { host: "git.example.test" });
    no("POST", "/api/projects/pB/lfs-access", { host: "git.example.test" });
    // Channels: the channel of a chat of the project, the sender a chat of the project AND participant.
    yes("POST", "/api/channels/kA/messages", { chatId: "cA", text: "x" });
    no("POST", "/api/channels/kA/messages", { chatId: "cO", text: "x" }, /sender is not a chat of this project/);
    no("POST", "/api/channels/kB/messages", { chatId: "cA", text: "x" }, /not a channel/);
    no("POST", "/api/channels/kA/messages", { chatId: "cKind", text: "x" }, /not a participant/);
    no("GET", "/api/chats?workspaceId=w2");
    no("GET", "/api/chats/cA/artifacts/x?chatId=cB");
    // Browser: the project's and the agent browsers of its chats.
    yes("GET", "/api/browsers/brA/devtools/json");
    yes("GET", "/api/browsers/brAgA/devtools/page/1");
    no("GET", "/api/browsers/brB/devtools/json");
    no("GET", "/api/browsers/brAgB/devtools/json");
    no("GET", "/api/browsers/brWs/devtools/json");
    no("GET", "/api/browsers/missing/devtools/json");
    // A session in B is never an instance's browser — not under `proj:pA`, nor as the agent browser of a chat of A (started before the
    // move); without the instance's IP there is none.
    no("GET", "/api/browsers/brAinB/devtools/json", undefined, /does not run in its container/);
    no("GET", "/api/browsers/brAgAinB/devtools/page/1", undefined, /does not run in its container/);
    assert.match(PARAMETER.browser({ ...view, P: "pA", W: "w1", K: "pA/main", IP: null }, "brA"), /does not run in its container/, "an instance without IP has no browser");
    // Fixing: if the value is missing it is added; another one is 403.
    const fixed = yes("GET", "/api/workspaces/w1/effective-skills");
    assert.equal(fixed.url.searchParams.get("projectId"), "pA");
    assert.equal(yes("GET", "/api/workspaces/w1/effective-workflows?projectId=pA").url.searchParams.get("projectId"), "pA");
    no("GET", "/api/workspaces/w1/effective-skills?projectId=pB", undefined, /only the value of this project/);
    no("GET", "/api/workspaces/w1/effective-skills?projectId=", undefined, /only the value of this project/);
    no("GET", "/api/workspaces/w2/effective-skills");
    // Workspace context: a drop only onto the workspace level or into the own project.
    yes("POST", "/api/workspaces/w1/context", { text: "x", route: "workspace" });
    yes("POST", "/api/workspaces/w1/context", { text: "x", projectId: "pA" });
    no("POST", "/api/workspaces/w1/context", { text: "x", projectId: "pB" });
    no("POST", "/api/workspaces/w1/context", { text: "x" });
    no("POST", "/api/workspaces/w2/context", { text: "x", route: "workspace" });
    // Language service: only under the project folder by realpath.
    yes("POST", "/api/lsp", { file: path.join(pA, "x.ts") });
    yes("POST", "/api/lsp", { file: path.join(pA, "..", "a", "x.ts") });
    no("POST", "/api/lsp", { file: path.join(pB, "y.ts") }, /realpath/);
    no("POST", "/api/lsp", { file: path.join(pA, "out.ts") }, /realpath/);
    no("POST", "/api/lsp", { file: path.join(pA, "missing.ts") });
    no("POST", "/api/lsp", { file: pA });
    no("POST", "/api/lsp", {});
    // Project of the instance gone: nothing goes.
    const empty = { ...view, project: () => null };
    const u = fenceVerdict({ source: NETWORK_A, token: "tA", method: "GET", path: "/api/projects/pA/context", instances: [IA], identifierOfToken });
    assert.equal(checkScope({ instance: IA, row: u.row, params: u.params }, empty).ok, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("filter: same shape, only the own; the counters by the rule of /api/active-runs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-fence-filter-"));
  try {
    const { pA, view } = testView(root);
    const s = { ...view, P: "pA", W: "w1" };
    assert.deepEqual(FILTER.projects([{ id: "pA" }, { id: "pB" }], s), [{ id: "pA" }]);
    assert.deepEqual(FILTER.workspaces([{ id: "w1", projects: [{ id: "pA" }, { id: "pB" }] }, { id: "w2", projects: [] }], s), [{ id: "w1", projects: [{ id: "pA" }] }]);
    assert.deepEqual(FILTER.services([{ id: "dA", projectId: "pA" }, { id: "dB", projectId: "pB" }], s), [{ id: "dA", projectId: "pA" }]);
    assert.equal(FILTER.boards, undefined, "the boards filter no longer exists");
    assert.equal(FILTER.todos, undefined, "the todo filter no longer exists");
    assert.deepEqual(FILTER.chats([{ id: "cA" }, { id: "cB" }, { id: "cO" }, { id: "cKind" }], s).map((c) => c.id), ["cA", "cKind"]);
    const running = FILTER.portsRunning({
      scanned: 3, findingsComplete: true,
      open: [{ port: 1, registered: { projectId: "pA" }, process: { cwd: "/x" }, mismatch: true }, { port: 2, registered: { projectId: "pB" } },
        { port: 3, registered: null, process: { cwd: path.join(pA, "sub") } }, { port: 4, registered: null, process: { cwd: "/foreign" } }],
      reserved: [{ port: 5, projectId: "pA" }, { port: 6, projectId: "pB" }],
      findings: [{ kind: "conflict", port: 7, services: [{ id: "dA" }, { id: "dB" }] }, { kind: "conflict", port: 8, services: [{ id: "dB" }] },
        { kind: "occupiedByOther", port: 1, process: "secret", cwd: "/x" }, { kind: "occupiedByOther", port: 2, process: "p", cwd: "/y" },
        { kind: "unregistered", port: 3, projectId: "pA" }, { kind: "unregistered", port: 9, projectId: "pB" }],
    }, s);
    assert.deepEqual(running.open.map((e) => e.port), [1, 3]);
    assert.equal(running.open[0].process, null, "the foreign process on the own port stays nameless");
    assert.deepEqual(running.reserved.map((r) => r.port), [5]);
    assert.deepEqual(running.findings, [{ kind: "conflict", port: 7, services: [{ id: "dA" }] }, { kind: "occupiedByOther", port: 1, process: "", cwd: "" }, { kind: "unregistered", port: 3, projectId: "pA" }]);
    assert.equal(running.scanned, 3);
    assert.deepEqual(FILTER.portsFree({ port: 3002, skipped: [{ port: 3000, id: "dA" }, { port: 3001, id: "dB" }], skippedTotal: 2, occupiedWithoutClaim: 0 }, s),
      { port: 3002, skipped: [{ port: 3000, id: "dA" }], skippedTotal: 1, occupiedWithoutClaim: 0 });
    const items = [{ kind: "chat", chatId: "cA", phase: "running" }, { kind: "chat", chatId: "cB", phase: "running" }, { kind: "limit", chatId: "cA", phase: "limit" },
      { kind: "workflow", chatId: "cKind", phase: "limit" }, { kind: "ask", chatId: "cA", phase: "ask" }, { kind: "chat", chatId: "cA", phase: "waiting" }];
    assert.deepEqual(countActiveRuns(items), { total: 6, running: 3, waiting: 1, ask: 1, limit: 1 }, "a workflow in \"limit\" counts as running, as in runs/routes.js");
    const active = FILTER.activeRuns({ items, counts: countActiveRuns(items), now: 1 }, s);
    assert.deepEqual(active.items.map((i) => i.chatId), ["cA", "cA", "cKind", "cA", "cA"]);
    assert.deepEqual(active.counts, { total: 5, running: 2, waiting: 1, ask: 1, limit: 1 });
    // An allowlist — the fields for the deploy (fingerprints of other projects' containers, copies, relocations, numbers across all
    // projects) and every future field of the route do not go out.
    const counter = FILTER.runsCounter({ busy: true, runs: 2, verdicts: 1, quiet: false, open: { runs: 2 }, approvals: [{ chatId: "cA" }, { chatId: "cB" }],
      agents: [{ chatId: "cB" }], dynWorkflows: [{ chatId: "cKind" }], projectWork: [{ projectId: "pA" }, { projectId: "pB" }],
      // the outer-loop runs by their observed chat — like `agents`.
      outerLoop: [{ runId: "l1", chatId: "cA", agentName: "Summarizer" }, { runId: "l2", chatId: "cB", agentName: "Foreign" }],
      relocationContainer: ["fingerprint-b"], copies: 3, copiesWaiting: 1, relocationsOpen: 1, converted: 2, projectError: 1, futureField: "x" }, s);
    assert.deepEqual(counter, { busy: true, runs: 2, verdicts: 1, quiet: false, open: { runs: 2 }, approvals: [{ chatId: "cA" }], agents: [], dynWorkflows: [{ chatId: "cKind" }],
      outerLoop: [{ runId: "l1", chatId: "cA", agentName: "Summarizer" }], projectWork: [{ projectId: "pA" }] });
    // An answer of unexpected shape throws (fence.js turns that into a 403 instead of a leak).
    for (const [f, r] of [["projects", {}], ["activeRuns", []], ["runsCounter", { busy: "yes" }], ["portsRunning", []], ["portsFree", {}]]) assert.throws(() => FILTER[f](r, s), f);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("upgrade verdict: ok without operation mark; an error in the verdict rejects instead of letting the upgrade listener throw", async () => {
  const broken = { url: "/api/tunnel?port=1", method: "GET", socket: { remoteAddress: NETWORK_A }, get headers() { throw new Error("broken"); } };
  await withEnvironment(withoutOps, async () => assert.deepEqual(fenceUpgrade(broken), { ok: true }));
  await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1" }, async () => {
    const r = fenceUpgrade(broken);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.match(r.reason, /verdict failed/);
    // From the project network without token: 401; from outside without token: ok (the data layer is not asked).
    assert.equal(fenceUpgrade({ url: "/api/tunnel", method: "GET", headers: {}, socket: { remoteAddress: NETWORK_A } }).status, 401);
    assert.deepEqual(fenceUpgrade({ url: "/api/tunnel", method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } }), { ok: true });
  });
});

// ── (5)–(9) On the real server ────────────────────────────────────────────────────────────────────
// The main agent: reads its MCP file, on "FENCE" calls three tools through the REAL cbase MCP server, on "HOLD" stops at a gate per
// chat, and writes environment and answers under LOCATION. On "AGENT" it starts a subagent in the background that lives at the gate
// "fence-sub" while the turn ends.
const fenceClaude = fakeClaude({
  main: `
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase;
  const chatId = cfg.env.CBASE_CHAT_ID;
  const result = { env: cfg.env, text, calls: {} };
  if (text === "HOLD") await gate("halt-" + chatId);
  if (text === "FENCE") {
    result.calls.list = await mcpCall("cbase_projects_list", {}, null);
    result.calls.erase = await mcpCall("cbase_project_delete", { projectId: cfg.env.CBASE_PROJECT_ID || "x" }, null);
    result.calls.changeover = await mcpCall("cbase_chat_set_project", {}, null);
    result.calls.context = await mcpCall("cbase_context_list", {}, null);
  }
  if (text === "AGENT") {
    const args = { description: "Alongside", prompt: "Wait at the gate." };
    say({ type: "assistant", message: { id: "main-a-" + turn, content: [{ type: "tool_use", id: "toolu_fence" + turn, name: "mcp__cbase__cbase_agent", input: args }] } });
    result.calls.agent = await mcpCall("cbase_agent", args);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_fence" + turn, content: textOf(result.calls.agent) }] } });
  }
  fs.writeFileSync(path.join(LOCATION, "fence-" + chatId + "-" + turn + ".json"), JSON.stringify(result));
  say({ type: "assistant", message: { id: "main-" + turn, content: [{ type: "text", text: "done " + text }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
  sub: `
    await gate("fence-sub");
    say({ type: "assistant", message: { id: "sub-1", content: [{ type: "text", text: "Finding" }] } });
    finished();
    say({ type: "result", result: "Finding", session_id: "sub-session" });`,
});
const resultOf = (ctx, chatId, turn = 1) => JSON.parse(fs.readFileSync(path.join(ctx.root, `fence-${chatId}-${turn}.json`), "utf8"));
const waitForResult = (ctx, chatId, turn = 1) => waitForTruthy(() => fs.existsSync(path.join(ctx.root, `fence-${chatId}-${turn}.json`)), `result ${chatId} turn ${turn}`);
const send = (base, chatId, text) => json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });

// The cbase server entry as state 17bb7a6 (the state before the access) wrote it without access, recorded: its env keys in their
// order, the timeout, no further field, an empty `names`. What it took from shared modules — the node binary and the MCP script,
// the server's own address, the playwright entry — it took then as now from the same modules, so those come from today's result.
// Its line ELECTRON_RUN_AS_NODE (gone with the standalone app: in the container `process.execPath` was always node, the variable
// had no effect) is left out — not an access question.
function writtenBeforeAccess(opts, shared) {
  const cbase = {
    command: shared.cbase.command,
    args: shared.cbase.args,
    env: {
      CBASE_BASE_URL: shared.cbase.env.CBASE_BASE_URL, CBASE_TIME_ZONE: opts.timeZone, CBASE_SKILLS: JSON.stringify(opts.skills),
      CBASE_PROJECT_ID: opts.projectId, CBASE_WORKSPACE_ID: opts.workspaceId, CBASE_CHAT_ID: opts.chatId,
    },
    timeout: 660000,
  };
  const servers = { cbase, playwright: shared.playwright };
  return { result: { names: [], servers }, file: JSON.stringify({ mcpServers: servers }, null, 2) };
}

test("writeMcpConfig: without access byte-equal to state 17bb7a6, with access address and token only in env of the cbase server", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-fence-mcp-config-"));
  try {
    await withAgentsServer(async (ctx) => {
      const opts = { projectId: "p1", workspaceId: ctx.ws.id, chatId: ctx.chat.id, extraServers: [], headless: true, toolset: "", tools: null, skills: ["a"], vision: true, timeZone: "Europe/Berlin" };
      const fresh = path.join(tmp, "fresh.json");
      const rNew = writeMcpConfig(fresh, opts);
      const before = writtenBeforeAccess(opts, rNew.servers);
      // Except the marker CBASE_WRITE_PERMISSION of agent communication: a coding chat now writes "free" (before, nothing stood for
      // "no") — it is not an access question. Everything else stays byte-equal.
      const withoutMarker = (file) => {
        const t = fs.readFileSync(file, "utf8");
        const cfg = JSON.parse(t);
        assert.equal(cfg.mcpServers.cbase.env.CBASE_WRITE_PERMISSION, "free", "coding chat: write permission free");
        // Likewise the marker CBASE_SKILL_WRITE: the main run of a coding chat writes skills — not an access question either.
        assert.equal(cfg.mcpServers.cbase.env.CBASE_SKILL_WRITE, "1", "coding main run: skills write");
        return t.replace(/,\n {8}"CBASE_WRITE_PERMISSION": "free"/, "").replace(/,\n {8}"CBASE_SKILL_WRITE": "1"/, "");
      };
      assert.equal(withoutMarker(fresh), before.file, "without access byte-equal");
      assert.equal(rNew.servers.cbase.env.CBASE_WRITE_PERMISSION, "free");
      const { CBASE_WRITE_PERMISSION: _marker, CBASE_SKILL_WRITE: _skill, ...envNew } = rNew.servers.cbase.env;
      // Two return fields of the coding MCP airlock: the names of the wrappers and the prompt section of the project assignment — empty
      // without coding servers; the FILE stays byte-equal (above).
      const { airlock: airlockR, assignment, ...rNewWithout } = rNew;
      assert.deepEqual(airlockR, []);
      assert.equal(assignment, "");
      assert.deepEqual({ ...rNewWithout, servers: { ...rNew.servers, cbase: { ...rNew.servers.cbase, env: envNew } } }, before.result);
      assert.equal(JSON.parse(fs.readFileSync(fresh, "utf8")).mcpServers.cbase.env.CBASE_TOKEN, undefined);
      // Empty values mean "no access" (the caller passes `{}` from backendAccessFor).
      writeMcpConfig(fresh, { ...opts, backendUrl: "", token: "" });
      assert.equal(withoutMarker(fresh), before.file);
      // With access: address from the project network, token — only in env of the cbase server.
      const access = { backendUrl: "http://10.230.5.1:7718", token: "a".repeat(64) };
      writeMcpConfig(fresh, { ...opts, ...access });
      const cfg = JSON.parse(fs.readFileSync(fresh, "utf8"));
      assert.equal(cfg.mcpServers.cbase.env.CBASE_BASE_URL, access.backendUrl);
      assert.equal(cfg.mcpServers.cbase.env.CBASE_TOKEN, access.token);
      for (const [name, s] of Object.entries(cfg.mcpServers)) if (name !== "cbase") assert.ok(!JSON.stringify(s).includes(access.token), `${name} carries the token`);
      // Counter-test: the state before the access knows neither (it wrote the same entry with or without access) — the promise
      // above would be red there.
      const oldCfg = JSON.parse(before.file);
      assert.notEqual(oldCfg.mcpServers.cbase.env.CBASE_BASE_URL, access.backendUrl);
      assert.equal(oldCfg.mcpServers.cbase.env.CBASE_TOKEN, undefined);
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("dispatcher: 401 without token from the project network, foreign token 401, own filtered or 403; /api/runs/active open from outside; without operation mark as before", async () => {
  const fd = await fakeDocker();
  setFenceSource(testSource);
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws } = ctx;
      const P = await twoProjects(ctx, fd);
      fs.writeFileSync(path.join(P.A.path, "note.txt"), "x\n");
      fs.writeFileSync(path.join(P.B.path, "secret.ts"), "export {};\n");
      await withEnvironment(ops(fd), async () => {
        const a = (filePath, o = {}) => request(base, filePath, o);
        const fromA = { source: NETWORK_A, token: P.tA };

        // Without token from the project network: 401 — also liveness, UI and busy status.
        for (const [m, p] of [["GET", "/api/health"], ["GET", "/"], ["GET", "/api/runs/active"], ["GET", "/api/projects"], ["POST", `/api/chats/${P.cA.id}/message`]]) {
          const r = await a(p, { method: m, source: NETWORK_A, ...(m === "POST" ? { body: { text: "x" } } : {}) });
          assert.equal(r.status, 401, `${m} ${p}: ${JSON.stringify(r.data)}`);
          assert.match(r.data.error, /Fence/);
        }
        assert.equal((await a("/api/projects", { source: NETWORK_A, token: "f".repeat(64) })).status, 401, "a made-up token");
        // Foreign token from the own network: 401.
        assert.equal((await a("/api/projects", { source: NETWORK_A, token: P.tB })).status, 401);
        assert.equal((await a("/api/projects", { source: NETWORK_B, token: P.tA })).status, 401);

        // From outside without token: as before — also /api/runs/active (the gateway treats a body without busy as "idle").
        const outside = await a("/api/runs/active");
        assert.equal(outside.status, 200);
        assert.equal(typeof outside.data.busy, "boolean");
        assert.equal(outside.fenced, null);
        const all = await a("/api/projects");
        assert.deepEqual(all.data.map((x) => x.id).sort(), [P.A.id, P.B.id].sort());

        // Own token from the own network: filtered, with marker.
        const own = await a("/api/projects", fromA);
        assert.equal(own.status, 200);
        assert.equal(own.fenced, "1");
        assert.deepEqual(own.data.map((x) => x.id), [P.A.id]);
        assert.deepEqual(Object.keys(own.data[0]).sort(), Object.keys(all.data.find((x) => x.id === P.A.id)).sort(), "same shape");
        const wsList = await a("/api/workspaces", fromA);
        assert.deepEqual(wsList.data.map((w) => [w.id, w.projects.map((x) => x.id)]), [[ws.id, [P.A.id]]]);
        // Only a chat with at least one message is in the list — every chat of the workspace gets one so that the FENCE filters here and
        // not the emptiness.
        for (const c of store.listChats(ws.id, { archive: "including" })) if (!store.listMessages(c.id).length) store.addMessage(c.id, "user", "Hello");
        assert.ok(store.listChats(ws.id).length > 1, "precondition: more than one chat in the workspace");
        const chats = await a(`/api/chats?workspaceId=${ws.id}`, fromA);
        assert.deepEqual(chats.data.map((c) => c.id), [P.cA.id], "only chats of the project (none without a project)");
        const counter = await a("/api/runs/active", fromA);
        assert.equal(counter.status, 200);
        assert.equal(counter.fenced, "1");
        assert.equal(typeof counter.data.busy, "boolean");
        // Allowlist only — no deploy field reaches a project container (counter-test from outside: all present).
        for (const f of ["relocationContainer", "copies", "copiesWaiting", "relocationsOpen", "converted", "projectError"]) {
          assert.ok(!(f in counter.data), `${f} reached the project container`);
          assert.ok(f in outside.data, `${f} is missing from outside — the counter-test measures nothing`);
        }
        assert.equal((await a(`/api/projects/${P.A.id}/context`, fromA)).status, 200);
        assert.equal((await a(`/api/projects/${P.B.id}/context`, fromA)).status, 403);
        // Nobody deletes the own project from its container.
        const erase = await a(`/api/projects/${P.A.id}`, { ...fromA, method: "DELETE" });
        assert.equal(erase.status, 403);
        assert.match(erase.data.error, /project-delete/);
        assert.ok(store.getProject(P.A.id), "the project is still there");
        // Nobody changes the project assignment of the chat from the container; the title yes.
        for (const projectId of [null, "", P.B.id]) {
          const r = await a(`/api/chats/${P.cA.id}`, { ...fromA, method: "PATCH", body: { projectId } });
          assert.equal(r.status, 403, `projectId ${JSON.stringify(projectId)}`);
          assert.match(r.data.error, /project assignment from a project container/);
        }
        assert.equal(store.getChat(P.cA.id).projectId, P.A.id);
        const title = await a(`/api/chats/${P.cA.id}`, { ...fromA, method: "PATCH", body: { title: "Till renamed" } });
        assert.equal(title.status, 200, JSON.stringify(title.data));
        assert.equal(store.getChat(P.cA.id).title, "Till renamed", "the body arrived unchanged behind the fence");
        assert.equal((await a(`/api/chats/${P.cB.id}/agent`, { ...fromA, method: "POST", body: { prompt: "x", description: "x" } })).status, 403);
        assert.equal((await a(`/api/chats/${P.cO.id}/log`, fromA)).status, 403);
        // Fixed value.
        assert.equal((await a(`/api/workspaces/${ws.id}/effective-skills?projectId=${P.B.id}`, fromA)).status, 403);
        const fixed = await a(`/api/workspaces/${ws.id}/effective-skills`, fromA);
        assert.equal(fixed.status, 200);
        assert.deepEqual(fixed.data, (await a(`/api/workspaces/${ws.id}/effective-skills?projectId=${P.A.id}`)).data);
        // Language service: a file of the neighbour 403; an own one reaches the route (which says: no language — .md has a server by now, hence .txt).
        const lspB = await a("/api/lsp", { ...fromA, method: "POST", body: { file: path.join(P.B.path, "secret.ts"), line: 1, column: 1 } });
        assert.equal(lspB.status, 403);
        const lspA = await a("/api/lsp", { ...fromA, method: "POST", body: { file: path.join(P.A.path, "note.txt"), line: 1, column: 1 } });
        assert.equal(lspA.status, 400, JSON.stringify(lspA.data));
        // The workflow list of the WHOLE workspace once carried the workflows of all projects — readable from A with the token from the MCP
        // file. The route and its row are gone — from A 403 (no row), from outside 404.
        store.createWorkflow({ id: `wf-m4-${P.B.id}`, workspaceId: ws.id, projectId: P.B.id, name: "storage-secret", createdAt: Date.now(), updatedAt: Date.now() });
        const wfFromA = await a(`/api/chats/${P.cA.id}/manager-workflows`, fromA);
        assert.equal(wfFromA.status, 403, `the workflows of all projects reached A: ${JSON.stringify(wfFromA.data)}`);
        assert.match(wfFromA.data.error, /no row in the fence table/);
        assert.ok(!JSON.stringify(wfFromA.data).includes("storage-secret"));
        const wfOutside = await a(`/api/chats/${P.cA.id}/manager-workflows`);
        assert.equal(wfOutside.status, 404, "the route of the manager workflows is gone — also from outside");
        assert.ok(!JSON.stringify(wfOutside.data).includes("storage-secret"));
        // Rejected and unknown.
        for (const p of ["/api/tunnel?port=22", "/api/events", "/api/ui-lang", `/api/workspaces/${ws.id}/manager/overview`, "/"]) {
          const r = await a(p, fromA);
          assert.equal(r.status, 403, `${p}: ${JSON.stringify(r.data)}`);
        }
        // A valid token from outside (127.0.0.1): the scope of its instance.
        const fromOutside = await a("/api/projects", { token: P.tA });
        assert.deepEqual(fromOutside.data.map((x) => x.id), [P.A.id]);
        assert.equal(fromOutside.fenced, "1");

        // Two running turns (a gate each): /api/active-runs from outside carries both, and its counters follow the SAME rule as the
        // active-run counting (the filter's binding to runs/routes.js); from A's network only A's run.
        await send(base, P.cA.id, "HOLD");
        await send(base, P.cB.id, "HOLD");
        await ctx.gate.reached(`halt-${P.cA.id}`);
        await ctx.gate.reached(`halt-${P.cB.id}`);
        const everythingActive = await a("/api/active-runs");
        assert.ok(everythingActive.data.items.length >= 2);
        assert.deepEqual(everythingActive.data.counts, countActiveRuns(everythingActive.data.items));
        const activeA = await a("/api/active-runs", fromA);
        assert.equal(activeA.fenced, "1");
        assert.deepEqual([...new Set(activeA.data.items.map((i) => i.chatId))], [P.cA.id]);
        assert.deepEqual(activeA.data.counts, countActiveRuns(activeA.data.items));
        const busy = await a("/api/runs/active", fromA);
        assert.equal(busy.data.busy, true, "the counters stay — also from the project network");
        assert.equal(busy.data.runs, 2);
        ctx.gate.open(`halt-${P.cA.id}`);
        ctx.gate.open(`halt-${P.cB.id}`);
        await ctx.waitForQuiet();
      });

      // Without operation mark nothing changes — neither the source nor a token.
      await withEnvironment({ ...withoutOps, CBASE_DOCKER_BIN: fd.bin }, async () => {
        const withoutToken = await request(base, "/api/projects", { source: NETWORK_A });
        assert.equal(withoutToken.status, 200);
        assert.deepEqual(withoutToken.data.map((x) => x.id).sort(), [P.A.id, P.B.id].sort());
        const withToken = await request(base, "/api/projects", { source: NETWORK_A, token: P.tA });
        assert.equal(withToken.fenced, null);
        assert.equal(withToken.data.length, 2);
        assert.equal((await request(base, "/api/ui-lang", { source: NETWORK_A, token: P.tA })).status, 200);
      });
    }, { claude: fenceClaude });
  } finally {
    setFenceSource(null);
    fd.cleanUp();
  }
});

// ── (10) The language service from the project container ─────────────────────────────────────────
// The body check once covered only `file`; a rename wrote every hit itself, and the root searched beyond the project folder. An import
// from the project into a neighbour project was enough to write there (and read there via definition/hover). Now the language server
// runs in the project container (lsp/sessions.js) and computes itself; B checks what it returns (lsp/limit.js). The language server
// here is test/fake-lsp.mjs — it "sees" the neighbour project when the script wants it: exactly the case B must catch (a real
// server in the container would not see it, a faulty mount or an absolute path would).
test("language service from the project container: only under the project folder is anything read or renamed — a rename that reaches into the neighbour project changes nothing anywhere; within the project rename works across files", async () => {
  const fd = await fakeDocker();
  setFenceSource(testSource);
  const scenarioFile = path.join(fd.dir, "lsp-scenario.json");
  const scenario = (o = {}) => fs.writeFileSync(scenarioFile, JSON.stringify(o));
  scenario();
  const FAKE_LSP = path.join(TESTDIR, "fake-lsp.mjs");
  try {
    await withAgentsServer(async (ctx) => {
      const { base } = ctx;
      const P = await twoProjects(ctx, fd);
      const neighbor = path.join(P.B.path, "secret.ts");
      const neighborText = 'export const secret = "SECRET_VALUE" as const;\n';
      fs.writeFileSync(neighbor, neighborText);
      const main = path.join(P.A.path, "main.ts");
      const mainText = `import { secret } from ${JSON.stringify(path.join(P.B.path, "secret"))};\nexport const x = secret + 1;\n`;
      fs.writeFileSync(main, mainText);
      fs.writeFileSync(path.join(P.A.path, "a.ts"), "export const alt = 1;\n");
      fs.writeFileSync(path.join(P.A.path, "b.ts"), 'import { alt } from "./a";\nexport const y = alt + 1;\n');
      await withEnvironment({ ...ops(fd), CBASE_LSP_FAKE: JSON.stringify([process.execPath, FAKE_LSP, "--scenario", scenarioFile]) }, async () => {
        const lsp = (body) => request(base, "/api/lsp", { source: NETWORK_A, token: P.tA, method: "POST", body });
        // Reading: the definition in the neighbour project is a place (path, line, `external`), never its content.
        scenario({ definition: [{ path: neighbor, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } } }] });
        const def = await lsp({ file: main, action: "definition", line: 2, column: 18 });
        assert.equal(def.status, 200, JSON.stringify(def.data));
        // The answer is called `locations` — an earlier version of this line checked `definitions`, and `[].every` was always true.
        // Now: at least one place, and the one in the neighbour project is external.
        const locations = def.data.locations;
        assert.ok(Array.isArray(locations) && locations.length >= 1, `no places in the answer: ${JSON.stringify(def.data)}`);
        assert.ok(locations.every((d) => d.external === true || !String(d.file).startsWith(P.B.path)), `place in the neighbour project not marked external: ${JSON.stringify(def.data)}`);
        assert.ok(locations.some((d) => d.file === neighbor && d.external === true), `the definition in the neighbour project is missing: ${JSON.stringify(def.data)}`);
        assert.ok(!JSON.stringify(def.data).includes("SECRET_VALUE"), `definition reads from the neighbour project: ${JSON.stringify(def.data)}`);
        // The language server ran in A's container — never in B's, never in the neighbour's.
        const starts = fd.calls().filter((a) => a.args[0] === "exec" && a.args.includes(FAKE_LSP));
        assert.ok(starts.length >= 1, "no start of the language server via docker exec");
        assert.ok(starts.every((a) => a.args.includes(`cbase-p-${P.A.id}`) && !a.args.includes(`cbase-p-${P.B.id}`)), JSON.stringify(starts.map((a) => a.args)));
        // Rename at the import, the result reaches into the neighbour project: 403 OUTSIDE, NOTHING written — not in the project either.
        scenario({ renameAlongside: [{ path: neighbor, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } } }] });
        const renamed = await lsp({ file: main, action: "rename", line: 2, column: 18, newName: "fresh" });
        assert.equal(renamed.status, 403, JSON.stringify(renamed.data));
        assert.match(renamed.data.error, /Fence \(language-service\)/);
        assert.equal(fs.readFileSync(neighbor, "utf8"), neighborText, `rename wrote into the neighbour project: ${JSON.stringify(renamed)}`);
        assert.equal(fs.readFileSync(main, "utf8"), mainText, "all or nothing: the own file stayed too");
        scenario();
        // A new name that is no identifier: 400, nothing written.
        const broken = await lsp({ file: path.join(P.A.path, "b.ts"), action: "rename", line: 2, column: 18, newName: "a; b" });
        assert.equal(broken.status, 400, JSON.stringify(broken.data));
        assert.match(broken.data.error, /Bezeichner/);
        assert.equal(fs.readFileSync(path.join(P.A.path, "a.ts"), "utf8"), "export const alt = 1;\n");
        // In the project: rename across two files, both written (`changed` with absolute paths).
        scenario({ renameAlongside: [{ path: path.join(P.A.path, "a.ts"), range: { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } } }] });
        const gut = await lsp({ file: path.join(P.A.path, "b.ts"), action: "rename", line: 2, column: 18, newName: "newName" });
        assert.equal(gut.status, 200, JSON.stringify(gut.data));
        assert.deepEqual([...(gut.data.changed || [])].sort(), [path.join(P.A.path, "a.ts"), path.join(P.A.path, "b.ts")], JSON.stringify(gut.data));
        assert.equal(fs.readFileSync(path.join(P.A.path, "a.ts"), "utf8"), "export const newName = 1;\n");
        assert.equal(fs.readFileSync(path.join(P.A.path, "b.ts"), "utf8"), 'import { newName } from "./a";\nexport const y = newName + 1;\n');
      });
    }, { claude: fenceClaude });
  } finally {
    setFenceSource(null);
    fd.cleanUp();
  }
});

test("upgrade paths: /api/tunnel and DevTools — from the project network 401/403, from outside as before (101 and echo)", async () => {
  const fd = await fakeDocker();
  setFenceSource(testSource);
  // An echo service for the tunnel and a fake DevTools (HTTP /json/version + WebSocket, CDP answers, otherwise echo).
  const echoService = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echoService.listen(0, "127.0.0.1", r));
  const devtools = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${devtools.address().port}/devtools/browser/fake` }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const cdp = new WebSocketServer({ server: devtools });
  const cdpEcho = (sock) => sock.on("message", (d) => {
    let m = null;
    try { m = JSON.parse(String(d)); } catch { /* echo */ }
    sock.send(m && m.id !== undefined && m.method ? JSON.stringify({ id: m.id, result: {} }) : String(d));
  });
  cdp.on("connection", cdpEcho);
  await new Promise((r) => devtools.listen(0, "127.0.0.1", r));
  // The browser of a chat of A must run in the INSTANCE of A (debug host = its IP) — a browser in B is never its. A second fake
  // DevTools on the second loopback plays the Chromium in A's container.
  const IP_A = await secondLoopback();
  const devtoolsA = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${devtoolsA.address().port}/devtools/browser/fake` }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const cdpA = new WebSocketServer({ server: devtoolsA });
  cdpA.on("connection", cdpEcho);
  await new Promise((r) => devtoolsA.listen(0, IP_A, r));
  try {
    await withAgentsServer(async (ctx) => {
      const { base } = ctx;
      const wsBase = base.replace("http://", "ws://");
      const P = await twoProjects(ctx, fd, { ipA: IP_A });
      // The agent browsers: the one of B's chat in the flat profile root (B), the one of A's chat in A's runtime folder — there the
      // server's scanner asks for the instance's IP in operation (projectbox/browser-network.js).
      const root = playwrightProfileRoot(allLocations()[0]);
      const rootA = playwrightProfileRoot(locationFor({ projectId: P.A.id, converted: true }));
      try {
        fs.mkdirSync(path.join(root, `chat-${P.cB.id}`), { recursive: true });
        fs.writeFileSync(path.join(root, `chat-${P.cB.id}`, "DevToolsActivePort"), `${devtools.address().port}\n/devtools/browser/fake`);
        fs.mkdirSync(path.join(rootA, `chat-${P.cA.id}`), { recursive: true });
        fs.writeFileSync(path.join(rootA, `chat-${P.cA.id}`, "DevToolsActivePort"), `${devtoolsA.address().port}\n/devtools/browser/fake`);
        const browser = await withEnvironment(ops(fd), () => waitForTruthy(async () => {
          const l = (await json(`${base}/api/browsers`)).browsers;
          const a = l.find((b) => b.chatId === P.cA.id);
          const b = l.find((x) => x.chatId === P.cB.id);
          return a && b ? { a, b } : null;
        }, "agent browser of A (in the instance) and B in the list"));
        const tunnel = `${wsBase}/api/tunnel?port=${echoService.address().port}`;
        const dt = (id) => `${wsBase}/api/browsers/${id}/devtools/page/1`;

        await withEnvironment(ops(fd), async () => {
          const header = (source, token) => ({ ...(source ? { [SOURCE_HEADER]: source } : {}), ...(token ? { [TOKEN_HEADER]: token } : {}) });
          // Tunnel: from the project network 401 without, 403 with token (also with a valid one from outside); from outside without token as before.
          assert.equal((await wsAttempt(tunnel, header(NETWORK_A))).status, 401);
          const t403 = await wsAttempt(tunnel, header(NETWORK_A, P.tA));
          assert.equal(t403.status, 403);
          assert.match(JSON.parse(t403.body).error, /tunnel/);
          assert.equal((await wsAttempt(tunnel, header(null, P.tA))).status, 403);
          const t101 = await wsAttempt(tunnel, header(null, null));
          assert.equal(t101.status, 101, JSON.stringify(t101));
          assert.equal(await echo(t101.ws, "through the tunnel"), "through the tunnel");
          // DevTools: the browser of a chat of the own project works, the neighbour's does not; without token 401.
          assert.equal((await wsAttempt(dt(browser.a.id), header(NETWORK_A))).status, 401);
          assert.equal((await wsAttempt(dt(browser.b.id), header(NETWORK_A, P.tA))).status, 403);
          assert.equal((await wsAttempt(dt("0000"), header(NETWORK_A, P.tA))).status, 403, "unknown is 403, not 404");
          const own = await wsAttempt(dt(browser.a.id), header(NETWORK_A, P.tA));
          assert.equal(own.status, 101, JSON.stringify(own));
          assert.equal(await echo(own.ws, "devtools-probe"), "devtools-probe");
          const outsideB = await wsAttempt(dt(browser.b.id), header(null, null));
          assert.equal(outsideB.status, 101, "from outside as before");
          // Dot segments and encoded slashes: the fence judged the normalized address (A's browser — allowed), the proxy connected to the
          // browser from the RAW one (B); the third lands normalized on /api/projects (filtered, without browser) and went through too.
          // In scope now 400.
          const port = new URL(base).port;
          for (const raw of [
            `/api/browsers/${browser.b.id}/devtools/browser/fake/../../../../${browser.a.id}/devtools/page/1`,
            `/api/browsers/${browser.b.id}/devtools/browser/fake/%2e%2e/%2E%2E/%2e%2e/%2e%2e/${browser.a.id}/devtools/page/1`,
            `/api/browsers/${browser.b.id}/devtools/browser/fake/../../../../../projects`,
            `/api/browsers/${browser.a.id}/devtools/page%2f1`,
          ]) {
            const r = await rawUpgrade(port, raw, header(NETWORK_A, P.tA));
            assert.equal(r.status, 400, `${raw}: ${r.first} — the proxy slipped past a verdict about another address`);
          }
          assert.equal((await rawUpgrade(port, `/api/browsers/${browser.a.id}/devtools/page/1`, header(NETWORK_A, P.tA))).status, 101, "the same path without dots: the own browser");
          // Every upgrade path goes through the fence first; an unknown one is ended. Before, for a path with the BEGINNING "/api/tunnel"
          // both listeners returned silently — the socket stayed open without an answer. (On the old state this test therefore does not
          // end: rawUpgrade waits for `close` without deadline.)
          for (const raw of ["/api/tunnelx", "/api/tunnel/../a", "/api/tunnel/x", "/api/unknown"]) {
            assert.equal((await rawUpgrade(port, raw, header(NETWORK_A))).status, 401, `${raw} from the project network without token`);
            assert.equal((await rawUpgrade(port, raw, header(null, null))).status, 0, `${raw} from outside: ended (close)`);
          }
          const tunnelRaw = await rawUpgrade(port, `/api/tunnel?port=${echoService.address().port}`, header(null, null));
          assert.equal(tunnelRaw.status, 101, "/api/tunnel from outside as before");
          // A "filtered" row cannot be filtered on a stream: an upgrade onto it is 403.
          const filtered = fenceUpgrade({ url: "/api/projects", method: "GET", headers: header(NETWORK_A, P.tA), socket: {} });
          assert.equal(filtered.ok, false, JSON.stringify(filtered));
          assert.equal(filtered.status, 403);
          assert.match(filtered.reason, /allowed/);
          // The HTTP side of the same family (proxyDevtools) behind the same verdict.
          assert.equal((await request(base, `/api/browsers/${browser.b.id}/devtools/json/version`, { source: NETWORK_A, token: P.tA })).status, 403);
        });
        // Without operation mark from the "project network" without token — as before.
        await withEnvironment(withoutOps, async () => {
          const g1 = await wsAttempt(tunnel, { [SOURCE_HEADER]: NETWORK_A });
          assert.equal(g1.status, 101);
        });
      } finally {
        // BEFORE the harness's server.close(): an open socket would hold it.
        await allWsShut();
        fs.rmSync(path.join(root, `chat-${P.cB.id}`), { recursive: true, force: true });
        fs.rmSync(path.join(rootA, `chat-${P.cA.id}`), { recursive: true, force: true });
      }
    }, { claude: fenceClaude });

    // Counter-test of the wiring: the same tunnel WITHOUT fence (attachTunnel as in the old state 17bb7a6) lets the project network
    // through — the rejection above comes from the fence, not from the tunnel.
    const bare = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
    attachTunnel(bare);
    await new Promise((r) => bare.listen(0, "127.0.0.1", r));
    try {
      await withEnvironment(ops(fd), async () => {
        const r = await wsAttempt(`ws://127.0.0.1:${bare.address().port}/api/tunnel?port=${echoService.address().port}`, { [SOURCE_HEADER]: NETWORK_A, [TOKEN_HEADER]: "x" });
        assert.equal(r.status, 101);
        assert.equal(await echo(r.ws, "without fence"), "without fence");
        await shut(r.ws);
      });
    } finally {
      await allWsShut();
      bare.closeAllConnections?.();
      await new Promise((r) => bare.close(r));
    }
  } finally {
    await allWsShut();
    setFenceSource(null);
    for (const c of cdp.clients) c.terminate();
    cdp.close();
    devtools.closeAllConnections?.();
    await new Promise((r) => devtools.close(r));
    for (const c of cdpA.clients) c.terminate();
    cdpA.close();
    devtoolsA.closeAllConnections?.();
    await new Promise((r) => devtoolsA.close(r));
    echoService.close();
    fd.cleanUp();
  }
});

test("cbase MCP in the project container: token and address in the MCP file, only the own project, second text block; without instance as before", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base } = ctx;
      const P = await twoProjects(ctx, fd);
      await withEnvironment(ops(fd), async () => {
        // In the project container (chat of A): the MCP file carries address and token of the instance.
        await send(base, P.cA.id, "FENCE");
        await waitForResult(ctx, P.cA.id);
        await ctx.waitForQuiet();
        const r = resultOf(ctx, P.cA.id);
        assert.equal(r.env.CBASE_TOKEN, tokenFor(P.iA), "the instance's token is in the MCP file");
        assert.equal(r.env.CBASE_BASE_URL, backendUrlFor(P.iA), "the address from the instance's gateway");
        assert.ok(execCalls(fd).length > 0, "the turn ran in the project container");
        const list = r.calls.list.result;
        assert.ok(!list.isError, JSON.stringify(list));
        assert.deepEqual(JSON.parse(list.content[0].text).map((x) => x.id), [P.A.id], "only the own project");
        assert.equal(list.content.length, 2);
        assert.deepEqual(list.content[1], { type: "text", text: FENCE_HINT });
        // What the fence ALWAYS rejects the MCP server does not offer with a token at all (mcp/visibility.js FENCE_LOCKED) — a remembered
        // name runs into "unknown" instead of the fence. The rows themselves (project-delete, the body check on the PATCH) are held by
        // (6) directly at the dispatcher; fence-tools.test.js holds offering against table.
        const erase = r.calls.erase.result;
        assert.equal(erase.isError, true);
        assert.equal(erase.content[0].text, "Unknown tool: cbase_project_delete");
        assert.ok(store.getProject(P.A.id));
        const changeover = r.calls.changeover.result;
        assert.equal(changeover.isError, true);
        assert.equal(changeover.content[0].text, "Unknown tool: cbase_chat_set_project");
        assert.equal(store.getChat(P.cA.id).projectId, P.A.id);
        // A tool whose answer is NOT filtered gets no hint — not even when it resolves first in its process (resolve: /api/projects)
        // and checks the project (assertInScope: /api/projects).
        const context = r.calls.context.result;
        assert.ok(!context.isError, JSON.stringify(context));
        assert.equal(context.content.length, 1, `the "filtered …" hint hangs on an unfiltered answer: ${JSON.stringify(context.content.slice(1))}`);

        // Without instance (chat without project, runs in B): no token, BASE_URL, everything as before — one block, both projects.
        await send(base, P.cO.id, "FENCE");
        await waitForResult(ctx, P.cO.id);
        await ctx.waitForQuiet();
        const o = resultOf(ctx, P.cO.id);
        assert.equal(o.env.CBASE_TOKEN, undefined);
        assert.equal(o.env.CBASE_BASE_URL, base);
        assert.equal(o.calls.list.result.content.length, 1);
        assert.deepEqual(JSON.parse(o.calls.list.result.content[0].text).map((x) => x.id).sort(), [P.A.id, P.B.id].sort());
      });
    }, { claude: fenceClaude });
  } finally { fd.cleanUp(); }
});

// ── (11)/(12) Project switch beside living work ──────────────────────────────────────────────────
// A project switch applies from the next turn on; the running turn and subagents already running stay in the old project. So the
// switch is ALLOWED (an earlier repair blocked it with 409). What keeps running in the old project keeps its instance and token —
// the fence must let its calls through to the routes of ITS chat, but no foreign chat, and after the work ends only the chat's
// project counts. The calls go with the instance token from its network, exactly as the cbase MCP in the container sends them.
// Counter-tests: chats/routes.js with the 409 block => both tests red (409 instead of 200); fence.js without the exception => 403
// instead of 200; runs/agents.js chatAliveInInstance always false => (11) red; projectbox/idle.js without the loop over
// turnsInProject => (12) red (A quiet mid-turn); runs/do-run.js without reportTurnElsewhere or chats/routes.js without
// turnProjectSwitched => (12) red (no "instance-switch" hint in the next turn).
const chatSwitch = async (base, chatId, projectId) => {
  const r = await fetch(`${base}/api/chats/${chatId}`, { method: "PATCH", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ projectId }) });
  return { status: r.status, body: await r.json() };
};

test("(11) project switch beside a living subagent: the chat switches (200) — its calls from A to its own chat succeed, a foreign chat stays 403; after its end the new project applies", async () => {
  const fd = await fakeDocker();
  setFenceSource(testSource);
  try {
    await withAgentsServer(async (ctx) => {
      const { base } = ctx;
      const P = await twoProjects(ctx, fd);
      const fromA = { source: NETWORK_A, token: P.tA };
      await withEnvironment(ops(fd), async () => {
        await send(base, P.cA.id, "AGENT");
        await ctx.gate.reached("fence-sub");
        try {
          // The turn is over (the coding chat does not hold its subagent), the subagent lives.
          await waitForTruthy(async () => {
            const r = await json(`${base}/api/runs/active`);
            return r.runs === 0 && (r.agents || []).some((a) => a.chatId === P.cA.id) ? r : null;
          }, "turn over, subagent alive");
          const [image] = store.subagentsOf(P.cA.id);
          assert.equal(image?.instance, `${P.A.id}/main`, "the subagent lives in A's instance");
          const r = await chatSwitch(base, P.cA.id, P.B.id);
          assert.equal(r.status, 200, `the switch beside living work is allowed — ${JSON.stringify(r.body)}`);
          assert.equal(store.getChat(P.cA.id).projectId, P.B.id);
          // The subagent keeps working in A and reaches its chat with A's token.
          for (const filePath of [`/api/chats/${P.cA.id}`, `/api/chats/${P.cA.id}/log`, `/api/chats/${P.cA.id}/agents`]) {
            const a = await request(base, filePath, fromA);
            assert.equal(a.status, 200, `${filePath} from A after the switch: ${JSON.stringify(a.data).slice(0, 300)}`);
          }
          // No widening: a chat of B and one without project stay closed for A.
          for (const c of [P.cB, P.cO]) assert.equal((await request(base, `/api/chats/${c.id}`, fromA)).status, 403, `foreign chat ${c.id} from A`);
          // From B the chat is in scope anyway (it is in B now).
          assert.equal((await request(base, `/api/chats/${P.cA.id}`, { source: NETWORK_B, token: P.tB })).status, 200);
        } finally { ctx.gate.open("fence-sub"); }
        await ctx.waitForQuiet();
        // After its end (and the turn of its completion notice, which already ran in B) the chat is closed for A again.
        const afterwards = await request(base, `/api/chats/${P.cA.id}`, fromA);
        assert.equal(afterwards.status, 403, `after the end of the work in A: ${JSON.stringify(afterwards.data)}`);
        assert.equal((await request(base, `/api/chats/${P.cA.id}`, { source: NETWORK_B, token: P.tB })).status, 200);
      });
    }, { claude: fenceClaude });
  } finally {
    setFenceSource(null);
    fd.cleanUp();
  }
});

test("(12) project switch mid-turn (200) — the turn keeps running in A and holds A's idle state, its chat calls from A succeed, a foreign chat stays 403; the next turn runs in B and learns of it ONCE", async () => {
  const fd = await fakeDocker();
  setFenceSource(testSource);
  try {
    await withAgentsServer(async (ctx) => {
      const { base } = ctx;
      const P = await twoProjects(ctx, fd);
      const fromA = { source: NETWORK_A, token: P.tA };
      const file = (turn = 1) => path.join(ctx.root, `zaun-${P.cA.id}-${turn}.json`);
      const inContainer = (name) => execCalls(fd).filter((a) => a.args.includes(name) && a.args.includes(WRAPPER_PATH)).length;
      const nameA = `cbase-p-${P.A.id}`;
      const nameB = `cbase-p-${P.B.id}`;
      await withEnvironment(ops(fd), async () => {
        await send(base, P.cA.id, "HOLD");
        await ctx.gate.reached(`halt-${P.cA.id}`);
        try {
          assert.equal(inContainer(nameA), 1, "the turn runs in A's container");
          const r = await chatSwitch(base, P.cA.id, P.B.id);
          assert.equal(r.status, 200, `the switch mid-turn is allowed — ${JSON.stringify(r.body)}`);
          assert.equal(store.getChat(P.cA.id).projectId, P.B.id);
          // The turn keeps running in A: A's idle check sees it although its chat is in B now.
          const l = projectIdle(P.A.id);
          assert.equal(l.quiet, false, "the running turn dropped out of A's idle state because its chat is elsewhere");
          assert.ok(l.open.some((o) => o.chatId === P.cA.id && o.reason === "running"), JSON.stringify(l.open));
          const s = projectLocks(P.A.id, { reason: "relocation" });
          assert.equal(s.ok, false, `a relocation of A would start under the turn: ${JSON.stringify(s)}`);
          assert.equal(projectLocked(P.A.id), null, "the lock is released");
          // Its chat calls from A succeed (question, history, agents — the reading rows here).
          for (const filePath of [`/api/chats/${P.cA.id}`, `/api/chats/${P.cA.id}/log`, `/api/chats/${P.cA.id}/agents`]) {
            const a = await request(base, filePath, fromA);
            assert.equal(a.status, 200, `${filePath} from A mid-turn after the switch: ${JSON.stringify(a.data).slice(0, 300)}`);
          }
          for (const c of [P.cB, P.cO]) assert.equal((await request(base, `/api/chats/${c.id}`, fromA)).status, 403, `foreign chat ${c.id} from A`);
        } finally { ctx.gate.open(`halt-${P.cA.id}`); }
        await ctx.waitForQuiet();
        assert.equal(projectIdle(P.A.id).quiet, true, "after the turn A is quiet");
        assert.equal((await request(base, `/api/chats/${P.cA.id}`, fromA)).status, 403, "after the turn the chat is closed for A again");

        // The next turn runs in B and carries ONE silent hint where the previous one ran.
        fs.rmSync(file(), { force: true });
        await send(base, P.cA.id, "FURTHER");
        await waitForResult(ctx, P.cA.id);
        await ctx.waitForQuiet();
        assert.equal(inContainer(nameB), 1, "the next turn ran in B's container");
        const two = resultOf(ctx, P.cA.id).text;
        assert.match(two, /source="instance-switch"/, `no "instance-switch" hint on the next turn: ${two.slice(0, 600)}`);
        assert.ok(two.includes("while the previous turn was running") && two.includes(`in the project container ${P.A.id}/main`)
          && two.includes(`in the project container ${P.B.id}/main`), two.slice(0, 800));
        fs.rmSync(file(), { force: true });
        await send(base, P.cA.id, "AGAIN");
        await waitForResult(ctx, P.cA.id);
        await ctx.waitForQuiet();
        assert.ok(!resultOf(ctx, P.cA.id).text.includes("while the previous turn was running"), "the same hint came a second time");
      });
    }, { claude: fenceClaude });
  } finally {
    setFenceSource(null);
    fd.cleanUp();
  }
});

// A codex that records its argv and the token of its environment and answers at once.
const codexFence = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for the EXISTENCE of a file and then reads it — without rename it read an empty one under load.
// pids/ and gates/ (the gate folder) are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
fs.writeFileSync(path.join(LOCATION, "codex-call.json"), JSON.stringify({ argv: process.argv.slice(2), token: process.env.CBASE_TOKEN ?? null }));
const say = (o) => console.log(JSON.stringify(o));
say({ type: "thread.started", thread_id: "codex-thread" });
say({ type: "turn.started" });
say({ type: "item.completed", item: { id: "answer-1", type: "agent_message", text: "Codex done" } });
say({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
`;

test("codex in the project container: the token never in argv — env_vars, the value in the environment (in exec as -e without =)", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws } = ctx;
      const P = await twoProjects(ctx, fd);
      await withEnvironment(ops(fd), async () => {
        const cx = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, projectId: P.A.id, provider: "codex", model: "gpt-5.6-sol", permissionMode: "bypassPermissions" }) });
        await json(`${base}/api/chats/${cx.id}`, { method: "PATCH", body: JSON.stringify({ title: "Codex in container" }) });
        await send(base, cx.id, "Compute");
        await waitForTruthy(() => fs.existsSync(path.join(ctx.root, "codex-call.json")), "codex call recorded");
        await ctx.waitForQuiet();
        const token = tokenFor(P.iA);
        const call = JSON.parse(fs.readFileSync(path.join(ctx.root, "codex-call.json"), "utf8"));
        assert.ok(!call.argv.some((x) => x.includes(token)), "the token is in Codex's argv");
        assert.ok(call.argv.includes('mcp_servers.cbase.env_vars=["CBASE_TOKEN"]'), call.argv.join(" "));
        assert.ok(!call.argv.some((x) => x.startsWith("mcp_servers.cbase.env.CBASE_TOKEN")));
        assert.ok(call.argv.includes(`mcp_servers.cbase.env.CBASE_BASE_URL=${JSON.stringify(backendUrlFor(P.iA))}`));
        assert.equal(call.token, token, "the value comes through the Codex process's environment");
        const exec = execCalls(fd).find((a) => a.args.includes(process.env.CODEX_BIN));
        assert.ok(exec, "Codex ran in the project container");
        const e = exec.args.indexOf("CBASE_TOKEN");
        assert.ok(e > 0 && exec.args[e - 1] === "-e", "-e CBASE_TOKEN in the exec");
        assert.ok(!exec.args.some((x) => x.includes(token)), "the token is in the argv of docker exec");
      });
    }, { claude: fenceClaude, codex: codexFence });
  } finally { fd.cleanUp(); }
});

test("without an instance Codex writes no env_vars — the argv stays as before", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws } = ctx;
    const cx = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "codex", model: "gpt-5.6-sol", permissionMode: "bypassPermissions" }) });
    await json(`${base}/api/chats/${cx.id}`, { method: "PATCH", body: JSON.stringify({ title: "Codex in B" }) });
    await send(base, cx.id, "Compute");
    await waitForTruthy(() => fs.existsSync(path.join(ctx.root, "codex-call.json")), "codex call recorded");
    await ctx.waitForQuiet();
    const call = JSON.parse(fs.readFileSync(path.join(ctx.root, "codex-call.json"), "utf8"));
    assert.ok(!call.argv.some((x) => x.includes("env_vars")), call.argv.join(" "));
    assert.equal(call.token, null);
    assert.ok(call.argv.includes(`mcp_servers.cbase.env.CBASE_BASE_URL=${JSON.stringify(base)}`));
  }, { claude: fenceClaude, codex: codexFence });
});

// ── (13) The git access for cbase-project and the assignment of worktrees ───────────────────────────
// The real file runs as a child (asynchronously — the server lives in this process) against the real server and the fake docker. The
// "git in the container" is a script (programs of the fake docker): per host it asks `git credential fill` with the environment of
// the exec and writes which password arrived — without system and global configuration (the test reads no real access, not even from
// the Mac's keychain).
const WRAPPER_PROJECT = path.join(REPO, "server", "backend", "cbase-project");
const REAL_GIT = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
function cbaseProject(args, { cwd, env }) {
  const subprocess = spawn(process.execPath, [WRAPPER_PROJECT, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  subprocess.stdout.on("data", (b) => { out += b; });
  subprocess.stderr.on("data", (b) => { err += b; });
  return new Promise((resolve) => subprocess.once("close", (code) => resolve({ code, out, err })));
}
async function accessRequest(base, wid, { key, source, token, body = { hosts: ["git.example.test", "other.example.test"] } } = {}) {
  const headers = { Connection: "close", "Content-Type": "application/json" };
  if (key !== undefined) headers[GIT_ACCESS_HEADER] = key;
  if (source) headers[SOURCE_HEADER] = source;
  if (token) headers[TOKEN_HEADER] = token;
  const res = await fetch(`${base}/api/workspaces/${wid}/git-access`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, cache: res.headers.get("cache-control"), data };
}

test("(13) git access for cbase-project: operation mark, key, loopback; never from the project network; the real file fetches only the hosts of its targets — worktrees belong to their project", async () => {
  const help = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-fence-git-")));
  const SECRET = `access-${Date.now().toString(36)}-${process.pid}`;
  const FOREIGN = `other-ws-${process.pid}`;
  const log = path.join(help, "container-git.log");
  const home = path.join(help, "home");
  fs.mkdirSync(home);
  const gitInContainer = path.join(help, "git-in-container.sh");
  fs.writeFileSync(gitInContainer, `#!/bin/sh
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
unset GIT_ASKPASS SSH_ASKPASS
for h in git.example.test other.example.test; do
  p=$(printf 'protocol=https\\nhost=%s\\n\\n' "$h" | '${REAL_GIT}' credential fill 2>/dev/null | sed -n 's/^password=//p')
  printf '%s\\t%s\\n' "$h" "$p" >> '${log}'
done
`, { mode: 0o755 });
  const fd = await fakeDocker({ programs: { git: gitInContainer } });
  setFenceSource(testSource);
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws } = ctx;
      const P = await twoProjects(ctx, fd);
      store.setGitCred(ws.id, "git.example.test", "user", SECRET);
      const w2 = store.createWorkspace({ id: "0a3c5e1e-9999-4a4a-8b8b-000000000009", name: "Other", path: path.join(ctx.root, "other"), createdAt: Date.now() });
      store.setGitCred(w2.id, "other.example.test", "someone", FOREIGN);
      const gitA = (...a) => { const r = spawnSync(REAL_GIT, a, { cwd: P.A.path, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); assert.equal(r.status, 0, `${a.join(" ")}: ${r.stderr}`); };
      gitA("init", "-q");
      gitA("commit", "-q", "--allow-empty", "-m", "a");
      gitA("remote", "add", "origin", "https://git.example.test/team/till.git");
      gitA("remote", "add", "foreign", "https://other.example.test/x.git");

      // Without operation mark no key and the route 404.
      await withEnvironment(withoutOps, async () => {
        assert.deepEqual(createGitAccessKey(), { ops: false });
        const r = await accessRequest(base, ws.id, { key: "whatever" });
        assert.equal(r.status, 404, JSON.stringify(r.data));
        assert.match(r.data.error, /only in server mode/);
      });

      await withEnvironment(ops(fd), async () => {
        // The key: 0600 under <data>, under no mount of a project container.
        const s = createGitAccessKey();
        assert.equal(s.path, path.join(DIRS.data, "git-access.key"));
        assert.equal(s.path, gitAccessKeyPath());
        assert.equal(fs.statSync(s.path).mode & 0o777, 0o600);
        const key = fs.readFileSync(s.path, "utf8").trim();
        assert.match(key, /^[0-9a-f]{64}$/);
        const location = locationFor({ projectId: P.A.id, converted: true });
        const rules = mountRules({ home: os.homedir(), wsPath: ws.path, projectPath: P.A.path, runtime: location.root, cliHome: location.home });
        const liesIn = (p, d) => p === d || p.startsWith(`${d}${path.sep}`);
        assert.deepEqual(rules.filter((m) => liesIn(s.path, m.source)).map((m) => m.rule), [], "the key would lie in a project container");

        // The route: only with key, only from loopback, never from the project network; only the workspace, only the hosts.
        const ok = await accessRequest(base, ws.id, { key });
        assert.equal(ok.status, 200, JSON.stringify(ok.data));
        assert.deepEqual(ok.data, { accesses: { "git.example.test": { username: "user", secret: SECRET } } }, "only the stored host, never another workspace's access");
        assert.equal(ok.cache, "no-store");
        assert.deepEqual((await accessRequest(base, w2.id, { key })).data, { accesses: { "other.example.test": { username: "someone", secret: FOREIGN } } });
        for (const [name, o, status] of [
          ["without key", {}, 403],
          ["wrong key", { key: "f".repeat(64) }, 403],
          ["via the gateway without key", { source: "172.17.0.1" }, 403],
          ["via the gateway with key", { source: "172.17.0.1", key }, 403],
          ["from the project network without token", { source: NETWORK_A, key }, 401],
          ["from the project network with token", { source: NETWORK_A, token: P.tA, key }, 403],
          ["with token from outside", { token: P.tA, key }, 403],
          ["broken hosts", { key, body: { hosts: ["a b"] } }, 400],
        ]) {
          const r = await accessRequest(base, ws.id, o);
          assert.equal(r.status, status, `${name}: ${JSON.stringify(r.data)}`);
          assert.ok(!JSON.stringify(r.data).includes(SECRET), `${name}: the access came out`);
          // With a token the EXPLICIT row judges (not just "no row"): a broader row before it would let it through.
          if (o.token) assert.match(r.data.error, /git-access.*never to a project container/, name);
        }
        // A new start invalidates the old key.
        createGitAccessKey();
        assert.equal((await accessRequest(base, ws.id, { key })).status, 403, "the key of an earlier start still works");
        const fresh = fs.readFileSync(s.path, "utf8").trim();

        // The real file against this server: only the hosts of its targets.
        const env = { PATH: process.env.PATH, HOME: home, PWD: P.A.path, TERM: "dumb", GIT_CONFIG_NOSYSTEM: "1",
          CBASE_PROJECT_API: base, CBASE_DOCKER_BIN: fd.bin, CBASE_GIT_KEY: s.path, CBASE_GIT_PROJECTS: path.join(help, "no-list") };
        const run = async (gitArgs) => {
          fs.rmSync(log, { force: true });
          const from = fd.calls().length;
          const r = await cbaseProject([P.A.id, "--git-access", "--", "git", ...gitArgs], { cwd: P.A.path, env });
          assert.equal(r.code, 0, JSON.stringify(r));
          const docker = fd.calls({ daemon: "host" }).slice(from).map((a) => a.args);
          for (const a of docker) assert.ok(!a.some((x) => x.includes(SECRET) || x.includes(fresh)), `a secret in argv: ${a.join(" ")}`);
          return Object.fromEntries(fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((z) => z.split("\t")));
        };
        assert.deepEqual(await run(["fetch", "origin"]), { "git.example.test": SECRET, "other.example.test": "" });
        assert.deepEqual(await run(["fetch", "foreign"]), { "git.example.test": "", "other.example.test": "" }, "a remote on a foreign host would get an access");
        gitA("config", "url.https://other.example.test/.insteadOf", "https://git.example.test/");
        assert.deepEqual(await run(["fetch", "origin"]), { "git.example.test": "", "other.example.test": "" }, "via insteadOf the foreign host would get origin's access");
        gitA("config", "--unset", "url.https://other.example.test/.insteadOf");

        // The list carries the worktree folder of the runtime folder (physical and in the form of locationFor) — over the WHOLE runtime
        // folder in which the worktree folder lies.
        const list = path.join(help, "git-projects");
        await withEnvironment({ CBASE_GIT_PROJECTS: list }, async () => {
          assert.equal(writeGitProjects().written, true);
          const rows = fs.readFileSync(list, "utf8").split("\n");
          assert.ok(rows.includes(`${P.A.id}\t${path.resolve(location.root)}`), rows.join("\n"));
          assert.ok(rows.includes(`${P.A.id}\t${fs.realpathSync(P.A.path)}`), rows.join("\n"));
        });

        // A linked worktree outside any project belongs to the project through its common .git; one in the runtime folder through the
        // location; an own repo next to it stays in B.
        const outside = path.join(ctx.root, "workspace", "hotfix");
        const inRun = path.join(location.worktrees, "agent-x");
        gitA("worktree", "add", "-q", "-b", "wt-outside", outside);
        gitA("worktree", "add", "-q", "-b", "wt-run", inRun);
        fs.mkdirSync(path.join(outside, "deep"));
        const free = path.join(ctx.root, "workspace", "free");
        fs.mkdirSync(free);
        assert.equal(spawnSync(REAL_GIT, ["init", "-q"], { cwd: free }).status, 0);
        const source = gitInstanceForWorkspace();
        for (const p of [outside, path.join(outside, "deep"), inRun]) assert.equal(source(p)?.projectId, P.A.id, p);
        assert.equal(source(free), null);
        assert.equal(source(P.B.path)?.projectId, P.B.id);
      });
    }, { claude: fenceClaude });
  } finally {
    setFenceSource(null);
    fd.cleanUp();
    fs.rmSync(help, { recursive: true, force: true });
  }
});

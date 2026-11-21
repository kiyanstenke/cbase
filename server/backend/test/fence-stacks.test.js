// Guard for the fence part of the project-container tools, REST and visibility (projectbox/fence-table.js, fence.js).
//
// THE ROWS. Once ONE row ("project-stack-copies") rejected everything under `…/stack-copies/**` from a project network. Now every
// `api(` call of the four tools (mcp/tools/stacks.js) has its own row: create (POST), list (GET), row of a copy (GET /:name, no
// tool), fetch (POST /:name/fetch), clear away (DELETE /:name). Scope is the OWN project and every copy of it (every agent of a
// coding chat fetches and clears away, also the copy it runs in). Creating works only from the main (nothing is created from inside
// a copy) and only for a chat OF THIS instance; the TEMPLATE may be a ready copy (`baseInstance` in the body, the route checks it;
// the fence lets the field through from the main and stays 409 from the copy); every other method and every subroute has no row
// and is 403 like anything unknown. The seam guard "every api( call has a row, every mcp row has a call" is in fence.test.js (3).
//
// The promises, each with the way that breaks it:
//   (1) The verdict (pure, fenceVerdict): the five rows, each with method and path, in the token's scope; copy token from the copy's
//       network => scope, main token from the copy's network => 401, copy token from the main's network => 401, no token from
//       either 401 (fence matrix); anything without a row (PUT, PATCH, GET …/fetch, POST …/:name, DELETE without name) is 403.
//   (2) The checks in scope (pure, checkScope against a test view): creating from the main only for a chat of the main (no chat of
//       the copy, none of a neighbour project, none without a project, none without `chatId`); creating with the token of a COPY is
//       409, whatever the body, and a foreign project stays 403 there too (the fence does not reveal what exists); list, fetch and
//       clear away work with both tokens in the own project, never in a foreign one.
//   (3) The dispatcher on the real server (real copy on the fake docker): the copy token creates nothing (409, no new row in
//       stack_copies); the main token reaches the route (its 400 NAME_INVALID/BASE_INVALID arrives, nothing is created) and fails with
//       the chat of the copy, of a neighbour project and of a chat without project (403 of the fence); list, row, fetch (real, 200)
//       with the token of the copy; 404 of the route for an unknown copy; a neighbour project is 403; source x token (401) on the
//       real dispatcher; without token from outside as before.
//
// No clock: the copy is built through the real queue (stacks-copy-harness.mjs), waiting is on states. Every connection is a single
// request with `Connection: close`.
//
// COUNTER-TESTS (one sabotage each on the real tree):
//   projectbox/fence.js                `onlyFromMain` is not checked (creating with a copy's token)   => (2b) (3) red
//   projectbox/fence-table.js          fetch row with any method (`*` instead of POST)                  => (1) red
//                                      create without the body check `copyForChat`                      => (1) (2a) (3) red
//                                      clear-away row with any method (`*` instead of DELETE)           => (1) (3) red
//                                      list row rejected instead of allowed                             => (1) (3) red
//   fence-table.js with the old 409 sentence ("a copy of a copy does not exist", wrong since a copy may be the template)
//                                                                                                       => (2b) (3) red
//   `baseInstance` goes from the main through the fence to the route (2a) (3).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { FENCE_TABLE, rowFor } from "../electron/server/projectbox/fence-table.js";
import { PARAMETER, BODY, TOKEN_HEADER, checkScope, setFenceSource, fenceVerdict } from "../electron/server/projectbox/fence.js";
import { tokenFor } from "../electron/server/projectbox/token.js";
import { json } from "./agent-harness.mjs";
import { buildCopy, situationDefault, withCopy } from "./stacks-copy-harness.mjs";

const ROWS = {
  create: ["POST", "/api/projects/pA/stack-copies", "project-copy-create"],
  list: ["GET", "/api/projects/pA/stack-copies", "project-copies"],
  row: ["GET", "/api/projects/pA/stack-copies/k1", "project-copy"],
  fetch: ["POST", "/api/projects/pA/stack-copies/k1/fetch", "project-copy-fetch"],
  clearAway: ["DELETE", "/api/projects/pA/stack-copies/k1", "project-copy-clear-away"],
};

// ── (1) The verdict: five rows, source x token ──────────────────────────────────────────────────────────────────────────────
const MAIN = Object.freeze({ projectId: "pA", instance: "main", identifier: "pA/main", subnet: "10.230.5.0/24" });
const COPY = Object.freeze({ projectId: "pA", instance: "copy-k1", identifier: "pA/copy-k1", subnet: "10.230.7.0/24" });
const NETWORK_MAIN = "10.230.5.2";
const NETWORK_COPY = "10.230.7.2";
const tokenOf = { tH: MAIN.identifier, tK: COPY.identifier };
const verdict = (source, token, method, filePath) => {
  const inst = token ? { tH: MAIN, tK: COPY }[token] : null;
  return fenceVerdict({ source, token, method, path: filePath, instances: inst ? [inst] : [], identifierOfToken: (t) => tokenOf[t] || null });
};

test("(1) verdict: the five rows apply in the token's scope; copy token from the copy network => scope, main token from there => 401; anything without a row => 403", () => {
  for (const [name, [method, filePath, family]] of Object.entries(ROWS)) {
    for (const [token, source] of [["tH", NETWORK_MAIN], ["tK", NETWORK_COPY], ["tH", "203.0.113.9"], ["tK", "127.0.0.1"]]) {
      const r = verdict(source, token, method, filePath);
      assert.equal(r.verdict, "scope", `${name} with ${token} from ${source}: ${JSON.stringify(r)}`);
      assert.equal(r.row.family, family, name);
      assert.equal(r.row.rule, "allowed", name);
      assert.equal(r.params.project, "pA", name);
    }
    // The source matrix: the other instance's token from the own network, no token from a project network.
    assert.equal(verdict(NETWORK_COPY, "tH", method, filePath).verdict, "401", `${name}: main token from the copy network`);
    assert.equal(verdict(NETWORK_MAIN, "tK", method, filePath).verdict, "401", `${name}: copy token from the main network`);
    assert.equal(verdict(NETWORK_COPY, null, method, filePath).verdict, "401", `${name}: no token from the copy network`);
    assert.equal(verdict(NETWORK_MAIN, "tX", method, filePath).verdict, "401", `${name}: unknown token`);
    assert.equal(verdict("203.0.113.9", null, method, filePath).verdict, "as-today", `${name}: from outside without token as before`);
  }
  // Anything without a row: 403 "no row in the fence table" (fence wording) — never a pass-through into the unknown.
  for (const [m, p] of [["PUT", "/api/projects/pA/stack-copies"], ["PATCH", "/api/projects/pA/stack-copies/k1"], ["GET", "/api/projects/pA/stack-copies/k1/fetch"],
    ["POST", "/api/projects/pA/stack-copies/k1"], ["POST", "/api/projects/pA/stack-copies/k1/fetch/x"], ["DELETE", "/api/projects/pA/stack-copies"], ["DELETE", "/api/projects/pA/stack-copies/k1/fetch"]]) {
    for (const token of ["tH", "tK"]) {
      const r = verdict(token === "tH" ? NETWORK_MAIN : NETWORK_COPY, token, m, p);
      assert.equal(r.verdict, "403", `${m} ${p} with ${token}`);
      assert.match(r.reason, /no row in the fence table/, `${m} ${p}`);
    }
  }
  // The old catch-all row is gone (it rejected everything); no row under stack-copies rejects except the delete preview.
  assert.equal(FENCE_TABLE.some((z) => z.family === "project-stack-copies"), false, "the catch-all row \"project-stack-copies\" is still in the table");
  // All allowed except the delete preview — it belongs to the human's dialog (rejected with reason).
  for (const z of FENCE_TABLE.filter((x) => /stack-copies/.test(x.pattern))) assert.equal(z.rule, z.family === "project-copy-status" ? "rejected" : "allowed", z.family);
  for (const token of ["tH", "tK"]) {
    const r = verdict(token === "tH" ? NETWORK_MAIN : NETWORK_COPY, token, "GET", "/api/projects/pA/stack-copies/k1/state");
    assert.equal(r.verdict, "403", `delete preview with ${token}`);
    assert.match(r.reason, /delete preview/);
  }
  // Only creating carries the main marker and the body check; fetch, clear away and list are explicitly allowed from the copy.
  const withMarker = FENCE_TABLE.filter((z) => z.onlyFromMain).map((z) => z.family);
  assert.deepEqual(withMarker, ["project-copy-create"]);
  assert.equal(rowFor("POST", "/api/projects/pA/stack-copies").row.body, "copyForChat");
  for (const f of ["project-copies", "project-copy", "project-copy-fetch", "project-copy-clear-away"]) {
    assert.equal(FENCE_TABLE.find((z) => z.family === f).onlyFromMain, undefined, f);
  }
});

// ── (2) The checks in scope ───────────────────────────────────────────────────────────────────────────────────────────────
const KH = "pA/main";
const KK = "pA/copy-k1";
const CHATS = {
  cH: { id: "cH", projectId: "pA" }, // in the main
  cK: { id: "cK", projectId: "pA" }, // in the copy
  cB: { id: "cB", projectId: "pB" }, // neighbour project
  cM: { id: "cM", projectId: null }, // chat without project
};
function view({ runs = [] } = {}) {
  const identifier = { cH: KH, cK: KK };
  return {
    project: (id) => ({ pA: { id: "pA", workspaceId: "w1", path: "/ws/pA" }, pB: { id: "pB", workspaceId: "w1", path: "/ws/pB" } })[id] || null,
    chat: (id) => CHATS[id] || null, graphStartOfChild: () => null,
    instanceForChat: (c) => ({ instance: { projectId: "pA" }, identifier: identifier[c.id] ?? null, locked: false }),
    runInInstance: (chatId, k) => runs.some(([c, kk]) => c === chatId && kk === k),
  };
}
const check = (inst, family, { project = "pA", name, body, runs } = {}) => {
  const row = FENCE_TABLE.find((z) => z.family === family);
  const params = { project, ...(name ? { name } : {}) };
  return checkScope({ instance: inst, row, params, method: row.methods[0], body }, view({ runs }));
};

test("(2a) creating from the main: only for a chat of the main — never for the copy's, a neighbour project's, a project-less chat, or without chatId", () => {
  assert.deepEqual(check(MAIN, "project-copy-create", { body: { chatId: "cH" } }), { ok: true });
  assert.deepEqual(check(MAIN, "project-copy-create", { body: { chatId: "cH", name: "x", base: { ".": "main" } } }), { ok: true }, "name and base are checked by the route");
  // A copy from a copy, created from the main — the route checks the template (`baseInstance`).
  assert.deepEqual(check(MAIN, "project-copy-create", { body: { chatId: "cH", baseInstance: "copy-k1" } }), { ok: true }, "the route checks baseInstance");
  for (const [chatId, pattern] of [["cK", /instance other than/], ["cB", /not a chat of this project/], ["cM", /not a chat of this project/], ["existsNot", /not a chat of this project/]]) {
    const r = check(MAIN, "project-copy-create", { body: { chatId } });
    assert.equal(r.ok, false, chatId);
    assert.equal(r.status, undefined, `${chatId}: that is a 403, not a 409`);
    assert.match(r.reason, pattern, chatId);
  }
  for (const body of [{}, undefined, null, { chatId: "" }, { chatId: 7 }, { chatId: ["cH"] }]) {
    const r = check(MAIN, "project-copy-create", { body });
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match(r.reason, /chatId/, JSON.stringify(body));
  }
  // A LIVE run of the chat in the main (a subagent whose chat has since moved in) still reaches the chat — the route then answers with its busy code.
  assert.deepEqual(check(MAIN, "project-copy-create", { body: { chatId: "cK" }, runs: [["cK", KH]] }), { ok: true });
  // The check alone (the row's body check):
  assert.equal(BODY.copyForChat({ ...view(), P: "pA", W: "w1", K: KH }, { chatId: "cH" }), null);
  assert.match(BODY.copyForChat({ ...view(), P: "pA", W: "w1", K: KH }, { chatId: "cK" }), /of this instance/);
  assert.equal(PARAMETER.chatInstance({ ...view(), P: "pA", W: "w1", K: KK }, "cK"), null);
});

test("(2b) creating with a COPY token is 409, whatever the body, also with a template; a foreign project stays 403 there too", () => {
  for (const body of [{ chatId: "cK" }, { chatId: "cH" }, { chatId: "cB" }, { chatId: "cM" }, {}, undefined, { chatId: 7, name: 5 },
    { chatId: "cK", baseInstance: "copy-k1" }, { chatId: "cK", baseInstance: "main" }]) {
    const r = check(COPY, "project-copy-create", { body });
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.status, 409, `${JSON.stringify(body)}: ${r.reason}`);
    assert.match(r.reason, /no copy is created from inside a copy/);
    assert.doesNotMatch(r.reason, /Kopie einer Kopie gibt es nicht/, "the sentence promises what is no longer true");
    assert.match(r.reason, /project-copy-create/);
  }
  // The fence does not reveal what exists: another project is 403 — for the main and the copy token, never 409.
  for (const inst of [MAIN, COPY]) {
    const r = check(inst, "project-copy-create", { project: "pB", body: { chatId: "cH" } });
    assert.equal(r.ok, false);
    assert.equal(r.status, undefined, `${inst.identifier}: 403 instead of 409 for a foreign project`);
    assert.match(r.reason, /different project than/);
  }
});

test("(2c) list, row, fetch and clear away: with both tokens in the own project (also every copy of it), never in a foreign one", () => {
  for (const family of ["project-copies", "project-copy", "project-copy-fetch", "project-copy-clear-away"]) {
    for (const inst of [MAIN, COPY]) {
      assert.deepEqual(check(inst, family, { name: "k1" }), { ok: true }, `${family} with ${inst.identifier}`);
      assert.deepEqual(check(inst, family, { name: "k7" }), { ok: true }, `${family} with ${inst.identifier}: the name is free, the route judges (404)`);
      const r = check(inst, family, { project: "pB", name: "k1" });
      assert.equal(r.ok, false, `${family} with ${inst.identifier}: foreign project`);
      assert.equal(r.status, undefined, family);
      assert.match(r.reason, /different project than/, family);
    }
  }
});

// ── (3) The dispatcher on the real server ──────────────────────────────────────────────────────────────────────────────────────
const SOURCE_HEADER = "x-cbase-test-source";
const testSource = (req) => req.headers?.[SOURCE_HEADER] || req.socket?.remoteAddress;
async function rest(base, method, filePath, { token = null, source = null, body } = {}) {
  const headers = { Connection: "close" };
  if (token) headers[TOKEN_HEADER] = token;
  if (source) headers[SOURCE_HEADER] = source;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${filePath}`, { method: method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data };
}
async function chatIn(ctx, projectId, title) {
  const c = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.ws.id, ...(projectId ? { projectId } : {}), provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
  await json(`${ctx.base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: title }) });
  return c;
}
const ipIn = (subnet) => String(subnet).replace(/\.0\/24$/, ".2");

test("(3) dispatcher: the copy token creates nothing (409), the main token reaches the route and fails with foreign chats; list, row, fetch, clear-away 404 in scope; 401 by source x token", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const cH = await chatIn(ctx, pid, "Main chat");
    const cM = await chatIn(ctx, null, "Project-less chat");
    const neighborPath = path.join(ctx.root, "workspace", "storage");
    fs.mkdirSync(neighborPath, { recursive: true });
    const neighbor = await ctx.projectWithoutInstance({ name: "storage", path: neighborPath });
    const cN = await chatIn(ctx, neighbor.id, "Neighbour chat");
    const cK = ctx.chat;
    await json(`${ctx.base}/api/chats/${cK.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
    await buildCopy(b, { chatId: cK.id });
    const mainRow = store.projectInstance(pid, "main");
    const copyRow = store.projectInstance(pid, "copy-k1");
    assert.ok(mainRow && copyRow, "both instance rows exist");
    const tH = tokenFor(mainRow);
    const tK = tokenFor(copyRow);
    const base = `/api/projects/${pid}/stack-copies`;
    const count = () => store.stackCopiesOf(pid).length;
    assert.equal(count(), 1, "only k1");

    // Without token from outside (the gateway, the UI): the route as before — control that the fence does nothing of its own.
    let r = await rest(ctx.base, "GET", base);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.copies.map((k) => k.name), ["k1"]);

    // The copy token creates nothing: 409 — with the copy's chat, the main's and without body, also with its own copy as template
    // (the template may be a copy, creation happens from the main); no row appears.
    for (const body of [{ chatId: cK.id }, { chatId: cH.id }, { chatId: cM.id }, {}, { chatId: cK.id, baseInstance: "copy-k1" }]) {
      r = await rest(ctx.base, "POST", base, { token: tK, body });
      assert.equal(r.status, 409, `${JSON.stringify(body)}: ${JSON.stringify(r.data)}`);
      assert.match(r.data.error, /no copy is created from inside a copy/);
    }
    assert.equal(count(), 1, "the copy token created a row");
    // The main token with the copy's chat, a neighbour project's, a project-less chat, without chatId: 403 of the fence, nothing appears.
    for (const body of [{ chatId: cK.id }, { chatId: cN.id }, { chatId: cM.id }, {}]) {
      r = await rest(ctx.base, "POST", base, { token: tH, body });
      assert.equal(r.status, 403, `${JSON.stringify(body)}: ${JSON.stringify(r.data)}`);
      assert.match(r.data.error, /^Fence \(project-copy-create\)/);
    }
    // With the main's chat the request reaches the route: its 400 (name, base) is heard, and nothing appears.
    r = await rest(ctx.base, "POST", base, { token: tH, body: { chatId: cH.id, name: "Invalid!" } });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.code, "NAME_INVALID");
    r = await rest(ctx.base, "POST", base, { token: tH, body: { chatId: cH.id, base: 42 } });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.code, "BASE_INVALID");
    // `baseInstance` goes from the main through the fence to the route — its rejection of a template is heard, nothing appears.
    r = await rest(ctx.base, "POST", base, { token: tH, body: { chatId: cH.id, baseInstance: "copy-k9" } });
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, "TEMPLATE_UNKNOWN");
    r = await rest(ctx.base, "POST", base, { token: tH, body: { chatId: cH.id, baseInstance: "Copy K1" } });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.code, "BASE_INSTANCE_INVALID");
    assert.equal(count(), 1, "the route's 400s and 409s created a row");

    // List, row, fetch, clear-away 404 in scope — with both tokens; the fence does not change the route's answer (no filter).
    for (const token of [tH, tK]) {
      r = await rest(ctx.base, "GET", base, { token });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.deepEqual(r.data.copies.map((k) => k.name), ["k1"]);
      assert.equal(r.data.copies[0].chatId, cK.id);
      r = await rest(ctx.base, "GET", `${base}/k1`, { token });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.copy.name, "k1");
      r = await rest(ctx.base, "GET", `${base}/k9`, { token });
      assert.equal(r.status, 404, "the route judges the name");
      r = await rest(ctx.base, "DELETE", `${base}/k9`, { token, body: {} });
      assert.equal(r.status, 404, JSON.stringify(r.data));
      r = await rest(ctx.base, "POST", `${base}/k9/fetch`, { token, body: {} });
      assert.equal(r.status, 404, JSON.stringify(r.data));
      // Without a row: 403 (no pass-through).
      r = await rest(ctx.base, "PUT", base, { token, body: {} });
      assert.equal(r.status, 403);
      assert.match(r.data.error, /no row in the fence table/);
      r = await rest(ctx.base, "POST", `${base}/k1`, { token, body: {} });
      assert.equal(r.status, 403);
      // A neighbour project: 403 of the scope, also for a list.
      r = await rest(ctx.base, "GET", `/api/projects/${neighbor.id}/stack-copies`, { token });
      assert.equal(r.status, 403, JSON.stringify(r.data));
      assert.match(r.data.error, /different project than/);
    }
    // Fetching from the copy itself (every agent fetches) — real: the route fetches the live copy's commits into the main.
    r = await rest(ctx.base, "POST", `${base}/k1/fetch`, { token: tK, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.result && typeof r.data.result === "object", JSON.stringify(r.data));
    r = await rest(ctx.base, "POST", `${base}/k1/fetch`, { token: tH, body: {} });
    assert.equal(r.status, 200, `fetching again from the main is harmless: ${JSON.stringify(r.data)}`);

    // Source x token on the real dispatcher (test seam: the header says which network the request "comes" from).
    assert.ok(copyRow.subnet, "creation wrote the copy's network into its row");
    const sourceCopy = ipIn(copyRow.subnet);
    setFenceSource(testSource);
    try {
      r = await rest(ctx.base, "GET", base, { token: tK, source: sourceCopy });
      assert.equal(r.status, 200, `copy token from the copy network: ${JSON.stringify(r.data)}`);
      r = await rest(ctx.base, "GET", base, { token: tH, source: sourceCopy });
      assert.equal(r.status, 401, `main token from the copy network: ${JSON.stringify(r.data)}`);
      r = await rest(ctx.base, "GET", base, { source: sourceCopy });
      assert.equal(r.status, 401, "no token from the copy network");
      r = await rest(ctx.base, "GET", base, { token: tK, source: "10.230.250.2" });
      assert.equal(r.status, 401, "copy token from a foreign project network");
      r = await rest(ctx.base, "POST", base, { token: tK, source: sourceCopy, body: { chatId: cK.id } });
      assert.equal(r.status, 409, `creating from the copy network: ${JSON.stringify(r.data)}`);
    } finally { setFenceSource(null); }
    assert.equal(count(), 1);
  });
});


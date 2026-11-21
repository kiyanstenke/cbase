// The outer loop, the routes — through the real server:
//   (1) workspace: list with catalog = EXACTLY the two coding groups and built-ins (against the list written out here, not
//       against the own constant), seed visible; create (workspace, project), read, change only the sent fields incl.
//       `defaultNewSince`; every 400 — validation, `chatId` in the body, foreign project, unknown field — writes nothing; 404 for
//       foreign agents
//   (2) DELETE: the summarizer 409; an agent with a running AND a parked run => 200, both rows are `aborted` BEFORE the aborter
//       runs (spy via setOuterLoopAborter), afterwards agent, runs, notes, activation are gone — a neighbor's run keeps running
//       (no 409)
//   (3) reset: only the summarizer, from the template — provider, model, effort and `enabled` stay; `templateNew`; paging runs
//       (newest first, `additional`, `after` = id of the last run — gap-free even in the same millisecond; `before` 400 with a
//       hint, an unknown or foreign `after` 400), sum, `chatTitle`, `chatKind`; broken parameters 400
//   (4) project: takeover only for agents of workspace origin; without the field 400; deselected => not available in the
//       project chat
//   (5) chat: chat info (target chat, reason, available agents with source/switch/last run, notes), activation per chat
//       (400 field/no target chat, 404 not available, 409 archived — BEFORE and AFTER the body), a second "on" does not move
//       `since`; chat-owned agents (400 with `defaultNew`/`projectId`/`chatId`; a manager conversation is no target); paging notes
//   Every workspace carries THREE seeded agents — summarizer, agenda keeper (`<ws>-a9e0da`) and timeline agent — in every list; the
//   keeper's own routes are in outerloop-agenda-keeper.test.js. `area` is accepted by every route and ignored, no response carries
//   it; an agent with the dead column area = managing is missing from the chat info (counter-check: the POST with area = managing
//   would have written the column, the GET would have returned the field).
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/outerloop-routes.test.js

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { CODING_GROUPS } from "../electron/server/toolchain/tool-catalog.js";
import { CATALOG_NAMES } from "../electron/mcp/catalog.js";
import { BUILTIN_TOOLS } from "../electron/server/providers/contract.js";
import { setOuterLoopAborter } from "../electron/server/outerloop/abort.js";
import { SUMMARIZER_TEMPLATE as V } from "../electron/server/outerloop/template.js";
import { withAgentsServer } from "./agent-harness.mjs";

// The contract itself, written out — NOT imported from outerloop/catalog.js: otherwise the test would check the constant against itself.
const E7_GROUPS = ["context", "communication"];
const E7_BUILTIN_FROM = ["Task", "Monitor", "ScheduleWakeup", "TaskStop", "ExitPlanMode", "SlashCommand"];
const E7_TOOLS = CODING_GROUPS.filter((g) => E7_GROUPS.includes(g.key)).flatMap((g) => g.tools);

const BODY = Object.freeze({
  name: "Reviewer", job: "Review the chat.", trigger: [{ kind: "quiet", minutes: 5 }], provider: "claude",
  model: "claude-haiku-4-5-20251001", effort: "", defaultNew: false, tools: [], builtin: [], mcp: {}, enabled: true,
});
const without = (o, ...fields) => Object.fromEntries(Object.entries(o).filter(([k]) => !fields.includes(k)));
const CHAT_BODY = Object.freeze(without(BODY, "defaultNew"));

// The harness's `json` throws on an error status — here the status itself counts.
async function request(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close" } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const post = (url, b) => request(url, { method: "POST", body: JSON.stringify(b) });
const patch = (url, b) => request(url, { method: "PATCH", body: JSON.stringify(b) });
const put = (url, b) => request(url, { method: "PUT", body: JSON.stringify(b) });

// A request whose body comes only AFTER entering the route — without a clock: `Expect: 100-continue` (pattern from
// archive.test.js heldRequest; a .test.js never imports another). When the 100 arrives at the test, the route is surely in
// `await readBody(...)`, behind the dispatcher's first lock. `send()` delivers the body.
function heldRequest(base, method, filePath, bodyText) {
  const u = new URL(base + filePath);
  const buf = Buffer.from(bodyText);
  let finished;
  const response = new Promise((resolve, reject) => { finished = { resolve, reject }; });
  let further;
  const ready = new Promise((resolve) => { further = resolve; });
  const req = http.request({
    host: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false,
    headers: { "Content-Type": "application/json", "Content-Length": buf.length, Expect: "100-continue" },
  }, (res) => {
    let d = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { d += c; });
    res.on("end", () => { let body = d; try { body = JSON.parse(d); } catch { /* not JSON */ } finished.resolve({ status: res.statusCode, body }); });
  });
  req.on("continue", () => further());
  req.on("error", (e) => finished.reject(e));
  req.flushHeaders();
  const tooEarly = response.then((a) => { throw new Error(`response before the body: ${a.status} ${JSON.stringify(a.body)}`); });
  tooEarly.catch(() => {});
  return { ready: Promise.race([ready, tooEarly]), response, send: () => req.end(buf) };
}

// A made-up run row `running` without a core is open work for /api/runs/active (`open.outerLoop`) — at the end of each test the
// test closes EXACTLY its own dummies, otherwise the harness's quiet waits for them forever. No blanket abort: a real run that
// hangs should stop the suite.
const mocksTo = (...ids) => { for (const id of ids.flat()) store.outerLoopRunState(id, "aborted", { error: "Testende (Attrappe)" }); };

async function newProject(ctx, wid, name) {
  const filePath = path.join(ctx.root, `projekt-${name}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(filePath, { recursive: true });
  const r = await post(`${ctx.base}/api/workspaces/${wid}/projects`, { path: filePath, name });
  assert.ok(r.status < 400, JSON.stringify(r.body));
  return r.body;
}
async function newWorkspace(ctx, name) {
  const filePath = path.join(ctx.root, `ws-${name}`);
  fs.mkdirSync(filePath, { recursive: true });
  const r = await post(`${ctx.base}/api/workspaces`, { name, path: filePath });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const newChat = (wid, fields = {}) => {
  const at = Date.now();
  return store.createChat({ id: crypto.randomUUID(), workspaceId: wid, title: "Nebenchat", createdAt: at, updatedAt: at, ...fields });
};

// ── (1) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(1) workspace: list with catalog = exactly the contract; create, read, change only the sent fields; every 400 writes nothing", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws } = ctx;
    const W = `${base}/api/workspaces/${ws.id}/outer-loop`;

    const inventory = await request(W);
    assert.equal(inventory.status, 200);
    const k = inventory.body.catalog;
    assert.deepEqual(k.groups.map((g) => g.key).sort(), [...E7_GROUPS].sort(), "groups exactly E7");
    assert.deepEqual(k.groups.flatMap((g) => g.tools).sort(), [...E7_TOOLS].sort(), "tools exactly those of the contract groups");
    assert.deepEqual(k.builtin, BUILTIN_TOOLS.filter((t) => !E7_BUILTIN_FROM.includes(t)), "built-ins: BUILTIN_TOOLS without the six");
    assert.ok(k.toolAreas.length > 0 && k.toolAreas.every((b) => k.groups.some((g) => g.area === b.key)), "only areas with groups");
    assert.deepEqual([k.mcpServer, k.cbaseApproval], [[], []]);
    assert.ok(Array.isArray(k.fenceDropped) && k.fenceDropped.every((g) => E7_GROUPS.includes(g)));
    assert.deepEqual(inventory.body.trigger.kinds, ["quiet", "interval", "run_end", "clockTime"]);
    assert.deepEqual(inventory.body.trigger.limits.quiet, { field: "minutes", min: 1, max: 1440 });
    assert.deepEqual(inventory.body.template, { revision: V.revision });
    // The seeded agents in the public form: the summarizer, behind it the agenda keeper, then the timeline agent (timeline-agent.test.js).
    assert.equal(inventory.body.items.length, 3);
    assert.deepEqual([inventory.body.items[2].id, inventory.body.items[2].timeline, inventory.body.items[2].fixed], [`${ws.id}-71e11e`, true, true]);
    const z = inventory.body.items[0];
    const pf = inventory.body.items[1];
    assert.deepEqual([pf.id, pf.agendaKeeper, pf.summarizer, pf.fixed, pf.origin, pf.effective, pf.ineffectiveReason],
      [`${ws.id}-a9e0da`, true, false, true, "workspace", false, "without-model"], "the seeded agenda keeper");
    assert.deepEqual([z.fixed, z.agendaKeeper, z.markUpkeep, z.upkeepTally], [true, false, false, null], "the summarizer is fixed but no keeper");
    assert.deepEqual(
      { id: z.id, summarizer: z.summarizer, origin: z.origin, enabled: z.enabled, effective: z.effective, ineffectiveReason: z.ineffectiveReason,
        templateNew: z.templateNew, chatTitle: z.chatTitle, chatKind: z.chatKind, projectName: z.projectName, notTakenOverIn: z.notTakenOverIn, running: z.running },
      { id: ws.id, summarizer: true, origin: "workspace", enabled: true, effective: false, ineffectiveReason: "without-model",
        templateNew: false, chatTitle: null, chatKind: null, projectName: null, notTakenOverIn: [], running: 0 });

    // Create: workspace (with default for new chats => defaultNewSince) and project
    const before = Date.now();
    const a = await post(W, { ...BODY, defaultNew: true, trigger: [{ kind: "clockTime", times: ["18:00", "09:00", "09:00"] }, { kind: "quiet", minutes: 3 }] });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.origin, "workspace");
    assert.deepEqual([a.body.projectId, a.body.chatId, a.body.summarizer, a.body.effective], [null, null, false, true]);
    assert.deepEqual(a.body.trigger, [{ kind: "quiet", minutes: 3 }, { kind: "clockTime", times: ["09:00", "18:00"] }], "gespeicherte Form");
    assert.ok(a.body.defaultNewSince >= before, "effective with defaultNew => defaultNewSince set");
    const proj = await newProject(ctx, ws.id, "A");
    const pa = await post(W, { ...BODY, name: "Project reviewer", projectId: proj.id });
    assert.equal(pa.status, 201, JSON.stringify(pa.body));
    assert.deepEqual([pa.body.origin, pa.body.projectId, pa.body.projectName, pa.body.notTakenOverIn], ["project", proj.id, "A", []]);
    const withNull = await post(W, { ...BODY, name: "Without project", projectId: null });
    assert.equal(withNull.status, 201);
    assert.equal(withNull.body.origin, "workspace", "projectId null means workspace");

    // 400 — and nothing written
    const ws2 = await newWorkspace(ctx, "Two");
    const foreignProject = await newProject(ctx, ws2.id, "Foreign");
    const outside = CATALOG_NAMES.find((t) => t !== "cbase_chat_analysis" && !E7_TOOLS.includes(t));
    assert.ok(outside, "a selectable tool outside the catalog");
    const count = () => store.outerLoopAgentsOf(ws.id).length;
    const prior = count();
    const cases = [
      [{ ...BODY, chatId: ctx.chat.id }, /Chat-Info/, "chatId in the body"],
      [{ ...BODY, projectId: crypto.randomUUID() }, /Projekt/, "unknown project"],
      [{ ...BODY, projectId: foreignProject.id }, /Projekt/, "project of another workspace"],
      [{ ...BODY, projectId: 5 }, /Projekt/, "projectId is no id"],
      [without(BODY, "name"), /Name/, "without name"],
      [without(BODY, "defaultNew"), /defaultNew/, "without defaultNew"],
      [without(BODY, "tools"), /tools/, "without tools"],
      [{ ...BODY, tools: [outside] }, /nicht wählbar/, "tool outside the catalog"],
      [{ ...BODY, tools: ["cbase_chat_analysis"] }, /nicht wählbar/, "the analysis tool is never selectable"],
      [{ ...BODY, builtin: ["Task"] }, /Eingebaute/, "Task"],
      [{ ...BODY, mcp: { [crypto.randomUUID()]: ["x"] } }, /MCP-Server/, "foreign MCP server"],
      [{ ...BODY, trigger: [] }, /mindestens/, "no triggers"],
      [{ ...BODY, trigger: [{ kind: "clockTime", clockTimes: ["09:00"] }] }, /times als Liste/, "times of day under a wrong key"],
      [{ ...BODY, effort: "turbo" }, /turbo/, "unknown effort"],
      [{ ...BODY, provider: "nonexistent" }, /Anbieter/, "unknown provider"],
      [{ ...BODY, summarizer: true }, /Unbekanntes Feld: summarizer/, "unknown field"],
      [[BODY], /Objekt/, "list instead of object"],
    ];
    for (const [body, pattern, what] of cases) {
      const r = await post(W, body);
      assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.body)}`);
      if (pattern) assert.match(r.body.error, pattern, what);
    }
    assert.equal(count(), prior, "no 400 created an agent");
    // `area`: an old client sends it — accepted, ignored, in no response.
    const old = await post(W, { ...BODY, name: "Old client", area: "managing" });
    assert.equal(old.status, 201, JSON.stringify(old.body));
    assert.equal("area" in old.body, false, "no response carries area");
    assert.equal(store.outerLoopAgent(old.body.id).area, "coding", "the dead column stays at the default");
    assert.equal((await post(W, { ...BODY, name: "Broken", area: 7 })).status, 201, "a broken value is ignored too");

    // Lesen
    const g = await request(`${W}/${a.body.id}`);
    assert.equal(g.status, 200);
    assert.deepEqual(g.body, a.body);
    assert.equal((await request(`${W}/${crypto.randomUUID()}`)).status, 404);
    assert.equal((await request(`${W}/${ws2.id}`)).status, 404, "the summarizer of another workspace");
    assert.equal((await patch(`${W}/${ws2.id}`, { name: "foreign" })).status, 404);
    assert.equal(store.outerLoopAgent(ws2.id).name, V.name);

    // Change: only the sent fields
    const p1 = await patch(`${W}/${a.body.id}`, { job: "Review anew." });
    assert.equal(p1.status, 200);
    assert.deepEqual({ ...p1.body, updatedAt: 0 }, { ...a.body, job: "Review anew.", updatedAt: 0 }, "only the job changed");
    const empty = await patch(`${W}/${a.body.id}`, {});
    assert.equal(empty.status, 200);
    assert.equal(empty.body.job, "Review anew.");
    for (const [body, pattern, what] of [
      [{ projectId: proj.id }, /Herkunft/, "projectId"],
      [{ chatId: ctx.chat.id }, /Herkunft/, "chatId"],
      [{ summarizer: true }, /Unbekanntes Feld/, "unknown field"],
      [{ name: "Half", trigger: [{ kind: "quiet", minutes: 0 }] }, /minutes ganzzahlig/, "broken trigger next to a valid name"],
      [{ enabled: "yes" }, /enabled:/, "enabled is no bool"],
    ]) {
      const r = await patch(`${W}/${a.body.id}`, body);
      assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, pattern, what);
    }
    assert.equal(store.outerLoopAgent(a.body.id).name, "Reviewer", "a 400 does not change the valid fields next to it either");
    const p2 = await patch(`${W}/${a.body.id}`, { defaultNew: false });
    assert.equal(p2.body.defaultNewSince, null, "defaultNew off => defaultNewSince cleared");
    assert.equal((await patch(`${W}/${crypto.randomUUID()}`, { name: "x" })).status, 404);

    // The summarizer becomes effective as soon as a model is chosen — and switched off it keeps its point in time
    const zw = await patch(`${W}/${ws.id}`, { provider: "claude", model: "claude-haiku-4-5-20251001" });
    assert.equal(zw.status, 200);
    assert.deepEqual([zw.body.effective, zw.body.ineffectiveReason], [true, null]);
    assert.ok(zw.body.defaultNewSince >= before, "became effective with defaultNew => defaultNewSince");
    const turnedOff = await patch(`${W}/${ws.id}`, { enabled: false });
    assert.deepEqual([turnedOff.body.effective, turnedOff.body.ineffectiveReason, turnedOff.body.defaultNewSince], [false, "off", zw.body.defaultNewSince]);
  });
});

// ── (2) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The spy replaces the run's aborter (B sets it in server.js at start) — every test starts its own server.
test("(2) DELETE: summarizer 409; running and parked run => 200, rows aborted before the aborter, everything gone, neighbor keeps running", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, chat } = ctx;
    const W = `${base}/api/workspaces/${ws.id}/outer-loop`;
    const seen = [];
    setOuterLoopAborter(({ agentIds }) => seen.push({
      agentIds, states: agentIds.flatMap((aid) => store.outerLoopRunsOfAgent(aid).items.map((l) => l.state)).sort(),
    }));
    try {
      const z = await request(`${W}/${ws.id}`, { method: "DELETE" });
      assert.equal(z.status, 409, JSON.stringify(z.body));
      assert.equal(z.body.summarizer, true);
      assert.ok(store.outerLoopSummarizer(ws.id), "the summarizer is still there");
      assert.deepEqual(seen, [], "a 409 aborts nothing");

      const a = (await post(W, BODY)).body;
      const neighbor = (await post(W, { ...BODY, name: "Nachbar" })).body;
      store.createOuterLoopRun({ id: "l-running", agentId: a.id, chatId: chat.id, trigger: "quiet" });
      store.createOuterLoopRun({ id: "l-park", agentId: a.id, chatId: chat.id, trigger: "interval" });
      store.outerLoopRunState("l-park", "parked", { parkedUntil: Date.now() + 3_600_000 });
      store.createOuterLoopRun({ id: "l-neighbor", agentId: neighbor.id, chatId: chat.id, trigger: "quiet" });
      store.createOuterLoopNote({ agentId: a.id, chatId: chat.id, runId: "l-old", text: "Note from earlier" });
      store.setOuterLoopActive(a.id, chat.id, true);
      store.setOuterLoopTakeover(a.id, crypto.randomUUID(), false);
      assert.equal((await request(`${W}/${a.id}`)).body.running, 1, "before: one running run");

      const d = await request(`${W}/${a.id}`, { method: "DELETE" });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      assert.deepEqual(d.body, { ok: true });
      assert.deepEqual(seen, [{ agentIds: [a.id], states: ["aborted", "aborted"] }], "the aborter saw both rows already aborted");
      assert.equal(store.outerLoopAgent(a.id), null);
      assert.deepEqual([store.outerLoopRun("l-running"), store.outerLoopRun("l-park")], [null, null]);
      assert.deepEqual(store.outerLoopNotes(chat.id, { agentId: a.id }).items, []);
      assert.equal(store.outerLoopActiveRow(a.id, chat.id), null);
      assert.deepEqual(store.outerLoopNotTakenOver(a.id), []);
      assert.equal(store.outerLoopRun("l-neighbor").state, "running", "the neighbor's run keeps running");
      assert.equal((await request(`${W}/${a.id}`, { method: "DELETE" })).status, 404, "deleting twice: 404");
    } finally { setOuterLoopAborter(null); mocksTo("l-neighbor"); }
  });
});

// ── (3) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(3) reset only on the summarizer, model/effort/enabled stay; paging runs with sum and chatTitle", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, chat } = ctx;
    const W = `${base}/api/workspaces/${ws.id}/outer-loop`;
    const tool = E7_TOOLS[0];
    const changed = await patch(`${W}/${ws.id}`, {
      name: "Mein Zusammenfasser", job: "Anders.", trigger: [{ kind: "run_end" }], area: "managing", defaultNew: false,
      tools: [tool], builtin: ["Read"], provider: "claude", model: "claude-haiku-4-5-20251001", effort: "high", enabled: false,
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    store.changeOuterLoopAgent(ws.id, { templateRevision: 0, area: "managing" });
    assert.equal((await request(`${W}/${ws.id}`)).body.templateNew, true, "older revision => hint");

    const r = await post(`${W}/${ws.id}/reset`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.deepEqual(
      { name: b.name, job: b.job, trigger: b.trigger, area: "area" in b, defaultNew: b.defaultNew, tools: b.tools,
        builtin: b.builtin, mcp: b.mcp, templateRevision: b.templateRevision, templateNew: b.templateNew },
      { name: V.name, job: V.job, trigger: V.trigger, area: false, defaultNew: V.defaultNew, tools: [], builtin: [],
        mcp: {}, templateRevision: V.revision, templateNew: false }, "from the template");
    assert.deepEqual([b.provider, b.model, b.effort, b.enabled], ["claude", "claude-haiku-4-5-20251001", "high", false], "provider, model, level and on stay");
    assert.equal(store.outerLoopAgent(ws.id).area, "coding", "the dead column back to coding — the summarizer cannot be deleted");
    assert.equal(b.defaultNewSince, null, "switched off stays default without a point in time");

    const a = (await post(W, BODY)).body;
    const no = await post(`${W}/${a.id}/reset`, {});
    assert.equal(no.status, 400);
    assert.match(no.body.error, /Zusammenfasser/);
    assert.equal(store.outerLoopAgent(a.id).name, "Reviewer")
;
    assert.equal((await post(`${W}/${crypto.randomUUID()}/reset`, {})).status, 404);

    // Runs: three on two chats, newest first
    const second = newChat(ws.id, { title: "Zweiter" });
    store.createOuterLoopRun({ id: "l1", agentId: a.id, chatId: chat.id, trigger: "quiet", startedAt: 1000 });
    store.outerLoopRunEnd("l1", { state: "finished", input: 100, output: 10, cached: 5, cost: 0.25, endedAt: 1500 });
    store.createOuterLoopRun({ id: "l2", agentId: a.id, chatId: second.id, trigger: "interval", startedAt: 2000 });
    store.outerLoopRunEnd("l2", { state: "error", error: "broken", input: 50, output: 0, cached: 0, cost: null, endedAt: 2500 });
    store.createOuterLoopRun({ id: "l3", agentId: a.id, chatId: chat.id, trigger: "run_end", startedAt: 3000 });
    try {
      const L = `${W}/${a.id}/runs`;
      const s1 = await request(`${L}?limit=2`);
      assert.equal(s1.status, 200, JSON.stringify(s1.body));
      assert.deepEqual(s1.body.items.map((l) => [l.id, l.state, l.chatTitle, l.chatKind]), [["l3", "running", "Agent-E2E", "normal"], ["l2", "error", "Zweiter", "normal"]]);
      assert.equal(s1.body.additional, true);
      assert.deepEqual(s1.body.sum, { runs: 3, input: 150, output: 10, cached: 5, cost: 0.25 });
      assert.equal(s1.body.items[1].error, "broken");
      const s2 = await request(`${L}?limit=2&after=${s1.body.items[1].id}`);
      assert.deepEqual([s2.status, s2.body.items.map((l) => l.id), s2.body.additional], [200, ["l1"], false]);
      assert.equal(s2.body.items[0].cost, 0.25);
      assert.deepEqual((await request(L)).body.items.map((l) => l.id), ["l3", "l2", "l1"], "without parameters: all up to the default");
      for (const q of ["limit=0", "limit=abc", "limit=501", "after=", `after=${crypto.randomUUID()}`]) {
        assert.equal((await request(`${L}?${q}`)).status, 400, q);
      }
      // The old cursor is a 400 with a hint at `after` — silently ignored it would return the first page again and again.
      const old = await request(`${L}?limit=2&before=${s1.body.items[1].startedAt}`);
      assert.equal(old.status, 400, JSON.stringify(old.body));
      assert.match(old.body.error, /after=/);
      // A run of ANOTHER agent is no cursor of this agent.
      const foreign = (await post(W, { ...BODY, name: "Fremd" })).body;
      store.createOuterLoopRun({ id: "foreign-1", agentId: foreign.id, chatId: chat.id, trigger: "quiet", startedAt: 2500 });
      store.outerLoopRunEnd("foreign-1", { state: "finished", endedAt: 2600 });
      assert.equal((await request(`${L}?after=foreign-1`)).status, 400, "a foreign run as cursor");
      // A run on an old manager conversation carries no genus (`null`): "to the chat" has no target for it.
      const mg = newChat(ws.id, { kind: "manager", title: "Conversation" });
      store.createOuterLoopRun({ id: "l-mg", agentId: foreign.id, chatId: mg.id, trigger: "quiet", startedAt: 2700 });
      store.outerLoopRunEnd("l-mg", { state: "finished", endedAt: 2800 });
      assert.deepEqual((await request(`${W}/${foreign.id}/runs`)).body.items.map((l) => [l.id, l.chatKind]), [["l-mg", null], ["foreign-1", "normal"]]);

      // GUARD: five runs in the SAME millisecond, the page boundary in the middle of them — every page joins without a gap.
      // Counter-test: the old cursor `before=<startedAt>` (strictly smaller) lost runs 3–5 of the group.
      const equal = (await post(W, { ...BODY, name: "Gleichzeitig" })).body;
      const ids = [];
      for (let i = 0; i < 5; i += 1) {
        const id = `gleich-${i}`;
        store.createOuterLoopRun({ id, agentId: equal.id, chatId: chat.id, trigger: "interval", startedAt: 7000 });
        store.outerLoopRunEnd(id, { state: "finished", endedAt: 7001 });
        ids.push(id);
      }
      const G = `${W}/${equal.id}/runs`;
      const seen = [];
      let to = null;
      // At most as many pages as there are runs (+1) — a server that ignores `after` would otherwise return page 1 endlessly.
      for (let pages = 0; pages <= ids.length; pages += 1) {
        const page = await request(`${G}?limit=2${to ? `&after=${to}` : ""}`);
        assert.equal(page.status, 200, JSON.stringify(page.body));
        seen.push(...page.body.items.map((l) => l.id));
        if (!page.body.additional) break;
        to = page.body.items[page.body.items.length - 1].id;
      }
      assert.deepEqual(seen, [...ids].reverse(), "every page joins — no run of the same millisecond is lost");
      assert.equal((await request(`${W}/${crypto.randomUUID()}/runs`)).status, 404);
    } finally { mocksTo("l3"); }
  });
});

// ── (4) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(4) project: takeover only for workspace origin, field required; deselected => not available in the project chat", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws } = ctx;
    const W = `${base}/api/workspaces/${ws.id}/outer-loop`;
    const proj = await newProject(ctx, ws.id, "P");
    const P = `${base}/api/projects/${proj.id}/workspace-outer-loop`;
    const w = (await post(W, BODY)).body;
    const pa = (await post(W, { ...BODY, name: "Projekt-Agent", projectId: proj.id })).body;
    const ws2 = await newWorkspace(ctx, "Two");

    const g = await request(P);
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.items.map((a) => [a.id, a.origin, a.takenOver]), [[ws.id, "workspace", true], [`${ws.id}-a9e0da`, "workspace", true], [`${ws.id}-71e11e`, "workspace", true], [w.id, "workspace", true]],
      "summarizer, agenda keeper and workspace agent — no project agent");

    for (const [body, what] of [[{}, "without field"], [{ takenOver: "no" }, "no bool"], [{ takenOver: null }, "null"], [{ takenOver: false, enabled: true }, "foreign field"]]) {
      const r = await patch(`${P}/${w.id}`, body);
      assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.body)}`);
    }
    assert.equal(store.outerLoopTakenOver(w.id, proj.id), true, "no 400 deselected");
    for (const [aid, what] of [[pa.id, "Projekt-Agent"], [crypto.randomUUID(), "unknown"], [ws2.id, "Zusammenfasser eines anderen Workspace"]]) {
      assert.equal((await patch(`${P}/${aid}`, { takenOver: false })).status, 404, what);
    }

    const projectChat = newChat(ws.id, { projectId: proj.id });
    const C = `${base}/api/chats/${projectChat.id}/outer-loop`;
    assert.ok((await request(C)).body.agents.some((a) => a.id === w.id), "taken over => available in the project chat");
    const out = await patch(`${P}/${w.id}`, { takenOver: false });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true, agentId: w.id, takenOver: false });
    assert.equal((await request(P)).body.items.find((a) => a.id === w.id).takenOver, false);
    assert.deepEqual((await request(`${W}/${w.id}`)).body.notTakenOverIn, [proj.id]);
    assert.deepEqual((await request(C)).body.agents.map((a) => a.id), [ws.id, `${ws.id}-a9e0da`, `${ws.id}-71e11e`, pa.id], "deselected => not available (summarizer, agenda keeper, timeline in the project chat and the project agent stay)");
    assert.equal((await put(`${C}/${w.id}/active`, { enabled: true })).status, 404, "switch on an unavailable agent");
    const turnedOn = await patch(`${P}/${w.id}`, { takenOver: true });
    assert.deepEqual(turnedOn.body, { ok: true, agentId: w.id, takenOver: true });
    assert.equal(store.outerLoopTakenOver(w.id, proj.id), true);
  });
});

// ── (5) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(5) chat: chat info, toggle per chat (400/404/409 before AND after the body), chat-owned agents, notes", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, chat } = ctx;
    const W = `${base}/api/workspaces/${ws.id}/outer-loop`;
    const C = `${base}/api/chats/${chat.id}/outer-loop`;
    const w = (await post(W, { ...BODY, trigger: [{ kind: "run_end" }], tools: [E7_TOOLS[0]] })).body;
    // The dead column is set by no route any more — only existing data carries it; here through the store, also as default for new chats.
    const mg = (await post(W, { ...BODY, name: "Managing", defaultNew: true })).body;
    store.changeOuterLoopAgent(mg.id, { area: "managing" });

    // Chat info: available are summarizer, agenda keeper and the coding agent, not the managing agent
    const s0 = await request(C);
    assert.equal(s0.status, 200);
    assert.deepEqual([s0.body.targetChat, s0.body.reason, s0.body.notes], [true, "", []]);
    assert.deepEqual(s0.body.agents.map((a) => [a.id, a.active, a.source, a.toggleable, a.running, a.lastRun]),
      [[ws.id, false, "ineffective", false, false, null], [`${ws.id}-a9e0da`, false, "ineffective", false, false, null], [w.id, false, "no-default", true, false, null]]);
    const rowW = s0.body.agents[2];
    assert.deepEqual([rowW.trigger, rowW.tools, rowW.effective, rowW.ineffectiveReason, rowW.since], [w.trigger, w.tools, true, null, null],
      "the row carries what the editor writes back");

    // Switch: 400 field, 404 not available
    for (const [body, what] of [[{}, "without the field"], [{ enabled: "yes" }, "not a bool"], [{ enabled: true, since: 1 }, "unknown field"]]) {
      assert.equal((await put(`${C}/${w.id}/active`, body)).status, 400, what);
    }
    assert.equal((await put(`${C}/${mg.id}/active`, { enabled: true })).status, 404, "area does not fit");
    assert.equal((await put(`${C}/${crypto.randomUUID()}/active`, { enabled: true })).status, 404, "unknown");
    assert.equal(store.outerLoopActiveRow(w.id, chat.id), null, "no error case wrote a row");
    const turnedOn = await put(`${C}/${w.id}/active`, { enabled: true });
    assert.equal(turnedOn.status, 200, JSON.stringify(turnedOn.body));
    assert.deepEqual(turnedOn.body, { ok: true, agentId: w.id, enabled: true, active: true, source: "row-on" });
    const since = store.outerLoopActiveRow(w.id, chat.id).since;
    await put(`${C}/${w.id}/active`, { enabled: true });
    assert.equal(store.outerLoopActiveRow(w.id, chat.id).since, since, "a second \"enabled\" does not move the start");
    const z = await put(`${C}/${ws.id}/active`, { enabled: true });
    assert.deepEqual([z.status, z.body.active, z.body.source], [200, false, "ineffective"], "the row stands, the summarizer stays quiet without a model");

    // An "on" on an agent that is already active through the default keeps its start
    const std = (await post(W, { ...BODY, name: "Standard", defaultNew: true })).body;
    const fresh = newChat(ws.id, { createdAt: std.defaultNewSince + 1 });
    const stdCurrent = (await request(`${base}/api/chats/${fresh.id}/outer-loop`)).body.agents.find((a) => a.id === std.id);
    assert.deepEqual([stdCurrent.active, stdCurrent.source, stdCurrent.since], [true, "standard", fresh.createdAt]);
    await put(`${base}/api/chats/${fresh.id}/outer-loop/${std.id}/active`, { enabled: true });
    assert.equal(store.outerLoopActiveRow(std.id, fresh.id).since, fresh.createdAt, "the switch confirms, it starts nothing");

    // Last run and "running" per chat: every state, only THIS chat
    store.createOuterLoopRun({ id: "f-old", agentId: w.id, chatId: chat.id, trigger: "run_end", startedAt: 1000 });
    store.outerLoopRunEnd("f-old", { state: "finished", endedAt: 1100 });
    store.createOuterLoopRun({ id: "l-now", agentId: w.id, chatId: chat.id, trigger: "run_end", startedAt: 5000 });
    const other = Array.from({ length: 250 }, (_, i) => `anderer-${i}`);
    for (const [i, id] of other.entries()) store.createOuterLoopRun({ id, agentId: w.id, chatId: fresh.id, trigger: "quiet", startedAt: 6000 + i });
    try {
      let row = (await request(C)).body.agents.find((a) => a.id === w.id);
      assert.deepEqual([row.running, row.lastRun?.id, row.lastRun?.chatTitle], [true, "l-now", "Agent-E2E"], "behind 250 newer runs on another chat");
      store.outerLoopRunEnd("l-now", { state: "error", error: "Anbieter weg", endedAt: 5100 });
      row = (await request(C)).body.agents.find((a) => a.id === w.id);
      assert.deepEqual([row.running, row.lastRun.id, row.lastRun.state, row.lastRun.error], [false, "l-now", "error", "Anbieter weg"]);
    } finally { mocksTo("l-now", other); }

    // Notes: in the chat info (newest first, with names) and paged
    const n1 = store.createOuterLoopNote({ agentId: w.id, chatId: chat.id, runId: "f-old", text: "First." });
    store.createOuterLoopNote({ agentId: ws.id, chatId: chat.id, runId: "z", text: "From the summarizer." });
    const n3 = store.createOuterLoopNote({ agentId: w.id, chatId: chat.id, runId: "l-now", text: "Second." });
    assert.deepEqual((await request(C)).body.notes.map((n) => [n.text, n.agentName]),
      [["Second.", "Reviewer"], ["From the summarizer.", V.name], ["First.", "Reviewer"]]);
    const N = `${C}/notes`;
    const page = await request(`${N}?agentId=${w.id}&limit=1`);
    assert.deepEqual([page.status, page.body.items.map((n) => n.id), page.body.additional], [200, [n3.id], true]);
    const rest = await request(`${N}?agentId=${w.id}&limit=1&before=${n3.id}`);
    assert.deepEqual([rest.body.items.map((n) => n.id), rest.body.additional], [[n1.id], false]);
    assert.equal((await request(N)).body.items.length, 3);
    for (const q of ["limit=0", "limit=201", "before=x"]) assert.equal((await request(`${N}?${q}`)).status, 400, q);

    // The chat's own agents
    const count = () => store.outerLoopAgentsOfTheChat(chat.id).length;
    for (const [body, pattern, what] of [
      [{ ...CHAT_BODY, defaultNew: false }, /defaultNew/, "defaultNew"],
      [{ ...CHAT_BODY, projectId: null }, /projectId/, "projectId"],
      [{ ...CHAT_BODY, chatId: chat.id }, /chatId/, "chatId"],
      [{ ...CHAT_BODY, color: "rot" }, /Unbekanntes Feld: color/, "unknown field"],
      [without(CHAT_BODY, "job"), /job/, "without job"],
    ]) {
      const r = await post(C, body);
      assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, pattern, what);
    }
    assert.equal(count(), 0);
    const own = await post(C, { ...CHAT_BODY, name: "Eigener" });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.deepEqual([own.body.origin, own.body.chatId, own.body.chatKind, own.body.chatTitle, "area" in own.body, own.body.defaultNew],
      ["chat", chat.id, "normal", "Agent-E2E", false, false]);
    const inChat = (await request(C)).body.agents.find((a) => a.id === own.body.id);
    assert.deepEqual([inChat.active, inChat.source], [true, "chat"], "chat-owned => active without a row");
    assert.equal((await patch(`${W}/${own.body.id}`, { area: "managing" })).status, 200, "area: ignored");
    assert.equal(store.outerLoopAgent(own.body.id).area, "coding");
    assert.equal((await patch(`${W}/${own.body.id}`, { defaultNew: true })).status, 400);
    assert.equal((await patch(`${W}/${own.body.id}`, { name: "Umbenannt" })).body.name, "Umbenannt");
    const mgChat = newChat(ws.id, { kind: "manager" });
    const mgOwn = await post(`${base}/api/chats/${mgChat.id}/outer-loop`, CHAT_BODY);
    // The lock of the genus "manager" (runs/manager-lock.js: 409, read-only) comes first; that a manager conversation is no
    // target is what the GET below says.
    assert.equal(mgOwn.status, 409, "a manager conversation is read-only");
    assert.equal(mgOwn.body.managerLocked, true);
    const mgInfo = (await request(`${base}/api/chats/${mgChat.id}/outer-loop`)).body;
    assert.deepEqual([mgInfo.targetChat, mgInfo.agents], [false, []]);

    // No target chat: reason, no agents, switch and create 400 — on a chat of a foreign genus (an unknown one: an old app-agent
    // chat is read-only, runs/only-readable.js, and would get 409 before the body).
    const wb = newChat(ws.id, { kind: "foreign" });
    const WB = `${base}/api/chats/${wb.id}/outer-loop`;
    const swb = await request(WB);
    assert.deepEqual([swb.body.targetChat, swb.body.agents], [false, []]);
    assert.match(swb.body.reason, /Kein Ziel/);
    assert.match((await put(`${WB}/${w.id}/active`, { enabled: true })).body.error, /Kein Ziel/);
    assert.equal((await post(WB, CHAT_BODY)).status, 400);
    assert.equal(store.outerLoopAgentsOfTheChat(wb.id).length, 0);

    // Archive: reading works, switch and create 409 — before the body (dispatcher) ...
    const archive = (isOn) => put(`${base}/api/chats/${chat.id}/archive`, { archived: isOn });
    assert.equal((await archive(true)).status, 200);
    const sa = await request(C);
    assert.equal(sa.status, 200);
    assert.ok(sa.body.agents.every((a) => a.source === "archived" && !a.active && !a.toggleable), JSON.stringify(sa.body.agents.map((a) => a.source)));
    const rowPrior = store.outerLoopActiveRow(w.id, chat.id);
    const locked = await put(`${C}/${w.id}/active`, { enabled: false });
    assert.deepEqual([locked.status, locked.body.archived], [409, true]);
    assert.equal((await post(C, CHAT_BODY)).status, 409);
    assert.equal((await archive(false)).status, 200);
    // ... and AFTER the body: archived while the request is in readBody
    const gp = heldRequest(base, "PUT", `/api/chats/${chat.id}/outer-loop/${w.id}/active`, JSON.stringify({ enabled: false }));
    await gp.ready;
    assert.equal((await archive(true)).status, 200);
    gp.send();
    const afterBody = await gp.response;
    assert.deepEqual([afterBody.status, afterBody.body.archived], [409, true], JSON.stringify(afterBody.body));
    assert.deepEqual(store.outerLoopActiveRow(w.id, chat.id), rowPrior, "the switch wrote nothing");
    assert.equal((await archive(false)).status, 200);
    const ga = heldRequest(base, "POST", `/api/chats/${chat.id}/outer-loop`, JSON.stringify({ ...CHAT_BODY, name: "Too late" }));
    await ga.ready;
    assert.equal((await archive(true)).status, 200);
    ga.send();
    assert.equal((await ga.response).status, 409);
    assert.equal(store.outerLoopAgentsOfTheChat(chat.id).some((a) => a.name === "Too late"), false, "no agent in the archived chat");
  });
});

// ── (6) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The choice of an agent on a coding server that is later switched off or deleted. The editor sends the choice back on every save
// (normMcp): saving must not check against the ENABLED servers only, and deleting must remove the id from `outer_loop_agents.mcp` —
// otherwise every save would be a 400 and the agent could no longer be changed.
test("(6) MCP choice: a switched-off server keeps it and blocks no save; deleting (server, project) removes it", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws } = ctx;
    const W = `${base}/api/workspaces/${ws.id}/outer-loop`;
    const at = Date.now();
    const srv = store.createMcpServer({ id: crypto.randomUUID(), workspaceId: ws.id, name: "teams", transport: "http", url: "http://127.0.0.1:9/mcp", createdAt: at, updatedAt: at });
    const fresh = await post(W, { ...BODY, mcp: { [srv.id]: ["read"] } });
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    const a = fresh.body;

    store.updateMcpServer(srv.id, { enabled: false });
    assert.equal((await request(W)).body.catalog.mcpServer.some((s) => s.id === srv.id), false, "switched off: not in the editor's catalog");
    const p1 = await patch(`${W}/${a.id}`, { name: "Reviewer 2", mcp: { [srv.id]: ["read"] } });
    assert.equal(p1.status, 200, `switched off: saving with the choice sent back — ${JSON.stringify(p1.body)}`);
    assert.deepEqual(store.outerLoopAgent(a.id).mcp, { [srv.id]: ["read"] }, "the choice survives the switch-off");

    store.deleteMcpServer(srv.id);
    assert.deepEqual(store.outerLoopAgent(a.id).mcp, {}, "deleted: removed from the choice");
    assert.equal((await patch(`${W}/${a.id}`, { name: "Reviewer 3" })).status, 200);
    const foreign = await patch(`${W}/${a.id}`, { mcp: { [srv.id]: ["read"] } });
    assert.equal(foreign.status, 400, "an id that does not exist stays a 400");

    // A project-owned server: deleting the project removes its choice too — another choice stays.
    const proj = await newProject(ctx, ws.id, "P");
    const ps = store.createMcpServer({ id: crypto.randomUUID(), workspaceId: ws.id, projectId: proj.id, name: "project-server", transport: "http", url: "http://127.0.0.1:9/mcp", createdAt: at, updatedAt: at });
    const stays = store.createMcpServer({ id: crypto.randomUUID(), workspaceId: ws.id, name: "stays", transport: "http", url: "http://127.0.0.1:9/mcp", createdAt: at, updatedAt: at });
    const p2 = await patch(`${W}/${a.id}`, { mcp: { [ps.id]: ["x"], [stays.id]: ["y"] } });
    assert.equal(p2.status, 200, JSON.stringify(p2.body));
    store.deleteProject(ws.id, proj.id);
    assert.deepEqual(store.outerLoopAgent(a.id).mcp, { [stays.id]: ["y"] }, "project deleted: only the choice on its server drops");
  });
});

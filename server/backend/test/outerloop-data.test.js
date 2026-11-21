// The outer loop, data layer. What holds here:
//   (1) five tables + FTS with two triggers on a fresh DB; one summarizer per workspace (UNIQUE), never with project
//   (2) seed: at workspace POST (the real route), idempotent, and the start migration (server.js) catches up a missing one —
//       over a real restart
//   (3) activation as a matrix: row on/off/none x defaultNew x point in time x area x takeover x chat origin x archived x
//       special chat/child chat/manager conversation x ineffective x foreign workspace; sinceFor; activeAgentsFor; defaultSinceNew.
//       An agent with the dead column area = managing is available on no chat, not even as default and with an "on" row; a
//       manager conversation is no target any more; a chat with scheduleId (job chat) is a target like any coding chat.
//   (4) the note search finds only notes of a summarizer (counter-check: the same note of another agent), the newest per chat
//       only from ITS workspace
//   (5) checkAgentBody: 400 for every name outside the catalog, unknown built-ins, a foreign MCP server, a broken trigger, an
//       unknown effort, defaultNew with chat origin, missing required fields; `area` is ignored in every origin; the catalog is the
//       two coding groups, the MCP servers are the coding servers of the workspace
//   (6) runs: watermark, states only from open rows, abort at start, abort per agent over outerloop/abort.js with an aborter spy;
//       new rows above the watermark; sessions per chat
//   (7) delete paths: the close path (deleteOuterLoopChat) and the two delete lists take runs, notes, activation along — the
//       three tables WITHOUT a scope column, which the generic guard in schema-register.test.js does not see; a neighbor stays
//   (8) the real delete routes of project and workspace abort running runs of their agents (aborter called)
//   (9) cost: ONE computation with the tick of the amounts (account/prices.js) — reported before estimated, subscription and
//       without price null (no price table: the catalog price estimates)
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/outerloop-data.test.js

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { db as storeDb } from "../electron/server/store/db.js";
import { setUpManagerMcpServer, seedOldSchema } from "./managing-old-seed.mjs";
import { CATALOG_NAMES } from "../electron/mcp/catalog.js";
import { BUILTIN_TOOLS } from "../electron/server/providers/contract.js";
import {
  OUTER_LOOP_BUILTIN, OUTER_LOOP_GROUPS, OUTER_LOOP_SELECTABLE, OUTER_LOOP_FENCE_DROPPED, outerLoopCatalog, checkAgentBody, checkTrigger,
} from "../electron/server/outerloop/catalog.js";
import { activeAgentsFor, activation, sinceFor, defaultSinceNew, effective } from "../electron/server/outerloop/activation.js";
import { seedMissingSummarizer, seedSummarizer } from "../electron/server/outerloop/seed.js";
import { SUMMARIZER_TEMPLATE } from "../electron/server/outerloop/template.js";
import { publicAgent, publicAgentShort } from "../electron/server/outerloop/publiclyVisible.js";
import { abortOuterLoop, setOuterLoopAborter } from "../electron/server/outerloop/abort.js";
import { estimatedCost, costFor } from "../electron/server/account/prices.js";
import { withAgentsServer } from "./agent-harness.mjs";

// The harness's `json` throws on an error status — here the status itself counts.
async function request(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close" } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-outerloop-data-"));
  try { store.initStore(dir); return run(storeDb); }
  finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }
  }
}

let counter = 0;
const newId = (p) => `${p}-${++counter}`;
const chat = (ws, { kind = "normal", projectId = null, createdAt = 2000, scheduleId = null } = {}) =>
  store.createChat({ id: newId("c"), workspaceId: ws, projectId, kind, scheduleId, createdAt, updatedAt: createdAt });
const agent = (ws, fields = {}) => store.createOuterLoopAgent({
  id: newId("a"), workspaceId: ws, name: fields.name || "A", trigger: [{ kind: "run_end" }], area: "coding", provider: "claude",
  model: "m", defaultNew: false, tools: [], builtin: [], mcp: {}, at: 100, ...fields,
});

// ── (1) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(1) five tables and the note FTS with two triggers on a fresh DB; one summarizer per workspace, never with project or chat", () => {
  withStore((db) => {
    const existing = new Set(db.prepare("SELECT name FROM sqlite_master").all().map((r) => r.name));
    for (const n of ["outer_loop_agents", "outer_loop_takeover", "outer_loop_active", "outer_loop_runs", "outer_loop_notes",
      "outer_loop_notes_fts", "outer_loop_notes_fts_ai", "outer_loop_notes_fts_ad", "outer_loop_summarizer_per_ws"]) {
      assert.ok(existing.has(n), `${n} missing after initStore`);
    }
    assert.equal(store.outerLoopNoteSearchAvailable(), true, "FTS5 with contentless_delete is available on this machine — the search must be too");
    store.createWorkspace({ id: "ws-1", name: "W", path: "/w/1", createdAt: 1 });
    const z = seedSummarizer("ws-1", 50);
    assert.equal(z.summarizer, true);
    assert.equal(z.id, "ws-1", "the summarizer's id is the workspace's (no new golden id)");
    assert.throws(() => store.createOuterLoopAgent({ id: "second", workspaceId: "ws-1", name: "Z2", summarizer: true }), /UNIQUE/);
    store.createWorkspace({ id: "ws-2", name: "W2", path: "/w/2", createdAt: 1 });
    assert.throws(() => store.createOuterLoopAgent({ id: "zp", workspaceId: "ws-2", projectId: "p", name: "Z", summarizer: true }), /CHECK/);
    assert.throws(() => store.createOuterLoopAgent({ id: "pc", workspaceId: "ws-2", projectId: "p", chatId: "c", name: "PC" }), /CHECK/);
    assert.throws(() => store.createOuterLoopAgent({ id: "bb", workspaceId: "ws-2", name: "B", area: "anywhere" }), /CHECK/);
  });
});

// ── (2) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(2a) seed: from the template, ineffective without a model (enabled stays), idempotent; seedMissingSummarizer counts only the new ones", () => {
  withStore(() => {
    store.createWorkspace({ id: "ws-a", name: "A", path: "/w/a", createdAt: 1 });
    store.createWorkspace({ id: "ws-b", name: "B", path: "/w/b", createdAt: 1 });
    const z = seedSummarizer("ws-a", 70);
    const V = SUMMARIZER_TEMPLATE;
    assert.deepEqual({ name: z.name, job: z.job, trigger: z.trigger, area: z.area, defaultNew: z.defaultNew, tools: z.tools, builtin: z.builtin, mcp: z.mcp, templateRevision: z.templateRevision },
      { name: V.name, job: V.job, trigger: [{ kind: "quiet", minutes: 5 }], area: "coding", defaultNew: true, tools: [], builtin: [], mcp: {}, templateRevision: V.revision });
    assert.equal(z.enabled, true, "\"off until a model is chosen\" is the state ineffective, not enabled = false");
    assert.equal(z.defaultNewSince, null, "ineffective => no default point in time");
    assert.equal(effective(z), false);
    assert.equal(publicAgent(z).ineffectiveReason, "without-model");
    assert.equal(publicAgent(z).templateNew, false);
    assert.equal(seedSummarizer("ws-a").createdAt, 70, "a second call creates nothing");
    assert.equal(seedMissingSummarizer(), 1, "only ws-b was missing");
    assert.equal(seedMissingSummarizer(), 0, "idempotent");
    assert.equal(store.outerLoopAgentsOf("ws-b").length, 1);
  });
});

test("(2b) seed through the real paths: POST /api/workspaces seeds; if it is missing, the next start catches up (server.js)", async () => {
  await withAgentsServer(async (ctx) => {
    const z = store.outerLoopSummarizer(ctx.ws.id);
    assert.ok(z, "POST /api/workspaces seeded the summarizer");
    assert.equal(z.id, ctx.ws.id);
    const r = await request(`${ctx.base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Second", path: path.join(ctx.root, "second") }) });
    assert.equal(r.status, 201);
    assert.ok(store.outerLoopSummarizer(r.body.id), "the second workspace too");
    assert.equal(store.deleteOuterLoopAgent(ctx.ws.id), true);
    assert.equal(store.outerLoopSummarizer(ctx.ws.id), null);
    await ctx.restart();
    assert.ok(store.outerLoopSummarizer(ctx.ws.id), "the start migration re-seeded it");
    // The same path also seeds the agenda keeper (outerloop-agenda-keeper.test.js) and the timeline agent (timeline-agent.test.js):
    // three agents per workspace.
    assert.equal(store.outerLoopAgentsOf(r.body.id).length, 3, "the second got no further one");
  });
});

// ── (3) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(3) activation as a matrix — computed, not written; each source in its order", () => {
  withStore(() => {
    store.createWorkspace({ id: "W", name: "W", path: "/w/W", createdAt: 1 });
    store.createWorkspace({ id: "X", name: "X", path: "/w/X", createdAt: 1 });
    store.addProject("W", { id: "P1", name: "P1", path: "/w/W/p1", createdAt: 1 });
    store.addProject("W", { id: "P2", name: "P2", path: "/w/W/p2", createdAt: 1 });
    const cNorm = chat("W");
    const cOld = chat("W", { createdAt: 500 });
    const cP1 = chat("W", { projectId: "P1" });
    const cP2 = chat("W", { projectId: "P2" });
    const cMgr = chat("W", { kind: "manager" });
    const cArch = chat("W");
    store.archiveChat(cArch.id, 3000);
    const cSonder = chat("W", { kind: "manager" });
    store.updateChat(cSonder.id, { specialRole: "administrator" });
    const cOrch = chat("W");
    const cKind = chat("W");
    store.createGraphStart({ id: "gs-1", chatId: cOrch.id, childChatId: cKind.id, workflowId: "wf", workflowName: "WF", shortName: "wf", status: "started" });
    const cPlan = chat("W", { scheduleId: "plan-1" });
    const cForeign = chat("X");
    const get = (c) => store.getChat(c.id);

    const aWs = agent("W", { name: "Ws", defaultNew: true, defaultNewSince: 1000 });
    const aMgr = agent("W", { name: "Mgr", area: "managing", defaultNew: true, defaultNewSince: 1000 });
    const aMgrChat = agent("W", { name: "MgrChat", area: "managing", chatId: cOld.id, at: 1500 });
    const aProj = agent("W", { name: "Proj", projectId: "P1" });
    const aChat = agent("W", { name: "Chat", chatId: cNorm.id, at: 1500 });
    const aWithoutModel = agent("W", { name: "Without", model: "", defaultNew: true, defaultNewSince: 1000 });
    const aOff = agent("W", { name: "Off", enabled: false, defaultNew: true, defaultNewSince: 1000 });
    const q = (a, c) => { const r = activation(store.outerLoopAgent(a.id), get(c)); return `${r.active ? "+" : "-"}${r.source}${r.since === null ? "" : `@${r.since}`}`; };

    // Zielchats (K58)
    assert.equal(q(aWs, cSonder), "-no-target-chat", "Sonderchat");
    assert.equal(q(aWs, cKind), "-no-target-chat", "Kind-Chat eines Graph-Workflows");
    assert.equal(q(aWs, cMgr), "-no-target-chat", "manager conversation");
    assert.equal(q(aWs, cPlan), "+standard@2000", "chat of a scheduled job: a target like any coding chat");
    assert.equal(q(aWs, cArch), "-archived");
    store.setOuterLoopActive(aWs.id, cArch.id, true, 2500);
    assert.equal(q(aWs, cArch), "-archived", "an archived chat rests even with an \"enabled\" row");
    // availability
    assert.equal(q(aWs, cForeign), "-not-available", "foreign workspace");
    assert.equal(q(aMgr, cNorm), "-not-available", "area managing does not reach a coding chat, not even as default for new chats");
    assert.equal(q(aMgr, cMgr), "-no-target-chat");
    assert.equal(q(aMgrChat, cOld), "-not-available", "also a chat-owned agent with area = managing");
    // The response says so: with enabled, provider and model it is NOT effective, reason "managing" — both clients show "not
    // running" instead of an ordinary workspace agent. Control: the coding agent. Counter-test: publiclyVisible.js without the
    // "managing" line and with `effective(agent)` => red.
    const view = (a) => [publicAgent(store.outerLoopAgent(a.id)), publicAgentShort(store.outerLoopAgent(a.id))].map((x) => [x.effective, x.ineffectiveReason]);
    assert.deepEqual(view(aMgr), [[false, "managing"], [false, "managing"]], "the managing agent is ineffective in the response");
    assert.deepEqual(view(aMgrChat), [[false, "managing"], [false, "managing"]]);
    assert.deepEqual(view(aWs), [[true, null], [true, null]], "control: the coding agent stays effective");
    assert.equal(q(aProj, cNorm), "-not-available", "project agent does not reach a chat without a project");
    assert.equal(q(aProj, cP2), "-not-available", "project agent does not reach another project");
    assert.equal(q(aProj, cP1), "-no-default");
    assert.equal(q(aChat, cOld), "-not-available", "chat-owned agent does not reach a foreign chat");
    // effectiveness
    assert.equal(q(aWithoutModel, cNorm), "-ineffective");
    assert.equal(q(aOff, cNorm), "-ineffective");
    store.setOuterLoopActive(aWithoutModel.id, cNorm.id, true, 2100);
    assert.equal(q(aWithoutModel, cNorm), "-ineffective", "an \"enabled\" row does not make an agent without a model effective");
    // default for new chats and point in time
    assert.equal(q(aWs, cNorm), "+standard@2000", "chat after the default point in time: since = chat creation");
    assert.equal(q(aWs, cOld), "-no-default", "chat BEFORE the default point in time (no bulk catch-up)");
    store.changeOuterLoopAgent(aWs.id, { defaultNewSince: 2000 });
    assert.equal(q(aWs, cNorm), "+standard@2000", "a chat exactly at the point in time counts");
    store.changeOuterLoopAgent(aWs.id, { defaultNewSince: 1000 });
    // rows (three-valued)
    store.setOuterLoopActive(aWs.id, cOld.id, true, 3000);
    assert.equal(q(aWs, cOld), "+row-on@3000", "an old chat switched on individually is observed from then on");
    store.setOuterLoopActive(aWs.id, cNorm.id, false, 3000);
    assert.equal(q(aWs, cNorm), "-row-off", "an \"off\" row beats the default");
    store.setOuterLoopActive(aMgr.id, cNorm.id, true, 2200);
    assert.equal(q(aMgr, cNorm), "-not-available", "also with an \"enabled\" row");
    // takeover in the project
    assert.equal(q(aWs, cP1), "+standard@2000", "no takeover row means taken over");
    store.setOuterLoopTakeover(aWs.id, "P1", false);
    assert.equal(q(aWs, cP1), "-not-available", "deselected in the project");
    assert.deepEqual(store.outerLoopNotTakenOver(aWs.id), ["P1"]);
    store.setOuterLoopTakeover(aWs.id, "P1", true);
    assert.equal(q(aWs, cP1), "+standard@2000");
    assert.deepEqual(store.outerLoopNotTakenOver(aWs.id), []);
    // chat origin
    assert.equal(q(aChat, cNorm), "+chat@1500", "active without a row, since its creation");
    store.setOuterLoopActive(aChat.id, cNorm.id, false, 4000);
    assert.equal(q(aChat, cNorm), "-row-off");
    store.setOuterLoopActive(aChat.id, cNorm.id, true, 4100);
    assert.equal(q(aChat, cNorm), "+row-on@4100");
    // sinceFor and the list
    assert.equal(sinceFor(store.outerLoopAgent(aWs.id), get(cP1)), 2000);
    assert.equal(sinceFor(store.outerLoopAgent(aWs.id), get(cOld)), 3000);
    assert.equal(sinceFor(store.outerLoopAgent(aChat.id), get(cNorm)), 4100);
    assert.deepEqual(activeAgentsFor(get(cNorm)).map((x) => `${x.agent.name}@${x.since}`), ["Chat@4100"], "Ws is off there, Without/Off ineffective");
    assert.deepEqual(activeAgentsFor(get(cP1)).map((x) => x.agent.name).sort(), ["Ws"], "Proj without default and without a row");
    assert.deepEqual(activeAgentsFor(get(cArch)), []);
  });
});

test("(3b) defaultSinceNew: set when it becomes effective, cleared with defaultNew, stays otherwise", () => {
  const w = { enabled: true, provider: "claude", model: "m" };
  assert.equal(defaultSinceNew(null, { ...w, defaultNew: true }, 10), 10, "new and effective");
  assert.equal(defaultSinceNew(null, { ...w, model: "", defaultNew: true }, 10), null, "new and ineffective (the seed)");
  assert.equal(defaultSinceNew({ enabled: true, provider: "", model: "", defaultNew: true, defaultNewSince: null }, { ...w, defaultNew: true }, 20), 20, "becomes effective");
  assert.equal(defaultSinceNew({ ...w, defaultNew: true, defaultNewSince: 10 }, { ...w, defaultNew: true }, 30), 10, "stays");
  assert.equal(defaultSinceNew({ ...w, defaultNew: false, defaultNewSince: null }, { ...w, defaultNew: true }, 40), 40, "turns on at an effective one");
  assert.equal(defaultSinceNew({ ...w, defaultNew: true, defaultNewSince: 10 }, { ...w, defaultNew: false }, 50), null, "turns off");
  assert.equal(defaultSinceNew({ ...w, defaultNew: true, defaultNewSince: 10 }, { ...w, enabled: false, defaultNew: true }, 60), 10, "switched off: stays");
  assert.equal(defaultSinceNew({ ...w, enabled: false, defaultNew: true, defaultNewSince: 10 }, { ...w, defaultNew: true }, 70), 70, "effective again: new");
});

// ── (4) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(4) note search: only notes of a summarizer; the newest per chat only from the summarizer of ITS workspace", () => {
  withStore(() => {
    store.createWorkspace({ id: "W", name: "W", path: "/w/W", createdAt: 1 });
    store.createWorkspace({ id: "X", name: "X", path: "/w/X", createdAt: 1 });
    const z = seedSummarizer("W");
    const zx = seedSummarizer("X");
    const other = agent("W", { name: "Reviewer" });
    const c1 = chat("W"); const c2 = chat("W");
    store.createOuterLoopNote({ agentId: z.id, chatId: c1.id, runId: "l1", text: "The chat is rebuilding the checkout interface.", at: 1 });
    store.createOuterLoopNote({ agentId: other.id, chatId: c2.id, runId: "l2", text: "The chat is rebuilding the checkout interface anew.", at: 2 });
    store.createOuterLoopNote({ agentId: other.id, chatId: c1.id, runId: "l3", text: "Only the reviewer knows about zebra stripes.", at: 3 });
    const hits = store.outerLoopNoteSearch("checkout", [c1.id, c2.id]);
    assert.deepEqual(hits.map((t) => t.chatId), [c1.id], "the reviewer's note with the same word is not in the index");
    assert.deepEqual(store.outerLoopNoteSearch("zebra", [c1.id, c2.id]), [], "counter-check: a word only from a foreign note");
    assert.deepEqual(store.outerLoopNoteSearch("checkout", [c2.id]), [], "only the passed chats");
    // The newest per chat: only the summarizer, only the own workspace (a foreign summarizer wrote on c2 — must not count).
    store.createOuterLoopNote({ agentId: z.id, chatId: c1.id, runId: "l4", text: "Newer note.", at: 4 });
    store.createOuterLoopNote({ agentId: zx.id, chatId: c2.id, runId: "l5", text: "Foreign.", at: 5 });
    const newest = store.summarizerNotesNewest([c1.id, c2.id]);
    assert.equal(newest.get(c1.id)?.text, "Newer note.");
    assert.equal(newest.has(c2.id), false, "reviewer and foreign summarizer do not count");
    // Notes are immutable; deleting clears the index (contentless_delete), also for a row that was never in it.
    store.deleteOuterLoopChat(c1.id);
    assert.deepEqual(store.outerLoopNoteSearch("checkout", [c1.id]), []);
    const foreign = store.outerLoopNotes(c2.id, { agentId: zx.id }).items[0].id;
    assert.deepEqual(storeDb.prepare("SELECT rowid AS id FROM outer_loop_notes_fts").all().map((r) => r.id), [foreign],
      "the index of c1 is gone — only the summarizer note on c2 is still there");
  });
});

// ── (5) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const BODY = { name: "Reviewer", job: "Review.", trigger: [{ kind: "quiet", minutes: 5 }], defaultNew: false, tools: [], builtin: [], mcp: {} };
const fourHundred = (fn, pattern) => assert.throws(fn, (e) => e.status === 400 && (!pattern || pattern.test(e.message)));

test("(5) checkAgentBody: 400 for everything outside the catalog, foreign MCP servers, broken triggers, unknown efforts; the catalog is exactly the two coding groups", () => {
  withStore(() => {
    store.createWorkspace({ id: "W", name: "W", path: "/w/W", createdAt: 1 });
    store.createWorkspace({ id: "X", name: "X", path: "/w/X", createdAt: 1 });
    // Coding MCP servers: the servers of the coding side, no longer the manager's.
    store.createMcpServer({ id: "srv-w", workspaceId: "W", name: "teams", transport: "http", url: "http://127.0.0.1:1/mcp", createdAt: 1, updatedAt: 1 });
    store.createMcpServer({ id: "srv-x", workspaceId: "X", name: "foreign", transport: "http", url: "http://127.0.0.1:1/mcp", createdAt: 1, updatedAt: 1 });
    // A managing server of a store from before the teardown (only the old-schema seed creates the table): never selectable.
    seedOldSchema(storeDb);
    setUpManagerMcpServer(storeDb, { id: "srv-mgr", workspaceId: "W", key: "mgr", name: "Mgr", url: "http://127.0.0.1:1/mcp" });
    const p = (b, o = {}) => checkAgentBody(b, { workspaceId: "W", ...o });
    // The catalog: the two coding groups, the same objects as toolchain/tool-catalog.js.
    const E7 = ["context", "communication"]; // in catalog order
    assert.deepEqual(OUTER_LOOP_GROUPS, E7);
    assert.deepEqual(outerLoopCatalog("W").groups.map((g) => g.key), E7);
    assert.deepEqual([...OUTER_LOOP_FENCE_DROPPED], [], "no group drops out entirely in the project container");
    assert.deepEqual(outerLoopCatalog("W").mcpServer.map((x) => [x.id, x.key]), [["srv-w", "teams"]], "only the coding servers of THIS workspace");
    assert.deepEqual([...OUTER_LOOP_BUILTIN], BUILTIN_TOOLS.filter((t) => !["Task", "Monitor", "ScheduleWakeup", "TaskStop", "ExitPlanMode", "SlashCommand"].includes(t)));
    // Every name outside the catalog — all of the remaining MCP catalog including the analysis tool — is a 400; every one inside
    // works. The tools of the removed groups (facts, memory, proposals, manager workflows) are in no catalog any more — still a
    // 400, never silently accepted.
    const DROPPED = ["cbase_fact_search", "cbase_memory_read", "cbase_proposal_submit", "cbase_workflow_list"];
    assert.deepEqual(DROPPED.filter((t) => CATALOG_NAMES.includes(t)), [], "precondition: the removed tools are in no catalog");
    const outside = [...CATALOG_NAMES.filter((t) => !OUTER_LOOP_SELECTABLE.includes(t)), ...DROPPED, "Read"];
    assert.ok(outside.includes("cbase_chat_analysis") && outside.includes("cbase_workflow_start"), "the analysis tool and the graph workflows are not selectable");
    assert.ok(outside.length > DROPPED.length + 1, "the complement from the catalog is not empty");
    for (const t of outside) fourHundred(() => p({ ...BODY, tools: [t] }), /nicht wählbar/);
    assert.deepEqual(p({ ...BODY, tools: [...OUTER_LOOP_SELECTABLE].reverse() }).tools, [...OUTER_LOOP_SELECTABLE], "all selectable, stored in catalog order");
    for (const t of ["Task", "Monitor", "ScheduleWakeup", "TaskStop", "ExitPlanMode", "SlashCommand", "Skill", "Nonexistent"]) fourHundred(() => p({ ...BODY, builtin: [t] }), /nicht wählbar/);
    assert.deepEqual(p({ ...BODY, builtin: ["Write", "Bash", "Read"] }).builtin, ["Read", "Write", "Bash"], "built-ins in the order of BUILTIN_TOOLS");
    // MCP: only servers of THIS workspace
    fourHundred(() => p({ ...BODY, mcp: { "srv-x": ["a"] } }), /MCP-Server/);
    fourHundred(() => p({ ...BODY, mcp: { "srv-mgr": ["a"] } }), /MCP-Server/, "a manager's server is no choice any more");
    fourHundred(() => p({ ...BODY, mcp: { "exists-not": ["a"] } }), /MCP-Server/);
    fourHundred(() => p({ ...BODY, mcp: [] }));
    assert.deepEqual(p({ ...BODY, mcp: { "srv-w": ["read", "read"] } }).mcp, { "srv-w": ["read"] });
    // trigger
    for (const broken of [undefined, "quiet", [], [{ kind: "quiet" }], [{ kind: "quiet", minutes: 0 }], [{ kind: "quiet", minutes: 1441 }], [{ kind: "quiet", minutes: 2.5 }],
      [{ kind: "interval", minutes: 4 }], [{ kind: "interval", minutes: 10081 }], [{ kind: "quiet", minutes: 5 }, { kind: "quiet", minutes: 6 }],
      [{ kind: "clockTime", times: [] }], [{ kind: "clockTime", times: ["24:00"] }], [{ kind: "clockTime", times: ["8:00"] }],
      [{ kind: "clockTime", times: Array.from({ length: 25 }, (_, i) => `${String(i % 24).padStart(2, "0")}:${String(i).padStart(2, "0")}`) }],
      [{ kind: "afterRun" }], [{ kind: "nonexistent" }], [null]]) {
      fourHundred(() => p({ ...BODY, trigger: broken }));
    }
    assert.deepEqual(checkTrigger([{ kind: "clockTime", times: ["18:00", "08:30", "18:00"] }, { kind: "run_end", extra: 1 }, { kind: "interval", minutes: 5 }, { kind: "quiet", minutes: 1440 }]),
      [{ kind: "quiet", minutes: 1440 }, { kind: "interval", minutes: 5 }, { kind: "run_end" }, { kind: "clockTime", times: ["08:30", "18:00"] }], "canonical form");
    // effort
    fourHundred(() => p({ ...BODY, effort: "ultra" }), /Denkstufe/);
    fourHundred(() => p({ ...BODY, effort: 3 }), /Denkstufe/);
    assert.equal(p({ ...BODY, effort: "high" }).effort, "high");
    assert.equal(p(BODY).effort, "", "without a value: the provider's default effort");
    // provider: Codex selectable, unknown not
    assert.equal(p({ ...BODY, provider: "codex", model: "gpt-5.6-sol" }).provider, "codex");
    fourHundred(() => p({ ...BODY, provider: "nonexistent" }), /Anbieter/);
    // chat origin: default drops out; `area` is accepted in every origin and ignored
    fourHundred(() => p({ ...BODY }, { origin: "chat" }), /entfällt/);
    const { defaultNew: _s, ...chatBody } = BODY;
    const KEY_CHAT = ["builtin", "effort", "enabled", "job", "mcp", "model", "name", "provider", "tools", "trigger"];
    assert.deepEqual(Object.keys(p(chatBody, { origin: "chat" })).sort(), KEY_CHAT);
    assert.deepEqual(Object.keys(p({ ...chatBody, area: "managing" }, { origin: "chat" })).sort(), KEY_CHAT, "area with chat origin: ignored");
    for (const area of ["coding", "managing", "anywhere", 7]) {
      assert.equal("area" in p({ ...BODY, area }), false, `area ${area}: ignored, not stored`);
    }
    assert.deepEqual(p({ area: "managing" }, { part: true }), {}, "PATCH with area only: nothing to change");
    // required fields when creating ("a missing field is no statement"); PATCH only what came
    for (const field of Object.keys(BODY)) {
      const { [field]: _dropped, ...without } = BODY;
      fourHundred(() => p(without), undefined);
    }
    assert.deepEqual(p({ name: "Fresh" }, { part: true }), { name: "Fresh" });
    fourHundred(() => p({ enabled: "yes" }, { part: true }));
    fourHundred(() => p({ defaultNew: 1 }, { part: true }));
    fourHundred(() => p({ ...BODY, name: "x".repeat(121) }));
  });
});

// ── (6) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(6) runs: watermark, only open rows change, abort at start and per agent (aborter spy), new rows and sessions", () => {
  withStore(() => {
    store.createWorkspace({ id: "W", name: "W", path: "/w/W", createdAt: 1 });
    const a = agent("W", { name: "A" });
    const b = agent("W", { name: "B" });
    const c = chat("W");
    const d = chat("W");
    const roles = ["user", "assistant"];
    const row = (role, text, ts) => { store.addMessage(c.id, role, text, ts); return store.messageStats(c.id).lastId; };
    const m1 = row("user", "Hello", 1000);
    row("tool", JSON.stringify({ id: "t1", name: "Bash" }), 1001);
    const m3 = row("assistant", "Response", 1002);
    const id = Number;
    assert.deepEqual(store.outerLoopNewRows(c.id, { fromId: 0, roles }), { count: 2, untilId: id(m3) });
    assert.deepEqual(store.outerLoopNewRows(c.id, { fromId: id(m1), roles }), { count: 1, untilId: id(m3) });
    assert.deepEqual(store.outerLoopNewRows(c.id, { fromId: 0, since: 1002, roles }), { count: 1, untilId: id(m3) }, "since takes effect");
    assert.deepEqual(store.outerLoopNewRows(c.id, { fromId: id(m3), roles }), { count: 0, untilId: id(m3) });
    assert.deepEqual(store.outerLoopChatsWithNew("W", a.id, roles), [c.id], "without a finished run: every row");

    const l1 = store.createOuterLoopRun({ id: "l1", agentId: a.id, chatId: c.id, trigger: "quiet", fromMessageId: 0, set: { cbase: ["cbase_chat_analysis"] }, startedAt: 2000 });
    assert.equal(l1.state, "running");
    assert.equal(store.outerLoopRunApplies("l1"), true);
    assert.equal(store.outerLoopRunningOn(a.id, c.id), true);
    assert.equal(store.outerLoopRunningCount(a.id), 1);
    assert.deepEqual(store.outerLoopRunsOpen().map((l) => l.id), ["l1"]);
    assert.equal(store.outerLoopRunState("l1", "parked", { parkedUntil: 9000 }).parkedUntil, 9000);
    assert.deepEqual(store.outerLoopRunsParked().map((l) => [l.id, l.parkedUntil, l.attempts]), [["l1", 9000, 1]]);
    assert.equal(store.outerLoopRunState("l1", "running", { increaseAttempts: true }).attempts, 2);
    assert.equal(store.outerLoopRunEnd("l1", { state: "finished", untilMessageId: id(m3), provider: "claude", model: "m", billing: "metered", input: 10, output: 5, cached: 2, cost: 0.5, sessionId: "sid-1", endedAt: 2100 }), true);
    assert.equal(store.outerLoopRunApplies("l1"), false, "finished no longer applies");
    assert.equal(store.outerLoopRunState("l1", "running"), null, "a finished run does not come back to life");
    assert.equal(store.outerLoopRunEnd("l1", { state: "error" }), false);
    assert.equal(store.outerLoopRun("l1").state, "finished");
    assert.equal(store.outerLoopLastFinishedRun(a.id, c.id).untilMessageId, id(m3));
    assert.deepEqual(store.outerLoopChatsWithNew("W", a.id, roles), [], "the watermark of the finished run");
    store.addMessage(c.id, "tool", JSON.stringify({ id: "t2" }), 1003);
    assert.deepEqual(store.outerLoopChatsWithNew("W", a.id, roles), [], "a tool row is nothing new");
    store.addMessage(c.id, "user", "Weiter", 1004);
    assert.deepEqual(store.outerLoopChatsWithNew("W", a.id, roles), [c.id]);
    assert.deepEqual(store.outerLoopChatsWithNew("W", b.id, roles), [c.id], "each agent has its own watermark");

    // Abort at start: running => aborted, parked stays.
    store.createOuterLoopRun({ id: "l2", agentId: a.id, chatId: d.id, trigger: "interval", startedAt: 3000 });
    store.createOuterLoopRun({ id: "l3", agentId: b.id, chatId: d.id, trigger: "clockTime", startedAt: 3001 });
    store.outerLoopRunState("l3", "parked", { parkedUntil: 5000 });
    assert.equal(store.abortOuterLoopRuns("restart"), 1);
    assert.equal(store.outerLoopRun("l2").state, "aborted");
    assert.equal(store.outerLoopRun("l2").error, "restart");
    assert.equal(store.outerLoopRun("l3").state, "parked");
    // Abort per agent: FIRST the rows (laeuft AND parked), THEN the aborter — with the ids.
    store.createOuterLoopRun({ id: "l4", agentId: b.id, chatId: c.id, trigger: "run_end", startedAt: 3002 });
    store.createOuterLoopRun({ id: "l5", agentId: a.id, chatId: c.id, trigger: "run_end", startedAt: 3003 });
    const seen = [];
    setOuterLoopAborter(({ agentIds }) => seen.push({ agentIds, states: ["l3", "l4", "l5"].map((x) => store.outerLoopRun(x).state) }));
    try {
      assert.deepEqual(abortOuterLoop({ agentIds: [b.id, b.id], reason: "agent deleted" }), { agentIds: [b.id], runs: 2 });
      assert.deepEqual(seen, [{ agentIds: [b.id], states: ["aborted", "aborted", "running"] }], "the aborter sees the rows already aborted; agent A stays");
      assert.equal(store.outerLoopRun("l4").error, "agent deleted");
      assert.deepEqual(abortOuterLoop({ agentIds: [] }), { agentIds: [], runs: 0 });
      assert.equal(seen.length, 1, "no call without agents");
    } finally { setOuterLoopAborter(null); }
    assert.deepEqual(abortOuterLoop({ agentIds: [a.id] }), { agentIds: [a.id], runs: 1 }, "without an aborter: only the rows");
    assert.equal(store.outerLoopRun("l5").state, "aborted");

    // paging and sum
    const page = store.outerLoopRunsOfAgent(a.id, { limit: 2 });
    assert.deepEqual(page.items.map((l) => l.id), ["l5", "l2"]);
    assert.equal(page.additional, true);
    assert.deepEqual(store.outerLoopRunsOfAgent(a.id, { limit: 2, after: page.items[1].id }).items.map((l) => l.id), ["l1"]);
    assert.equal(store.outerLoopRunsOfAgent(a.id, { after: "exists-not" }), null, "an unknown cursor is not an empty page");
    assert.equal(store.outerLoopRunsOfAgent(a.id, { after: "l4" }), null, "the run of another agent is no cursor");
    assert.deepEqual(store.outerLoopRunSum(a.id), { runs: 3, input: 10, output: 5, cached: 2, cost: 0.5 });
    assert.equal(store.outerLoopRunSum(b.id).cost, null, "without a price: unknown, not 0");

    // paging notes
    for (let i = 0; i < 3; i++) store.createOuterLoopNote({ agentId: a.id, chatId: c.id, runId: "l1", text: `N${i}`, at: 10 + i });
    store.createOuterLoopNote({ agentId: b.id, chatId: c.id, runId: "l4", text: "B", at: 20 });
    const n = store.outerLoopNotes(c.id, { agentId: a.id, limit: 2 });
    assert.deepEqual(n.items.map((x) => x.text), ["N2", "N1"]);
    assert.equal(n.additional, true);
    assert.deepEqual(store.outerLoopNotes(c.id, { agentId: a.id, before: n.items[1].id }).items.map((x) => x.text), ["N0"]);
    assert.deepEqual(store.outerLoopNotes(c.id).items.map((x) => x.text), ["B", "N2", "N1", "N0"]);
    assert.equal(store.outerLoopLastNote(a.id, c.id).text, "N2");

    // sessions per chat: runs on the chat and runs of chat-owned agents
    const own = agent("W", { name: "Own", chatId: d.id });
    store.createOuterLoopRun({ id: "l6", agentId: own.id, chatId: d.id, trigger: "quiet", startedAt: 4000 });
    store.outerLoopRunEnd("l6", { state: "finished", sessionId: "sid-6" });
    const s = store.outerLoopSessionsOf([c.id, d.id]);
    assert.deepEqual(s.get(c.id), ["sid-1"]);
    assert.deepEqual(s.get(d.id), ["sid-6"]);
    assert.deepEqual(store.outerLoopSessionsOf(null).get(c.id), ["sid-1"]);
    assert.deepEqual(store.outerLoopSessionsOf([]), new Map());
  });
});

// ── (6b) ───────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(6b) last starts per pair without a window, session at once, abort of exactly these runs", () => {
  withStore(() => {
    store.createWorkspace({ id: "W", name: "W", path: "/w/W", createdAt: 1 });
    const a = agent("W", { name: "A" });
    const old = chat("W");
    const loud = chat("W");
    // A chat behind the 500 newest runs counted as "never started" in the tick (interval and time of day due at once).
    store.createOuterLoopRun({ id: "old-u", agentId: a.id, chatId: old.id, trigger: "clockTime", startedAt: 1000 });
    store.createOuterLoopRun({ id: "old-i", agentId: a.id, chatId: old.id, trigger: "interval", startedAt: 1500 });
    storeDb.exec("BEGIN");
    try { for (let i = 0; i < 520; i++) store.createOuterLoopRun({ id: `loud-${i}`, agentId: a.id, chatId: loud.id, trigger: "interval", startedAt: 2000 + i }); }
    finally { storeDb.exec("COMMIT"); }
    const st = store.outerLoopLastStarts(a.id, [old.id, loud.id, "without"]);
    assert.deepEqual(st.get(old.id), { all: 1500, clock: 1000 }, "the old chat is started — also behind 520 newer runs");
    assert.deepEqual(st.get(loud.id), { all: 2519, clock: null });
    assert.equal(st.has("without"), false, "never started: no entry");
    assert.deepEqual(store.outerLoopLastStarts(a.id, []), new Map());

    // The session of an OPEN run is set at once (the first one wins); a finished one gets none any more.
    store.createOuterLoopRun({ id: "s1", agentId: a.id, chatId: old.id, trigger: "quiet", startedAt: 5000 });
    assert.equal(store.outerLoopRunSession("s1", "sid-a"), true);
    assert.equal(store.outerLoopRunSession("s1", "sid-b"), false, "the first one wins");
    assert.equal(store.outerLoopRun("s1").sessionId, "sid-a");
    assert.equal(store.outerLoopRunSession("old-u", "sid-x"), true, "old-u is still open (running)");
    store.outerLoopRunEnd("old-i", { state: "finished" });
    assert.equal(store.outerLoopRunSession("old-i", "sid-y"), false, "a finished run gets no session any more");

    // Abort of exactly these runs (project deleted): the aborter gets the run ids; other runs of the same agent stay.
    const seen = [];
    setOuterLoopAborter((o) => seen.push(o));
    try {
      assert.deepEqual(abortOuterLoop({ runIds: ["s1", "s1"], reason: "project deleted" }), { agentIds: [], runIds: ["s1"], runs: 1 });
      assert.deepEqual(seen, [{ agentIds: [], runIds: ["s1"] }]);
      assert.equal(store.outerLoopRun("s1").state, "aborted");
      assert.equal(store.outerLoopRun("s1").error, "project deleted");
      assert.equal(store.outerLoopRun("old-u").state, "running", "another run of the same agent stays");
      assert.deepEqual(store.outerLoopSessionsOf([old.id]).get(old.id).sort(), ["sid-a", "sid-x"], "the close path finds the sessions");
    } finally { setOuterLoopAborter(null); }
  });
});

// ── (7) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function seedAgentWithRows(ws, fields, chatId, tag) {
  const a = agent(ws, fields);
  store.createOuterLoopRun({ id: `l-${tag}`, agentId: a.id, chatId, trigger: "quiet", startedAt: 1 });
  store.createOuterLoopNote({ agentId: a.id, chatId, runId: `l-${tag}`, text: tag });
  store.setOuterLoopActive(a.id, chatId, true, 1);
  return a;
}
const rowsOf = (db, agentId) => ["outer_loop_runs", "outer_loop_notes", "outer_loop_active", "outer_loop_takeover"]
  .map((t) => db.prepare(`SELECT count(*) AS n FROM ${t} WHERE agent_id = ?`).get(agentId).n);

test("(7) deleting: chat (close path), project and workspace take runs, notes, activation along — a neighbor stays", () => {
  withStore((db) => {
    store.createWorkspace({ id: "W", name: "W", path: "/w/W", createdAt: 1 });
    store.createWorkspace({ id: "N", name: "Neighbor", path: "/w/N", createdAt: 1 });
    store.addProject("W", { id: "P", name: "P", path: "/w/W/p", createdAt: 1 });
    store.addProject("W", { id: "Q", name: "Q", path: "/w/W/q", createdAt: 1 });
    const c = chat("W"); const cq = chat("W", { projectId: "Q" }); const cn = chat("N");
    // Chat: the chat-owned agent with its rows, the rows of a workspace agent on this chat; everything stays on the neighbor chat.
    const own = seedAgentWithRows("W", { name: "Own", chatId: c.id }, c.id, "own");
    const wsA = seedAgentWithRows("W", { name: "Ws" }, c.id, "ws-c");
    store.createOuterLoopRun({ id: "l-ws-cq", agentId: wsA.id, chatId: cq.id, trigger: "quiet", startedAt: 1 });
    store.setOuterLoopTakeover(wsA.id, "Q", false);
    assert.deepEqual(store.deleteOuterLoopChat(c.id), { agents: 1, runs: 2, notes: 2, active: 2 });
    assert.equal(store.outerLoopAgent(own.id), null);
    assert.deepEqual(rowsOf(db, own.id), [0, 0, 0, 0]);
    assert.deepEqual(rowsOf(db, wsA.id), [1, 0, 0, 1], "the run on the other chat and the takeover stay");
    // Project: project agents with their rows, the takeover of workspace agents into this project; the sibling project stays.
    const projA = seedAgentWithRows("W", { name: "Proj", projectId: "P" }, cq.id, "proj");
    store.setOuterLoopTakeover(wsA.id, "P", false);
    assert.equal(store.deleteProject("W", "P"), true);
    assert.equal(store.outerLoopAgent(projA.id), null);
    assert.deepEqual(rowsOf(db, projA.id), [0, 0, 0, 0]);
    assert.deepEqual(store.outerLoopNotTakenOver(wsA.id), ["Q"], "the takeover in P is gone, the one in Q stays");
    // Workspace: everything; the neighbor workspace stays.
    const nb = seedAgentWithRows("N", { name: "NB" }, cn.id, "nb");
    const z = seedSummarizer("W");
    store.createOuterLoopNote({ agentId: z.id, chatId: cq.id, runId: "x", text: "Zusammenfassung" });
    store.deleteWorkspace("W");
    assert.deepEqual(store.outerLoopAgentsOf("W"), []);
    for (const t of ["outer_loop_runs", "outer_loop_notes", "outer_loop_active", "outer_loop_takeover"]) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${t} WHERE agent_id <> ?`).get(nb.id).n, 0, `${t}: only the neighbor stays`);
    }
    assert.deepEqual(rowsOf(db, nb.id), [1, 1, 1, 0]);
    assert.ok(store.outerLoopAgent(nb.id));
  });
});

// ── (8) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(8) the real delete routes: project and workspace abort running runs of their agents before the rows fall", async () => {
  await withAgentsServer(async (ctx) => {
    const seen = [];
    setOuterLoopAborter(({ agentIds }) => seen.push({ agentIds, states: agentIds.flatMap((aid) => store.outerLoopRunsOfAgent(aid).items.map((l) => l.state)) }));
    try {
      const filePath = path.join(ctx.root, "project-a");
      fs.mkdirSync(filePath, { recursive: true });
      const pr = await request(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ path: filePath, name: "A" }) });
      assert.ok(pr.status < 400, JSON.stringify(pr.body));
      const projA = agent(ctx.ws.id, { name: "Proj", projectId: pr.body.id });
      const wsA = agent(ctx.ws.id, { name: "Ws" });
      store.createOuterLoopRun({ id: "lp", agentId: projA.id, chatId: ctx.chat.id, trigger: "quiet" });
      store.createOuterLoopRun({ id: "lw", agentId: wsA.id, chatId: ctx.chat.id, trigger: "quiet" });
      const r = await request(`${ctx.base}/api/projects/${pr.body.id}`, { method: "DELETE" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(seen, [{ agentIds: [projA.id], states: ["aborted"] }], "project: only its agent, the row already aborted");
      assert.equal(store.outerLoopAgent(projA.id), null);
      assert.equal(store.outerLoopRun("lw").state, "running", "the workspace agent keeps running");
      // The running run counts as background work in B — here without a core; the route does not check it (no 409).
      const w = await request(`${ctx.base}/api/workspaces/${ctx.ws.id}`, { method: "DELETE" });
      assert.equal(w.status, 200, JSON.stringify(w.body));
      assert.equal(seen.length, 2);
      assert.deepEqual([...seen[1].agentIds].sort(), [ctx.ws.id, `${ctx.ws.id}-a9e0da`, `${ctx.ws.id}-71e11e`, wsA.id].sort(), "workspace: all its agents, summarizer, agenda keeper and timeline included");
      assert.deepEqual(seen[1].states, ["aborted"]);
      assert.equal(store.outerLoopRun("lw"), null, "afterwards the row fell with the workspace");
    } finally { setOuterLoopAborter(null); }
  });
});

// ── (9) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(9) cost: ONE computation with the tick of the amounts — per 1M tokens, reported before estimated, subscription and without price null", () => {
  // Catalog prices in USD per token (providers/openrouter-catalog.js): $2 / $10 per million, cache read $0.1 per million.
  const prices = { prompt: 2e-6, completion: 1e-5, cacheRead: 1e-7, cacheWrite: null };
  assert.equal(costFor({ model: "m1", input: 1_000_000, output: 500_000, prices }), 7);
  assert.equal(costFor({ model: "m1", input: 1_000_000, output: 500_000, reported: 0.25, prices }), 0.25, "reported comes first");
  assert.equal(costFor({ model: "m1", input: 1_000_000, output: 0, billing: "subscription", prices }), null);
  assert.equal(costFor({ model: "without", input: 1, output: 1, prices: null }), null);
  // Cache: `input` IN FULL (engine contract) — the read part at the read price. The tick of the amounts (account/openrouter-inquiry.js)
  // computes a row without an amount with the same function from the row's parts (fresh, read, write) — the same number.

  const run = costFor({ model: "m1", input: 1_000_000, output: 0, cached: 400_000, prices });
  assert.ok(Math.abs(run - (600_000 * 2e-6 + 400_000 * 1e-7)) < 1e-9, String(run));
  assert.equal(estimatedCost({ input: 600_000, output: 0, cacheRead: 400_000, cacheWrite: 0 }, prices), run);
});

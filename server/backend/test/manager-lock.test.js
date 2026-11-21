// The lock of the kind "manager": a manager chat (only in a store from before the removal of Managing) is permanently read-only
// (runs/manager-lock.js). This file holds EVERY path, each with a counter-test on a coding chat (or coding folder, coding channel,
// coding skill) that takes the SAME path in the same server and gets through — without it "the manager chat did not run" would
// prove nothing.
//
//   (1) Routes: every write and start route of a manager chat is 409 `{ error, managerLocked: true }` — message, answer to a
//       question, control, fork, "try now", compact, clear, rename, workflow, archive, delete, folder; nothing written. Reading
//       and the emergency valves (stop) stay. Folders of the kind manager and folders with a manager chat (legacy) likewise;
//       manager skills (PUT, DELETE, revert).
//   (2) Start paths without a route: machine delivery (deliverUserPrompt), the inherited queue (runInputsRestartGrace →
//       takeNextRunInput), the restart (resumeInterruptedWork), the wait row (fireAutoContinue), doRun directly — no turn, and
//       unlike a read-only chat (runs/only-readable.js) every row STAYS (queue, active_runs, wait row). Plus the start migrations that write chats (chatsWithoutLevel,
//       modelMigrationCandidates, migrateRoleLevelsLater), the auto-archive and the outer loop. And the follow-up start of dynamic
//       workflows and graph starts: HERE a run of a manager chat is given up or discarded instead of continued — one write exactly
//       once, afterwards the fingerprint stands.
//   (3) Frozen channels (channels/freeze.js): a channel with a manager participant accepts no message, delivers nothing (not in the
//       follow-up start either), changes no status, writes no system note, counts no human involvement and stays when its coding
//       participant is deleted; a NEW channel with a manager chat is 409.
//   (4) Lists: a manager chat — a special chat too — stays unarchived in the DB and appears in NO list of the clients
//       and agents: not in the chat list (every archive page), not in the overview and the search of cbase_agents_list; the view
//       "chat" is 403. A coding chat as control. (The dock of the app agents — /api/agent-chats — is gone; the route is 404.)
//   (5) The follow-up start of the subagents (runs/agents.js reportOrphaned): a subagent of a manager chat STAYS — a parked one is
//       not adopted into a core without a turn, a running one is not orphaned, no hint; its rows in `subagents` and `chat_hints`
//       are byte-equal, and the idle gate (/api/runs/active `agents`) does not count it. A coding chat as control: its parked one
//       is adopted (lives, is in the gate), its running one is orphaned with a hint.
//   (6) The restart of a PARKED chat and the workflow runs (runs/resume.js): for a manager chat with active_runs AND run wait row no
//       row falls and no wait row advances; its workflow run is not driven (stays `running`, even without a workflow). The
//       controls: a coding chat with the same rows (active_runs gone, wait row made due, the continuation runs) and one with a run
//       without workflow (driven ⇒ `failed`).
//
// COUNTER-TESTS (each sabotage changes one place in the server, run the section): the lock line in chats/routes.js chatRoutes ⇒
// (1) red (/message 202); the check in
// queue.js deliverUserPrompt ⇒ (2) red; the quiet line in runs/routes.js openWork ⇒ (2) hangs (quiet — open queue 1); the line in
// channels/delivery.js deliverChannel ⇒ (3) red (true); the one in setChannelStatus ⇒ (3) red (no throw); the line in
// dynworkflows/run.js dynWorkflowsRestartGrace ⇒ (2) red at (k), the one in workflows/graph-start.js ⇒ (2) red at (l);
// store/chats.js listAgentChats with the old filter `kind != 'normal'` ⇒ (4) red; both `managerLocked` lines in runs/agents.js ⇒
// (5) red (the parked manager subagent was in `agents`, the rows deviated); one of the two `managerLocked` lines in the filters of
// resumeInterruptedWork each ⇒ (6) red (the active_runs row of the manager chat was gone, or its workflow run `failed`).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { skillCreate } from "../electron/server/toolchain/skill-change.js";
import { db as rawDb } from "../electron/server/store/db.js";
import { fireAutoContinue, runInputsRestartGrace } from "../electron/server/runs/auto-continue.js";
import { doRun } from "../electron/server/runs/do-run.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { resumeInterruptedWork } from "../electron/server/runs/resume.js";
import { pendingRunInputs, persistRunInputs, running } from "../electron/server/runs/state.js";
import { ROLES_AFTER_MARKER, migrateRoleLevelsLater } from "../electron/server/chats/auto-gone.js";
import { areaMatches } from "../electron/server/outerloop/activation.js";
import { channelHumanInvolved, channelRestartGrace, setChannelStatus, channelSystemNote, deliverChannel } from "../electron/server/channels/delivery.js";
import { channelFrozen } from "../electron/server/channels/freeze.js";
import { dynWorkflowsRestartGrace } from "../electron/server/dynworkflows/run.js";
import { newRunId, newTaskId } from "../electron/server/dynworkflows/journal.js";
import { graphStartsRestartGrace } from "../electron/server/workflows/graph-start.js";
import { stopBackgroundAgents, reportOrphaned } from "../electron/server/runs/agents.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";

// The fake CLI records per run what it got (text, resumed session) — counting goes via these files.
const claude = fakeClaude({
  main: `
  fs.writeFileSync(path.join(LOCATION, "ran-" + process.pid + ".json"), JSON.stringify({ resume: arg("--resume"), text }));
  finished();
  say({ type: "result", result: "ran", session_id: "s-control" });`,
});
// The wording of the lock (runs/manager-lock.js) — this file runs with the default language German.
const LOCK = { error: "Managing ist abgebaut — dieser Chat ist nur noch lesbar.", managerLocked: true };
const runs = (root) => fs.readdirSync(root).filter((f) => /^ran-\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8")));

const raw = async (url, init) => {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init?.headers || {}) } });
  let body = null;
  try { body = await r.json(); } catch { /* no JSON */ }
  return { status: r.status, body };
};

// A manager chat as an old user DB carries it — around the store (no route accepts one that runs any more). With a
// CLI session so that "the old session started" is measurable.
function managerChat(ws, { title = "Job till", specialRole = "" } = {}) {
  const now = Date.now();
  const c = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, title, kind: "manager", createdAt: now, updatedAt: now });
  store.updateChat(c.id, { claudeSessionId: "s-old-manager", ...(specialRole ? { specialRole } : {}) });
  return store.getChat(c.id);
}
const codingChat = async (ctx, title) => {
  const c = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.ws.id, provider: "claude", model: "claude-haiku-4-5-20251001" }) });
  await json(`${ctx.base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  return store.getChat(c.id);
};

test("(1) routes: a manager chat accepts only reading and stop (every write and start route 409 with marker, nothing written); manager folders and manager skills likewise — each with a counter-test", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, root } = ctx;
    const m = managerChat(ws);
    store.addMessage(m.id, "assistant", "Old state of the till");
    store.addMessage(m.id, "ask", JSON.stringify({ requestId: "r-old", questions: [{ header: "Plan", question: "A or B?", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] }));
    const cf = await json(`${base}/api/chat-folders`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, name: "Coding", kind: "normal" }) });
    const chatsPrior = rawDb.prepare("SELECT COUNT(*) AS n FROM chats").get().n;
    const logPrior = store.listMessages(m.id).map((r) => [r.role, r.text]);
    const requests = [
      ["POST", "/message", { text: "further" }],
      ["POST", "/ask-answer", { requestId: "r-old", answers: [{ selected: ["A"], text: "" }] }],
      ["POST", "/control", {}],
      ["POST", "/fork", {}],
      ["POST", "/auto-continue/now", {}],
      ["POST", "/compact", {}],
      ["POST", "/clear", {}],
      ["PATCH", "", { title: "Renamed" }],
      ["PATCH", "", { folderId: cf.id }],
      ["POST", "/workflow", { workflowId: "wf-x" }],
      ["PUT", "/archive", { archived: true }],
      ["DELETE", "", null],
    ];
    for (const [method, sub, body] of requests) {
      const r = await raw(`${base}/api/chats/${m.id}${sub}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(r.status, 409, `${method} ${sub || "/"} ⇒ 409 (war ${r.status} ${JSON.stringify(r.body)})`);
      assert.deepEqual(r.body, LOCK, `${method} ${sub || "/"}: wording and marker`);
    }
    const afterwards = store.getChat(m.id);
    assert.ok(afterwards, "the manager chat still exists");
    assert.deepEqual([afterwards.title, afterwards.folderId, afterwards.archivedAt, afterwards.claudeSessionId], ["Job till", null, null, "s-old-manager"], "nothing changed on the chat");
    assert.deepEqual(store.listMessages(m.id).map((r) => [r.role, r.text]), logPrior, "nothing written to the history");
    assert.equal(rawDb.prepare("SELECT COUNT(*) AS n FROM chats").get().n, chatsPrior, "no fork created");
    assert.equal(running.has(m.id), false, "no run");
    // Reading and the emergency valves stay.
    assert.equal((await raw(`${base}/api/chats/${m.id}`)).status, 200, "GET");
    assert.equal((await raw(`${base}/api/chats/${m.id}/log`)).status, 200, "GET …/log");
    assert.notEqual((await raw(`${base}/api/chats/${m.id}/stop`, { method: "POST", body: "{}" })).status, 409, "POST …/stop stays open");
    assert.notEqual((await raw(`${base}/api/chats/${m.id}/dyn-workflows/runs/x/stop`, { method: "POST", body: "{}" })).status, 409, "stop of a dyn. workflow");
    // Counter-test in the same server: the same PATCH and the same message to a coding chat go through and run.
    assert.equal((await raw(`${base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Control" }) })).status, 200);
    assert.equal((await raw(`${base}/api/chats/${ctx.chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "further" }) })).status, 202);
    await ctx.waitForQuiet();
    const run = runs(root);
    assert.equal(run.length, 1, "exactly one run — the control's");
    assert.notEqual(run[0].resume, "s-old-manager", "the session of the manager chat did not start");

    // Folders: one of the kind manager and a coding folder with a manager chat in it (legacy) — every writing path 409; a coding
    // folder without a manager chat takes the same path (counter-test).
    const mf = store.createChatFolder({ id: crypto.randomUUID(), workspaceId: ws.id, name: "Schedule", kind: "manager", createdAt: Date.now(), updatedAt: Date.now() });
    const mixed = await json(`${base}/api/chat-folders`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, name: "Mixed", kind: "normal" }) });
    const m2 = managerChat(ws, { title: "In the coding folder" });
    store.updateChat(m2.id, { folderId: mixed.id });
    for (const f of [mf, mixed]) {
      for (const [method, sub, body] of [["PATCH", "", { name: "Fresh" }], ["PUT", "/archive", { archived: true }], ["DELETE", "", null], ["DELETE", "?permanently=1", null]]) {
        const r = await raw(`${base}/api/chat-folders/${f.id}${sub}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
        assert.deepEqual([r.status, r.body], [409, LOCK], `folder ${f.name}: ${method} ${sub || "/"}`);
      }
      assert.equal((await raw(`${base}/api/chat-folders/${f.id}/archive`)).status, 200, `folder ${f.name}: reading stays`);
      assert.deepEqual([store.getChatFolder(f.id)?.name, store.getChatFolder(f.id)?.archivedAt], [f.name, null], `folder ${f.name}: nothing changed`);
    }
    assert.equal(store.getChat(m2.id).folderId, mixed.id, "the manager chat stays in its folder");
    assert.equal((await raw(`${base}/api/chat-folders/${cf.id}`, { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) })).status, 200, "counter-test: coding folder");
    assert.equal(store.getChatFolder(cf.id).name, "Renamed");

    // Manager skills: change, delete and reverting their history 409 — a coding skill takes the same path.
    const skill = async (name, area) => (area === "managing"
      ? skillCreate({ workspaceId: ws.id, name, area, description: "x", body: "y" }, { who: "human" }).skill
      : json(`${base}/api/workspaces/${ws.id}/skills`, { method: "POST", body: JSON.stringify({ name, area, description: "x", body: "y" }) }));
    const ms = await skill("situation-lock", "managing");
    const cs = await skill("grill-lock", "coding");
    for (const [method, body] of [["PUT", { description: "fresh", body: "fresh" }], ["DELETE", null]]) {
      const r = await raw(`${base}/api/workspaces/${ws.id}/skills/${ms.id}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.deepEqual([r.status, r.body], [409, LOCK], `manager skill: ${method}`);
    }
    assert.equal(store.getSkill(ms.id)?.body, "y", "the manager skill is unchanged");
    const entry = store.skillHistoryList(ws.id, { skillId: ms.id })[0];
    assert.ok(entry, "precondition: the creation is in the history");
    const z = await raw(`${base}/api/skill-history/${entry.id}/revert`, { method: "POST", body: "{}" });
    assert.deepEqual([z.status, z.body], [409, LOCK], "manager skill: revert");
    assert.ok(store.getSkill(ms.id), "the manager skill still exists");
    assert.equal((await raw(`${base}/api/workspaces/${ws.id}/skills/${cs.id}`, { method: "PUT", body: JSON.stringify({ description: "fresh", body: "fresh" }) })).status, 200, "counter-test: coding skill PUT");
    assert.equal((await raw(`${base}/api/workspaces/${ws.id}/skills/${cs.id}`, { method: "DELETE" })).status, 200, "counter-test: coding skill DELETE");

  }, { claude });
});

// Sabotages (2): the check in queue.js deliverUserPrompt ⇒ (a) red (`ok: true`, user row); in takeNextRunInput ⇒ (b) red (two chats
// started); in resume.js ⇒ (c) red (resumption written); in auto-continue.js ⇒ (d) red (`ok: true`); in do-run.js ⇒ (e) red (the
// chat is in `running`); `AND kind <> 'manager'` in store chatsWithoutLevel ⇒ (f) red; in the model migration ⇒ (g) red; (h) has
// no write path any more — `migrateRoleLevelsLater` sets only the marker —, the check holds that it stays so;
// `c.kind IN ('normal', 'manager')` in the auto-archive SQL ⇒ (i) red.
// The quiet state (/api/runs/active `quiet`, runs/routes.js openWork) does not count the manager chat's standing queue — otherwise
// it would never be quiet again: the line `if (managerLocked(…)) continue;` there removed ⇒ (b) hangs at "quiet — open queue 1".
test("(2) start paths without a route: no turn of a manager chat (delivery, queue, restart, wait row, doRun), its rows stay; the migrations, the auto-archive and the outer loop leave it out — each with a coding chat as control", async () => {
  await withAgentsServer(async (ctx) => {
    const { ws, root } = ctx;
    const control = ctx.chat;
    const m = managerChat(ws);
    store.addMessage(m.id, "assistant", "Old state");
    const mLog = () => store.listMessages(m.id).map((r) => [r.role, r.text]);
    const logPrior = mLog();
    const untouched = (way) => {
      assert.equal(running.has(m.id), false, `${way}: the manager chat is in running — a turn began`);
      assert.deepEqual(mLog(), logPrior, `${way}: written to the manager chat's history`);
      assert.equal(store.getChat(m.id).claudeSessionId, "s-old-manager", `${way}: session touched`);
    };
    let controlRuns = 0;
    const controlRan = async (way, text) => {
      assert.equal(running.has(control.id), true, `${way}: the control did NOT start — the path is not the one the test means`);
      await ctx.waitForQuiet();
      controlRuns += 1;
      const run = runs(root);
      assert.equal(run.length, controlRuns, `${way}: only the control ran`);
      assert.equal(run.some((l) => l.text.includes(text)), true, `${way}: the control's run carries its text`);
      assert.equal(run.some((l) => l.resume === "s-old-manager"), false, `${way}: the manager chat's session started`);
    };

    // (a) Machine delivery (channel, wake-up call, schedule, copy …): nothing written, nothing queued, no turn.
    const delivery = deliverUserPrompt(m, { prompt: "Wake-up a", display: "Wake-up a", cause: "event" });
    assert.deepEqual(delivery, { ok: false, queued: false, injected: false, onlyReadable: true, managerLocked: true, error: LOCK.error });
    assert.equal(pendingRunInputs.has(m.id), false, "(a) nothing queued");
    deliverUserPrompt(control, { prompt: "Wake-up a", display: "Wake-up a", cause: "event" });
    untouched("(a) Delivery");
    await controlRan("(a) Delivery", "Wake-up a");

    // (b) The inherited queue after the restart: the manager chat does not start, its queue stays (memory AND row).
    const entry = (text) => ({ id: crypto.randomUUID(), prompt: text, display: text, attachments: [], cause: "user", causeSpecified: "user", silent: false });
    for (const c of [m, control]) { pendingRunInputs.set(c.id, [entry("Queue b")]); persistRunInputs(c.id); }
    assert.equal(runInputsRestartGrace(), 1, "(b) exactly ONE chat started from the queue — the control");
    await new Promise((r) => queueMicrotask(r)); // the follow-up start runs in the microtask
    untouched("(b) Queue");
    assert.equal(pendingRunInputs.get(m.id)?.length, 1, "(b) the manager chat's queue stays in memory");
    assert.equal(store.listRunInputs().filter((q) => q.chatId === m.id).length, 1, "(b) and in run_inputs");
    await controlRan("(b) Queue", "Queue b");

    // (c) The restart (active_runs): the control starts again, the manager chat does not — and its row stays.
    const now = Date.now();
    for (const c of [m, control]) store.setActiveRun(c.id, { kind: "chat", prompt: "Restart c", startedAt: now });
    resumeInterruptedWork();
    untouched("(c) Resumption");
    assert.equal(store.listActiveRuns().some((r) => r.chatId === m.id), true, "(c) the manager chat's active_runs row stays");
    await controlRan("(c) Resumption", "Restart c");

    // (d) The wait row at the limit: neither started nor discarded.
    for (const c of [m, control]) store.setPendingResume(c.id, { kind: "run", prompt: "Wait row d", dueAt: Date.now() });
    assert.deepEqual(await fireAutoContinue(m.id, { manual: true }), { ok: false, reason: "manager-locked" }, "(d) Manager-Chat");
    assert.ok(store.getPendingResume(m.id), "(d) the manager chat's wait row stays");
    assert.deepEqual(await fireAutoContinue(control.id, { manual: true }), { ok: true }, "(d) Control");
    untouched("(d) WaitRow");
    await controlRan("(d) WaitRow", "Wait row d");

    // (e) doRun directly — the catcher for workflow drivers, goal gate and every future path.
    const direct = doRun(m, "Direct e");
    const controlRun = doRun(store.getChat(control.id), "Direct e");
    untouched("(e) doRun");
    assert.equal(await direct, undefined);
    await controlRan("(e) doRun", "Direct e");
    await controlRun;

    // (f) The level migration reads no manager chat (chatsWithoutLevel), (g) the model migration likewise.
    rawDb.prepare("UPDATE chats SET effort = '', model = 'model-old-teardown' WHERE id IN (?, ?)").run(m.id, control.id);
    const withoutLevel = store.chatsWithoutLevel().map((c) => c.id);
    assert.deepEqual([withoutLevel.includes(control.id), withoutLevel.includes(m.id)], [true, false], "(f) chatsWithoutLevel");
    const candidates = store.modelMigrationCandidates("model-old-teardown").chats.map((c) => c.id);
    assert.deepEqual([candidates.includes(control.id), candidates.includes(m.id)], [true, false], "(g) Model-Migration");
    // (h) The later migration of the role levels writes no manager chat — it sets only its marker.
    store.setSetting(ROLES_AFTER_MARKER, "");
    migrateRoleLevelsLater();
    assert.equal(rawDb.prepare("SELECT effort FROM chats WHERE id = ?").get(m.id).effort, "", "(h) the manager chat's level stays empty");
    assert.ok(store.getSetting(ROLES_AFTER_MARKER, ""), "(h) the marker is set — the migration ran");
    rawDb.prepare("UPDATE chats SET effort = 'high', model = 'claude-haiku-4-5-20251001' WHERE id = ?").run(control.id);

    // (i) The auto-archive takes only coding chats; (j) the outer loop never matches a manager chat.
    const candidate = store.autoArchiveCandidates(Date.now() + 365 * 86_400_000).map((c) => c.id);
    assert.deepEqual([candidate.includes(control.id), candidate.includes(m.id)], [true, false], "(i) Auto-Archive");
    assert.deepEqual([areaMatches({ area: "coding" }, store.getChat(control.id)), areaMatches({ area: "coding" }, m)], [true, false], "(j) Outer Loop");

    // (k) The follow-up start of dynamic workflows: the run of a manager chat is given up, not continued — its agents ran via the
    // own core past doRun. The control is adopted (without a script file its continuation then throws: an error line in ITS
    // history, interrupted again — the path is the same).
    const dynRun = (chat) => {
      const runId = newRunId();
      store.createDynRun({ runId, taskId: newTaskId(), chatId: chat.id, name: "teardown-k", meta: {}, scriptPath: path.join(root, "missing", "script.js"), outputPath: path.join(root, `${runId}.json`) });
      assert.equal(store.endDynRun(runId, { status: "interrupted", ordered: true }), true);
      return runId;
    };
    const dynM = dynRun(m);
    const dynK = dynRun(control);
    try {
      dynWorkflowsRestartGrace();
      assert.deepEqual([store.readDynRun(dynM).status, store.readDynRun(dynM).error], ["failed", LOCK.error], "(k) the manager chat's run is abandoned");
      assert.equal(store.readDynRun(dynK).status, "running", "(k) the control was adopted — the path is the one the test means");
      await waitForTruthy(() => store.listMessages(control.id).some((x) => x.role === "hint" && x.text.includes(dynK)), "(k) error line of the control");
      untouched("(k) dyn. follow-up start");
    } finally {
      store.endDynRun(dynK, { status: "failed", error: "Test end" });
      store.abandonDynRun(dynK, "Test end");
    }

    // (l) The graph follow-up start: an earmarked start of a manager orchestrator is discarded — with the lock's wording, before
    // anything is looked up. The control gets further (up to the check whether the workflow exists). A SECOND manager chat: the
    // first one has carried a wait row since (d) — parked counts as running, the follow-up start would leave its start standing.
    const m2 = managerChat(ws, { title: "Job warehouse" });
    const earmark = (chat) => store.createGraphStart({ id: crypto.randomUUID(), chatId: chat.id, workflowId: "wf-teardown-missing", workflowName: "Missing", shortName: "missing", status: "earmarked" }).id;
    const gM = earmark(m2);
    const gK = earmark(control);
    graphStartsRestartGrace();
    assert.deepEqual([store.graphStart(gM).status, store.graphStart(gM).reason], ["dismissed", LOCK.error], "(l) the manager orchestrator's start is dismissed");
    assert.equal(store.graphStart(gK).status, "dismissed", "(l) the control was redeemed");
    assert.match(store.graphStart(gK).reason, /Missing/, "(l) the control got past the lock up to the workflow check");
    untouched("(l) Graph-RestartGrace");
    assert.deepEqual([running.has(m2.id), store.listMessages(m2.id).length], [false, 0], "(l) the second manager chat: no turn, no history");
  }, { claude });
});

// Sabotages (3): `if (channelFrozen(channel.id)) throw …` in the channel send path ⇒ red at "message" (the route has a line of
// its own before it — both removed ⇒ 201); the line in channels/delivery.js deliverChannel ⇒ red (true); in setChannelStatus ⇒
// red (no throw); in channelHumanInvolved ⇒ red (counter 0); in channels/lifecycle.js the channel creation ⇒ red at "new channel
// with manager chat" (201). The line in the participant-deleted path removed ALONE stays green: then setChannelStatus throws on
// closing and the catch there swallows it — it is the duplication that saves the log entry.
test("(3) frozen channels: a channel with a manager participant accepts nothing, delivers nothing, changes no status, counts no involvement and stays when its coding participant is deleted; a new one with a manager chat is 409 — a coding channel takes every path", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, root } = ctx;
    const m = managerChat(ws);
    const c1 = await codingChat(ctx, "Rebuild till");
    const c2 = await codingChat(ctx, "Warehouse A");
    const c3 = await codingChat(ctx, "Warehouse B");
    // The legacy: an open channel manager ↔ coding with a message the coding chat does not have yet (cursor 0).
    const old = store.createChannel({ id: crypto.randomUUID(), workspaceId: ws.id, name: "Till-rebuild", creatorChatId: m.id });
    store.addChannelParticipants(old.id, { chatId: m.id });
    store.addChannelParticipants(old.id, { chatId: c1.id });
    store.addChannelMessage({ channelId: old.id, senderChatId: m.id, text: "Please rebuild the till." });
    store.updateChannel(old.id, { agentsSinceHuman: 3 });
    const snapshot = () => { const k = store.getChannel(old.id); return [k.status, k.lastSeq, k.agentsSinceHuman, k.pauseReason]; };
    const prior = snapshot();
    assert.equal(channelFrozen(old.id), true);
    // The counter-test: a channel between two coding chats, via the route.
    const free = await json(`${base}/api/workspaces/${ws.id}/channels`, { method: "POST", body: JSON.stringify({ name: "Warehouse", participants: [c2.id, c3.id] }) });
    assert.equal(channelFrozen(free.id), false);

    // Creating with a manager chat: 409, no channel.
    const count = () => store.listChannels(ws.id).length;
    const n = count();
    const fresh = await raw(`${base}/api/workspaces/${ws.id}/channels`, { method: "POST", body: JSON.stringify({ name: "Fresh", participants: [m.id, c2.id] }) });
    assert.deepEqual([fresh.status, fresh.body], [409, LOCK], "new channel with manager chat");
    assert.equal(count(), n, "no channel created");

    // Every writing route on the frozen channel 409; reading stays.
    for (const [method, sub, body] of [
      ["POST", "/messages", { chatId: c1.id, text: "Done?" }], ["PATCH", "", { name: "Renamed" }], ["POST", "/pause", {}],
      ["POST", "/resume", {}], ["POST", "/close", {}], ["POST", "/open", {}], ["POST", "/read", { seq: 1 }],
    ]) {
      const r = await raw(`${base}/api/channels/${old.id}${sub}`, { method, body: JSON.stringify(body) });
      assert.deepEqual([r.status, r.body], [409, LOCK], `${method} ${sub || "/"}`);
    }
    assert.equal((await raw(`${base}/api/channels/${old.id}`)).status, 200, "GET stays");
    assert.deepEqual(snapshot(), prior, "nothing changed on the channel");
    assert.equal(store.getChannel(old.id).name, "Till-rebuild");

    // Delivery, follow-up start, status change, system note, human involvement — at the functions.
    assert.equal(deliverChannel(old.id, c1.id), false, "deliverChannel");
    channelRestartGrace();
    assert.equal(running.has(c1.id), false, "the follow-up start starts no turn from the frozen channel");
    assert.throws(() => setChannelStatus(store.getChannel(old.id), "paused"), (e) => e.managerLocked === true && e.status === 409);
    assert.throws(() => channelSystemNote(store.getChannel(old.id), "pause", "x"), (e) => e.managerLocked === true);
    channelHumanInvolved(c1.id);
    assert.deepEqual(snapshot(), prior, "no system note, no counter reset");
    assert.equal(store.getChannelParticipants(old.id, c1.id).cursor, 0, "the coding chat's cursor stands");
    // Counter-test: in the coding channel the involvement resets the counter, and a message delivers (a turn runs).
    store.updateChannel(free.id, { agentsSinceHuman: 3 });
    channelHumanInvolved(c2.id);
    assert.equal(store.getChannel(free.id).agentsSinceHuman, 0, "counter-test: involvement counts in the coding channel");
    assert.equal((await raw(`${base}/api/channels/${free.id}/messages`, { method: "POST", body: JSON.stringify({ chatId: c2.id, text: "Count warehouse." }) })).status, 201);
    await ctx.waitForQuiet();
    assert.equal(runs(root).some((l) => l.text.includes("Count warehouse.")), true, "counter-test: delivered, a turn ran");
    assert.equal(runs(root).length, 1, "and only this one");

    // Delete the coding participant: the frozen channel stays as it is; the coding channel closes.
    const messagesPrior = store.listChannelMessages(old.id).length;
    assert.equal((await raw(`${base}/api/chats/${c1.id}`, { method: "DELETE" })).status, 200);
    assert.equal(store.getChannel(old.id).status, "open", "the frozen channel stays open");
    assert.equal(store.listChannelMessages(old.id).length, messagesPrior, "no system note");
    assert.equal((await raw(`${base}/api/chats/${c3.id}`, { method: "DELETE" })).status, 200);
    assert.equal(store.getChannel(free.id).status, "closed", "counter-test: the coding channel closes");
  }, { claude });
});

test("(4) lists: a manager chat (a special chat too) is in no list — chat list, overview and search of the agents; the view \"chat\" is 403", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws } = ctx;
    const m = managerChat(ws, { title: "Till manager" });
    const v = managerChat(ws, { title: "Till administrator", specialRole: "administrator" });
    for (const c of [m, v]) store.addMessage(c.id, "user", "Check till");
    // The controls: two coding chats (reader and target) with the same message.
    const reader = await codingChat(ctx, "Reader");
    const target = await codingChat(ctx, "Till coding");
    for (const c of [reader, target]) store.addMessage(c.id, "user", "Check till");

    assert.equal((await raw(`${base}/api/agent-chats`)).status, 404, "the dock of the app agents is gone");

    for (const archive of ["without", "only", "including"]) {
      const list = (await json(`${base}/api/chats?workspaceId=${ws.id}&archive=${archive}`)).map((c) => c.id);
      if (archive !== "only") assert.ok(list.includes(target.id), `control: the coding chat is in the list (${archive})`);
      for (const c of [m, v]) assert.ok(!list.includes(c.id), `${c.title} not in the chat list (${archive})`);
    }

    const read = (q) => raw(`${base}/api/chats/${reader.id}/communication?${new URLSearchParams(q)}`);
    const summary = await read({ view: "summary" });
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    const ids = summary.body.chats.map((c) => c.id);
    assert.ok(ids.includes(target.id), "control: the coding chat is in the overview");
    for (const c of [m, v]) assert.ok(!ids.includes(c.id), `${c.title} not in the overview`);
    const search = await read({ view: "chats", search: "till" });
    assert.equal(search.status, 200, JSON.stringify(search.body));
    const hits = search.body.chats.map((c) => c.id);
    assert.ok(hits.includes(target.id), "control: the search finds the coding chat");
    for (const c of [m, v]) assert.ok(!hits.includes(c.id), `${c.title} not in the search`);
    for (const c of [m, v]) assert.equal((await read({ view: "chat", chatId: c.id })).status, 403, `${c.title}: view "chat"`);
  }, { claude });
});

test("(5) follow-up start of the subagents: the subagent of a manager chat stays (not adopted, not orphaned, no hint, not in the idle gate) — that of a coding chat is adopted or orphaned", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, root } = ctx;
    const control = ctx.chat;
    const m = managerChat(ws);
    const now = Date.now();
    const image = (agentId, state) => ({
      agentId, name: agentId, description: agentId, provider: "claude", model: "claude-haiku-4-5-20251001", sessionId: `s-${agentId}`, state,
      status: state === "parked" ? "parked" : "running", startedAt: now, cwd: root, ...(state === "parked" ? { parkedUntil: now + 3_600_000 } : {}),
    });
    for (const [c, k] of [[m, "m"], [control, "k"]]) {
      store.rememberSubagent(c.id, image(`parked-${k}`, "parked"));
      store.rememberSubagent(c.id, image(`running-${k}`, "running"));
    }
    const rows = (chatId) => ({
      subagents: rawDb.prepare("SELECT * FROM subagents WHERE chat_id = ? ORDER BY rowid").all(chatId),
      hints: rawDb.prepare("SELECT * FROM chat_hints WHERE chat_id = ? ORDER BY id").all(chatId),
    });
    const prior = rows(m.id);
    try {
      reportOrphaned();
      assert.deepEqual(rows(m.id), prior, "the manager chat's rows in subagents and chat_hints are unchanged");
      const state = (chatId, id) => store.readSubagent(chatId, id)?.state;
      assert.deepEqual([state(control.id, "parked-k"), state(control.id, "running-k")], ["parked", "orphaned"], "control: adopted or orphaned");
      assert.ok(store.openHints(control.id).some((h) => h.source === "agent-orphaned"), "control: the hint about the orphan is there");
      const gate = (await json(`${base}/api/runs/active`)).agents.map((a) => `${a.chatId}/${a.agentId}`);
      assert.ok(gate.includes(`${control.id}/parked-k`), `control: the adopted one is in the idle gate — ${JSON.stringify(gate)}`);
      assert.ok(!gate.some((x) => x.startsWith(`${m.id}/`)), `no subagent of the manager chat in the idle gate — ${JSON.stringify(gate)}`);
      assert.equal(running.has(m.id), false, "no turn of the manager chat");
    } finally {
      // Around the core, not via the route: the stop route of a manager chat is 409 — and in the counter-test its subagent lives.
      for (const c of [control, m]) stopBackgroundAgents(c.id, { ofHuman: true });
    }
  }, { claude });
});

test("(6) restart: the active_runs and run wait row of a parked manager chat stay untouched, its workflow run is not driven — the coding controls take both paths", async () => {
  await withAgentsServer(async (ctx) => {
    const { ws } = ctx;
    const control = ctx.chat;
    const m = managerChat(ws);
    const kWf = await codingChat(ctx, "Control workflow");
    const now = Date.now();
    const later = now + 3_600_000;
    for (const c of [m, control]) {
      store.setActiveRun(c.id, { kind: "chat", prompt: "Restart 6", startedAt: now });
      store.setPendingResume(c.id, { kind: "run", prompt: "Wait row 6", dueAt: later });
    }
    const run = (chat) => store.startWorkflowRun({ id: crypto.randomUUID(), chatId: chat.id, workflowId: "wf-teardown-6-missing", workflowName: "Missing 6", workspaceId: ws.id }).id;
    // A SECOND manager chat carries only the workflow run: the first one drops out of the list of runs with its wait row.
    const m2 = managerChat(ws, { title: "Job warehouse" });
    run(m2);
    const kRun = run(kWf);
    const rows = (chatId) => Object.fromEntries(["active_runs", "pending_resumes", "workflow_runs"].map((t) => [t, rawDb.prepare(`SELECT * FROM ${t} WHERE chat_id = ? ORDER BY rowid`).all(chatId)]));
    const prior = rows(m.id);
    const prior2 = rows(m2.id);
    resumeInterruptedWork();
    assert.equal(store.listActiveRuns().some((r) => r.chatId === control.id), false, "control: the active_runs row is gone");
    await waitForTruthy(() => store.getWorkflowRunById(kRun)?.status === "failed" || null, "control: its run without workflow was driven");
    await waitForTruthy(() => store.listMessages(control.id).some((x) => x.role === "assistant") || null, "control: the wait row made due ran");
    await ctx.waitForQuiet();
    assert.deepEqual(rows(m.id), prior, "the manager chat's rows in active_runs and pending_resumes are unchanged");
    assert.deepEqual(rows(m2.id), prior2, "the second manager chat's workflow run was not driven");
    for (const c of [m, m2]) {
      assert.equal(running.has(c.id), false, `${c.title}: no turn`);
      assert.deepEqual(store.listMessages(c.id), [], `${c.title}: nothing in the history`);
    }
  }, { claude });
});

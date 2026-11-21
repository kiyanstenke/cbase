// The legacy data of the registration agent: its run kind, route POST /api/apps/registration-agent, prompt, the full view over
// all workspaces (CBASE_GLOBAL_AGENT) and the conflict chat on services and conflict list are gone, but the chats it created
// (kind 'conflict' — the global one without a project and the older per-project ones) stay in the user DBs: removing a feature
// deletes no data. This file holds what happens to them:
//
//   (1) List: the Coding list /api/chats shows both forms on no archive page and does not trip over them (/api/agent-chats is 404).
//   (2) Read: GET /api/chats/:id and /log.
//   (3) Archive: PUT and GET …/archive answer 400 (an app-agent chat cannot be archived) — no crash, archivedAt stays null.
//   (4) READ-ONLY (runs/only-readable.js): every route that could begin a turn or change the chat — message, answer to its open
//       question card, steering, fork, "try now", compact, clear, rename, workflow — is 409 with the wording and
//       `onlyReadable: true`; nothing is written, no run, no fork, the CLI session stays untouched. Stop and read still work.
//       Positive control on the same server: the same message to an ordinary chat runs (workspace fence, no full view).
//   (5) The route is gone: POST /api/apps/registration-agent => 404, no chat is created.
//   (6) Conflicts without a chat: GET /api/ports/conflicts carries only `{ items }` per project, GET …/services no `conflictChatId`.
//   (7) Delete: DELETE /api/chats/:id => gone (GET 404, no longer in the DB).
//
// The second test holds the start paths WITHOUT a route — each with an ordinary chat as positive control that takes the same
// path in the same call and runs: (a) machine delivery (deliverUserPrompt — channel, wake call, copy, …), (b) the inherited queue
// after the restart (runInputsRestartGrace), (c) the resumption after the restart (resumeInterruptedWork, active_runs), (d) the
// wait row at the limit (fireAutoContinue), (e) doRun directly (the catcher for workflow drivers, goal gate and every future
// path). Plus (f) the auto title: first an ordinary chat is titled through the route (the fake CLI answers the title oneshot),
// THEN the `conflict` chat keeps its title.
//
// COUNTER-TESTS (each sabotage in the product, run the file, restore):
//   · drop the line `if (onlyReadable(chat) && !archiveAllowed(…))` in chats/routes.js => (4) red (/message 202);
//   · drop the check in queue.js deliverUserPrompt => (a) red (delivery says `ok: true` and writes the user row — only doRun
//     catches the run);
//   · drop the check in queue.js takeNextRunInput => (b) red (two chats started from the queue);
//   · drop the check in resume.js => (c) red (a resumption marker is written into the log — only doRun catches the run);
//   · drop the check in auto-continue.js fireAutoContinueInner => (d) red (`ok: true` instead of "only-readable");
//   · drop the check in do-run.js doRun => (e) red (the chat is in `running`, the old session starts);
//   · drop all six checks => both tests red ((4) and (a));
//   · put 'conflict' back into AUTO_TITLE_KINDS (runs/post-run.js) => (f) red ("New title") — the positive control shows that
//     the auto title runs at all (without an oneshot answer EVERY auto title would fail silently).
//   · (5) red if the route answers 200 with a chatId; (6) red if `chatId` is on the conflict list or `conflictChatId` on services.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { fireAutoContinue, runInputsRestartGrace } from "../electron/server/runs/auto-continue.js";
import { doRun } from "../electron/server/runs/do-run.js";
import { maybeAutoTitle } from "../electron/server/runs/post-run.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { resumeInterruptedWork } from "../electron/server/runs/resume.js";
import { pendingRunInputs, persistRunInputs, running } from "../electron/server/runs/state.js";
import { fakeClaude, freePort, json, withAgentsServer } from "./agent-harness.mjs";

// The fake CLI records what a run received: the appended system prompt, the resumed session and the environment of the cbase
// MCP server. The title oneshot gets an answer — without it every oneshot ends with exit 3, runOnce throws, and EVERY auto
// title would fail silently: then "the title stayed" would prove nothing.
const claude = fakeClaude({
  main: `
  let mcp = null;
  try { mcp = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase; } catch {}
  fs.writeFileSync(path.join(LOCATION, "run-" + process.pid + ".json"), JSON.stringify({ sys: arg("--append-system-prompt"), resume: arg("--resume"), env: (mcp && mcp.env) || null, text }));
  finished();
  say({ type: "result", result: "Legacy data read", session_id: "s-legacy-data" });`,
  oneshot: `fs.writeFileSync(path.join(LOCATION, "oneshot-" + process.pid + ".txt"), prompt); respond("New title");`,
});
// The wording of the lock (runs/only-readable.js) — the file runs with the default language, German.
const LOCK = "Der Agent dieses Chats ist entfernt — der Chat ist nur noch lesbar.";
const runs = (root) => fs.readdirSync(root).filter((f) => /^run-\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8")));

const raw = async (url, init) => {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init?.headers || {}) } });
  let body = null;
  try { body = await r.json(); } catch { /* no JSON */ }
  return { status: r.status, body };
};

function oldChat(ws, { projectId = null, title }) {
  const now = Date.now();
  // How the registration agent created it: workspace "home", kind 'conflict', bypassPermissions.
  return store.createChat({
    id: crypto.randomUUID(), workspaceId: ws.id, projectId, title, profile: "default", kind: "conflict",
    permissionMode: "bypassPermissions", createdAt: now, updatedAt: now,
  });
}

async function project(ctx, name) {
  const filePath = path.join(ctx.root, "workspace", name.toLowerCase());
  fs.mkdirSync(filePath, { recursive: true });
  return json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name, path: filePath }) });
}

test("registration agent gone: old chats (kind conflict) are read-only and deletable (every write and start route 409); route and conflict chat are gone", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, root } = ctx;
    const till = await project(ctx, "Till");
    const lager = await project(ctx, "Stock");
    const global = oldChat(ws, { title: "Registration agent" });
    const perProject = oldChat(ws, { projectId: till.id, title: "Conflict Till" });
    store.addMessage(global.id, "assistant", "Old finding: :3000 duplicate");

    // (1) List — the app-agent route is gone; both stay in the DB.
    assert.equal((await raw(`${base}/api/agent-chats`)).status, 404);
    for (const c of [global, perProject]) assert.equal(store.getChat(c.id)?.kind, "conflict", `${c.title} is in the DB`);
    assert.equal(store.getChat(perProject.id).projectId, till.id);
    for (const archive of ["without", "only", "including"]) {
      const coding = await json(`${base}/api/chats?workspaceId=${ws.id}&archive=${archive}`);
      assert.equal(coding.some((c) => c.kind === "conflict"), false, `/api/chats archive=${archive} without app agents`);
    }

    // (2) Read
    assert.equal((await json(`${base}/api/chats/${global.id}`)).kind, "conflict");
    const log = await json(`${base}/api/chats/${global.id}/log`);
    assert.deepEqual(log.map((m) => m.text), ["Old finding: :3000 duplicate"]);

    // (3) Archive
    for (const c of [global, perProject]) {
      const put = await raw(`${base}/api/chats/${c.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
      assert.equal(put.status, 400, `${c.title}: PUT …/archive => 400`);
      assert.match(put.body.error, /archivieren/);
      assert.equal((await raw(`${base}/api/chats/${c.id}/archive`)).status, 400, `${c.title}: GET …/archive => 400`);
      assert.equal(store.getChat(c.id).archivedAt, null);
    }

    // (4) Read-only. The global old chat as in a real user DB: a CLI session, an outdated plan and its open question card — an
    // answer to it used to go out as a turn with --resume.
    store.updateChat(global.id, { claudeSessionId: "s-legacy-registration" });
    store.addMessage(global.id, "ask", JSON.stringify({ requestId: "r-old", questions: [{ header: "Port", question: "Till :3000 → :3100 in .env.local – confirm?", multiSelect: false, options: [{ label: "Yes", description: "" }, { label: "No", description: "" }] }] }));
    // Coding chats counted unfiltered (the client list shows only chats with a message).
    const chatsPrior = store.chatIdsInWorkspace(ws.id).length;
    const requests = [
      ["POST", "/message", { text: "yes" }],
      ["POST", "/ask-answer", { requestId: "r-old", answers: [{ selected: ["Yes"], text: "" }] }],
      ["POST", "/control", {}],
      ["POST", "/fork", {}],
      ["POST", "/auto-continue/now", {}],
      ["POST", "/compact", {}],
      ["POST", "/clear", {}],
      ["PATCH", "", { title: "Renamed" }],
      ["POST", "/workflow", { workflowId: "wf-x" }],
    ];
    for (const c of [global, perProject]) {
      const logPrior = await json(`${base}/api/chats/${c.id}/log`);
      for (const [method, sub, body] of requests) {
        const r = await raw(`${base}/api/chats/${c.id}${sub}`, { method, body: JSON.stringify(body) });
        assert.equal(r.status, 409, `${c.title}: ${method} ${sub || "/"} => 409 (was ${r.status} ${JSON.stringify(r.body)})`);
        assert.deepEqual(r.body, { error: LOCK, onlyReadable: true }, `${c.title}: ${method} ${sub || "/"} — the wording of the lock`);
      }
      assert.deepEqual(await json(`${base}/api/chats/${c.id}/log`), logPrior, `${c.title}: nothing written to the log`);
      const afterwards = store.getChat(c.id);
      assert.equal(afterwards.title, c.title, `${c.title}: not renamed`);
      assert.equal(afterwards.claudeSessionId, c.id === global.id ? "s-legacy-registration" : null, `${c.title}: session untouched`);
      assert.equal(running.has(c.id), false, `${c.title}: no run`);
      // Reading and stopping still work (the same allowlist as the archive).
      assert.equal((await raw(`${base}/api/chats/${c.id}/auto-continue`)).status, 200, `${c.title}: GET …/auto-continue`);
      assert.notEqual((await raw(`${base}/api/chats/${c.id}/stop`, { method: "POST", body: "{}" })).status, 409, `${c.title}: POST …/stop stays open`);
    }
    const chatsAfterwards = store.chatIdsInWorkspace(ws.id).length;
    assert.equal(chatsAfterwards, chatsPrior, "no fork created");
    // Positive control on the same server: the same message to an ordinary chat runs — and carries, like every run, the
    // workspace fence, no full view.
    const message = await raw(`${base}/api/chats/${ctx.chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "yes" }) });
    assert.equal(message.status, 202, `control: /message => 202 (${JSON.stringify(message.body)})`);
    await ctx.waitForLog(ctx.chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === "Legacy data read"));
    await ctx.waitForQuiet();
    const run = runs(root);
    assert.equal(run.length, 1, `exactly one run — the control's (${JSON.stringify(run.map((l) => l.resume))})`);
    const [run2] = run;
    assert.equal(run2.text.includes("yes"), true);
    assert.notEqual(run2.resume, "s-legacy-registration", "the old session of the registration agent did not start");
    assert.ok(run2.env, "MCP configuration read");
    assert.equal(run2.env.CBASE_WORKSPACE_ID, ws.id, "workspace fence like every chat");
    assert.equal("CBASE_GLOBAL_AGENT" in run2.env, false, "no full view over all workspaces");

    // (5) The route is gone
    const prior = store.chatIdsInWorkspace(ws.id).length;
    const reg = await raw(`${base}/api/apps/registration-agent`, { method: "POST" });
    assert.equal(reg.status, 404, `POST /api/apps/registration-agent => 404 (was ${reg.status} ${JSON.stringify(reg.body)})`);
    assert.equal(store.chatIdsInWorkspace(ws.id).length, prior, "no new chat");

    // (6) Conflicts without a chat
    const port = await freePort();
    for (const p of [till, lager]) {
      await json(`${base}/api/project-services`, { method: "POST", body: JSON.stringify({ projectId: p.id, name: "web", port, kind: "frontend" }) });
    }
    const conflicts = await json(`${base}/api/ports/conflicts`);
    assert.ok(conflicts[till.id], "the conflict over the port is there");
    for (const [pid, group] of Object.entries(conflicts)) {
      assert.deepEqual(Object.keys(group), ["items"], `${pid}: only items, no chatId`);
      assert.ok(group.items.some((i) => i.port === port));
    }
    const services = await json(`${base}/api/projects/${till.id}/services`);
    assert.equal("conflictChatId" in services, false, "GET …/services without conflictChatId");
    assert.equal(services.services.length, 1);

    // (7) Delete
    for (const c of [global, perProject]) {
      const way = await raw(`${base}/api/chats/${c.id}`, { method: "DELETE" });
      assert.equal(way.status, 200, `${c.title}: DELETE => 200 (${JSON.stringify(way.body)})`);
      assert.equal((await raw(`${base}/api/chats/${c.id}`)).status, 404, `${c.title}: 404 afterwards`);
      assert.ok(!store.getChat(c.id), `${c.title}: no longer in the DB`);
    }
  }, { claude });
});

// The start paths WITHOUT a route — called in the server's process (the same module instances). For each path an ordinary chat
// (`ctx.chat`) takes the same path in the same call and RUNS: without this control "the old chat did not run" would prove
// nothing. Whether a path starts shows synchronously in `running` (doRun sets the mark before its first await) — the test
// waits only for the end of the control, never for a duration.
test("no start path without a route begins a turn in a `conflict` chat (delivery, queue, resumption, wait row, doRun); the title stays while an ordinary chat is titled", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, root } = ctx;
    const control = ctx.chat;
    const old = oldChat(ws, { title: "Registration agent" });
    store.updateChat(old.id, { claudeSessionId: "s-legacy-registration" });
    store.addMessage(old.id, "assistant", "Till :3000 → :3100 in .env.local – confirm?");
    const oldLog = () => store.listMessages(old.id).map((m) => [m.role, m.text]);
    const logPrior = oldLog();
    const untouched = (way) => {
      assert.equal(running.has(old.id), false, `${way}: the old chat is in running — a turn began`);
      assert.deepEqual(oldLog(), logPrior, `${way}: written to the old chat's log`);
      assert.equal(store.getChat(old.id).claudeSessionId, "s-legacy-registration", `${way}: session touched`);
      assert.equal(store.listActiveRuns().some((r) => r.chatId === old.id), false, `${way}: active_runs row still there`);
      assert.equal(store.getPendingResume(old.id), null, `${way}: wait row still there`);
      assert.equal(pendingRunInputs.has(old.id), false, `${way}: queue still there`);
      assert.equal(store.listRunInputs().some((q) => q.chatId === old.id), false, `${way}: queue in run_inputs`);
    };
    let controlRuns = 0;
    const controlRan = async (way, text) => {
      assert.equal(running.has(control.id), true, `${way}: the control did NOT start — the path is not the one the test means`);
      await ctx.waitForQuiet();
      controlRuns += 1;
      const run = runs(root);
      assert.equal(run.length, controlRuns, `${way}: only the control ran (${JSON.stringify(run.map((l) => [l.text.slice(0, 40), l.resume]))})`);
      assert.equal(run.some((l) => l.text.includes(text)), true, `${way}: the control's run carries its text`);
      assert.equal(run.some((l) => l.resume === "s-legacy-registration"), false, `${way}: the old session started`);
    };

    // (a) Machine delivery (channel, wake call, copy, schedule …): nothing written, nothing queued, no turn.
    const delivery = deliverUserPrompt(old, { prompt: "Wake call a", display: "Wake call a", cause: "event" });
    assert.deepEqual(delivery, { ok: false, queued: false, injected: false, onlyReadable: true, error: LOCK });
    deliverUserPrompt(control, { prompt: "Wake call a", display: "Wake call a", cause: "event" });
    untouched("(a) Delivery");
    await controlRan("(a) Delivery", "Wake call a");

    // (b) The inherited queue after the restart: both chats carry an entry as run_inputs returns it.
    const entry = (text) => ({ id: crypto.randomUUID(), prompt: text, display: text, attachments: [], cause: "user", causeSpecified: "user", silent: false });
    for (const c of [old, control]) { pendingRunInputs.set(c.id, [entry("Queue b")]); persistRunInputs(c.id); }
    assert.equal(runInputsRestartGrace(), 1, "(b) exactly ONE chat started from the queue — the control");
    await new Promise((r) => queueMicrotask(r)); // the follow-up start runs in a microtask
    untouched("(b) Queue");
    await controlRan("(b) Queue", "Queue b");

    // (c) The resumption after the restart (active_runs): the control starts again, the old chat does not — and its log stays
    // as it was (no resumption marker, no deleted partial output).
    const now = Date.now();
    for (const c of [old, control]) store.setActiveRun(c.id, { kind: "chat", prompt: "Restart c", startedAt: now });
    resumeInterruptedWork();
    untouched("(c) Resumption");
    await controlRan("(c) Resumption", "Restart c");

    // (d) The wait row at the limit (alarm, sweeper, "try now" — `manual`, so no limit fetch comes in between; the check sits
    // in the server BEFORE it).
    for (const c of [old, control]) store.setPendingResume(c.id, { kind: "run", prompt: "Wait row d", dueAt: Date.now() });
    assert.deepEqual(await fireAutoContinue(old.id, { manual: true }), { ok: false, reason: "only-readable" }, "(d) the wait row of the old chat is dismissed");
    assert.deepEqual(await fireAutoContinue(control.id, { manual: true }), { ok: true }, "(d) Control");
    untouched("(d) WaitRow");
    await controlRan("(d) WaitRow", "Wait row d");

    // (e) doRun directly — the path of the workflow drivers, the goal gate and every caller that does not exist yet. The catcher
    // also clears an inherited active_runs row.
    store.setActiveRun(old.id, { kind: "chat", prompt: "Direct e", startedAt: Date.now() });
    const direct = doRun(old, "Direct e");
    const controlRun = doRun(store.getChat(control.id), "Direct e");
    untouched("(e) doRun");
    assert.equal(await direct, undefined);
    await controlRan("(e) doRun", "Direct e");
    await controlRun;

    // (f) The auto title. First the positive control through the route — an ordinary chat with a placeholder title gets titled
    // (the fake CLI answers the oneshot); only THEN does "the old chat keeps its title" say anything.
    const fresh = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001" }) });
    assert.equal(store.getChat(fresh.id).titled, false, "control: not titled yet");
    await json(`${base}/api/chats/${fresh.id}/message`, { method: "POST", body: JSON.stringify({ text: "Title f" }) });
    await ctx.waitForTruthy(() => store.getChat(fresh.id)?.title === "New title", "auto title of the control");
    await ctx.waitForQuiet();
    assert.equal(store.getChat(old.id).titled, false, "the old chat is not titled by hand — otherwise (f) would check nothing");
    await maybeAutoTitle(store.getChat(old.id), "Any conflicts left?", "Legacy data read");
    assert.equal(store.getChat(old.id).title, "Registration agent", "no auto title for the kind `conflict`");
  }, { claude });
});

// The auto title comes only from HUMAN input (runs/human-input.js, cause "user"). A first turn started by a wake call (cause
// "event": copy arrival, hook, …) or a completion notice (cause "agent") must not title the chat from the NOTICE
// ("<task-notification> …" as a title); the hook skips these turns (`turnWithoutHuman`), the next human turn sets the title. A turn
// without a stated cause (doRun directly, an app agent) is titled as before. COUNTER-TEST: drop the line
// `if (turnWithoutHuman(chat.id)) return;` in runs/post-run.js autoTitleHook => this test red (title from the wake call).
test("a first turn from a wake call or completion notice does not title the chat (no title oneshot); the following human turn does", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, root } = ctx;
    const titleOneshots = (word) => fs.readdirSync(root).filter((f) => /^oneshot-\d+\.txt$/.test(f))
      .map((f) => fs.readFileSync(path.join(root, f), "utf8")).filter((t) => t.includes("<chat>") && t.includes(word));
    const fresh = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001" }) });
    const titlePrior = store.getChat(fresh.id).title;
    for (const [cause, text] of [["event", "WAKE-CALL-E2ES"], ["agent", "<task-notification>DONE-E2ES</task-notification>"]]) {
      deliverUserPrompt(store.getChat(fresh.id), { prompt: text, display: text, cause });
      await ctx.waitForQuiet();
      assert.equal(runs(root).some((l) => l.text.includes(text)), true, `the turn from "${cause}" did not run — the test checked nothing`);
      assert.equal(store.getChat(fresh.id).titled, false, `a turn from "${cause}" titled the chat`);
      assert.equal(store.getChat(fresh.id).title, titlePrior);
      assert.deepEqual(titleOneshots(text.slice(0, 12)), [], `a title oneshot from "${cause}"`);
    }
    // The human writes: now the title comes — from THEIR message.
    await json(`${base}/api/chats/${fresh.id}/message`, { method: "POST", body: JSON.stringify({ text: "Human asks e2es" }) });
    await ctx.waitForTruthy(() => store.getChat(fresh.id)?.title === "New title", "auto title after the human turn");
    await ctx.waitForQuiet();
    assert.equal(titleOneshots("Human asks e2es").length, 1, "the title oneshot of the human turn");
  }, { claude });
});

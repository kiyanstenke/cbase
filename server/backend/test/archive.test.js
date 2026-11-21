// The archive through the server: required fields and kinds of the route, the list filters including `archive=`,
// open work reason by reason, asking-card dismissal without a run, folders (route, atomic 409, the event), a schedule run
// fetching its folder, "no run in the archive" (channel, the call in doRun), the write lock as a request matrix, shells,
// sibling artifacts, permanent delete with the ONE delete cascade, the `chat_archive` event and MCP. A manager chat is only
// legacy data in the store since the managing teardown. The fork takes over the kind of its original and stays in its
// folder; a non-archivable chat is not forked.
//
// The data layer (column, trigger, four store functions, the store filters) is tested without a server in
// `archive-store.test.js`; the way back before the credit gate is in `credit-gate-ways.test.js`.
//
// After EVERY test the invariant runs over a raw connection: active chats in archived folders = 0.
//
// Sabotage: each one is named below at its test with "Sabotage:" (turning exactly that test red).
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 node --test server/backend/test/archive.test.js

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  fakeClaude, json, makeChat, makeWorkspace, ok, openStream, waitFor, waitForIdle, withMcp, withServer,
} from "./server-harness.mjs";
import * as store from "../electron/server/store.js";
import { db as rawDb } from "../electron/server/store/db.js";
import { compacting, pendingRunInputs, running, targetCheckOn, targetCheckOff } from "../electron/server/runs/state.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { pendingPermissions } from "../electron/server/runs/approvals.js";
import { dismissAsk, openAskOf } from "../electron/server/runs/ask.js";
import { ARCHIVE_REASONS, DELETE_HOLDS, openWork } from "../electron/server/runs/archive.js";
import { archiveAllowed } from "../electron/server/chats/routes.js";
import { chatArchive } from "../electron/server/chats/archive.js";

const SERVER_DIR = fileURLToPath(new URL("../electron/server/", import.meta.url));
const source = (rel) => fs.readFileSync(path.join(SERVER_DIR, rel), "utf8");

// ── Helpers ───────────────────────────────────────────────────────────────────

function invariant(root) {
  const raw = new DatabaseSync(path.join(root, "data-root", "data", "automater.db"));
  try {
    const n = raw.prepare(`SELECT COUNT(*) AS n FROM chats c JOIN chat_folders f ON f.id = c.folder_id
      WHERE c.archived_at IS NULL AND f.archived_at IS NOT NULL`).get().n;
    assert.equal(n, 0, `invariant broken: ${n} active chat(s) in an archived folder`);
  } finally { raw.close(); }
}
// withServer + invariant at the end of the body (only after a passed body — otherwise the error above counts).
// The finally is the emergency brake for failure: a run in an ARCHIVED chat (which only exists if a promise is broken)
// could no longer be stopped over HTTP while `/stop` was locked — the fake CLI (STAY-OPEN) kept the event loop open, and the
// red line became a hang without verdict. Since `/stop` is allowed in the archive (own test below) the brake stays anyway,
// because if the allowlist row falls, exactly the test that should report it would hang. So: fetch such chats back
// directly in the store, then the harness stops them.
const withServerValue = (run) => withServer(async (ctx) => {
  try {
    await run(ctx);
  } finally {
    for (const id of [...running]) {
      if (store.getChat(id)?.archivedAt) { store.fetchChatBack(id); console.warn(`[archive] run in archived chat ${id} — fetched back for stopping`); }
    }
  }
  invariant(ctx.root);
});

const archive = (base, id, extra = {}) => json(`${base}/api/chats/${id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true, ...extra }) });
const back = (base, id) => json(`${base}/api/chats/${id}/archive`, { method: "PUT", body: JSON.stringify({ archived: false }) });
const folderArchive = (base, id, archived) => json(`${base}/api/chat-folders/${id}/archive`, { method: "PUT", body: JSON.stringify({ archived }) });
const precheck = async (base, id) => ok(`${base}/api/chats/${id}/archive`);
const reasons = async (base, id) => (await precheck(base, id)).open.map((o) => o.reason);
const newFolder = (base, workspaceId, name = "Folder", kind = "normal") =>
  ok(`${base}/api/chat-folders`, { method: "POST", body: JSON.stringify({ workspaceId, name, kind }) });
const inFolder = (base, chatId, folderId) => ok(`${base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ folderId }) });
// A manager conversation only arises as legacy data in the store (the routes of the manager agents and chats are gone) —
// the lock (runs/manager-lock.js) keeps it frozen until phase 2.
const newConversation = (wid, title = "Conversation") => {
  const t = Date.now();
  return { chatId: store.createChat({ id: crypto.randomUUID(), workspaceId: wid, kind: "manager", title, createdAt: t, updatedAt: t }).id };
};
const newManagerFolder = (wid, name) => {
  const t = Date.now();
  return store.createChatFolder({ id: crypto.randomUUID(), workspaceId: wid, name, kind: "manager", createdAt: t, updatedAt: t });
};
const archiveEvents = (s) => s.events.filter((e) => e.type === "chat_archive");
// Until n archive events have arrived (the stream is a second connection — the route's answer can be there before the
// event). "Exactly n" is checked afterwards by the caller's line.
const untilEvents = (s, n, what) => waitFor(async () => archiveEvents(s).length >= n, what);
// "Exactly n" without a clock: a watchdog chat is archived, and its event must be at place n — a duplicate event before it
// would shift it (the same connection keeps the order).
async function watchdogPlace(base, workspaceId, s) {
  const w = await makeChat(base, workspaceId);
  assert.equal((await archive(base, w.id)).status, 200);
  await s.waitFor((e) => e.type === "chat_archive" && e.chatIds?.[0] === w.id, "event of the watchdog");
  return archiveEvents(s).findIndex((e) => e.chatIds?.[0] === w.id);
}
// A request whose body only comes AFTER entering the route — without a clock: `Expect: 100-continue`. The server writes
// "100 Continue" and calls the handler in the SAME step; up to the body await of the sub-slice there are only microtasks,
// which run before the next I/O event. When the 100 arrives at the test, the route is thus safely in `await readBody(…)`,
// behind the first lock. `send()` delivers the body.
function heldRequest(base, method, filePath, bodyText, type = "application/json") {
  const u = new URL(base + filePath);
  const buf = Buffer.from(bodyText);
  let finished;
  const response = new Promise((resolve, reject) => { finished = { resolve, reject }; });
  let further;
  const ready = new Promise((resolve) => { further = resolve; });
  const req = http.request({
    host: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false,
    headers: { "Content-Type": type, "Content-Length": buf.length, Expect: "100-continue" },
  }, (res) => {
    let d = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { d += c; });
    res.on("end", () => { let body = d; try { body = JSON.parse(d); } catch { /* not JSON */ } finished.resolve({ status: res.statusCode, body }); });
  });
  req.on("continue", () => further());
  req.on("error", (e) => finished.reject(e));
  req.flushHeaders();
  // If the response comes BEFORE the 100 (the route answered without a body), that is an error, not a hang. The later,
  // normal answer makes this promise fail too — the empty catch only covers the race.
  const tooEarly = response.then((a) => { throw new Error(`response before the body: ${a.status} ${JSON.stringify(a.body)}`); });
  tooEarly.catch(() => {});
  return { ready: Promise.race([ready, tooEarly]), response, send: () => req.end(buf) };
}
const question = () => ({ requestId: crypto.randomUUID(), questions: [{ header: "Choice", question: "Which variant?", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] });

// ── Required fields, kinds, list filters, state kept on archive ─────────────────────────
// Sabotage: read `b.archived !== false` as "on" ⇒ the 400 lines red; drop the kind check ⇒ the kind case red.
test("route: required fields (400, nothing changed), only coding and manager chats, filter archive=without|only|including, updatedAt and pinned stay", async () => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Archiv", wsPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    // Only chats with at least one message appear in the clients' lists — the chats of this test are "real" ones, i.e.
    // written to.
    for (const c of [a, b]) store.addMessage(c.id, "user", "Hello");
    await ok(`${base}/api/chats/${a.id}`, { method: "PATCH", body: JSON.stringify({ title: "Alpha", pinned: true }) });
    await ok(`${base}/api/chats/${b.id}`, { method: "PATCH", body: JSON.stringify({ title: "Beta" }) });

    for (const body of [{}, { archived: "true" }, { archived: 1 }, { archived: true, dismissQuestion: "yes" }, { archived: true, dismissQuestion: null }]) {
      const r = await json(`${base}/api/chats/${a.id}/archive`, { method: "PUT", body: JSON.stringify(body) });
      assert.equal(r.status, 400, `body ${JSON.stringify(body)} ⇒ 400: ${JSON.stringify(r.body)}`);
    }
    assert.equal(store.getChat(a.id).archivedAt, null, "a rejected body changed nothing");

    // Kind check: special chat (administrator), app agent (service), app agent (conflict) ⇒ 400, GET like PUT.
    const now = Date.now();
    const special = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", title: "Administrator", createdAt: now, updatedAt: now });
    store.updateChat(special.id, { specialRole: "administrator" });
    const appChat = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "service", title: "Service", createdAt: now, updatedAt: now });
    const agent = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "conflict", title: "Conflict", createdAt: now, updatedAt: now });
    for (const c of [special, appChat, agent]) {
      // The administrator (kind manager) is read-only: its PUT hits the lock first (409, runs/manager-lock.js).
      const desired = c === special ? 409 : 400;
      assert.equal((await archive(base, c.id)).status, desired, `${c.title}: PUT ⇒ ${desired}`);
      assert.equal((await json(`${base}/api/chats/${c.id}/archive`)).status, 400, `${c.title}: GET ⇒ 400`);
      assert.equal(store.getChat(c.id).archivedAt, null);
    }

    // Order, updatedAt and pinned before archiving …
    const prior = (await ok(`${base}/api/chats?workspaceId=${ws.id}`)).map((c) => c.id);
    const old = store.getChat(a.id);
    assert.deepEqual((await precheck(base, a.id)), { archived: false, archivedAt: null, open: [], terminals: 0 });
    const r = await archive(base, a.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(typeof r.body.chat.archivedAt, "number");
    assert.deepEqual(r.body.folderIds, []);
    const at = r.body.chat.archivedAt;
    // Same state ⇒ unchanged, the old timestamp stays.
    const still = await archive(base, a.id);
    assert.equal(still.body.unchanged, true);
    assert.equal(still.body.chat.archivedAt, at);

    // Filter: /api/chats without, only, including, unknown.
    assert.deepEqual((await ok(`${base}/api/chats?workspaceId=${ws.id}`)).map((c) => c.id), [b.id], "default: only active");
    assert.deepEqual((await ok(`${base}/api/chats?workspaceId=${ws.id}&archive=without`)).map((c) => c.id), [b.id]);
    assert.deepEqual((await ok(`${base}/api/chats?workspaceId=${ws.id}&archive=only`)).map((c) => c.id), [a.id]);
    assert.deepEqual(new Set((await ok(`${base}/api/chats?workspaceId=${ws.id}&archive=including`)).map((c) => c.id)), new Set([a.id, b.id]));
    for (const wrong of ["x", "", "ONLY"]) {
      assert.equal((await json(`${base}/api/chats?workspaceId=${ws.id}&archive=${wrong}`)).status, 400, `archive=${wrong} ⇒ 400`);
    }

    // … and after restoring: the same values, the same place.
    const w = await back(base, a.id);
    assert.equal(w.status, 200);
    assert.equal(w.body.chat.archivedAt, null);
    const fresh = store.getChat(a.id);
    assert.equal(fresh.updatedAt, old.updatedAt, "updatedAt stays");
    assert.equal(fresh.pinned, old.pinned, "pinned stays");
    assert.deepEqual((await ok(`${base}/api/chats?workspaceId=${ws.id}`)).map((c) => c.id), prior, "same order");
    assert.equal((await back(base, a.id)).body.unchanged, true, "an active chat: unchanged");

    // Folder list: chatCount per side, unknown value ⇒ 400.
    const f = await newFolder(base, ws.id);
    await inFolder(base, a.id, f.id);
    await inFolder(base, b.id, f.id);
    await ok(`${base}/api/chats/${a.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
    const folder = (q = "") => ok(`${base}/api/chat-folders?workspaceId=${ws.id}${q}`);
    assert.deepEqual((await folder()).map((x) => [x.id, x.chatCount]), [[f.id, 1]], "an active folder counts only the active chat");
    assert.deepEqual(await folder("&archive=only"), [], "the folder itself is not archived");
    assert.equal((await folderArchive(base, f.id, true)).status, 200);
    assert.deepEqual((await folder()).map((x) => x.id), []);
    assert.deepEqual((await folder("&archive=only")).map((x) => [x.id, x.chatCount, typeof x.archivedAt]), [[f.id, 2, "number"]]);
    assert.deepEqual((await folder("&archive=including")).map((x) => [x.id, x.chatCount]), [[f.id, 2]]);
    assert.equal((await json(`${base}/api/chat-folders?workspaceId=${ws.id}&archive=all`)).status, 400);
  });
});

// ── Open work, reason by reason ─────────────────────────────────────────────
// The goal check runs FOR REAL: the fake judge holds while the hold file exists. Everything else is set at its source (the
// same maps/tables that openWork reads) — each case has EXACTLY one reason.
// Sabotage: per reason drop the line in openWork ⇒ exactly that case red; for "target" the line `targetCheckOn(chat.id)` in
// goalGateAfterRun. Two OVERLAPPING verdicts: own test.
test("409 per reason: running, interrupted, compacted, queue, waitRow, workflow, question, approval, target — the chat stays unchanged", async () => {
  // "interrupted" is the active_runs row WITHOUT a run — the state before the restart. The restart is off here: under load
  // its 2.5 s timer only fired when the row was already there, picked it up and started a run — the precheck reported
  // "running". A clock would otherwise decide which reason applies.
  const restartGracePrior = process.env.CBASE_RESTART_GRACE_MS;
  process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
  try {
  await withServerValue(async ({ base, root, wsPath, oneshots }) => {
    const hold = path.join(root, "target-hold");
    const HOLD = `    if (prompt.includes("You soberly check whether the overarching target") && fs.existsSync(${JSON.stringify(hold)})) {
      const wait = () => {
        if (fs.existsSync(${JSON.stringify(hold)})) return setTimeout(wait, 20);
        process.stdout.write(JSON.stringify({ result: JSON.stringify({ achieved: true, note: "reached" }) }));
        process.exit(0);
      };
      return wait();
    }
`;
    const marker = '    let result = "Title";\n';
    assert.ok(fakeClaude.includes(marker), "the fake CLI lost its marker — the holder hangs on it");
    fs.writeFileSync(path.join(root, "fake-claude"), fakeClaude.replace(marker, HOLD + marker));
    const ws = await makeWorkspace(base, "Reasons", wsPath);
    const x = await makeChat(base, ws.id);

    // "agent" (a background agent that survives its turn) — not reproducible here (it needs a real agent behind a gate),
    // measured in background-network.test.js. Likewise "dynworkflow" (from the ONE query runs/background.js) — measured in
    // dynworkflows-run.test.js, and "graphWorkflow" (same query) — measured in graph-background.test.js; "monitor" (same query) — measured in monitor-over-the-turn.test.js; "copy" (build-up or
    // tear-down of the chat's copy) — measured in stacks-remove.test.js.
    assert.deepEqual(ARCHIVE_REASONS, ["running", "agent", "dynworkflow", "graphWorkflow", "monitor", "copy", "interrupted", "compacted", "queue", "waitRow", "workflow", "question", "approval", "target"]);
    const check = async (chatId, expected) => {
      assert.deepEqual(await reasons(base, chatId), [expected], `precheck names exactly ${expected}`);
      assert.deepEqual(openWork(chatId).map((o) => o.reason), [expected]);
      const r = await archive(base, chatId);
      assert.equal(r.status, 409, `${expected}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.open.map((o) => o.reason), [expected]);
      assert.ok(r.body.open.every((o) => typeof o.text === "string" && o.text.length > 5), "every reason carries the server text");
      assert.equal(store.getChat(chatId).archivedAt, null, `${expected}: the chat is unchanged`);
    };

    // running — the fake CLI holds the turn open.
    await ok(`${base}/api/chats/${x.id}/message`, { method: "POST", body: JSON.stringify({ text: "STAY-OPEN please" }) });
    await waitFor(async () => running.has(x.id), "the run is there");
    await check(x.id, "running");
    await ok(`${base}/api/chats/${x.id}/stop`, { method: "POST" });
    await waitForIdle(base);
    assert.deepEqual(await reasons(base, x.id), []);

    // interrupted: active_runs row without `running` — the 2.5 s before resumeInterruptedWork.
    store.setActiveRun(x.id, { kind: "chat", prompt: "before the restart" });
    try { await check(x.id, "interrupted"); } finally { store.clearActiveRun(x.id); }

    compacting.add(x.id);
    try { await check(x.id, "compacted"); } finally { compacting.delete(x.id); }

    pendingRunInputs.set(x.id, [{ id: crypto.randomUUID(), prompt: "afterwards", display: "afterwards", attachments: [], cause: "user" }]);
    try { await check(x.id, "queue"); } finally { pendingRunInputs.delete(x.id); }

    store.setPendingResume(x.id, { kind: "run", prompt: "at the limit", reason: "reset", dueAt: Date.now() + 3_600_000, resetsAt: Date.now() + 3_600_000 });
    try { await check(x.id, "waitRow"); } finally { store.clearPendingResume(x.id); }

    store.startWorkflowRun({ id: crypto.randomUUID(), chatId: x.id, workflowId: "wf-archive", workflowName: "Archive test", workspaceId: ws.id });
    store.updateWorkflowRun(x.id, { status: "waiting" });
    try { await check(x.id, "workflow"); } finally { store.updateWorkflowRun(x.id, { status: "cancelled" }); }

    store.addMessage(x.id, "ask", JSON.stringify(question()));
    try { await check(x.id, "question"); } finally { dismissAsk(x.id, "test"); }

    const rid = crypto.randomUUID();
    pendingPermissions.set(rid, { chatId: x.id, requestId: rid, resolve() {}, timer: null, input: {}, toolName: "Bash", at: Date.now() });
    try { await check(x.id, "approval"); } finally { pendingPermissions.delete(rid); }

    // target — for real: set a goal, one turn, the verdict holds.
    const y = await makeChat(base, ws.id);
    await ok(`${base}/api/chats/${y.id}`, { method: "PATCH", body: JSON.stringify({ goal: "Goal Z is reached." }) });
    fs.writeFileSync(hold, "hold");
    try {
      await ok(`${base}/api/chats/${y.id}/message`, { method: "POST", body: JSON.stringify({ text: "Work on the goal." }) });
      await waitFor(async () => oneshots().some((o) => String(o.prompt || "").includes("You soberly check")), "the goal verdict has started");
      assert.equal(running.has(y.id), false, "the verdict runs AFTER the turn — `running` does not see it");
      await check(y.id, "target");
    } finally { fs.rmSync(hold, { force: true }); }
    await waitFor(async () => (await ok(`${base}/api/chats/${y.id}/log`)).some((z) => z.role === "goal"), "the verdict has fallen");
    assert.deepEqual(await reasons(base, y.id), [], "after the verdict nothing is open anymore");
    assert.equal((await archive(base, y.id)).status, 200);
    assert.deepEqual(await reasons(base, x.id), []);
    assert.equal((await archive(base, x.id)).status, 200, "without open work it works");
  });
  } finally {
    if (restartGracePrior === undefined) delete process.env.CBASE_RESTART_GRACE_MS; else process.env.CBASE_RESTART_GRACE_MS = restartGracePrior;
  }
});

// ── ONE truth about open work — also when deleting ──────────────────────────────
// Deleting a chat used to stop on `running` alone, the archive on thirteen reasons. A running compaction or goal verdict
// kept writing AFTER the delete (meta row, "goal" message) — under a chat id that no delete path reaches anymore. Now both
// ask the same query (runs/archive.js openWork), and per reason ONE decision stands in `DELETE_HOLDS` — a new archive reason
// without an entry turns this test red.
test("deleting a chat asks the same query as the archive — compacted and target ⇒ 409 with reason, an open question does not hold it", async () => {
  assert.deepEqual(Object.keys(DELETE_HOLDS), ARCHIVE_REASONS, "every archive reason needs exactly ONE decision for deleting, in the same order");
  assert.ok(Object.values(DELETE_HOLDS).every((v) => typeof v === "boolean"), "the decision is yes or no");
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Deleting", wsPath);
    const x = await makeChat(base, ws.id);
    const erase = (id) => json(`${base}/api/chats/${id}`, { method: "DELETE" });
    const locked = async (reason) => {
      const r = await erase(x.id);
      assert.equal(r.status, 409, `${reason}: the delete went through although writing continues afterwards — ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.open.map((o) => o.reason), [reason]);
      assert.ok(typeof r.body.error === "string" && r.body.error.length > 10, "the refusal names the reason in a sentence");
      assert.ok(store.getChat(x.id), `${reason}: the chat is gone despite 409`);
    };
    compacting.add(x.id);
    try { await locked("compacted"); } finally { compacting.delete(x.id); }
    targetCheckOn(x.id);
    try { await locked("target"); } finally { targetCheckOff(x.id); }

    // The question holds the ARCHIVE (the human should not lose sight of it), not the delete — whoever throws the chat away
    // throws the question away with it; afterwards nothing writes anymore.
    store.addMessage(x.id, "ask", JSON.stringify(question()));
    assert.deepEqual(await reasons(base, x.id), ["question"]);
    const r = await erase(x.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!store.getChat(x.id), "the chat is gone");
  });
});

// ── The fork in ONE step ─────────────────────────────────────────────────────
// The fork used to create row, history (row by row in autocommit) and fork marker separately: an error in the middle left a
// half fork standing — with part of the history and without `fork_pending`, i.e. without its own session. The error here
// comes from a TEMP trigger on the third row (standing in for disk full or BUSY).
test("if copying the history fails, no fork arises — neither row nor half history; without an error the history is complete and in order", async () => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Fork", wsPath);
    const x = await makeChat(base, ws.id);
    for (const [i, t] of ["one", "two", "three", "four"].entries()) store.addMessage(x.id, i % 2 ? "assistant" : "user", t, 1_000 + i);
    const prior = (id) => store.listMessages(id).map((z) => [z.role, z.text, z.ts]);
    const chatsPrior = rawDb.prepare("SELECT id FROM chats ORDER BY id").all().map((c) => c.id);
    const messagesPrior = rawDb.prepare("SELECT count(*) AS n FROM messages").get().n;
    rawDb.exec(`CREATE TEMP TRIGGER poison_fork BEFORE INSERT ON messages WHEN NEW.chat_id != '${x.id}' AND NEW.text = 'three'
                BEGIN SELECT RAISE(ABORT, 'POISON-FORK'); END`);
    try {
      const f = await json(`${base}/api/chats/${x.id}/fork`, { method: "POST", body: "{}" });
      assert.notEqual(f.status, 201, `the fork reports success although the copy failed: ${JSON.stringify(f.body)}`);
    } finally { rawDb.exec("DROP TRIGGER IF EXISTS temp.poison_fork"); }
    assert.deepEqual(rawDb.prepare("SELECT id FROM chats ORDER BY id").all().map((c) => c.id), chatsPrior, "a half fork stayed as a chat");
    assert.equal(rawDb.prepare("SELECT count(*) AS n FROM messages").get().n, messagesPrior, "part of the history stayed under a fork id");

    const ok201 = await json(`${base}/api/chats/${x.id}/fork`, { method: "POST", body: "{}" });
    assert.equal(ok201.status, 201, JSON.stringify(ok201.body));
    assert.deepEqual(prior(ok201.body.id), prior(x.id), "the fork carries the history completely, in order, with role and time");
    assert.equal(ok201.body.titled, true);
  });
});

// ── The question as the ONLY reason ──────────────────────────────────────────
// Sabotage: drop the condition "exactly question" ⇒ the third case red; replace `dismissAsk` by the /ask-answer path
// (deliverUserPrompt) ⇒ "no run" red.
test("\"dismiss question and archive\" dismisses the card without a run — but only if it is the only reason", async () => {
  await withServerValue(async ({ base, wsPath, turns }) => {
    const ws = await makeWorkspace(base, "Dismiss", wsPath);
    const z = await makeChat(base, ws.id);
    const card = question();
    store.addMessage(z.id, "ask", JSON.stringify(card));
    const without = await archive(base, z.id);
    assert.equal(without.status, 409);
    assert.deepEqual(without.body.open.map((o) => o.reason), ["question"]);
    const prior = turns().length;
    const including = await archive(base, z.id, { dismissQuestion: true });
    assert.equal(including.status, 200, JSON.stringify(including.body));
    assert.equal(typeof store.getChat(z.id).archivedAt, "number");
    const responses = store.listMessages(z.id).filter((r) => r.role === "ask_answer").map((r) => JSON.parse(r.text));
    assert.equal(responses.length, 1);
    assert.equal(responses[0].requestId, card.requestId);
    assert.equal(responses[0].dismissed, "archive");
    assert.deepEqual(responses[0].answers, []);
    assert.equal(openAskOf(z.id), null, "the card is closed");
    await new Promise((r) => setImmediate(r));
    assert.equal(running.has(z.id), false, "no run");
    assert.equal((await ok(`${base}/api/runs/active`)).busy, false, "no run (server)");
    assert.equal(turns().length, prior, "the CLI was not called");
    assert.equal(store.listMessages(z.id).some((r) => r.role === "user"), false, "no user row");

    // Card AND queue: 409 even with the field, the card stays open.
    const w = await makeChat(base, ws.id);
    const card2 = question();
    store.addMessage(w.id, "ask", JSON.stringify(card2));
    pendingRunInputs.set(w.id, [{ id: crypto.randomUUID(), prompt: "afterwards", display: "afterwards", attachments: [], cause: "user" }]);
    try {
      const r = await archive(base, w.id, { dismissQuestion: true });
      assert.equal(r.status, 409);
      assert.deepEqual(r.body.open.map((o) => o.reason), ["queue", "question"]);
      assert.equal(openAskOf(w.id)?.requestId, card2.requestId, "the card stays open");
      assert.equal(store.getChat(w.id).archivedAt, null);
      assert.equal(store.listMessages(w.id).some((m) => m.role === "ask_answer"), false);
    } finally { pendingRunInputs.delete(w.id); }
  });
});

// ── Two overlapping goal verdicts ────────────────────────────────────────────
// Sabotage: the marker as a Set (`targetCheckOn` = add, `targetCheckOff` = delete) ⇒ after verdict 1 the marker is gone
// although verdict 2 still runs — "409 target" red (200).
test("the goal marker counts: when the first of two overlapping verdicts ends, the second keeps the chat out of the archive", async () => {
  await withServerValue(async ({ base, root, wsPath, oneshots }) => {
    const h1 = path.join(root, "hold-one");
    const h2 = path.join(root, "hold-two");
    // One holder per verdict, recognized by the last user prompt in the verdict prompt (TWO first: the prompt of the first
    // verdict cannot contain TWO, it arose before).
    const HOLD = `    if (prompt.includes("You soberly check whether the overarching target")) {
      const mine = prompt.includes("MESSAGE-TWO") ? ${JSON.stringify(h2)} : prompt.includes("MESSAGE-ONE") ? ${JSON.stringify(h1)} : null;
      if (mine) {
        const wait = () => {
          if (fs.existsSync(mine)) return setTimeout(wait, 20);
          process.stdout.write(JSON.stringify({ result: JSON.stringify({ achieved: true, note: "reached" }) }));
          process.exit(0);
        };
        return wait();
      }
    }
`;
    const marker = '    let result = "Title";\n';
    assert.ok(fakeClaude.includes(marker), "the fake CLI lost its marker — the holder hangs on it");
    fs.writeFileSync(path.join(root, "fake-claude"), fakeClaude.replace(marker, HOLD + marker));
    const ws = await makeWorkspace(base, "Two verdicts", wsPath);
    const z = await makeChat(base, ws.id);
    await ok(`${base}/api/chats/${z.id}`, { method: "PATCH", body: JSON.stringify({ goal: "Goal Z is reached." }) });
    const verdict = (word) => oneshots().some((o) => String(o.prompt || "").includes("You soberly check") && String(o.prompt || "").includes(word));
    const goalRows = () => store.listMessages(z.id).filter((m) => m.role === "goal").length;
    fs.writeFileSync(h1, "hold");
    fs.writeFileSync(h2, "hold");
    try {
      await ok(`${base}/api/chats/${z.id}/message`, { method: "POST", body: JSON.stringify({ text: "MESSAGE-ONE" }) });
      await waitFor(async () => verdict("MESSAGE-ONE"), "verdict 1 runs");
      // The second message DURING verdict 1: the chat is not running (the verdict stands after `running.delete`), so run B
      // starts, and its goal gate judges while verdict 1 still holds.
      await ok(`${base}/api/chats/${z.id}/message`, { method: "POST", body: JSON.stringify({ text: "MESSAGE-TWO" }) });
      await waitFor(async () => verdict("MESSAGE-TWO"), "verdict 2 runs");
      await waitFor(async () => !running.has(z.id), "run B has ended");
      assert.deepEqual(await reasons(base, z.id), ["target"]);
      fs.rmSync(h1);
      await waitFor(async () => goalRows() === 1, "verdict 1 has fallen (its row is there — its finally ran in the same step)");
      assert.deepEqual(await reasons(base, z.id), ["target"], "verdict 2 still runs — the marker belongs to it");
      const r = await archive(base, z.id);
      assert.equal(r.status, 409, `during verdict 2: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.open.map((o) => o.reason), ["target"]);
      assert.equal(store.getChat(z.id).archivedAt, null);
    } finally { fs.rmSync(h1, { force: true }); fs.rmSync(h2, { force: true }); }
    // Verdict 2 has fallen when its marker is gone. It no longer writes a row (judging only concerns the goal that holds NOW) —
    // verdict 1 cleared the goal as reached.
    await waitFor(async () => (await reasons(base, z.id)).length === 0, "verdict 2 has fallen");
    assert.deepEqual(await reasons(base, z.id), [], "after both verdicts nothing is open anymore");
    assert.equal(goalRows(), 1, "verdict 2 writes no second row about the already reached (cleared) goal");
    assert.equal((await archive(base, z.id)).status, 200);
  });
});

// ── Folders: through the route, atomic 409, the event ───────────────────────
// Sabotage: the check after writing instead of before ⇒ "409 atomic" red; drop `reportArchive` in the PUT ⇒ the event
// lines red.
test("folders: archive with content, only those that went along come back, a chat fetches its folder, 409 changes nothing, exactly one chat_archive per action", async () => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Folder", wsPath);
    const f = await newFolder(base, ws.id, "Till");
    const c = [];
    for (let i = 0; i < 4; i++) { const x = await makeChat(base, ws.id); await inFolder(base, x.id, f.id); c.push(x.id); }
    const individual = await archive(base, c[3]);
    const individualAt = individual.body.chat.archivedAt;
    await waitFor(async () => Date.now() > individualAt, "the clock is past the timestamp of the individually archived one");
    assert.deepEqual(await ok(`${base}/api/chat-folders/${f.id}/archive`), { archived: false, archivedAt: null, chats: 3, contextFiles: 0, open: [], terminals: 0 });
    for (const wrong of [{}, { archived: "yes" }]) assert.equal((await json(`${base}/api/chat-folders/${f.id}/archive`, { method: "PUT", body: JSON.stringify(wrong) })).status, 400);

    const stream = await openStream(`${base}/api/events`);
    try {
      const way = await folderArchive(base, f.id, true);
      assert.equal(way.status, 200, JSON.stringify(way.body));
      assert.deepEqual(way.body.chatIds, c.slice(0, 3));
      await stream.waitFor((e) => e.type === "chat_archive" && e.folderIds?.includes(f.id), "event for the folder");
      assert.deepEqual(archiveEvents(stream), [{ type: "chat_archive", workspaceId: ws.id, kind: "normal", chatIds: c.slice(0, 3), folderIds: [f.id], archived: true, reason: "user" }]);
      for (const id of c) assert.equal(typeof store.getChat(id).archivedAt, "number", `${id} archived`);
      assert.equal((await folderArchive(base, f.id, true)).body.unchanged, true);

      // Exactly the three come back, the individually archived one stays.
      const to = await folderArchive(base, f.id, false);
      assert.deepEqual(to.body.chatIds, c.slice(0, 3));
      assert.equal(store.getChatFolder(f.id).archivedAt, null);
      assert.equal(store.getChat(c[3]).archivedAt, individualAt, "the individually archived one stays, with its timestamp");
      await untilEvents(stream, 2, "event for restoring the folder");
      assert.deepEqual(archiveEvents(stream)[1], { type: "chat_archive", workspaceId: ws.id, kind: "normal", chatIds: c.slice(0, 3), folderIds: [f.id], archived: false, reason: "user" });

      // Archive the folder again, bring ONE chat back ⇒ the folder comes along, the others stay.
      assert.equal((await folderArchive(base, f.id, true)).status, 200);
      await untilEvents(stream, 3, "event for the second archiving");
      const one = await back(base, c[1]);
      assert.deepEqual(one.body.folderIds, [f.id], "the answer says the folder came along");
      await untilEvents(stream, 4, "event for the chat");
      assert.deepEqual(archiveEvents(stream).at(-1), { type: "chat_archive", workspaceId: ws.id, kind: "normal", chatIds: [c[1]], folderIds: [f.id], archived: false, reason: "user" });
      assert.equal(await watchdogPlace(base, ws.id, stream), 4, "exactly one event per action");
      assert.equal(store.getChatFolder(f.id).archivedAt, null);
      for (const id of [c[0], c[2], c[3]]) assert.equal(typeof store.getChat(id).archivedAt, "number", `${id} stays in the archive`);
    } finally { await stream.close(); }

    // Atomic 409: a chat runs ⇒ nothing archived, neither it nor the neighbor nor the folder.
    const g = await newFolder(base, ws.id, "Running");
    const g1 = await makeChat(base, ws.id);
    const g2 = await makeChat(base, ws.id);
    await inFolder(base, g1.id, g.id);
    await inFolder(base, g2.id, g.id);
    await ok(`${base}/api/chats/${g1.id}/message`, { method: "POST", body: JSON.stringify({ text: "STAY-OPEN" }) });
    await waitFor(async () => running.has(g1.id), "g1 runs");
    const before = await ok(`${base}/api/chat-folders/${g.id}/archive`);
    assert.deepEqual(before.open.map((o) => [o.chatId, o.open.map((x) => x.reason)]), [[g1.id, ["running"]]]);
    const r = await folderArchive(base, g.id, true);
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.chats.map((x) => x.chatId), [g1.id]);
    assert.equal(store.getChatFolder(g.id).archivedAt, null, "the folder is not archived");
    assert.equal(store.getChat(g2.id).archivedAt, null, "the neighbor is not archived");
    assert.equal(store.getChat(g1.id).archivedAt, null);
    await ok(`${base}/api/chats/${g1.id}/stop`, { method: "POST" });
    await waitForIdle(base);
  });
});

// ── No run in the archive: every way fetches back — except an agent ────────────
// Sabotage: drop the call `fetchBack(` in doRun ⇒ (b) and (c) red; drop the archive hold in channels/delivery.js
// deliverChannel ⇒ (a) red.
// (b) The same delivery (runs/queue.js deliverUserPrompt with cause "user") that the former proposal `chat_message` called.
test("no run in the archive: a channel message stops at the archived chat (note at the sender, no run), a delivery with cause \"user\" fetches it back (event reason \"work\"), and doRun calls fetchBack right after running.add", async () => {
  await withServerValue(async ({ base, wsPath, turns }) => {
    const ws = await makeWorkspace(base, "Work", wsPath);
    // The sender is a coding chat (a manager chat no longer writes, runs/manager-lock.js).
    const sender = await makeChat(base, ws.id);
    const coding = await makeChat(base, ws.id);
    const channel = await ok(`${base}/api/workspaces/${ws.id}/channels`, {
      method: "POST", body: JSON.stringify({ name: "Till", participants: [sender.id, coding.id] }),
    });
    await waitForIdle(base);
    assert.equal((await archive(base, coding.id)).status, 200);
    const d = await makeChat(base, ws.id);
    assert.equal((await archive(base, d.id)).status, 200);

    const stream = await openStream(`${base}/api/events`);
    try {
      // (a) Channel: the message waits, the chat stays in the archive, the sender gets a system note.
      await ok(`${base}/api/channels/${channel.id}/messages`, { method: "POST", body: JSON.stringify({ chatId: sender.id, text: "CHANNEL-JOB: check payment flow." }) });
      await waitForIdle(base);
      assert.ok(store.getChat(coding.id).archivedAt, "the chat stays archived");
      assert.equal(turns().some((t) => t.text.includes("CHANNEL-JOB: check payment flow.")), false, "no run");
      assert.equal(store.getChannelParticipants(channel.id, coding.id).cursor, 0, "the cursor stays");
      assert.ok(store.listMessages(sender.id).some((z) => z.role === "channel" && JSON.parse(z.text).systemKind === "archived"), "note at the sender");

      // (b) Delivery with cause "user" (the way of the old proposal chat_message).
      deliverUserPrompt(store.getChat(d.id), { prompt: "PROPOSAL: please continue.", display: "PROPOSAL: please continue.", cause: "user" });
      const e2 = await stream.waitFor((e) => e.type === "chat_archive" && e.chatIds?.includes(d.id), "fetch-back by delivery");
      assert.equal(e2.archived, false);
      assert.equal(e2.reason, "work");
      assert.equal(e2.cause, "user");
      assert.equal(store.getChat(d.id).archivedAt, null);
      await waitFor(async () => turns().some((t) => t.text.includes("PROPOSAL: please continue.")), "the run has run");
      await waitForIdle(base);
      assert.equal(await watchdogPlace(base, ws.id, stream), 1, "exactly one event per fetch-back — the channel message does not fetch back");
    } finally { await stream.close(); }

    // (c) Source text: the second statement of doRun, before the first await.
    const doRun = source("runs/do-run.js");
    const header = doRun.slice(doRun.indexOf("async function doRun("));
    const rows = header.split("\n").slice(1).map((z) => z.trim()).filter((z) => z && !z.startsWith("//"));
    // Before it only the catcher "read-only" (runs/only-readable.js) stands: it returns synchronously BEFORE the chat is in
    // `running` — such a chat begins no run, so nothing fetches it back either. Then the catcher "stays in the archive"
    // (runs/archive.js staysInArchive): a channel/message to an archived chat likewise returns synchronously before the chat
    // is in `running`. In between the catcher of kind "manager" (runs/manager-lock.js) — a manager chat begins no run. Exactly
    // these three lines.
    assert.equal(rows[0], "if (onlyReadable(chat)) { clearAwayOnlyReadable(chat.id); return; }", "before running.add first the catcher \"read-only\"");
    assert.match(rows[1], /^if \(managerLocked\(chat\)\) return;/, "then the catcher of kind \"manager\"");
    assert.match(rows[2], /^if \(staysInArchive\(chat\.id, cause\)\) return;/, "then the catcher \"stays in the archive\"");
    assert.equal(rows[3], "running.add(chat.id);");
    assert.match(rows[4], /^fetchBack\(chat\.id, \{ cause \}\);/, "fetchBack stands directly after running.add");
    assert.ok(header.indexOf("fetchBack(") < header.indexOf("await "), "before the first await (and thus before the credit gate)");
    // Every run ends in doRun: runChat( only appears there, in the subagent core, in its definition and in the wiring of the
    // core by the agent owner runs/agents.js.
    const hits = fs.readdirSync(SERVER_DIR, { recursive: true }).map(String).filter((f) => f.endsWith(".js") && !f.includes("node_modules"))
      .filter((f) => /\brunChat\(/.test(source(f).split("\n").filter((z) => !z.trim().startsWith("//")).join("\n"))).sort();
    assert.deepEqual(hits, ["providers/agent-runtime.js", "providers/index.js", "runs/agents.js", "runs/do-run.js"]);
  });
});

// ── Write lock ──────────────────────────────────────────────────────────────
// Sabotage: drop the check in chatRoutes ⇒ matrix red; widen `m === "GET"` to `m !== "POST"` in archiveAllowed (PATCH/PUT/
// DELETE would pass) ⇒ the PATCH/PUT/DELETE lines red; move the check after coreChatRoutes ⇒ source text red.
// `/stop`: POST /stop is the emergency valve and allowlisted (own test below); PUT/PATCH/DELETE on /stop stay in the matrix
// and locked.
const LOCK_PATHS = ["", "/message", `/message/queue/${crypto.randomUUID()}`, "/fork", "/workflow", "/workflow/skip", "/attachments?name=x",
  "/artifacts/file", `/todos/${crypto.randomUUID()}`, "/skills/x", "/channels", `/channels/${crypto.randomUUID()}`, "/channel-status", "/hooks",
  `/captures/c-${crypto.randomUUID()}/send`, "/compact", "/clear", "/stop", "/control", "/auto-continue", "/never-seen", "/dyn-workflows/runs/wf_x/stop",
  // The deposit takeover of an attachment is gone: locked in the archive like any unknown way.
  "/attachments/x1-note.txt/deposit",
  // The decision at the approval card starts a run — locked in the archive (not on the allowlist).
  "/dyn-workflows/approval",
  // Graph workflows: the start is locked, stopping a start is an emergency valve (allowlisted).
  "/graph-workflows/start", "/graph-workflows/gs_x/stop",
  // The Teams watch left cbase (D2): its former stop path is an unknown way like any other — locked.
  "/watches/w_x/stop"];
const READ_PATHS = ["", "/log", "/artifacts", "/archive", "/agents", "/channels", "/auto-continue", "/workflow"];
const allowlisted = (m, sub) => (m === "DELETE" && sub === "") || (m === "PUT" && sub === "/archive") || (m === "POST" && sub === "/stop")
  || (m === "POST" && sub === "/dyn-workflows/runs/wf_x/stop") || (m === "POST" && sub === "/graph-workflows/gs_x/stop");

test("write lock: an archived chat accepts only reading, restoring, permanent delete and stop — everything else 409, also unknown paths", async () => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Lock", wsPath);
    const a = await makeChat(base, ws.id);
    await ok(`${base}/api/chats/${a.id}`, { method: "PATCH", body: JSON.stringify({ title: "Locked" }) });
    // The deposit route only took attachments of a manager chat, which is read-only — only the allowlist as a function is
    // tested here.
    const attachment = { file: "x1-note.txt" };
    assert.equal((await archive(base, a.id)).status, 200);
    const rowsPrior = store.listMessages(a.id).length;

    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const sub of LOCK_PATHS) {
        if (allowlisted(m, sub)) continue;
        const r = await json(`${base}/api/chats/${a.id}${sub}`, { method: m, body: JSON.stringify({ text: "x", title: "y" }) });
        assert.equal(r.status, 409, `${m} ${sub || "(empty)"} ⇒ 409, war ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body?.archived, true, `${m} ${sub}: marker archived`);
        assert.equal(archiveAllowed(sub.split("?")[0], m), false, `archiveAllowed(${sub}, ${m})`);
      }
    }
    for (const sub of READ_PATHS) {
      const r = await json(`${base}/api/chats/${a.id}${sub}`);
      assert.notEqual(r.status, 409, `GET ${sub || "(empty)"} is never locked: ${JSON.stringify(r.body)}`);
      assert.equal(archiveAllowed(sub, "GET"), true);
    }
    // The allowlist: PUT /archive (here "unchanged"), DELETE "" (own test). The deposit takeover is gone and with it the
    // allowlist row — counter-test: the old row in archiveAllowed ⇒ red.
    assert.equal((await archive(base, a.id)).status, 200);
    assert.equal(archiveAllowed("/archive", "PUT"), true);
    assert.equal(archiveAllowed("", "DELETE"), true);
    assert.equal(archiveAllowed(`/attachments/${attachment.file}/deposit`, "POST"), false, "the deposit route no longer exists");
    assert.equal(archiveAllowed("/archive", "POST"), false);
    assert.equal(archiveAllowed("/stop", "POST"), true, "stop is allowed in the archive");
    assert.equal(archiveAllowed("/stop", "PUT"), false);
    // Stopping the dynamic workflow is an emergency valve like /stop — reaches the route (404: no such run).
    // Sabotage: drop the line in archiveAllowed ⇒ 409, red.
    assert.equal(archiveAllowed("/dyn-workflows/runs/wf_x/stop", "POST"), true, "workflow stop is allowed in the archive");
    assert.equal(archiveAllowed("/dyn-workflows/stop", "POST"), false, "the tool's path is not on the allowlist");
    const wfStop = await json(`${base}/api/chats/${a.id}/dyn-workflows/runs/wf_x/stop`, { method: "POST", body: "{}" });
    assert.equal(wfStop.status, 404, `workflow stop in the archive reaches the route: ${JSON.stringify(wfStop.body)}`);
    // The stop of a graph start likewise (404 unknown: no such start); the start stays 409.
    // Sabotage: drop the line in archiveAllowed ⇒ 409, red.
    assert.equal(archiveAllowed("/graph-workflows/gs_x/stop", "POST"), true, "graph stop is allowed in the archive");
    assert.equal(archiveAllowed("/graph-workflows/start", "POST"), false, "the start is not on the allowlist");
    const gStop = await json(`${base}/api/chats/${a.id}/graph-workflows/gs_x/stop`, { method: "POST", body: "{}" });
    assert.equal(gStop.status, 404, `graph stop in the archive reaches the route: ${JSON.stringify(gStop.body)}`);
    assert.equal(gStop.body?.reason, "unknown");

    // Nothing has changed.
    const after = store.getChat(a.id);
    assert.equal(typeof after.archivedAt, "number");
    assert.equal(after.title, "Locked");
    assert.equal(store.listMessages(a.id).length, rowsPrior, "no row added");

    // Source text: the lock stands in chatRoutes between the 404 line and the sub-table.
    const src = source("chats/routes.js");
    const eig = src.slice(src.indexOf("export async function chatRoutes("), src.indexOf("export function archiveAllowed("));
    const i404 = eig.indexOf('if (!chat) return send(res, 404');
    const iLock = eig.indexOf("archiveAllowed(");
    const iFor = eig.indexOf("for (const s of [");
    assert.ok(i404 >= 0 && iLock > i404 && iFor > iLock, `order 404 < archiveAllowed < sub-table: ${i404}, ${iLock}, ${iFor}`);
    const core = src.slice(src.indexOf("export async function coreChatRoutes("), src.indexOf("export async function contextChatRoutes("));
    assert.equal(core.includes("archiveAllowed("), false, "the lock does not belong in a sub-slice");
  });
});

// ── Stop is allowed in the archive (emergency valve) ──────────────────────────
// Sabotage: drop the line `if (sub === "/stop" && m === "POST") return true;` in archiveAllowed ⇒ 409, red (the run would
// keep running — the emergency brake in `withServerValue` fetches it back for stopping, no hang).
test("POST /stop halts a run that runs in an archived chat with a broken invariant — the chat stays archived", async () => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Valve", wsPath);
    const x = await makeChat(base, ws.id);
    await ok(`${base}/api/chats/${x.id}/message`, { method: "POST", body: JSON.stringify({ text: "STAY-OPEN" }) });
    await waitFor(async () => running.has(x.id), "the run is there");
    assert.equal((await archive(base, x.id)).status, 409, "the route does not archive a running chat");
    // Break the invariant by hand: archive past the store — exactly the case the emergency valve is for.
    assert.equal(store.archiveChat(x.id, Date.now()), true);
    const at = store.getChat(x.id).archivedAt;
    const r = await json(`${base}/api/chats/${x.id}/stop`, { method: "POST" });
    assert.equal(r.status, 200, `stop in the archive: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
    await waitFor(async () => !running.has(x.id), "the run has ended");
    assert.equal(store.getChat(x.id).archivedAt, at, "stop does not fetch back and does not re-archive");
    const empty = await json(`${base}/api/chats/${x.id}/stop`, { method: "POST" });
    assert.deepEqual([empty.status, empty.body.ok], [200, false], "without a run as always: ok false, no 409");
    assert.equal((await json(`${base}/api/chats/${x.id}/stop`, { method: "PUT" })).status, 409, "only POST is the emergency valve");
  });
});

// ── The lock AFTER the body ──────────────────────────────────────────────────
// Sabotage: drop `archivedNow` in the PATCH ⇒ "PATCH ⇒ 409" red (200, title, goal and pin changed); drop it in the attachment
// upload ⇒ red (201, the file lies in the archived chat); drop it at one of the other places ⇒ the source-text part red.
test("write lock after the body: a PATCH or upload that begins BEFORE archiving does not write into the archived chat afterwards", async () => {
  await withServerValue(async ({ base, root, wsPath }) => {
    const ws = await makeWorkspace(base, "Body", wsPath);
    const x = await makeChat(base, ws.id);
    await ok(`${base}/api/chats/${x.id}`, { method: "PATCH", body: JSON.stringify({ title: "Before" }) });
    const pa = heldRequest(base, "PATCH", `/api/chats/${x.id}`, JSON.stringify({ title: "renamed in the archive", goal: "goal in the archive", pinned: true }));
    await pa.ready;
    assert.equal((await archive(base, x.id)).status, 200, "archiving goes through while the body is pending");
    pa.send();
    const r = await pa.response;
    assert.equal(r.status, 409, `PATCH after archiving: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.archived, true);
    const after = store.getChat(x.id);
    assert.deepEqual([after.title, after.goal, after.pinned, typeof after.archivedAt], ["Before", "", false, "number"], "nothing written, archived");

    const y = await makeChat(base, ws.id);
    const up = heldRequest(base, "POST", `/api/chats/${y.id}/attachments?name=large.txt`, "Content of the attachment", "application/octet-stream");
    await up.ready;
    assert.equal((await archive(base, y.id)).status, 200);
    up.send();
    const u = await up.response;
    assert.equal(u.status, 409, `upload after archiving: ${JSON.stringify(u.body)}`);
    const dir = path.join(root, "data-root", "data", "attachments", y.id);
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], "no file in the archived chat");

    // Counter-test: the same held path on an ACTIVE chat goes through — the 409 comes from the archive, not from holding.
    const z = await makeChat(base, ws.id);
    const gp = heldRequest(base, "PATCH", `/api/chats/${z.id}`, JSON.stringify({ title: "Renamed while active" }));
    await gp.ready;
    gp.send();
    assert.equal((await gp.response).status, 200);
    assert.equal(store.getChat(z.id).title, "Renamed while active");

    // Source text: every body place of the chat sub-slices checks afterwards, or names its reason at the await.
    const rows = source("chats/routes.js").split("\n");
    const start = rows.findIndex((z) => z.startsWith("export async function archiveChatRoutes("));
    assert.ok(start > 0, "archiveChatRoutes found");
    const CHECK = "if (archivedNow(id)) return send(res, 409, archiveLock());";
    const places = [];
    for (let i = start; i < rows.length; i++) {
      if (!/await read(Raw)?Body(OrEmpty)?\(/.test(rows[i])) continue; // also readBodyOrEmpty
      const reason = rows[i].match(/\/\/ archive: (.+)$/)?.[1] || "";
      const checked = rows.slice(i + 1, i + 4).some((n) => n.includes(CHECK));
      places.push({ row: i + 1, reason, checked });
    }
    const without = places.filter((st) => !st.reason && !st.checked);
    assert.deepEqual(without, [], "body place without a second lock and without `// archive: <reason>`");
    assert.deepEqual(places.filter((st) => st.reason && st.checked), [], "an exception that does check is none");
    const n = places.filter((st) => st.checked).length;
    assert.ok(n >= 5, `at least PATCH, todo, attachment, artifact write, artifact upload: ${n}`);
    console.log(`[archive] measurement line: ${places.length} body places in the chat sub-slices — ${n} check afterwards, ${places.length - n} named exceptions (${places.filter((st) => st.reason).map((st) => `l. ${st.row}`).join(", ")})`);
  });
});

// ── Shells ───────────────────────────────────────────────────────────────────
// Sabotage: drop `killTerminalsByTag` in the PUT ⇒ "a1/a2 dead" red; drop the 409 branch in code-route.js ⇒ "new shell ⇒ 409"
// red.
test("the precheck counts the chat's shells, archiving ends exactly them, and a new shell for the archived chat is 409", async () => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Shells", wsPath);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    const all = [];
    const mk = async (tag) => {
      const r = await json(`${base}/api/workspaces/${ws.id}/terminal`, { method: "POST", body: JSON.stringify({ cols: 80, rows: 24, tag }) });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.available, true, `node-pty missing: ${JSON.stringify(r.body)}`);
      all.push(r.body.id);
      return r.body.id;
    };
    const alive = async (id) => (await json(`${base}/api/terminal/${id}/exists`)).body.exists;
    try {
      const a1 = await mk(`chat:${a.id}`);
      const a2 = await mk(`chat:${a.id}`);
      const b1 = await mk(`chat:${b.id}`);
      assert.equal((await precheck(base, a.id)).terminals, 2);
      assert.equal((await precheck(base, b.id)).terminals, 1);
      const r = await archive(base, a.id);
      assert.equal(r.status, 200);
      assert.equal(r.body.terminalsEnded, 2);
      assert.equal(await alive(a1), false, "a1 dead");
      assert.equal(await alive(a2), false, "a2 dead");
      assert.equal(await alive(b1), true, "b1 alive");
      const fresh = await json(`${base}/api/workspaces/${ws.id}/terminal`, { method: "POST", body: JSON.stringify({ cols: 80, rows: 24, tag: `chat:${a.id}` }) });
      // If it arose anyway (the promise is broken), it belongs in the finally — a living PTY would keep the event loop open,
      // and the failure would become a hang.
      if (fresh.body?.id) all.push(fresh.body.id);
      assert.equal(fresh.status, 409, `new shell ⇒ 409: ${JSON.stringify(fresh.body)}`);
      assert.equal(fresh.body.archived, true);
      assert.equal((await precheck(base, a.id)).terminals, 0);
      // Restored: the shell works again.
      assert.equal((await back(base, a.id)).status, 200);
      await mk(`chat:${a.id}`);
    } finally {
      for (const id of all) await fetch(`${base}/api/terminal/${id}`, { method: "DELETE" }).catch(() => {});
    }
  });
});

// ── Sibling artifacts (readable) ─────────────────────────────────────────────
// Sabotage: filter `listChatsInFolder` to active ones ⇒ 403 instead of 200, red.
test("sibling artifacts: an active chat reads the artifact of its archived neighbor in the folder", async () => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Siblings", wsPath);
    const f = await newFolder(base, ws.id);
    const a = await makeChat(base, ws.id);
    const b = await makeChat(base, ws.id);
    await inFolder(base, a.id, f.id);
    await inFolder(base, b.id, f.id);
    await ok(`${base}/api/chats/${b.id}/artifacts/file`, { method: "PUT", body: JSON.stringify({ path: "note.md", content: "# Status\n" }) });
    assert.equal((await archive(base, b.id)).status, 200);
    const r = await json(`${base}/api/chats/${a.id}/artifacts/file?chatId=${b.id}&path=note.md`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.chatId, b.id);
  });
});

// ── Permanent delete and the ONE delete cascade ───────────────────────────────
// Sabotage: drop the state check (`!folder.archivedAt`) ⇒ "on the active one ⇒ 400" red; comment out the kill line in
// chats/delete.js ⇒ terminal-tag.test.js "a1 dead" red.
test("permanent delete: an archived chat with cascade (channel closed), an archived folder with chats and context files; on the active folder and with permanently≠1 ⇒ 400", async () => {
  await withServerValue(async ({ base, wsPath, ctxDir }) => {
    const ws = await makeWorkspace(base, "Deleting", wsPath);
    // The counterpart is a coding chat (a channel with a manager chat is frozen and no longer closes).
    const opposite = await makeChat(base, ws.id);
    const x = await makeChat(base, ws.id);
    const channel = await ok(`${base}/api/workspaces/${ws.id}/channels`, { method: "POST", body: JSON.stringify({ name: "Path", participants: [opposite.id, x.id] }) });
    await waitForIdle(base);
    assert.equal((await archive(base, x.id)).status, 200);
    assert.equal((await json(`${base}/api/chats/${x.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await json(`${base}/api/chats/${x.id}`)).status, 404);
    assert.equal(store.listMessages(x.id).length, 0, "the history is gone");
    assert.equal((await ok(`${base}/api/channels/${channel.id}`)).status, "closed", "the cascade closes the channel");

    // Folder: active ⇒ 400; archived with "yes" ⇒ 400; archived with 1 ⇒ everything gone.
    const f = await newFolder(base, ws.id, "Get rid of it");
    const c1 = await makeChat(base, ws.id);
    const c2 = await makeChat(base, ws.id);
    await inFolder(base, c1.id, f.id);
    await inFolder(base, c2.id, f.id);
    await fetch(`${base}/api/chat-folders/${f.id}/context/upload?name=brief.md`, { method: "POST", body: "# Brief\n" });
    assert.ok(fs.existsSync(ctxDir(f.id)), "context file is there");
    assert.equal((await json(`${base}/api/chat-folders/${f.id}?permanently=1`, { method: "DELETE" })).status, 400, "on the active folder ⇒ 400");
    assert.equal(store.getChatFolder(f.id).id, f.id);
    assert.equal((await folderArchive(base, f.id, true)).status, 200);
    assert.equal((await json(`${base}/api/chat-folders/${f.id}?permanently=yes`, { method: "DELETE" })).status, 400, "permanently=yes ⇒ 400");
    assert.equal(store.getChatFolder(f.id).id, f.id, "nothing deleted");
    const prior = await ok(`${base}/api/chat-folders/${f.id}/archive`);
    assert.equal(prior.chats, 2, "the precheck number on the archived folder");
    assert.equal(prior.contextFiles, 1);
    const d = await json(`${base}/api/chat-folders/${f.id}?permanently=1`, { method: "DELETE" });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.chats, 2);
    assert.equal(d.body.contextFiles, 1);
    assert.equal(store.getChatFolder(f.id), undefined, "the folder is gone");
    for (const c of [c1, c2]) assert.equal((await json(`${base}/api/chats/${c.id}`)).status, 404, "the chats are gone");
    assert.equal(fs.existsSync(ctxDir(f.id)), false, "the context files are gone");

    // Source text: both paths call the ONE cascade.
    const src = source("chats/routes.js");
    const del = src.slice(src.indexOf('if (sub === "" && m === "DELETE")'), src.indexOf('if (sub === "/log" && m === "GET")'));
    assert.ok(del.includes("deleteChatPermanently(chat)"), "DELETE /api/chats/:id ruft deleteChatPermanently");
    assert.equal(del.includes("store.deleteChat("), false, "no second cascade in the body");
    const ord = src.slice(src.indexOf('url.searchParams.has("permanently")'), src.indexOf("Deleting a folder ONLY dissolves the grouping"));
    assert.ok(ord.includes("deleteChatPermanently(c)"), "the folder path calls deleteChatPermanently");
  });
});

// ── The folder side of the kind check and permanent delete ───────────────────
// The guard for "the precheck names the numbers": the number a client shows in the delete precheck (GET …/archive on the
// archived folder) is the number of chats that are ACTUALLY gone afterwards — on a mixed folder with a coding chat and an
// app-agent chat (legacy data).
// A manager folder is frozen (runs/manager-lock.js): every writing path is 409, so the calculation is tested on the coding
// folder. Sabotage: in the DELETE branch `store.chatsInFolder(folder.id, { archive: "only" })` instead of `finalSet(folder)`
// ⇒ "precheck == deleted" red; drop the filter in `finalSet` ⇒ "the app-agent chat survives" red; drop the kind check in
// chatCreateRoute ⇒ the 400 red; `folderLocks` without the kind line ⇒ "app-agent chat in the folder ⇒ 409" red; drop the kind
// line in the PATCH ⇒ "PATCH into a folder ⇒ 400" red; drop the folder lock in chats/routes.js ⇒ "manager folder ⇒ 409" red.
test("folders: no new mixed folder, a manager folder is frozen (409), a non-archivable chat locks the folder (409), and the delete precheck names exactly what is gone", async () => {
  await withServerValue(async ({ base, wsPath, ctxDir }) => {
    const ws = await makeWorkspace(base, "Mixed", wsPath);
    const m1 = newConversation(ws.id, "Conversation in the folder");
    store.addMessage(m1.chatId, "user", "What is due?");
    const mf = newManagerFolder(ws.id, "Schedule X");
    const cf = await newFolder(base, ws.id, "Coding folder");
    // The PATCH of a manager chat is 409 — the legacy "conversation in a manager folder" arises at the store.
    assert.equal((await json(`${base}/api/chats/${m1.chatId}`, { method: "PATCH", body: JSON.stringify({ folderId: mf.id }) })).status, 409);
    store.updateChat(m1.chatId, { folderId: mf.id });

    // No new mixed folders: POST /api/chats checks the kind like PATCH.
    const post = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, folderId: mf.id }) });
    assert.equal(post.status, 400, `POST /api/chats into a manager folder: ${JSON.stringify(post.body)}`);
    const newInFolder = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, folderId: cf.id }) });
    assert.equal(newInFolder.status, 201, "coding folder: as always");
    store.updateChat(newInFolder.body.id, { folderId: null }); // the numbers below only mean the legacy chats

    // The manager folder is frozen — archive, rename, delete, context upload 409, nothing changes; reading stays.
    const upload = async (fid) => {
      const x = await fetch(`${base}/api/chat-folders/${fid}/context/upload?name=brief.md`, { method: "POST", body: "# Brief\n" });
      return { status: x.status, body: await x.json() };
    };
    for (const [what, r] of [
      ["Archive", await folderArchive(base, mf.id, true)],
      ["Rename", await json(`${base}/api/chat-folders/${mf.id}`, { method: "PATCH", body: JSON.stringify({ name: "Fresh" }) })],
      ["Delete", await json(`${base}/api/chat-folders/${mf.id}`, { method: "DELETE" })],
      ["Context", await upload(mf.id)],
    ]) {
      assert.equal(r.status, 409, `${what}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.managerLocked, true, `${what}: the answer says why`);
    }
    assert.deepEqual([store.getChatFolder(mf.id).archivedAt, store.getChatFolder(mf.id).name, store.getChat(m1.chatId).folderId], [null, "Schedule X", mf.id], "409 changes nothing");
    assert.equal((await ok(`${base}/api/chat-folders/${mf.id}/archive`)).archived, false, "reading stays");

    // Kind check at the source: an app agent belongs in no folder; the administrator is a manager chat and thus 409 — and the
    // old app-agent chat is read-only too (runs/only-readable.js): 409 before the folder check.
    const now = Date.now();
    const verw = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", title: "Administrator", createdAt: now, updatedAt: now });
    store.updateChat(verw.id, { specialRole: "administrator" });
    const appChat = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "service", title: "Service", createdAt: now, updatedAt: now });
    for (const [c, f, status] of [[verw, mf, 409], [appChat, cf, 409]]) {
      const r = await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ folderId: f.id }) });
      assert.equal(r.status, status, `${c.title}: PATCH into a folder ⇒ ${status}: ${JSON.stringify(r.body)}`);
      assert.equal(store.getChat(c.id).folderId, null);
    }

    // Legacy data in the coding folder: a coding chat and the app-agent chat in it (past the store).
    const coding = await makeChat(base, ws.id);
    store.addMessage(coding.id, "user", "Hello"); // written to, otherwise it would be in no archive list
    store.updateChat(coding.id, { folderId: cf.id });
    store.updateChat(appChat.id, { folderId: cf.id });
    const before = await ok(`${base}/api/chat-folders/${cf.id}/archive`);
    assert.deepEqual(before.open.map((o) => [o.chatId, o.open.map((x) => x.reason)]), [[appChat.id, ["not_archivable"]]], "the app-agent chat is a reason");
    assert.ok(before.open[0].open[0].text.length > 10, "with server text");
    const locked = await folderArchive(base, cf.id, true);
    assert.equal(locked.status, 409, JSON.stringify(locked.body));
    assert.deepEqual(locked.body.chats.map((c) => c.chatId), [appChat.id]);
    for (const id of [coding.id, appChat.id]) assert.equal(store.getChat(id).archivedAt, null, "409 changes nothing");
    assert.equal(store.getChatFolder(cf.id).archivedAt, null);
    // The old app-agent chat is read-only (runs/only-readable.js) — no PATCH anymore either. In operation none lies in a
    // folder (it never went in, see above — this one is in it past the store), so it comes out past the store too.
    assert.equal((await json(`${base}/api/chats/${appChat.id}`, { method: "PATCH", body: JSON.stringify({ folderId: null }) })).status, 409, "read-only");
    store.updateChat(appChat.id, { folderId: null });

    // Archiving takes the coding chat along, the number before it names it.
    assert.equal((await upload(cf.id)).status, 201);
    assert.deepEqual(await ok(`${base}/api/chat-folders/${cf.id}/archive`), { archived: false, archivedAt: null, chats: 1, contextFiles: 1, open: [], terminals: 0 });
    const way = await folderArchive(base, cf.id, true);
    assert.equal(way.status, 200, JSON.stringify(way.body));
    assert.deepEqual(way.body.chatIds, [coding.id]);
    // Legacy two: an ARCHIVED app-agent chat in the archived folder — past the store, since no route creates them anymore
    // (an active one would bring the folder back via the trigger invariant).
    assert.equal(store.archiveChat(appChat.id, Date.now()), true);
    store.updateChat(appChat.id, { folderId: cf.id });

    // The precheck numbers — from the server, from the SAME function as deleting.
    const back = await ok(`${base}/api/chat-folders/${cf.id}/archive`);
    assert.deepEqual([back.archived, back.chats, back.contextFiles, back.open, back.terminals], [true, 1, 1, [], 0], JSON.stringify(back));
    const list = await ok(`${base}/api/chat-folders?workspaceId=${ws.id}&archive=only`);
    assert.equal(list.find((f) => f.id === cf.id)?.chatCount, back.chats, "chatCount of the archive list == precheck number");
    const all = [coding.id, appChat.id];
    const d = await json(`${base}/api/chat-folders/${cf.id}?permanently=1`, { method: "DELETE" });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const gone = all.filter((id) => !store.getChat(id));
    assert.deepEqual(gone, [coding.id], "exactly the chat of the folder kind is gone");
    assert.equal(gone.length, back.chats, "precheck number == actually deleted");
    assert.deepEqual([d.body.chats, d.body.contextFiles], [back.chats, back.contextFiles], "answer == precheck");
    assert.equal(fs.existsSync(ctxDir(cf.id)), false, "the context file is gone");
    assert.equal(store.getChat(appChat.id)?.folderId, null, "the app-agent chat survives, detached");
    // The manager folder and its conversation: untouched.
    assert.deepEqual([store.getChatFolder(mf.id)?.id, store.getChat(m1.chatId)?.folderId], [mf.id, mf.id]);
  });
});

// ── Follow-up findings ───────────────────────────────────────────────────────
// 1: forking a manager conversation is 409 and creates no chat; in the coding folder the fork stays where the original lies.
//    The rest in the test "fork takes over the kind" below.
// 2: a non-archivable chat in the folder appears in no list — reason text and 409 name title and KIND and the only way out.
//    Sabotage: the old text ("take it out of the folder first") or the old 409 sentence ⇒ red. On the manager folder the
//    folder lock (409 managerLocked) answers before this check.
// 3: channel_create from a manager chat is 409 — before the folder check at the proposal; no channel, no post.
// 4: if counting the context files fails (here: a symlink that `walkFiles` refuses), the number is `null` — in the precheck
//    (GET) as in the DELETE answer —, never a guessed 0; it is deleted anyway.
//    Sabotage: `catch { return 0; }` in the context-file counter ⇒ red.
test("follow-up findings: forking a manager conversation is locked, the lock names the invisible chats, channel_create from the manager is locked, an uncounted context file is null", async () => {
  await withServerValue(async ({ base, wsPath, ctxDir }) => {
    const ws = await makeWorkspace(base, "Follow-up", wsPath);
    const m = newConversation(ws.id, "Conversation to fork");
    const mf = newManagerFolder(ws.id, "Schedule Y");
    const cf = await newFolder(base, ws.id, "Coding folder");
    store.updateChat(m.chatId, { folderId: mf.id });

    // 1 — the fork of a manager conversation: 409, no new chat.
    const count = () => rawDb.prepare("SELECT COUNT(*) AS n FROM chats").get().n;
    const beforeFork = count();
    const fork = await json(`${base}/api/chats/${m.chatId}/fork`, { method: "POST", body: "{}" });
    assert.deepEqual([fork.status, fork.body.managerLocked], [409, true], JSON.stringify(fork.body));
    assert.equal(count(), beforeFork, "no chat created");
    // Counter-test: in the coding folder the fork stays where the original lies.
    const c = await makeChat(base, ws.id);
    await inFolder(base, c.id, cf.id);
    const fork2 = await json(`${base}/api/chats/${c.id}/fork`, { method: "POST", body: "{}" });
    assert.equal(fork2.status, 201, JSON.stringify(fork2.body));
    assert.equal(fork2.body.folderId, cf.id, "coding folder: the fork stays in the folder of the original");

    // 2 — legacy data: an app-agent chat in the coding folder (past the store); the administrator in the manager folder hits the lock.
    const now = Date.now();
    const verw = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", title: "Curator", createdAt: now, updatedAt: now });
    store.updateChat(verw.id, { specialRole: "administrator", folderId: mf.id });
    const mLock = await folderArchive(base, mf.id, true);
    assert.deepEqual([mLock.status, mLock.body.managerLocked], [409, true], JSON.stringify(mLock.body));
    const appChat = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "service", title: "Service X", createdAt: now, updatedAt: now });
    store.updateChat(appChat.id, { folderId: cf.id });
    const kind = "App-Agent (service)";
    const vp = await ok(`${base}/api/chat-folders/${cf.id}/archive`);
    const g = vp.open.find((o) => o.chatId === appChat.id);
    assert.deepEqual(g?.open.map((o) => o.reason), ["not_archivable"], JSON.stringify(vp.open));
    const text = g.open[0].text;
    assert.ok(text.includes(kind), `the reason names the kind "${kind}": ${text}`);
    assert.ok(text.includes("in keiner Chat-Liste"), `the reason says it is in no list: ${text}`);
    assert.ok(text.includes(`PATCH /api/chats/${appChat.id}`), `the reason names the way out including the id: ${text}`);
    assert.ok(!text.includes("erst aus dem Ordner nehmen"), "no longer the dead end from before");
    const r = await folderArchive(base, cf.id, true);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.ok(r.body.error.includes(`„${appChat.title}“ (${kind})`), `the 409 names title and kind: ${r.body.error}`);
    assert.equal(store.getChatFolder(cf.id).archivedAt, null, "409 changes nothing");
    // Only open work of a VISIBLE chat: the sentence stays the plain one, without addition (the reasons stand per row).
    store.updateChat(appChat.id, { folderId: null });
    const wait = await makeChat(base, ws.id);
    await inFolder(base, wait.id, cf.id);
    store.setPendingResume(wait.id, { prompt: "further", reason: "reset", limitGroup: "session", limitLabel: "5-hour window", resetsAt: now + 3600_000, dueAt: now + 3600_000, now });
    const onlyWork = await folderArchive(base, cf.id, true);
    assert.equal(onlyWork.status, 409, JSON.stringify(onlyWork.body));
    assert.equal(onlyWork.body.error, "Im Ordner ist noch Arbeit offen — nichts archiviert");
    store.clearPendingResume(wait.id);

    // 3 — channel_create from the manager chat: 409, no channel — with every folder.
    const channelsPrior = (await ok(`${base}/api/workspaces/${ws.id}/channels`)).items.length;
    const suggestion = (folderId) => json(`${base}/api/chats/${m.chatId}/channels`, { method: "POST", body: JSON.stringify({
      name: "Implementation", firstMessage: "Please implement.", fresh: { title: "Implementation", brief: "# Brief", folderId },
    }) });
    for (const fid of [mf.id, crypto.randomUUID(), cf.id]) {
      const v = await suggestion(fid);
      assert.equal(v.status, 409, `proposal with folder ${fid}: ${JSON.stringify(v.body)}`);
    }
    assert.equal((await ok(`${base}/api/workspaces/${ws.id}/channels`)).items.length, channelsPrior, "no channel created");

    // 4 — counting fails (symlink in the context folder) ⇒ null, in the precheck and in the DELETE answer.
    const uf = await newFolder(base, ws.id, "Uncountable");
    assert.equal((await fetch(`${base}/api/chat-folders/${uf.id}/context/upload?name=note.md`, { method: "POST", body: "# Note\n" })).status, 201);
    const empty = await ok(`${base}/api/chat-folders/${cf.id}/archive`);
    assert.equal(empty.contextFiles, 0, "a folder WITHOUT a context directory has 0 — no unknown");
    fs.symlinkSync(path.join(ctxDir(uf.id), "note.md"), path.join(ctxDir(uf.id), "reference.md"));
    const active = await ok(`${base}/api/chat-folders/${uf.id}/archive`);
    assert.equal(active.contextFiles, null, `on the active folder: unknown, not 0 — ${JSON.stringify(active)}`);
    assert.equal((await folderArchive(base, uf.id, true)).status, 200);
    const back = await ok(`${base}/api/chat-folders/${uf.id}/archive`);
    assert.deepEqual([back.archived, back.chats, back.contextFiles], [true, 0, null], JSON.stringify(back));
    const d = await json(`${base}/api/chat-folders/${uf.id}?permanently=1`, { method: "DELETE" });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual([d.body.chats, d.body.contextFiles], [0, null], "the answer says \"unknown\" like the precheck");
    assert.equal(fs.existsSync(ctxDir(uf.id)), false, "it is deleted anyway — including the link");
  });
});

// ── The fork takes over the kind of its original ─────────────────────────────
// Formerly every fork was fixed as a coding chat (`kind: "normal"`). Since no manager chat forks anymore (409 before any
// kind check), the cases manager conversation and schedule-run chat are gone. What remains on ONE server:
//   (a) a manager conversation, also the special chats administrator and extraction ⇒ 409 managerLocked, no new chat;
//   (c) a coding chat forks as always: coding chat, its folder, no agent, in the coding list;
//   (d) legacy data of a mixed folder (past the PATCH, via the store) is not continued: the fork of a coding chat from a
//       manager folder keeps its kind, the foreign folder falls away;
//   (e) app agent and the child chat of a background run ⇒ 400 with the reason in the sentence, and NO chat arises (rows of
//       the table counted).
// Sabotage in a copy: drop `if (refusal) …` ⇒ (e) red; `kindOf(inheritedFolder) === kind` → `true` ⇒ (d) red (mixed
// folder); drop the lock line in chats/routes.js ⇒ (a) red.
test("a fork takes over the kind of its original and stays in its folder; manager chats no longer fork, coding unchanged, legacy data not continued, non-forkable chats ⇒ 400 without a new chat", async () => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Forking", wsPath);
    const m = newConversation(ws.id, "To fork");
    const mf = newManagerFolder(ws.id, "Planning");
    const cf = await newFolder(base, ws.id, "Implementation");
    store.updateChat(m.chatId, { folderId: mf.id });
    store.addMessage(m.chatId, "user", "What is due?");
    const branch = (id) => json(`${base}/api/chats/${id}/fork`, { method: "POST", body: "{}" });
    const count = () => rawDb.prepare("SELECT COUNT(*) AS n FROM chats").get().n;
    const now = Date.now();
    const raw = (fields) => store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, createdAt: now, updatedAt: now, ...fields });
    const special = (role) => {
      const existing = rawDb.prepare("SELECT id FROM chats WHERE workspace_id = ? AND specialRole = ?").get(ws.id, role);
      const x = existing ? store.getChat(existing.id) : raw({ kind: "manager", title: role });
      store.updateChat(x.id, { specialRole: role });
      return store.getChat(x.id);
    };

    // (a) Manager chats ⇒ 409, no new chat.
    for (const x of [store.getChat(m.chatId), special("administrator"), special("pipeline")]) {
      const prior = count();
      const r = await branch(x.id);
      assert.deepEqual([r.status, r.body.managerLocked], [409, true], `${x.title}: ${JSON.stringify(r.body)}`);
      assert.equal(count(), prior, `${x.title}: no chat arises`);
    }

    // (c) Coding chat in the coding folder: unchanged.
    const c = await makeChat(base, ws.id);
    store.addMessage(c.id, "user", "Hello"); // the fork copies the history — an empty one would be in no list
    await inFolder(base, c.id, cf.id);
    const cc = await branch(c.id);
    assert.equal(cc.status, 201, JSON.stringify(cc.body));
    assert.deepEqual([cc.body.kind, cc.body.folderId, cc.body.agentId, cc.body.scheduleId], ["normal", cf.id, null, null], "coding chat, its folder, no agent");
    assert.ok((await ok(`${base}/api/chats?workspaceId=${ws.id}`)).some((x) => x.id === cc.body.id), "in the coding list");

    // (d) Legacy data of a mixed folder (past the PATCH): the fork keeps its kind, the foreign folder falls away.
    const lose = await makeChat(base, ws.id);
    store.updateChat(lose.id, { folderId: mf.id });
    const d1 = await branch(lose.id);
    assert.equal(d1.status, 201, JSON.stringify(d1.body));
    assert.deepEqual([d1.body.kind, d1.body.folderId], ["normal", null], "coding chat from a manager folder: no second foreigner in it");
    store.updateChat(lose.id, { folderId: null });

    // (e) not forkable ⇒ 400 with the reason, no new chat.
    const orchestrator = await makeChat(base, ws.id);
    const childChat = raw({ kind: "normal", title: "Child of a background run" });
    store.createGraphStart({ id: `gs-${crypto.randomUUID()}`, chatId: orchestrator.id, childChatId: childChat.id, workflowId: "wf-fork",
      workflowName: "Fork probe", shortName: "fork-probe", background: true, status: "stopped" });
    // An old app-agent chat (`service`) is read-only like a `conflict` chat: its fork is 409 before any kind check
    // (runs/only-readable.js, registration-legacy-data.test.js (4)), no new chat.
    const oldService = raw({ kind: "service", title: "Service" });
    const beforeService = count();
    const rd = await branch(oldService.id);
    assert.deepEqual([rd.status, rd.body.onlyReadable], [409, true], JSON.stringify(rd.body));
    assert.equal(count(), beforeService, "service: no chat arises");
    const cases = [
      [childChat, /Hintergrund-Lauf wird nicht verzweigt/],
    ];
    for (const [x, reason] of cases) {
      const prior = count();
      const r = await branch(x.id);
      assert.equal(r.status, 400, `${x.title}: ${JSON.stringify(r.body)}`);
      assert.match(String(r.body.error), reason, `${x.title}: the sentence names the reason`);
      assert.equal(count(), prior, `${x.title}: no chat arises`);
    }
  });
});

// ── MCP marks ────────────────────────────────────────────────────────────────
// Sabotage: drop the preset `archive: "including"` in communication/read.js ⇒ the archived one is missing, red; drop the row in
// the channel-status view ⇒ red. Via cbase_agents_list (the status lies in the on-demand summary).
test("cbase_agents_list (chats, chat, summary) shows archived items WITH the marker, active ones without a field", async () => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "MCP", wsPath);
    // A coding chat asks.
    const m = await makeChat(base, ws.id);
    const active = await makeChat(base, ws.id);
    const arch = await makeChat(base, ws.id);
    assert.equal((await archive(base, arch.id)).status, 200);
    await withMcp(
      { CBASE_BASE_URL: base, CBASE_CHAT_ID: m.id, CBASE_WORKSPACE_ID: ws.id, CBASE_TOOLS: JSON.stringify(["cbase_agents_list"]) },
      async ({ call }) => {
        const l = await call("cbase_agents_list", { view: "chats" });
        assert.equal(l.isError, false, l.text);
        const after = new Map(l.data.chats.map((c) => [c.id, c]));
        assert.equal(after.get(arch.id)?.archived, true, "the archived one is in it, marked");
        assert.ok(after.has(active.id));
        assert.equal("archived" in after.get(active.id), false, "active: no field");
        const ra = await call("cbase_agents_list", { view: "chat", chatId: arch.id });
        assert.equal(ra.isError, false, ra.text);
        assert.equal(ra.data.chat.archived, true);
        const rb = await call("cbase_agents_list", { view: "chat", chatId: active.id });
        assert.equal("archived" in rb.data.chat, false);
        // Without a history the summary calls no model — the status is in it anyway.
        const za = await call("cbase_agents_list", { view: "chat", chatId: arch.id, summarize: true });
        assert.equal(za.isError, false, za.text);
        assert.equal(za.data.archived, true);
        const zb = await call("cbase_agents_list", { view: "chat", chatId: active.id, summarize: true });
        assert.equal("archived" in zb.data, false);
      },
    );
  });
});

test("measurement: folder precheck over 20 chats of 500 rows (measurement line, no barrier)", async () => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Cost", wsPath);
    const f = await newFolder(base, ws.id, "Large");
    const text = "Lorem ipsum dolor sit amet, ".repeat(40); // ≈ 1.1 KB per row
    const t0 = Date.now();
    // The seed in ONE transaction: 10,040 single autocommit INSERTs blocked the event loop — server and test share it — for
    // 4 to 12 s, and the first request afterwards broke on the keep-alive connection the server was just closing after 5 s
    // idle (`fetch failed`, ECONNRESET). The test thus measured the machine's disk; in one go the seed takes ≈ 0.1 s. Only
    // the GET is measured.
    rawDb.exec("BEGIN");
    try {
      for (let i = 0; i < 20; i++) {
        const c = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, folderId: f.id, title: `Chat ${i}`, createdAt: t0, updatedAt: t0 });
        for (let j = 0; j < 500; j++) {
          const role = j % 5 === 0 ? "user" : j % 5 === 1 ? "assistant" : "tool";
          store.addMessage(c.id, role, role === "tool" ? JSON.stringify({ name: "Read", input: { path: `/x/${j}` }, output: text }) : text, t0 + j);
        }
        // Leaving every fifth card open would be open work — only answered ones here, so the answer is 0.
        store.addMessage(c.id, "ask", JSON.stringify({ requestId: `r-${i}`, questions: [] }), t0 + 600);
        store.addMessage(c.id, "ask_answer", JSON.stringify({ requestId: `r-${i}`, answers: [] }), t0 + 601);
      }
      rawDb.exec("COMMIT");
    } catch (e) {
      try { rawDb.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    }
    console.log(`[archive] measurement line: seed 20 × 502 rows in one transaction ${Date.now() - t0} ms`);
    const runs = [];
    let response;
    for (let k = 0; k < 5; k++) {
      const s = process.hrtime.bigint();
      response = await ok(`${base}/api/chat-folders/${f.id}/archive`);
      runs.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
    assert.equal(response.chats, 20);
    assert.deepEqual(response.open, []);
    const direct = process.hrtime.bigint();
    for (const c of store.chatsInFolder(f.id)) openWork(c.id);
    const directMs = Number(process.hrtime.bigint() - direct) / 1e6;
    runs.sort((a, b) => a - b);
    console.log(`[archive] measurement line: folder precheck 20 chats × 502 rows (≈ ${Math.round(20 * 502 * 1.2 / 1024)} MB history) — GET …/archive median ${runs[2].toFixed(1)} ms (min ${runs[0].toFixed(1)}, max ${runs[4].toFixed(1)}), openWork direct ${directMs.toFixed(1)} ms; threshold for the prefilter: 100 ms in the user containers`);
  });
});

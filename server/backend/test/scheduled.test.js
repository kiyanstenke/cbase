// The routes, the chat list and the notifications of scheduled jobs — main seam: real server, real routes, fake Claude from the agent
// harness. An occurrence ("Scheduled run …", German under uiLang "de") waits at gate g1, g2, … in its order; the
// human's messages with "GATE:x" at gate x. No time window.
//
// The promises, each with the way that breaks it:
//   (1) Create: chat and job in one step, the same verdicts as POST /api/chats, plus required instructions, rhythm and permission
//       mode (400 each with wording, and NOTHING is created); the chat is at once in GET /api/chats with `job`; the zone is
//       remembered. List with filter (unknown status 400), name, plain text, state.
//   (2) PATCH: only PATCH_FIELDS (a foreign field is 400, not silently skipped); pause clears the retry; resume and a new plan
//       compute the occurrence strictly after now; `done` sets only the run end.
//   (3) "Run now" and the runs (the global stream reports "running" ONCE, at the start of the turn); the note at run end carries
//       `chatId` — with the choice `schedule: off` none arises (counter-test: the same choice on, one note); the notification choice
//       of the job chat takes `schedule`, that of an ordinary chat does not.
//   (4) Approval in the scheduled turn: the coding card reports as a note `approval` (chatId, requestId), ALWAYS pushes, and the
//       decision resolves it. Counter-test: the same card in the human's turn reports nothing.
//   (5) Delete: open run => 409; otherwise the job goes, the chat stays with a `hint` row, its row carries `job: null`. A fork does not
//       take over the job.
//   (6) The wakeup: path and response shape unchanged, `nextAt` from the new table (the retry counts), `running` counts the
//       scheduled turn, without an occurrence `nextAt: 0`.
//   (7) Creating, PATCH and deleting by hand send the global event "scheduled". A refusal (400) sends none. Counter-test:
//       scheduled/routes.js without the three `report` lines => red.

import assert from "node:assert/strict";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { openStream } from "./server-harness.mjs";
import { GLOBAL, streamBarrier } from "./quiet.mjs";
import * as store from "../electron/server/store.js";
import { getMonitorEvents } from "../electron/server/services.js";
import { pendingPermissions, requestPermission, resolvePermission } from "../electron/server/runs/permissions.js";
import { pushVerdictForNote } from "../electron/server/workflows/run-state.js";
import { JOB_DERIVED, JOB_FIELDS, RUN_FIELDS } from "../electron/server/scheduled/contract.js";

const claude = fakeClaude({
  main: `
  let tag = (String(text).match(/GATE:(\\w+)/) || [])[1] || "";
  if (!tag && String(text).includes("Geplanter Lauf")) {
    const f = path.join(LOCATION, "scheduled-count");
    const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0) + 1;
    fs.writeFileSync(f, String(n));
    tag = "g" + n;
  }
  if (tag) await gate(tag);
  finished();
  say({ type: "result", result: "Erledigt " + tag, session_id: "s-main" });`,
});

// Without Connection: close — the harness closes the server after each test, an open keep-alive connection would hold it up.
async function raw(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init.headers || {}) } });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
const VALID = { instructions: "Enter the working hours.\nAfterwards report.", cadence: "daily", plan: { clockTime: "22:00" }, timeZone: "Europe/Berlin", permissionMode: "bypassPermissions" };
const scheduledUrl = (base, ws) => `${base}/api/workspaces/${ws.id}/scheduled`;
const create = (base, ws, body = {}) => raw(scheduledUrl(base, ws), { method: "POST", body: JSON.stringify({ ...VALID, ...body }) });
const chatRow = async (base, ws, chatId) => (await json(`${base}/api/chats?workspaceId=${ws.id}`)).find((c) => c.id === chatId);
const notes = (chatId, kind) => getMonitorEvents(0).filter((n) => n.chatId === chatId && n.kind === kind);

test("create in one step, the same verdicts as a chat, required fields; list, filter, chat list", async () => {
  await withAgentsServer(async ({ base, ws, waitForIdle }) => {
    const chatsPrior = store.listChats(ws.id, { archive: "including" }).length;
    for (const [body, wording] of [
      [{ instructions: "" }, /instructions fehlen/],
      [{ instructions: undefined }, /instructions fehlen/],
      [{ instructions: "x".repeat(20_001) }, /höchstens 20000 Zeichen/],
      [{ cadence: undefined }, /cadence fehlt/],
      [{ cadence: "hours" }, /gibt es nicht mehr/],
      [{ plan: { clockTime: "25:00" } }, /./],
      [{ timeZone: "Mars/Olympus" }, /Unbekannte Zeitzone/],
      [{ permissionMode: undefined }, /Rechte-Modus erforderlich/],
      [{ permissionMode: "everything" }, /Rechte-Modus erforderlich/],
      [{ provider: "foreign" }, /Unbekannter Anbieter/],
      [{ effort: "turbo" }, /./],
      [{ projectId: "00000000-0000-4000-8000-000000000000" }, /Projekt gehört nicht zu diesem Workspace/],
    ]) {
      const r = await create(base, ws, body);
      assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 80)} ⇒ ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.match(r.body.error, wording, JSON.stringify(body).slice(0, 80));
    }
    assert.equal(store.listChats(ws.id, { archive: "including" }).length, chatsPrior, "a refusal creates no chat");
    assert.deepEqual(store.listScheduledJobs(ws.id), [], "and no job");

    const prior = Date.now();
    const r = await create(base, ws, { notify: { schedule: "off", finished: "on", unknown: "on" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { job, chat } = r.body;
    assert.equal(chat.jobId, job.id);
    assert.equal(job.chatId, chat.id);
    assert.equal(chat.title, "Enter the working hours.", "the name is the first line of the instructions");
    assert.equal(job.name, chat.title);
    assert.equal(chat.permissionMode, "bypassPermissions");
    assert.equal(chat.kind, "normal");
    assert.deepEqual(chat.notify, { schedule: "off", finished: "on" }, "the choice is normalized — kinds of a chat and of a schedule");
    assert.ok(job.nextAt > prior, "the first occurrence is after now");
    assert.deepEqual([job.status, job.state, job.lastRun, job.cadenceText], ["active", null, null, "Täglich um 22:00"]);
    assert.equal(store.getSetting(`timeZone.${ws.id}`), "Europe/Berlin", "the zone is remembered (workspaces/timeZone.js)");

    const row = await chatRow(base, ws, chat.id);
    assert.ok(row, "the empty job chat is in the chat list");
    assert.deepEqual(row.job, { id: job.id, name: chat.title, status: "active", nextAt: job.nextAt });
    const without = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) });
    await json(`${base}/api/chats/${without.id}/message`, { method: "POST", body: JSON.stringify({ text: "Hello" }) });
    await waitForIdle();
    const withoutRow = await chatRow(base, ws, without.id);
    assert.ok(withoutRow && "job" in withoutRow, "the field is on every row");
    assert.equal(withoutRow.job, null, "without a job the row carries job: null");

    const own = await create(base, ws, { name: "ACME", timeZone: undefined, cadence: "oneTime", plan: { at: Date.now() + 3_600_000 } });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal(own.body.chat.title, "ACME");
    assert.equal(own.body.job.timeZone, "Europe/Berlin", "without a zone the workspace's remembered one");

    const list = await json(scheduledUrl(base, ws));
    assert.deepEqual(Object.keys(list.items[0]).sort(), [...JOB_FIELDS, ...JOB_DERIVED].sort(), "the response carries exactly the contract's fields");
    assert.deepEqual(list.items.map((a) => a.name), ["Enter the working hours.", "ACME"]);
    assert.equal((await raw(`${scheduledUrl(base, ws)}?status=broken`)).status, 400, "an unknown status is not an empty list");
    store.updateScheduledJob(own.body.job.id, { status: "paused" });
    assert.deepEqual((await json(`${scheduledUrl(base, ws)}?status=paused`)).items.map((a) => a.name), ["ACME"]);
    assert.equal((await json(`${scheduledUrl(base, ws)}/${job.id}`)).id, job.id);
    assert.equal((await raw(`${scheduledUrl(base, ws)}/00000000-0000-4000-8000-000000000000`)).status, 404);
  }, { claude });
});

test("PATCH: only its own fields; pause, resume and a fresh plan compute the occurrence strictly after now", async () => {
  await withAgentsServer(async ({ base, ws }) => {
    const { job } = (await create(base, ws)).body;
    const url = `${scheduledUrl(base, ws)}/${job.id}`;
    const patch = (b) => raw(url, { method: "PATCH", body: JSON.stringify(b) });

    let r = await patch({ name: "Fresh", instructions: "Different" });
    assert.equal(r.status, 400, "a foreign field is a refusal, not a silent skip");
    assert.match(r.body.error, /name/);
    assert.equal(store.getScheduledJob(job.id).instructions, job.instructions, "and nothing is changed");
    assert.equal((await patch({ status: "done" })).status, 400);
    assert.equal((await patch({ instructions: " " })).status, 400);
    assert.equal((await patch({ plan: { clockTime: "99:99" } })).status, 400);

    store.updateScheduledJob(job.id, { retryAt: Date.now() + 60_000 });
    r = await patch({ status: "paused" });
    assert.deepEqual([r.status, r.body.status, r.body.retryAt], [200, "paused", 0], "the pause clears the retry");
    store.updateScheduledJob(job.id, { nextAt: Date.now() - 3_600_000 });
    const prior = Date.now();
    r = await patch({ status: "active" });
    assert.ok(r.body.nextAt > prior, "resuming catches up on nothing");
    r = await patch({ instructions: "Only that." });
    assert.equal(r.body.instructions, "Only that.");
    const beforePlan = r.body.nextAt;
    r = await patch({ cadence: "weekly", plan: { clockTime: "07:15", days: [1] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.cadence, r.body.cadenceText.startsWith("Wöchentlich"), r.body.retryAt], ["weekly", true, 0], r.body.cadenceText);
    assert.notEqual(r.body.nextAt, beforePlan, "the new plan has a new occurrence");
    assert.ok(r.body.nextAt > Date.now());
    store.updateScheduledJob(job.id, { status: "done", nextAt: 0 });
    r = await patch({ plan: { clockTime: "08:00", days: [2] } });
    assert.deepEqual([r.body.status, r.body.nextAt > Date.now()], ["active", true], "a new plan wakes a done job");
    assert.deepEqual((await patch({})).body.instructions, "Only that.", "an empty body changes nothing");

    // A done ONE-TIME job whose time has passed does not become active without a new time — it would otherwise stand "active" with
    // nextAt 0 and never run. With a new time it works (counter-test: without the check in scheduled/routes.js, 200 with status active,
    // nextAt 0).
    const past = Date.now() - 3_600_000;
    store.updateScheduledJob(job.id, { cadence: "oneTime", plan: { at: past }, cron: "", oneTimeAt: past, status: "done", nextAt: 0 });
    r = await patch({ status: "active" });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /neuen Zeitpunkt/);
    assert.deepEqual([store.getScheduledJob(job.id).status, store.getScheduledJob(job.id).nextAt], ["done", 0], "nothing is changed");
    const later = Date.now() + 3_600_000;
    r = await patch({ status: "active", plan: { at: later } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.status, r.body.nextAt], ["active", later]);
  }, { claude });
});

test("run now, runs, note at run end with chatId — none with the choice \"off\"; the notification choice of the job chat", async () => {
  await withAgentsServer(async ({ base, ws, gate, waitForIdle }) => {
    const { job, chat } = (await create(base, ws)).body;
    const url = `${scheduledUrl(base, ws)}/${job.id}`;
    // "running" is reported for a run in exactly ONE place — the start of the turn (scheduled/run.js scheduledTurnStart). Counter-test:
    // reporting it also in startRun after direct delivery => red with ["running","running","ok"].
    const stream = await openStream(`${base}/api/events`);
    let r;
    try {
      await stream.waitFor((e) => e.type === "init", "init of the global stream");
      r = await raw(`${url}/run`, { method: "POST", body: "{}" });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.run.cause, "hand");
      await gate.reached("g1");
      assert.equal((await json(url)).state, "running");
      gate.open("g1");
      await waitForIdle();
      await streamBarrier(stream, GLOBAL);
      const followUp = stream.events.filter((e) => e.type === "scheduled" && e.runId === r.body.run.id).map((e) => e.status);
      assert.deepEqual(followUp, ["running", "ok"], "a directly delivered occurrence reports \"running\" once, at the start of its turn");
    } finally { await stream.close(); }
    const scheduleNotes = notes(chat.id, "schedule");
    assert.equal(scheduleNotes.length, 1, JSON.stringify(scheduleNotes));
    assert.deepEqual([scheduleNotes[0].title, scheduleNotes[0].body], [chat.title, "Erledigt g1"]);
    const runs = await json(`${url}/runs?limit=5`);
    assert.deepEqual(Object.keys(runs.items[0]).sort(), [...RUN_FIELDS].sort(), "a run carries exactly the contract's fields");
    assert.deepEqual(runs.items.map((l) => [l.cause, l.status, l.short]), [["hand", "ok", "Erledigt g1"]]);
    assert.equal((await json(url)).lastRun.status, "ok");

    // The choice "schedule: off" on the chat: neither bell nor push.
    r = await raw(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ notify: { schedule: "off", question: "on", finished: "off" } }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(store.getChat(chat.id).notify, { schedule: "off", question: "on", finished: "off" }, "the job chat takes the kinds of a chat AND of a schedule");
    await raw(`${url}/run`, { method: "POST", body: "{}" });
    await gate.reached("g2");
    gate.open("g2");
    await waitForIdle();
    assert.equal(store.listScheduledRuns(job.id, { limit: 1 })[0].status, "ok");
    assert.equal(notes(chat.id, "schedule").length, 1, "with the choice \"off\" no note arises");

    // Counter-test of the choice: an ordinary chat does not take `schedule`.
    const normal = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) });
    await raw(`${base}/api/chats/${normal.id}`, { method: "PATCH", body: JSON.stringify({ notify: { schedule: "off", finished: "off" } }) });
    assert.deepEqual(store.getChat(normal.id).notify, { finished: "off" });
  }, { claude });
});

test("approval in the scheduled turn: note with chatId and requestId, push always, resolved with the decision — nothing in the human's turn", async () => {
  await withAgentsServer(async ({ base, ws, gate, waitForIdle }) => {
    const { job, chat } = (await create(base, ws, { notify: { approval: "off", question: "off" } })).body;
    await raw(`${scheduledUrl(base, ws)}/${job.id}/run`, { method: "POST", body: "{}" });
    await gate.reached("g1");
    const response = requestPermission(chat.id, { toolName: "Bash", input: { command: "ls" } });
    const card = notes(chat.id, "approval");
    assert.equal(card.length, 1, "the coding card in the scheduled turn reports");
    assert.ok(card[0].requestId);
    assert.equal(card[0].resolved, undefined);
    assert.equal(pushVerdictForNote({ kind: "approval", chatId: chat.id }).push, true, "in the scheduled turn the approval ALWAYS pushes — despite the choice \"off\"");
    assert.equal(pushVerdictForNote({ kind: "question", chatId: chat.id }).push, true, "so does the question");
    assert.equal(resolvePermission(card[0].requestId, { behavior: "allow", updatedInput: {} }), true);
    assert.equal((await response).behavior, "allow");
    assert.equal(notes(chat.id, "approval")[0].resolved, true, "the decision resolves the note");
    gate.open("g1");
    await waitForIdle();

    // Counter-test: the human's own turn in the same chat — the same card reports nothing, and the choice applies.
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Me GATE:k1" }) });
    await gate.reached("k1");
    const second = requestPermission(chat.id, { toolName: "Bash", input: { command: "pwd" } });
    assert.equal(notes(chat.id, "approval").length, 1, "no note in the human's turn");
    assert.equal(pushVerdictForNote({ kind: "approval", chatId: chat.id }).push, false, "in the human's turn the push follows the choice");
    const open = [...pendingPermissions.values()].find((p) => p.chatId === chat.id);
    resolvePermission(open.requestId, { behavior: "deny", message: "no" });
    assert.equal((await second).behavior, "deny");
    gate.open("k1");
    await waitForIdle();
  }, { claude });
});

test("delete: open run 409, otherwise the chat stays with a hint; a fork does not take over the job", async () => {
  await withAgentsServer(async ({ base, ws, gate, waitForIdle, waitForQuiet }) => {
    const { job, chat } = (await create(base, ws)).body;
    const url = `${scheduledUrl(base, ws)}/${job.id}`;
    await raw(`${url}/run`, { method: "POST", body: "{}" });
    await gate.reached("g1");
    const locked = await raw(url, { method: "DELETE" });
    assert.equal(locked.status, 409, JSON.stringify(locked.body));
    assert.ok(store.getScheduledJob(job.id), "the job still exists");
    gate.open("g1");
    await waitForIdle();
    await waitForQuiet();

    const fork = await raw(`${base}/api/chats/${chat.id}/fork`, { method: "POST", body: "{}" });
    assert.ok(fork.status < 300, JSON.stringify(fork.body));
    assert.equal(store.getChat(fork.body.id).jobId, null, "the fork is not a second chat of the same job");
    assert.equal(store.getScheduledJob(job.id).chatId, chat.id);

    const r = await raw(url, { method: "DELETE" });
    assert.deepEqual([r.status, r.body.chatId], [200, chat.id]);
    assert.equal(store.getScheduledJob(job.id), null);
    assert.deepEqual(store.listScheduledRuns(job.id), [], "the runs go with it");
    assert.ok(store.getChat(chat.id), "the chat stays");
    assert.equal(store.getChat(chat.id).jobId, null);
    assert.ok(store.listMessages(chat.id).some((m) => m.role === "hint" && /geplante Auftrag dieses Chats wurde gelöscht/.test(m.text)));
    assert.equal((await chatRow(base, ws, chat.id)).job, null);
    assert.equal((await raw(url)).status, 404);
  }, { claude });
});

test("wakeup: path and shape unchanged, nextAt from the new table, running counts the scheduled turn, without an occurrence 0", async () => {
  await withAgentsServer(async ({ base, ws, gate, waitForIdle }) => {
    const wakeup = () => json(`${base}/api/schedules/next`);
    let w = await wakeup();
    assert.deepEqual(w, { nextAt: 0, in: null, running: 0 }, "without an occurrence as before");
    const { job } = (await create(base, ws)).body;
    w = await wakeup();
    assert.deepEqual(Object.keys(w).sort(), ["in", "nextAt", "running"]);
    assert.equal(w.nextAt, job.nextAt);
    assert.ok(w.in > 0);
    const soon = Date.now() + 60_000;
    store.updateScheduledJob(job.id, { retryAt: soon });
    assert.equal((await wakeup()).nextAt, soon, "the retry wakes too");
    store.updateScheduledJob(job.id, { status: "paused" });
    assert.equal((await wakeup()).nextAt, 0, "a paused job does not wake");
    store.updateScheduledJob(job.id, { status: "active", retryAt: 0 });

    await raw(`${scheduledUrl(base, ws)}/${job.id}/run`, { method: "POST", body: "{}" });
    await gate.reached("g1");
    assert.equal((await wakeup()).running, 1, "the scheduled turn runs");
    gate.open("g1");
    await waitForIdle();
    assert.equal((await wakeup()).running, 0);
  }, { claude });
});

test("creating, PATCH and deleting by hand send the global event \"scheduled\" — a refusal none", async () => {
  await withAgentsServer(async ({ base, ws }) => {
    const stream = await openStream(`${base}/api/events`);
    try {
      await stream.waitFor((e) => e.type === "init", "init of the global stream");
      // A barrier on the global stream after each response: what the route sent before its response is before it (no deadline, no
      // waiting for an event that may be missing — the counter-test is red, not a hang).
      const scheduled = async () => {
        await streamBarrier(stream, GLOBAL);
        return stream.events.filter((e) => e.type === "scheduled").map((e) => [e.status, e.workspaceId, e.jobId, e.chatId]);
      };
      const r = await create(base, ws);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const { job, chat } = r.body;
      const z = (status) => [status, ws.id, job.id, chat.id];
      assert.deepEqual(await scheduled(), [z("created")], "creating sends \"scheduled\"");
      const url = `${scheduledUrl(base, ws)}/${job.id}`;
      assert.equal((await raw(url, { method: "PATCH", body: JSON.stringify({ name: "x" }) })).status, 400);
      assert.deepEqual(await scheduled(), [z("created")], "a refusal (400) sends none");
      assert.equal((await raw(url, { method: "PATCH", body: JSON.stringify({ status: "paused" }) })).status, 200);
      assert.deepEqual(await scheduled(), [z("created"), z("changed")], "PATCH sends \"scheduled\"");
      assert.equal((await raw(url, { method: "DELETE" })).status, 200);
      assert.deepEqual(await scheduled(), [z("created"), z("changed"), z("deleted")], "deleting sends \"scheduled\"");
    } finally { await stream.close(); }
  }, { claude });
});

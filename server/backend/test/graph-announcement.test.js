// The announcement of a message ("/workflow:<short-name>", resolved) travels with the human input through queue, bundle, injection,
// steering and resume, and is readable in the running turn (`announcementsInTurn`).
//
// Three kinds in one file: units without a server (shape, reading, dedup), the store round trip (run_inputs, active_runs including
// broken JSON) and the main seam via `withAgentsServer` — every turn of the fake stands at a gate whose name its input carries
// ("GATE:x"), read while it waits there.
import assert from "node:assert/strict";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { db } from "../electron/server/store/db.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { resumeInterruptedWork } from "../electron/server/runs/resume.js";
import {
  announcementForm, announcementsFrom, announcementsInTurn, inputOf, pickedUpInTurn, humanFrom, humanInput, turnBegins,
  turnPast,
} from "../electron/server/runs/human-input.js";

const announcement = (id, shortName = "order-ship", attachments = ["/tmp/creation.png"]) => ({
  id, workflows: [{ workflowId: `wf-${shortName}`, shortName, name: `Name ${shortName}` }], attachments,
});

// ── Units ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("announcementForm: a valid shape is taken over as a fresh copy of only the known fields", () => {
  const raw = { ...announcement("a1"), foreign: 1 };
  raw.workflows[0].extra = "x";
  const f = announcementForm(raw);
  assert.deepEqual(f, announcement("a1"));
  assert.notEqual(f.workflows, raw.workflows, "a copy, no shared list");
  assert.deepEqual(announcementForm({ id: "a2", workflows: announcement("a2").workflows }).attachments, [], "missing attachments = []");
});

test("announcementForm: every invalid shape gives null", () => {
  const wf = announcement("x").workflows;
  const cases = [
    ["not an object", "a1"],
    ["list", [announcement("a1")]],
    ["null", null],
    ["without id", { workflows: wf }],
    ["empty id", { id: "", workflows: wf }],
    ["id of 65 characters", { id: "i".repeat(65), workflows: wf }],
    ["no workflows", { id: "a", workflows: [] }],
    ["21 workflows", { id: "a", workflows: Array.from({ length: 21 }, () => wf[0]) }],
    ["workflow without id", { id: "a", workflows: [{ shortName: "k", name: "n" }] }],
    ["workflow without short name", { id: "a", workflows: [{ workflowId: "w", shortName: "", name: "n" }] }],
    ["workflow without name", { id: "a", workflows: [{ workflowId: "w", shortName: "k" }] }],
    ["relative attachment", { id: "a", workflows: wf, attachments: ["rel/path.png"] }],
    ["attachment not a string", { id: "a", workflows: wf, attachments: [3] }],
    ["51 attachments", { id: "a", workflows: wf, attachments: Array.from({ length: 51 }, (_, i) => `/a/${i}`) }],
  ];
  for (const [what, raw] of cases) assert.equal(announcementForm(raw), null, what);
  assert.ok(announcementForm({ id: "i".repeat(64), workflows: Array.from({ length: 20 }, () => wf[0]),
    attachments: Array.from({ length: 50 }, (_, i) => `/a/${i}`) }), "still valid at the caps");
});

test("inputOf passes the announcement through, an invalid one drops out, an old entry has none — the field is then missing", () => {
  assert.deepEqual(inputOf({ causeSpecified: "user", display: "hi", announcement: announcement("a1") }),
    { cause: "user", text: "hi", announcement: announcement("a1") });
  const broken = inputOf({ causeSpecified: "user", display: "hi", announcement: { id: "a1" } });
  assert.deepEqual(broken, { cause: "user", text: "hi" });
  assert.equal("announcement" in broken, false, "no field announcement: null");
  const old = inputOf({ causeSpecified: "user", display: "old" });
  assert.equal("announcement" in old, false);
  assert.deepEqual(humanFrom([inputOf({ causeSpecified: "user", display: "hi", announcement: announcement("a1") })]), ["hi"],
    "the human reading stays as it was");
});

test("announcementsFrom: every cause, once per id, in order of arrival", () => {
  const list = [
    { cause: "user", text: "a", announcement: announcement("x1") },
    { cause: "user", text: "b" },
    { cause: "resumption", text: "", announcement: announcement("x2", "second") },
    { cause: "user", text: "c", announcement: announcement("x1", "different") },
    { cause: "channel", text: "d", announcement: { id: "broken" } },
  ];
  assert.deepEqual(announcementsFrom(list), [announcement("x1"), announcement("x2", "second")]);
  assert.deepEqual(announcementsFrom(null), []);
});

test("announcementsInTurn: null without a turn, [] without an announcement, both with two; a pick-up in the middle of the turn belongs", () => {
  const id = "graph-announcement-unit";
  assert.equal(announcementsInTurn(id), null);
  turnBegins(id, [inputOf({ causeSpecified: "user", display: "without" })]);
  try {
    assert.deepEqual(announcementsInTurn(id), []);
    pickedUpInTurn(id, [inputOf({ causeSpecified: "user", display: "one", announcement: announcement("m1") })]);
    pickedUpInTurn(id, [inputOf({ causeSpecified: "agent", display: "two", announcement: announcement("m2", "two") })]);
    assert.deepEqual(announcementsInTurn(id), [announcement("m1"), announcement("m2", "two")]);
    turnBegins(id, []);
    assert.deepEqual(announcementsInTurn(id), [], "a new turn begins without the announcements of the previous one");
  } finally {
    turnPast(id);
  }
  assert.equal(announcementsInTurn(id), null);
});

// ── Server ───────────────────────────────────────────────────────────────────────────────────────────────────────

const claude = fakeClaude({
  main: `
  const name = (String(text).match(/GATE:(\\w+)/) || [])[1] || ("t" + turn);
  await gate(name);
  finished();
  say({ type: "result", result: "ok " + name, session_id: "s-main" });`,
});

const send = (base, chatId, text) =>
  json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
const deliver = (chatId, text, a) =>
  deliverUserPrompt(store.getChat(chatId), { prompt: text, display: text, cause: "user", ...(a ? { announcement: a } : {}) });
const activeRow = (chatId) => store.listActiveRuns().find((r) => r.chatId === chatId);

test("store round trip: run_inputs carries the announcement, active_runs.announcements there and back, broken JSON gives []", async () => {
  await withAgentsServer(async () => {
    const cid = "graph-announcement-store";
    try {
      store.replaceRunInputs(cid, [
        { id: "e1", prompt: "p", display: "d", attachments: [], cause: "user", causeSpecified: "user", silent: false, announcement: announcement("s1") },
        { id: "e2", prompt: "p2", display: "d2", attachments: [], cause: "user", causeSpecified: "user", silent: false },
      ]);
      const [e1, e2] = store.listRunInputs().find((r) => r.chatId === cid).entries;
      assert.deepEqual(inputOf(e1).announcement, announcement("s1"));
      assert.equal("announcement" in inputOf(e2), false, "an entry without the field has no announcement");

      store.setActiveRun(cid, { prompt: "x", announcements: [announcement("s1"), announcement("s2", "two")], startedAt: 1 });
      assert.deepEqual(activeRow(cid).announcements, [announcement("s1"), announcement("s2", "two")]);
      store.setActiveRun(cid, { prompt: "y", startedAt: 2 });
      assert.deepEqual(activeRow(cid).announcements, [], "ON CONFLICT takes announcements along — clearing too");
      assert.equal(db.prepare("SELECT announcements FROM active_runs WHERE chat_id = ?").get(cid).announcements, "", "empty as ''");
      db.prepare("UPDATE active_runs SET announcements = ? WHERE chat_id = ?").run("{broken", cid);
      assert.deepEqual(activeRow(cid).announcements, []);
      db.prepare("UPDATE active_runs SET announcements = ? WHERE chat_id = ?").run('{"id":"no-array"}', cid);
      assert.deepEqual(activeRow(cid).announcements, []);
    } finally {
      store.clearRunInputs(cid);
      store.clearActiveRun(cid);
    }
  }, { claude });
});

test("direct start: the announcement is in the turn and in active_runs, not in the human reading", async () => {
  await withAgentsServer(async ({ chat, gate, waitForIdle }) => {
    const r = deliver(chat.id, "Go /workflow:order-ship GATE:d", announcement("d1"));
    assert.equal(r.queued, false);
    await gate.reached("d");
    assert.deepEqual(announcementsInTurn(chat.id), [announcement("d1")]);
    assert.deepEqual(humanInput(chat.id), ["Go /workflow:order-ship GATE:d"]);
    assert.deepEqual(activeRow(chat.id).announcements, [announcement("d1")]);
    gate.open("d");
    await waitForIdle();
    assert.equal(announcementsInTurn(chat.id), null);
  }, { claude });
});

test("queue and bundle: two queued announcements both go into the follow-up turn, the public list stays without", async () => {
  await withAgentsServer(async ({ base, chat, gate, waitForIdle }) => {
    await send(base, chat.id, "Lead-in GATE:a");
    await gate.reached("a");
    assert.deepEqual(announcementsInTurn(chat.id), [], "a turn without an announcement");
    const one = deliver(chat.id, "First GATE:b", announcement("q1"));
    const two = deliver(chat.id, "Second", announcement("q2", "two"));
    assert.equal(one.queued && two.queued, true);
    assert.ok(two.queue.every((x) => !("announcement" in x)), "publicPendingInputs carries no announcement");
    const backedUp = store.listRunInputs().find((x) => x.chatId === chat.id).entries;
    assert.deepEqual(backedUp.map((e) => e.announcement?.id), ["q1", "q2"], "run_inputs carries the announcements (restart-proof)");
    gate.open("a");
    await gate.reached("b");
    assert.deepEqual(announcementsInTurn(chat.id), [announcement("q1"), announcement("q2", "two")], "a bundle with two announcements carries both");
    gate.open("b");
    await waitForIdle();
  }, { claude });
});

test("steering: the announcement of the queued entry goes into the new run", async () => {
  await withAgentsServer(async ({ base, chat, gate, waitForIdle }) => {
    await send(base, chat.id, "Start GATE:s0");
    await gate.reached("s0");
    deliver(chat.id, "Correction GATE:s1", announcement("st1"));
    const r = await json(`${base}/api/chats/${chat.id}/control`, { method: "POST", body: "{}" });
    assert.equal(r.sent, 1, JSON.stringify(r));
    await gate.reached("s1");
    assert.deepEqual(announcementsInTurn(chat.id), [announcement("st1")]);
    assert.deepEqual(activeRow(chat.id).announcements, [announcement("st1")], "the new run secures it for the resume");
    gate.open("s1");
    await waitForIdle();
  }, { claude });
});

test("resume: the announcements from active_runs come back as inputs of cause \"resumption\" — no human input", async () => {
  await withAgentsServer(async ({ chat, gate, waitForIdle }) => {
    // The state after a crash in the middle of a turn: an active_runs row without a run. The follow-up start is switched off in the
    // process (CBASE_RESTART_GRACE_MS of the harness) — the test calls it itself.
    store.setActiveRun(chat.id, { prompt: "Interrupted GATE:w", announcements: [announcement("w1"), announcement("w2", "two")], startedAt: Date.now() });
    resumeInterruptedWork();
    await gate.reached("w");
    assert.deepEqual(announcementsInTurn(chat.id), [announcement("w1"), announcement("w2", "two")]);
    assert.deepEqual(humanInput(chat.id), [], "the resume does not count as human input (ultracode, budget)");
    assert.deepEqual(activeRow(chat.id).announcements, [announcement("w1"), announcement("w2", "two")], "and survives the next restart");
    gate.open("w");
    await waitForIdle();
  }, { claude });
});

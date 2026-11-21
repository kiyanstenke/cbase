// The consumers and responders of hook-register slice H-4 as units - without server, without fake CLI, with a real store in
// a temp directory where one is needed. Each consumer carries the body that used to sit in runs/; what is checked is the
// CONDITION that moved with it (a condition that stood before the call moves to the consumer if it steers nothing else in
// runs/), the contract of the switch (null is an answer, undefined means not responsible) and the safety net with its
// console line:
//   - runtime/sse.js setRunState: unset, the query throws in plain text (empty is not unknown); set,
//     /api/events delivers the initial state from `running()` and `workflows()`.
//   - channels/delivery.js channelHumanHook: only `cause === "user"` resets the counter - the condition that used to sit
//     in queue.js.
//   - The hub itself: where it fires and asks is checked by the server tests (channel, workflow-*) and the golden runs
//     (hooks.jsonl per scenario).
//
// This file imports NO other test file.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";

import * as store from "../electron/server/store.js";
import { resetHooks } from "../electron/server/runs/hooks.js";
import { eventStreamRoute, setRunState } from "../electron/server/runtime/sse.js";
import { channelHumanHook } from "../electron/server/channels/delivery.js";

beforeEach(resetHooks);

const now = () => Date.now();
async function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-h4-"));
  try {
    store.initStore(dir);
    return await fn(dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (e) { console.warn("[hook-consumer-h4] cleanup:", e?.message || e); }
  }
}
function seed() {
  const ws = store.createWorkspace({ id: "ws1", name: "W", path: os.tmpdir(), createdAt: now() });
  const chat = (id, extra = {}) => store.createChat({ id, workspaceId: ws.id, title: id, createdAt: now(), updatedAt: now(), ...extra });
  return { ws, chat };
}
const REAL_ERROR = console.error;
// An event-stream call against a fake response: collects what the server writes.
function eventsCall() {
  const req = new EventEmitter();
  const written = [];
  const res = { writeHead() {}, write(s) { written.push(String(s)); } };
  return { ctx: { req, res, url: new URL("http://x/api/events"), p: "/api/events", m: "GET" }, written, req };
}

// ── runtime/sse.js: the run state comes through the setter ─────────────────────

// Runs as the FIRST test of the file: the setter is module-wide, once set it stays (exactly so in the server).
test("setRunState: unset, the query THROWS in plain text - /api/events delivers no empty initial state", async () => {
  const { ctx } = eventsCall();
  await assert.rejects(() => eventStreamRoute(ctx), /run state not set \(setRunState in startServer\)/);
  // Each of the four questions must be a function.
  assert.throws(() => setRunState({ isRunning: () => false, question: () => false }), /running must be a function/);
  assert.throws(() => setRunState({ isRunning: new Set(), question: () => false, running: () => [] }), /isRunning must be a function/);
  assert.throws(() => setRunState({ isRunning: () => false, question: () => false, running: () => [] }), /workflows must be a function/);
});

test("setRunState: /api/events writes `running` from running() and `dynWorkflows` from workflows()", () => withStore(async () => {
  const running = new Set(["m1"]);
  const asked = [];
  setRunState({
    isRunning: (id) => running.has(id),
    question: (id) => { asked.push(id); return id === "m1"; },
    running: () => [...running],
    workflows: () => [{ chatId: "c7", runId: "r1" }],
  });
  const { ctx, written, req } = eventsCall();
  const p = eventStreamRoute(ctx);
  req.emit("close");
  assert.equal(await p, undefined, "the route answered (no NEXT)");
  assert.equal(written.length, 1);
  assert.deepEqual(JSON.parse(written[0].replace(/^data: /, "")).running, ["m1"]);
  // The open dynamic workflows are in the initial state (work icon of the chat list).
  assert.deepEqual(JSON.parse(written[0].replace(/^data: /, "")).dynWorkflows, [{ chatId: "c7", runId: "r1" }]);
  assert.deepEqual(asked, [], "the initial state asks no question");
}));

// ── channelHumanHook ───────────────────────────────────────────────────────────

test("channelHumanHook: only `cause === \"user\"` resets the agent counter of the channels - the condition from queue.js", () => withStore(() => {
  const { ws, chat } = seed();
  const c = chat("c1");
  // Two coding chats: a channel with a manager chat is frozen (channels/freeze.js) and counts nothing.
  chat("c2");
  const k = store.createChannel({ id: "k1", workspaceId: ws.id, name: "K", creatorChatId: "c2" });
  store.addChannelParticipants(k.id, { chatId: "c2" });
  store.addChannelParticipants(k.id, { chatId: "c1" });
  store.updateChannel(k.id, { agentsSinceHuman: 3 });
  for (const cause of ["event", "schedule", "channel", "workflow", ""]) {
    channelHumanHook({ chat: c, cause });
    assert.equal(store.getChannel(k.id).agentsSinceHuman, 3, `cause "${cause}" is no human participation`);
  }
  channelHumanHook({ chat: c, cause: "user" });
  assert.equal(store.getChannel(k.id).agentsSinceHuman, 0);
}));

test("zzz end: console.error is the original again", () => {
  assert.equal(console.error, REAL_ERROR);
});

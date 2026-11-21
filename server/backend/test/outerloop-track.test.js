// The track of a gap-free agent (outerloop/track.js). Failure mode: the timeline agent of a main chat failed on its track
// (step cap of the loop engine), the watermark stood still and every next run read the same track — about 1.3 M tokens per
// attempt, without end.
//   (1) The rule from the rows: none => 0, `error` with work => +1, `finished` => -1, `error` without work (input 0) does not
//       count, an agent that is not gap-free always reads in full; `capOnStage` halves per stage, never below 1
//   (2) The input on stage s is shorter, starts at the same place and carries at least one line — also on STAGE_MAX
//   (3) Over the real run: after a failed run on stage 1 the next one starts on stage 2 and reads exactly the track of stage 2;
//       the follow-up runs grow back stage by stage (2, 1, 0, ...) and read the whole track
//   (4) If STAGE_MAX failed too, the smallest track is skipped — visibly (a `finished` row with a reason, the watermark right
//       behind that track), then it continues on stage STAGE_MAX - 1; counter-check: a failure without work on STAGE_MAX
//       skips nothing
// Counter-test: without `stage` on the row and `nextStage`, (1) to (4) turn red.
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/outerloop-track.test.js

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { timelineAgentId } from "../electron/server/outerloop/seed.js";
import { FRAME_IDENTIFIER_LINE, buildInput } from "../electron/server/outerloop/input.js";
import { STAGE_MAX, capOnStage, nextStage } from "../electron/server/outerloop/track.js";
import { outerLoopCoreCount, startOuterLoopRun } from "../electron/server/outerloop/run.js";
import { fakeClaude, withAgentsServer } from "./agent-harness.mjs";

const MODEL = "claude-haiku-4-5-20251001";
const OL_BODY = `
if (joined.includes(${JSON.stringify(FRAME_IDENTIFIER_LINE)})) { finished(); say({ type: "result", result: "Nothing to add.", session_id: "ol" }); return; }
finished(); say({ type: "result", result: "fertig", session_id: "main-session" });
`;

async function newProject(ctx, name) {
  const filePath = path.join(ctx.root, `project-${name}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(filePath, { recursive: true });
  const r = await fetch(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ path: filePath, name }) });
  const b = await r.json();
  assert.ok(r.status < 400, JSON.stringify(b));
  return b;
}
const newChat = (wid, fields = {}) => {
  const at = Date.now();
  return store.createChat({ id: crypto.randomUUID(), workspaceId: wid, kind: "normal", title: "Project chat", createdAt: at, updatedAt: at, ...fields });
};
function longTrack(chatId, n = 40, t0 = 10_000) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    store.addMessage(chatId, i % 2 ? "assistant" : "user", `Line ${i}: ${"x".repeat(1500)}`, t0 + i);
    ids.push(store.messageStats(chatId).lastId);
  }
  return ids;
}
const seenIn = (text) => [...text.matchAll(/ · row (\d+)\] /g)].map((m) => Number(m[1]));
// A finished run row without a process: as run.js writes it at the end.
function row(agentId, chatId, { state, stage, input = 0, until = 0, from: start = 0 }) {
  const id = crypto.randomUUID();
  store.createOuterLoopRun({ id, agentId, chatId, trigger: "quiet", fromMessageId: start, stage });
  assert.ok(store.outerLoopRunEnd(id, { state, input, ...(state === "finished" ? { untilMessageId: until } : {}), error: state === "error" ? "Step cap of the loop engine reached" : "" }));
  return store.outerLoopRun(id);
}
function effective(ws, chat) {
  const a = store.changeOuterLoopAgent(timelineAgentId(ws.id), { provider: "claude", model: MODEL });
  store.setOuterLoopActive(a.id, chat.id, true, 0);
  return store.outerLoopAgent(a.id);
}

// ── (1) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(1) the rule from the rows: error with work +1, finished -1, error without work does not count, gap-free agent only", async () => {
  await withAgentsServer(async (ctx) => {
    const proj = await newProject(ctx, "Rule");
    const c = newChat(ctx.ws.id, { projectId: proj.id });
    const tla = store.outerLoopTimelineAgent(ctx.ws.id);
    assert.equal(nextStage(tla, c), 0, "without a run: full track");
    row(tla.id, c.id, { state: "error", stage: 0, input: 900_000 });
    assert.equal(nextStage(tla, c), 1, "failed after work: half track");
    row(tla.id, c.id, { state: "error", stage: 1, input: 0 });
    assert.equal(nextStage(tla, c), 1, "a failure without work (gate, spawn, provider) says nothing about the track");
    row(tla.id, c.id, { state: "aborted", stage: 3 });
    assert.equal(nextStage(tla, c), 1, "an aborted run likewise");
    row(tla.id, c.id, { state: "error", stage: 1, input: 5 });
    assert.equal(nextStage(tla, c), 2);
    row(tla.id, c.id, { state: "finished", stage: 2, until: 1 });
    assert.equal(nextStage(tla, c), 1, "after a finished one a stage larger — not straight back to full");
    row(tla.id, c.id, { state: "finished", stage: 0, until: 1 });
    assert.equal(nextStage(tla, c), 0, "never below 0");
    row(tla.id, c.id, { state: "error", stage: STAGE_MAX, input: 5 });
    assert.equal(nextStage(tla, c), STAGE_MAX + 1, "beyond STAGE_MAX means skip");
    // Only the gap-free agent has a track — the summarizer always reads in full, even after a failure.
    const summarizer = store.outerLoopSummarizer(ctx.ws.id);
    row(summarizer.id, c.id, { state: "error", stage: 0, input: 5 });
    assert.equal(nextStage(summarizer, c), 0);
    assert.deepEqual([0, 1, 2, 3, 4, 9].map((s) => capOnStage(12_000, s)), [12_000, 6_000, 3_000, 1_500, 750, 750], "halved per stage, capped at STAGE_MAX");
    assert.equal(capOnStage(1, STAGE_MAX), 1, "never below 1");
  });
});

// ── (2) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(2) the input on stage s: shorter, same first line, at least one line — also on STAGE_MAX", async (t) => {
  await withAgentsServer(async (ctx) => {
    const proj = await newProject(ctx, "Input");
    const c = newChat(ctx.ws.id, { projectId: proj.id });
    const ids = longTrack(c.id);
    const tla = store.outerLoopTimelineAgent(ctx.ws.id);
    const byKey = Array.from({ length: STAGE_MAX + 1 }, (_, s) => buildInput({ agent: tla, chat: c, fromId: 0, since: 0, trigger: "quiet", stage: s }));
    const seen = byKey.map((e) => seenIn(e.text));
    for (let s = 0; s <= STAGE_MAX; s++) {
      assert.ok(seen[s].length >= 1, `stage ${s}: at least one line`);
      assert.equal(seen[s][0], ids[0], `stage ${s}: from the start`);
      assert.equal(byKey[s].untilId, seen[s].at(-1), `stage ${s}: the watermark on the last seen line`);
      assert.equal(byKey[s].rest, true, `stage ${s}: the rest follows`);
      if (s) assert.ok(seen[s].length <= seen[s - 1].length, `stage ${s} reads no more than stage ${s - 1}`);
    }
    assert.ok(seen[STAGE_MAX].length < seen[0].length, `the smallest track is really smaller: ${seen.map((g) => g.length).join("/")}`);
    // An agent without a track ignores the stage.
    const summarizer = store.outerLoopSummarizer(ctx.ws.id);
    assert.equal(buildInput({ agent: summarizer, chat: c, fromId: 0, since: 0, trigger: "quiet", stage: 3 }).text,
      buildInput({ agent: summarizer, chat: c, fromId: 0, since: 0, trigger: "quiet" }).text);
    t.diagnostic(`lines per stage: ${seen.map((g) => g.length).join("/")}`);
  });
});

// ── (3) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(3) over the real run: after a failure on stage 1 the next one reads the track of stage 2, the follow-up runs grow back", async (t) => {
  await withAgentsServer(async (ctx) => {
    const { waitForTruthy } = ctx;
    const proj = await newProject(ctx, "Run");
    const c = newChat(ctx.ws.id, { projectId: proj.id });
    const ids = longTrack(c.id);
    const a = effective(ctx.ws, c);
    row(a.id, c.id, { state: "error", stage: 1, input: 1_300_000 });
    // What each stage would read from a watermark — the expectation, computed like the run.
    const expected = [];
    for (let start = 0, s = 2; start < ids.at(-1);) {
      const e = buildInput({ agent: a, chat: store.getChat(c.id), fromId: start, since: 0, trigger: "quiet", stage: s });
      expected.push({ stage: s, from: start, until: e.untilId });
      start = e.untilId;
      s = Math.max(0, s - 1);
    }
    const r = await startOuterLoopRun({ agent: a, chat: store.getChat(c.id), trigger: "quiet" });
    assert.equal(r.started, true, JSON.stringify(r));
    await waitForTruthy(() => {
      const l = store.outerLoopLastFinishedRun(a.id, c.id);
      return l && l.untilMessageId === ids.at(-1) && outerLoopCoreCount() === 0 && store.outerLoopRunsOpen().length === 0;
    }, "the whole track read");
    const runs = store.outerLoopRunsOfAgent(a.id, { limit: 500 }).items.filter((l) => l.chatId === c.id && l.state === "finished")
      .sort((x, y) => x.fromMessageId - y.fromMessageId);
    assert.deepEqual(runs.map((l) => ({ stage: l.stage, from: l.fromMessageId, until: l.untilMessageId })), expected,
      "stage 2 first, then larger step by step — each with exactly the track of its stage");
    assert.equal(runs[0].stage, 2);
    t.diagnostic(runs.map((l) => `s${l.stage}:${l.fromMessageId}→${l.untilMessageId}`).join(" "));
  }, { claude: fakeClaude({ main: OL_BODY }) });
});

// ── (4) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(4) if STAGE_MAX failed too, the smallest track is skipped visibly — a failure without work skips nothing", async (t) => {
  await withAgentsServer(async (ctx) => {
    const { waitForTruthy } = ctx;
    const proj = await newProject(ctx, "Jump");
    const c = newChat(ctx.ws.id, { projectId: proj.id });
    const ids = longTrack(c.id);
    const a = effective(ctx.ws, c);
    const small = buildInput({ agent: a, chat: store.getChat(c.id), fromId: 0, since: 0, trigger: "quiet", stage: STAGE_MAX });

    // Counter-check first: the last failure on STAGE_MAX had NO work (input 0) — before it one with work on STAGE_MAX - 1.
    row(a.id, c.id, { state: "error", stage: STAGE_MAX - 1, input: 5 });
    row(a.id, c.id, { state: "error", stage: STAGE_MAX, input: 0 });
    assert.equal(nextStage(a, c), STAGE_MAX, "the stage is computed from the one with work — no skipping");

    row(a.id, c.id, { state: "error", stage: STAGE_MAX, input: 5 });
    const r = await startOuterLoopRun({ agent: a, chat: store.getChat(c.id), trigger: "quiet" });
    assert.equal(r.reason, "skipped", JSON.stringify(r));
    const jump = store.outerLoopRun(r.runId);
    assert.deepEqual([jump.state, jump.stage, jump.fromMessageId, jump.untilMessageId, jump.input], ["finished", STAGE_MAX, 0, small.untilId, 0],
      "one finished row, the watermark right behind the smallest track, no consumption");
    assert.match(jump.error, new RegExp(`^Strecke übersprungen: Verlaufszeilen 1–${small.untilId} nicht ausgewertet`), "the reason is in the row");
    // Then on, one stage larger, until the track is read (follow-up runs without a trigger).
    await waitForTruthy(() => {
      const l = store.outerLoopLastFinishedRun(a.id, c.id);
      return l && l.untilMessageId === ids.at(-1) && outerLoopCoreCount() === 0 && store.outerLoopRunsOpen().length === 0;
    }, "the rest read");
    const afterwards = store.outerLoopRunsOfAgent(a.id, { limit: 500 }).items.filter((l) => l.chatId === c.id && l.state === "finished" && l.id !== jump.id)
      .sort((x, y) => x.fromMessageId - y.fromMessageId);
    assert.equal(afterwards[0].fromMessageId, small.untilId, "the next one continues behind the skipped track");
    assert.equal(afterwards[0].stage, STAGE_MAX - 1, "one stage larger");
    assert.equal(afterwards.filter((l) => /übersprungen/.test(l.error)).length, 0, "only the one track is skipped");
    t.diagnostic(`skipped 1–${small.untilId}; then
${afterwards.map((l) => `s${l.stage}`).join(" ")}`);
  }, { claude: fakeClaude({ main: OL_BODY }) });
});

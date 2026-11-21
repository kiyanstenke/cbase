// Gate test of the recorded streams: reads the fixtures under web/test/fixtures/streams/ — WITHOUT a server, in under a
// second — and pins what the recorder (web/test/streams/record.mjs) promises: per scenario three parsable files, the measured
// event sequence of the server, and a normalisation that lets nothing flaky through.
//
// NOT a reducer test — that is web/test/reducer.test.mjs (chatBubbles.ts against the bubble fixtures).
// The numbers below were measured on the recordings (see README.md there: scenario table).
//
// Run:  node --test web/test/streams.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SCENARIOS } from "./streams/scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "streams");

const readJsonl = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((z, i) => {
  try { return JSON.parse(z); } catch (e) { throw new Error(`${path.basename(file)} line ${i + 1} is not JSON: ${e.message}`); }
});
const load = (name) => ({
  sse: readJsonl(path.join(FIXTURES, `${name}.sse.jsonl`)),
  events: readJsonl(path.join(FIXTURES, `${name}.events.jsonl`)),
  log: JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.log.json`), "utf8")),
});
const harness = (sse) => sse.filter((e) => e.type === "harness").map((e) => e.subtype);
const metaJson = (row) => { try { return JSON.parse(row.text); } catch { return null; } };

// Expected event sequence — ordered, not gapless: each marker must come AFTER the previous one.
function inOrder(followUp, markers, what) {
  let startAt = 0;
  for (const m of markers) {
    const i = followUp.findIndex((x, idx) => idx >= startAt && x === m);
    assert.ok(i >= 0, `${what}: "${m}" is missing after position ${startAt} — sequence: ${followUp.join(" → ")}`);
    startAt = i + 1;
  }
}

// ── The table: per scenario minimum counts and the measured sequence of harness events ──────
const EXPECTED = {
  run: { sse: 15, events: 4, log: 3, harness: ["connected", "user_message", "run_started", "run_done"] },
  tool: { sse: 23, events: 4, log: 5, harness: ["connected", "user_message", "run_started", "run_done"] },
  subagent: { sse: 40, events: 4, log: 8, harness: ["connected", "user_message", "run_started", "run_done"] },
  question: { sse: 39, events: 7, log: 10, harness: ["connected", "user_message", "run_started", "ask_request", "run_done", "ask_resolved", "user_message", "run_started", "run_done"] },
  limit: { sse: 22, events: 12, log: 5, harness: ["connected", "user_message", "run_started", "limit_line", "limit_wait", "limit_line", "limit_wait", "run_started", "limit_wait", "run_done"] },
  compaction: { sse: 31, events: 6, log: 7, harness: ["connected", "user_message", "run_started", "run_done", "compacting", "compacted", "user_message", "run_started", "run_done"] },
  join: { sse: 20, events: 4, log: 5, harness: ["connected", "message_injected", "run_done"] },
  // background AFTER run_done carries the surviving agent; the second one (without a turn) reports its end.
  background: { sse: 47, events: 6, log: 10, harness: ["connected", "user_message", "run_started", "background", "run_done", "background", "user_message", "background", "run_started", "run_done"] },
  // Of the workflow ONLY the two markers — the start marker in the triggering turn, the end marker without a turn before the completion notice.
  dynworkflow: { sse: 39, events: 6, log: 10, harness: ["connected", "user_message", "run_started", "workflow_marker", "run_done", "workflow_marker", "user_message", "run_started", "run_done"] },
  // The card in the triggering turn, the turn ends; the decision without a turn, then the system notice as its own run.
  approval: { sse: 39, events: 6, log: 10, harness: ["connected", "user_message", "run_started", "workflow_approval", "run_done", "workflow_approval_decided", "user_message", "run_started", "run_done"] },
};

test("The scenario table and the fixtures agree: ten scenarios, three files each", () => {
  assert.deepEqual(SCENARIOS.map((s) => s.name), Object.keys(EXPECTED));
  const files = fs.readdirSync(FIXTURES).sort();
  const expected = SCENARIOS.flatMap((s) => [`${s.name}.events.jsonl`, `${s.name}.log.json`, `${s.name}.sse.jsonl`]).sort();
  assert.deepEqual(files, expected, "one file too many or too few under fixtures/streams");
});

for (const sz of SCENARIOS) {
  const e = EXPECTED[sz.name];
  test(`${sz.name}: parsable, minimum counts, run_started before run_done, harness sequence as measured`, () => {
    const { sse, events, log } = load(sz.name);
    assert.ok(sse.length >= e.sse, `chat stream: ${sse.length} < ${e.sse} events`);
    assert.ok(events.length >= e.events, `global stream: ${events.length} < ${e.events} events`);
    assert.ok(log.length >= e.log, `history: ${log.length} < ${e.log} rows`);
    // The server sends run_started / run_done — in this order (measured: never run_done without run_started;
    // the limit scenario has no run_done AFTER the parked run, only limit_line/limit_wait).
    // Exception with a reason: on JOIN the start lay before the stream — there the `connected` with running:true
    // is the beginning (no backlog, contract 1 of chat-stream-join.test.js).
    const followUp = harness(sse);
    const start = sz.streamLater
      ? sse.findIndex((x) => x.type === "harness" && x.subtype === "connected" && x.running === true)
      : sse.findIndex((x) => x.type === "harness" && x.subtype === "run_started");
    const end = sse.map((x) => x.type === "harness" && x.subtype === "run_done").lastIndexOf(true);
    assert.ok(start >= 0 && end > start, `${sz.streamLater ? "connected(running)" : "run_started"} (${start}) before run_done (${end}) — sequence: ${followUp.join(" → ")}`);
    inOrder(followUp, e.harness, sz.name);
    // Every event of the CLI and the server carries a `type`; the chat stream has these kinds.
    for (const evt of sse) assert.ok(["harness", "system", "stream_event", "assistant", "user", "result"].includes(evt.type), `unknown kind in the chat stream: ${JSON.stringify(evt).slice(0, 120)}`);
    // The global stream starts with init and carries one running:true and one running:false per run.
    assert.equal(events[0]?.type, "init");
    const runs = events.filter((x) => x.type === "run");
    assert.equal(runs.filter((x) => x.running === true).length, runs.filter((x) => x.running === false).length, "one run end per run start in the global stream");
    // The history ends with the run meta (secs/inTok/outTok) — the figures of the last run.
    const last = metaJson(log.at(-1));
    assert.equal(log.at(-1).role, "meta");
    assert.ok(last && "inTok" in last && "outTok" in last, `last history row is not a run meta: ${log.at(-1).text}`);
  });
}

test("join: the connected carries running, the running text and the queue", () => {
  const { sse } = load("join");
  const hello = sse.find((x) => x.type === "harness" && x.subtype === "connected");
  assert.ok(hello, "no connected");
  assert.equal(hello.running, true, "the stream opened IN THE MIDDLE of the run");
  assert.equal(hello.streamText, "Ich fange an und schreibe weiter, ", "the two deltas before joining");
  assert.ok(Array.isArray(hello.queued), "queued is missing");
  assert.equal(hello.queued.length, 1);
  assert.deepEqual(Object.keys(hello.queued[0]).sort(), ["controllable", "id", "text"]);
  assert.equal(hello.queued[0].text, "Und noch etwas hinterher.");
  // Nothing before the join is replayed (chat-stream-join.test.js, contract 1): no user_message, no
  // run_started — only what happened AFTER the connected.
  const followUp = harness(sse);
  assert.equal(followUp.includes("user_message"), false, "no backlog: the first message lay before the join");
  assert.equal(followUp.includes("run_started"), false, "no backlog: the run began before the join");
  // The queued message arrives as message_injected in the SAME process, then a second turn.
  const inj = sse.find((x) => x.type === "harness" && x.subtype === "message_injected");
  assert.equal(inj.text, "Und noch etwas hinterher.");
  assert.deepEqual(inj.queued, [], "after the injection the queue is empty");
  assert.equal(sse.filter((x) => x.type === "result").length, 2, "two turns, two results");
  assert.equal(sse.filter((x) => x.type === "harness" && x.subtype === "run_done").length, 1, "ONE process, ONE run_done");
});

test("compaction: compacting → compacted, and the history carries the meta row with compacted", () => {
  const { sse, log } = load("compaction");
  const followUp = harness(sse);
  assert.ok(followUp.indexOf("compacting") < followUp.indexOf("compacted"));
  const compacted = sse.find((x) => x.subtype === "compacted");
  assert.equal(compacted.auto, false);
  assert.equal(typeof compacted.chars, "number");
  const marker = log.filter((z) => z.role === "meta").map(metaJson).find((m) => m?.compacted === true);
  assert.ok(marker, "no meta row with compacted in the history");
  assert.equal(marker.at, "<t>", "the time of the marker is normalised");
  // Two kinds under the role meta: run figures AND compaction marker.
  const metas = log.filter((z) => z.role === "meta").map(metaJson);
  assert.equal(metas.filter((m) => "secs" in m).length, 2, "two run metas");
  assert.equal(metas.filter((m) => m.compacted).length, 1, "one compaction marker");
  // The run afterwards starts without a session (resume:false) — the summary replaces it.
  const starts = sse.filter((x) => x.subtype === "run_started");
  assert.deepEqual(starts.map((s) => s.resume), [false, false]);
});

test("question: ask_request comes from the route, the turn ends, the answer starts a resume run", () => {
  const { sse, log, events } = load("question");
  const ask = sse.find((x) => x.subtype === "ask_request");
  assert.equal(ask.requestId, "<id-1>", "the requestId is normalised (first unknown id)");
  assert.equal(ask.questions[0].question, "Monorepo oder getrennte Repos?");
  const resolved = sse.find((x) => x.subtype === "ask_resolved");
  assert.deepEqual(resolved.answers[0].selected, ["Getrennte Repos"]);
  assert.deepEqual(sse.filter((x) => x.subtype === "run_started").map((s) => s.resume), [false, true]);
  assert.deepEqual(log.map((z) => z.role), ["user", "tool", "ask", "tool_result", "assistant", "meta", "ask_answer", "user", "assistant", "meta"]);
  // The requestId is also IN the text of the tool result — normalised, with the same placeholder.
  const result = sse.find((x) => x.type === "user" && x.message?.content?.[0]?.tool_use_id === "toolu_ask_01");
  assert.ok(String(result.message.content[0].content).includes('"requestId":"<id-1>"'));
  const question = events.find((x) => x.type === "notice" && x.notice?.kind === "question");
  assert.equal(question.notice.requestId, "<id-1>");
});

test("limit: wait line and continuation — no run_done for the parked run, two bell notices", () => {
  const { sse, events, log } = load("limit");
  const rows = sse.filter((x) => x.subtype === "limit_line").map((x) => x.line.kind);
  assert.deepEqual(rows, ["wait", "resume"]);
  const wait = sse.filter((x) => x.subtype === "limit_wait").map((x) => x.wait);
  assert.deepEqual(wait.map((w) => (w ? "row" : "null")), ["null", "row", "null", "null"]);
  const row = wait.find(Boolean);
  assert.equal(row.reason, "reset");
  assert.equal(row.gate, false);
  assert.equal(row.dueAt, "<t>");
  assert.match(sse.find((x) => x.subtype === "limit_line").line.text, /<clock>/, "the clock text is normalised");
  assert.equal(sse.filter((x) => x.subtype === "run_done").length, 1, "only the continued run has a run_done");
  assert.equal(sse.filter((x) => x.subtype === "run_error").length, 0, "a limit is not an error");
  const bell = events.filter((x) => x.type === "notice" && x.notice?.kind === "limit").map((x) => x.notice.title);
  assert.equal(bell.length, 2, `parking and resuming: ${bell.join(" | ")}`);
  assert.deepEqual(log.filter((z) => z.role === "limit").map((z) => metaJson(z).kind), ["wait", "resume"]);
});

test("subagent: child events carry parent_tool_use_id, in the history they become tool/sub_text with parent", () => {
  const { sse, log } = load("subagent");
  const children = sse.filter((x) => x.parent_tool_use_id);
  assert.ok(children.length >= 10, `too few child events: ${children.length}`);
  assert.ok(children.every((x) => x.parent_tool_use_id === "toolu_agent_01"));
  assert.deepEqual(new Set(children.map((x) => x.type)), new Set(["stream_event", "assistant", "user"]));
  const withParent = log.filter((z) => ["tool", "sub_text"].includes(z.role)).map((z) => [z.role, metaJson(z).parent]);
  assert.deepEqual(withParent, [["tool", null], ["tool", "toolu_agent_01"], ["sub_text", "toolu_agent_01"]]);
  assert.equal(log.filter((z) => z.role === "assistant").length, 1, "the subagent's text is NOT an assistant row");
});

test("tool: tool_use with input_json_delta, tool_result, second API call", () => {
  const { sse, log } = load("tool");
  const starts = sse.filter((x) => x.type === "stream_event" && x.event?.type === "message_start");
  assert.equal(starts.length, 2, "two API calls");
  assert.ok(sse.some((x) => x.event?.delta?.type === "input_json_delta"));
  const result = sse.find((x) => x.type === "user");
  assert.equal(result.message.content[0].tool_use_id, "toolu_01");
  assert.deepEqual(log.map((z) => z.role), ["user", "tool", "tool_result", "assistant", "meta"]);
});

test("run: deltas add up to the text of the assistant event and the history row", () => {
  const { sse, log } = load("run");
  const deltas = sse.filter((x) => x.event?.delta?.type === "text_delta").map((x) => x.event.delta.text).join("");
  const full = sse.find((x) => x.type === "assistant").message.content[0].text;
  assert.equal(deltas, full);
  assert.equal(log.find((z) => z.role === "assistant").text, full);
  assert.ok(sse.filter((x) => x.event?.delta?.type === "text_delta").length >= 3, "a stream, not ONE delta");
});

// ── The normalisation lets nothing flaky through (the recorder's promise) ────────────
test("No fixture carries a raw UUID, an epoch time, a temp path or a port", () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const EPOCH = /\b1[6-9]\d{11}\b/;             // 2020–2033 in milliseconds
  const TMP = /\/var\/folders\/|\/private\/var\/|\/tmp\/cbase/;
  const PORT = /127\.0\.0\.1:\d{4,5}/;
  for (const file of fs.readdirSync(FIXTURES)) {
    const text = fs.readFileSync(path.join(FIXTURES, file), "utf8");
    for (const [name, re] of [["UUID", UUID], ["epoch time", EPOCH], ["temp path", TMP], ["port", PORT]]) {
      const m = re.exec(text);
      assert.equal(m, null, `${file}: ${name} not normalised — "${m?.[0]}"`);
    }
    assert.ok(text.endsWith("\n"), `${file} ends without a line break`);
  }
});

test("Placeholders are assigned in order of first occurrence", () => {
  const { log } = load("question");
  assert.deepEqual(log.map((z) => z.id), log.map((_, i) => `<msg-${i + 1}>`));
  const { sse } = load("join");
  assert.equal(sse[0].queued[0].id, "<id-1>");
});

test("background: the agent lives on in the stream after run_done, its end comes without a turn, the completion notice is marked", () => {
  const { sse, log } = load("background");
  const end = sse.findIndex((x) => x.type === "harness" && x.subtype === "run_done");
  const after = sse.slice(end + 1);
  const alive = after.find((x) => x.subtype === "background");
  assert.equal(alive?.agents?.length, 1, "the first background after run_done carries the survivor");
  assert.equal(alive.agents[0].status, "running");
  const notice = after.find((x) => x.subtype === "user_message");
  assert.equal(notice.systemNotice, true);
  assert.ok(notice.text.startsWith("<task-notification>"));
  assert.ok(after.some((x) => x.subtype === "background" && Array.isArray(x.agents) && x.agents.length === 0), "its end: background without it");
  assert.equal(log.filter((z) => z.role === "user" && z.text.startsWith("<task-notification>")).length, 1, "stored under the role user");
});

test("dynworkflow: exactly two markers of their own role, live and in the history; nothing per workflow agent", () => {
  const { sse, log } = load("dynworkflow");
  const live = sse.filter((x) => x.type === "harness" && x.subtype === "workflow_marker").map((x) => x.marker);
  assert.deepEqual(live.map((m) => [m.phase, m.name, m.status]), [["start", "findings-collect", undefined], ["end", "findings-collect", "finished"]]);
  const rows = log.filter((z) => z.role === "workflow_marker").map((z) => JSON.parse(z.text));
  assert.deepEqual(rows, live, "the history carries the same two markers as the stream");
  // No row per workflow agent: neither events with a parent block nor history rows with their text.
  assert.equal(sse.filter((x) => x.parent_tool_use_id).length, 0);
  assert.equal(log.filter((z) => z.role !== "user" && /Befund [AB]: gelesen/.test(z.text)).length, 0);
  const iEnd = log.findIndex((z) => z.role === "workflow_marker" && JSON.parse(z.text).phase === "end");
  assert.ok(log[iEnd + 1].role === "user" && log[iEnd + 1].text.startsWith("<task-notification>"), "the completion notice after the end marker");
});

test("approval: the card and its decision under their own roles, live and in the history; the rejection is a system notice", () => {
  const { sse, log } = load("approval");
  const card = sse.find((x) => x.type === "harness" && x.subtype === "workflow_approval")?.card;
  assert.deepEqual([card?.name, card?.description, card?.phases], ["findings-check", "Zwei Befunde gegenlesen", [{ title: "Lesen" }, { title: "Urteilen", detail: "je Befund" }]]);
  const ruling = sse.find((x) => x.type === "harness" && x.subtype === "workflow_approval_decided")?.ruling;
  assert.deepEqual([ruling?.requestId, ruling?.decision], [card.requestId, "rejected"]);
  assert.deepEqual(log.filter((z) => z.role === "workflow_approval").map((z) => JSON.parse(z.text)), [card], "the history carries the same card as the stream");
  assert.deepEqual(log.filter((z) => z.role === "workflow_approval_ruling").map((z) => JSON.parse(z.text)), [ruling]);
  // No run: no marker; the tool answered "awaiting_approval" (the product's status string).
  assert.equal(log.filter((z) => z.role === "workflow_marker").length, 0);
  assert.ok(log.some((z) => z.role === "tool_result" && z.text.includes("awaiting_approval")));
  const sys = sse.filter((x) => x.type === "harness" && x.subtype === "user_message" && x.systemNotice === true);
  assert.equal(sys.length, 1, "the rejection arrives as a system notice, never as a user message");
  assert.ok(sys[0].text.startsWith("<task-notification>") && sys[0].text.includes("was rejected by the user"));
});

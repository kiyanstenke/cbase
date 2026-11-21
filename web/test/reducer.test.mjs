// Gate test of the streaming reducer: the recorded chat streams (web/test/fixtures/streams/<scenario>.sse.jsonl) run through
// `reduceChatEvent`/`streamAfterEvent` from web/src/components/chat/chatBubbles.ts -- WITHOUT server, without React, in under a
// second -- against the reference web/test/fixtures/bubbles/<scenario>.reducer.json, recorded ONCE after the cut
// (CBASE_BUBBLES_RECORD=1). The DOM proof that the reducer draws the same bubbles as ChatPane did is
// a recording of the drawn bubbles in a real browser (not in the gate); this test pins the state afterwards.
//
// The wrapper in ChatPane is REPLAYED here (`Wrapper`): which refs it updates per event (run start, token counters, "joined"),
// so that the next ctx is right -- in the same order as there. What else it does (setState, reload, cache) is not the subject;
// only the bubbles are.
//
// De-normalization: the fixtures carry placeholders ("<t>", "<secs>", "<pid>", "<port>") in place of numbers. The reducer
// computes with numbers (`Number(evt.at) || ctx.now`, `line.at`) -- without translating back a string would stand in the bubble
// where the UI expects a number, and `Number("<t>")` would silently fall back to ctx.now. The counter-test (below) shows that
// the test sees it.
//
// Run:  node --test web/test/reducer.test.mjs
//       CBASE_BUBBLES_RECORD=1 node --test web/test/reducer.test.mjs   (rewrite the reference -- only with a named, intended
//       change; snapshots are an alarm, not a lock)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SCENARIOS } from "./streams/scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const STREAMS = path.join(here, "fixtures", "streams");
const BUBBLES = path.join(here, "fixtures", "bubbles");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const RECORD = process.env.CBASE_BUBBLES_RECORD === "1";

// chatBubbles.ts is a leaf module: values relative with `.js` ending (lib/tool-result, lib/stream, lib/channel-card), types via
// `@/...` -- `--noCheck --isolatedModules` compiles without tsconfig, a type import without value drops out. The output lies
// under web/node_modules so that ESM resolution is right as in global-events.test.mjs (the root folder is web/src:
// components/chat/... and lib/...).
let mod = null;
let channelCardMod = null; // lib/channel-card.js -- compiled as a dependency of chatBubbles.ts
const out = fs.existsSync(tsc) ? fs.mkdtempSync(path.join(webDir, "node_modules", ".reducer-test-")) : null;
if (out) {
  execFileSync(process.execPath, [
    tsc, path.join(webDir, "src", "components", "chat", "chatBubbles.ts"),
    "--outDir", out, "--rootDir", path.join(webDir, "src"), "--module", "es2022", "--target", "es2022",
    "--moduleResolution", "bundler", "--noCheck", "--isolatedModules", "--skipLibCheck",
  ], { cwd: webDir, stdio: "pipe" });
  mod = await import(pathToFileURL(path.join(out, "components", "chat", "chatBubbles.js")).href);
  channelCardMod = await import(pathToFileURL(path.join(out, "lib", "channel-card.js")).href);
  try { fs.rmSync(out, { recursive: true, force: true }); }
  catch (e) { console.warn("[test] temp directory stayed behind:", String(e?.message || e).slice(0, 120)); }
}

const readJsonl = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((z) => JSON.parse(z));

// ── De-normalization (inverse of web/test/streams/normalize.mjs, as far as the reducer reads numbers) ──
const T0 = Date.UTC(2026, 8, 17, 12, 0, 0); // 2026-09-17 12:00 UTC -- inside the window 2020-2033
export function deNormalize(value) {
  if (Array.isArray(value)) return value.map(deNormalize);
  if (value && typeof value === "object") {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = deNormalize(v);
    return o;
  }
  if (value === "<t>") return T0;
  if (value === "<secs>") return 1;
  if (value === "<pid>") return 4242;
  if (value === "<port>") return 17718;
  return value;
}

// The two language helpers the reducer gets via ctx (lib/i18n needs React -- not here):
// `t` like useT() (key = text, placeholder {name}), `resultToText` as in AssistantBlocks.tsx.
const t = (key, params) => key.replace(/\{(\w+)\}/g, (_, n) => String(params?.[n] ?? `{${n}}`));
const resultToText = (content) => {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : c?.text ?? (c?.type === "image" ? "[Image]" : ""))).join("");
  return String(content);
};

const deep = (x) => JSON.parse(JSON.stringify(x));
function freeze(x) {
  if (x && typeof x === "object" && !Object.isFrozen(x)) { Object.freeze(x); for (const v of Object.values(x)) freeze(v); }
  return x;
}

// ── The replayed wrapper: which refs ChatPane.onEvent updates that the next ctx needs ──
class Wrapper {
  constructor({ activeId = "<chat-1>" } = {}) {
    this.stream = { open: false, gotText: false };
    this.runStart = null; this.inTok = 0; this.outTok = 0; this.msgOutBase = 0;
    this.joined = false; this.activeId = activeId; this.wfStatus = undefined;
    this.clock = T0;
  }
  ctx() {
    return freeze({
      stream: this.stream, now: this.clock, wfStatus: this.wfStatus, activeId: this.activeId, joined: this.joined,
      runStart: this.runStart, inTok: this.inTok, outTok: this.outTok, t, resultToText,
    });
  }
  // The clock advances one second per event -- so `secs` of the summary carries the number of events
  // since run_started, and a swapped run start would be noticed.
  afterEvent(evt, stream) {
    this.stream = stream;
    this.clock += 1000;
    if (evt.type === "harness") {
      if (evt.subtype === "connected") this.joined = Boolean(evt.running);
      else if (evt.subtype === "run_started") { this.joined = false; this.runStart = this.clock - 1000; this.outTok = 0; this.inTok = 0; this.msgOutBase = 0; }
      else if (evt.subtype === "run_done" || evt.subtype === "run_aborted") { this.runStart = null; if (this.joined && this.activeId) this.joined = false; /* reloadOpenChatLog -> not the subject */ }
      else if (evt.subtype === "run_error") this.runStart = null;
      return;
    }
    if (evt.type === "stream_event") {
      const ev = evt.event ?? {};
      const parentId = evt.parent_tool_use_id ?? null;
      if (ev.type === "message_start" && !parentId) {
        this.msgOutBase = this.outTok;
        const u = ev.message?.usage;
        if (u) this.inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      } else if (ev.type === "message_delta" && ev.usage?.output_tokens && !parentId) {
        this.outTok = this.msgOutBase + ev.usage.output_tokens;
      }
      return;
    }
    if (evt.type === "assistant" && !(evt.parent_tool_use_id ?? null)) {
      const u = evt.message?.usage;
      if (u) this.inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
  }
}

const kind = (evt) => (evt.type === "harness" ? `harness/${evt.subtype}` : evt.type === "stream_event" ? `stream_event/${evt.event?.type}${evt.event?.delta?.type ? ":" + evt.event.delta.type : evt.event?.content_block?.type ? ":" + evt.event.content_block.type : ""}` : evt.type);

// The history on joining: the rows BEFORE the first answer -- the answer is in the DB only at the end of the run
// (measured: the join fixture shows a user bubble and the run indicator).
function startBubbles(name, log) {
  if (name !== "join") return [];
  const until = log.findIndex((z) => z.role !== "user");
  return mod.buildBubbles(deNormalize(until < 0 ? log : log.slice(0, until)));
}

// Play a scenario through the reducer. Checked per event: purity (twice the same call, the same value; the input stays
// untouched -- frozen), stream independence (streamAfterEvent == apply().stream).
function play(name, { deNorm = true, filter = () => true } = {}) {
  const sse = readJsonl(path.join(STREAMS, `${name}.sse.jsonl`)).filter(filter);
  const log = JSON.parse(fs.readFileSync(path.join(STREAMS, `${name}.log.json`), "utf8"));
  const wrapper = new Wrapper();
  let bubbles = freeze(startBubbles(name, log));
  const history = [];
  sse.forEach((raw, i) => {
    const evt = freeze(deNorm ? deNormalize(raw) : deep(raw));
    const ctx = wrapper.ctx();
    const once = mod.reduceChatEvent(bubbles, evt, ctx);
    const twice = mod.reduceChatEvent(bubbles, evt, ctx);
    assert.deepEqual(twice, once, `${name} #${i + 1} ${kind(evt)}: the same call twice, two results -- the reducer is not pure`);
    const stream = mod.streamAfterEvent(evt, ctx);
    assert.deepEqual(mod.apply(bubbles, evt, ctx).stream, stream, `${name} #${i + 1} ${kind(evt)}: the stream state depends on the bubbles`);
    bubbles = freeze(once);
    wrapper.afterEvent(evt, stream);
    history.push({ seq: i + 1, kind: kind(evt), bubbles: bubbles.length, stream });
  });
  return { start: name === "join" ? "buildBubbles(history up to the join)" : "[]", history, bubbles: deep(bubbles) };
}

const referenceFile = (name) => path.join(BUBBLES, `${name}.reducer.json`);

test("The reducer is compilable and exported purely (leaf module without React)", (t) => {
  if (!mod) { t.skip("node_modules missing (tsc) -- reducer not checkable"); return; }
  for (const f of ["reduceChatEvent", "streamAfterEvent", "apply", "buildBubbles", "addError", "applyClear", "markAskAnswered", "markApprovalDecided", "markWorkflowApproval"]) {
    assert.equal(typeof mod[f], "function", `${f} is missing in the export of chatBubbles.ts`);
  }
});

for (const sz of SCENARIOS) {
  test(`scenario "${sz.name}": the bubbles of the reducer equal the reference (${sz.name}.reducer.json)`, (t) => {
    if (!mod) { t.skip("node_modules missing (tsc)"); return; }
    const holds = play(sz.name);
    const file = referenceFile(sz.name);
    if (RECORD || !fs.existsSync(file)) {
      fs.mkdirSync(BUBBLES, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(holds, null, 2) + "\n");
      if (!RECORD) assert.fail(`${path.basename(file)} was missing and was written -- run again`);
      return;
    }
    const desired = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(holds.history, desired.history, `${sz.name}: bubble count or stream state per event differs from the reference`);
    assert.deepEqual(holds.bubbles, desired.bubbles, `${sz.name}: the bubbles at the end differ from the reference`);
    assert.equal(holds.start, desired.start);
  });
}

// ── Counter-tests: the test must SEE an error, else the reference is a claim ──
// (The fake CLI streams no thinking_delta -- no scenario carries one; so a text_delta and a tool start are omitted, which
// every recording has.)
// The clock of the replayer advances one second per event -- an omitted event therefore ALWAYS shifts `summary.secs`, and the
// counter-test would be red for that alone (the `tool_use` start event may be missing, `upsertTool` adds the block from the
// `assistant` row -- only the clock saw the difference). Hence the summary seconds and the end time `at` are zeroed before
// the comparison: a BLOCK must turn red, not the clock.
const withoutClock = (bs) => bs.map((b) => (b.summary ? { ...b, summary: { ...b.summary, secs: 0, ...(b.summary.at !== undefined ? { at: 0 } : {}) } } : b));

test("counter-test: an omitted text_delta or tool_result turns the scenario \"tool\" red in the BLOCKS (clock zeroed)", (t) => {
  if (!mod) { t.skip("node_modules missing (tsc)"); return; }
  const desired = JSON.parse(fs.readFileSync(referenceFile("tool"), "utf8"));
  const sse = readJsonl(path.join(STREAMS, "tool.sse.jsonl"));
  for (const [what, pred] of [
    ["text_delta", (e) => e.type === "stream_event" && e.event?.delta?.type === "text_delta"],
    ["tool_result", (e) => e.type === "user" && JSON.stringify(e).includes("tool_result")],
  ]) {
    const seq = sse.findIndex(pred);
    assert.ok(seq >= 0, `tool.sse.jsonl no longer carries a ${what} -- the counter-test needs another scenario`);
    const holds = play("tool", { filter: (_, i) => i !== seq });
    assert.notDeepEqual(withoutClock(holds.bubbles), withoutClock(desired.bubbles), `without the ${what} #${seq + 1} the BLOCKS must differ, not only the clock`);
  }
  // And the opposite, measured: the tool_use START EVENT (content_block_start) may be missing without any block
  // changing -- the assistant row carries the same call. Whoever sees this red has changed upsertTool.
  const start = sse.findIndex((e) => e.type === "stream_event" && e.event?.content_block?.type === "tool_use");
  assert.ok(start >= 0);
  assert.deepEqual(withoutClock(play("tool", { filter: (_, i) => i !== start }).bubbles), withoutClock(desired.bubbles), "content_block_start/tool_use is redundant to the assistant row");
});

test("counter-test: without de-normalization (Number(\"<t>\") is NaN) \"limit\" turns red", (t) => {
  if (!mod) { t.skip("node_modules missing (tsc)"); return; }
  const desired = JSON.parse(fs.readFileSync(referenceFile("limit"), "utf8"));
  const holds = play("limit", { deNorm: false });
  // The limit row carries `at`/`resetsAt`/`dueAt`: with the placeholder a string stands there instead of the number.
  assert.notDeepEqual(holds.bubbles, desired.bubbles, "without de-normalization the bubbles must differ");
  const row = holds.bubbles.find((b) => b.role === "limit");
  assert.equal(row?.limit?.at, "<t>", "the raw fixture row must carry the placeholder");
  assert.equal(typeof desired.bubbles.find((b) => b.role === "limit")?.limit?.at, "number", "the reference carries a number");
});

// ── The mark of the stream barrier (server/backend/test/quiet.mjs) ─────────────────────────────
// Tests write `{ type: "harness", subtype: "barrier" }` into a chat stream to know that their reader has everything before it.
// In the product nobody writes it -- a rig that uses the barrier in the browser must still not get a bubble from it. Hence: in
// EVERY state of every recorded stream (before the first event and after each) the mark is a no-op for bubbles AND stream
// state. Counter-test (shown red, reverted): a branch `evt.subtype === "barrier"` in `apply` that appends a divider => red
// before the first event of "run". The same holds for `harness/target` -- goal or pause changed via PATCH: the wrapper
// (ChatPane `onEvent`) takes the state into row, cache and list, the reducer does not know the event and must show nothing
// of it.
const BARRIER = Object.freeze({ type: "harness", subtype: "barrier", marker: "barrier-probe" });
const TARGET = Object.freeze({ type: "harness", subtype: "target", goal: "All green", goalPaused: true });
test("the stream-barrier mark and the target event change no bubble or stream state in any state of a recorded stream", (t) => {
  if (!mod) { t.skip("node_modules missing (tsc)"); return; }
  let states = 0;
  for (const sz of SCENARIOS) {
    const sse = readJsonl(path.join(STREAMS, `${sz.name}.sse.jsonl`));
    const log = JSON.parse(fs.readFileSync(path.join(STREAMS, `${sz.name}.log.json`), "utf8"));
    const wrapper = new Wrapper();
    let bubbles = freeze(startBubbles(sz.name, log));
    const check = (when) => {
      const ctx = wrapper.ctx();
      for (const marker of [BARRIER, TARGET]) {
        assert.deepEqual(mod.reduceChatEvent(bubbles, marker, ctx), bubbles, `${sz.name} ${when}: ${marker.subtype} changed the bubbles`);
        assert.deepEqual(mod.streamAfterEvent(marker, ctx), ctx.stream, `${sz.name} ${when}: ${marker.subtype} changed the stream state`);
      }
      states += 1;
    };
    check("before the first event");
    sse.forEach((raw, i) => {
      const evt = freeze(deNormalize(raw));
      const ctx = wrapper.ctx();
      bubbles = freeze(mod.reduceChatEvent(bubbles, evt, ctx));
      wrapper.afterEvent(evt, mod.streamAfterEvent(evt, ctx));
      check(`after #${i + 1} ${kind(evt)}`);
    });
  }
  t.diagnostic(`${states} states in ${SCENARIOS.length} streams checked`);
});

// ── Contract "connected": the field names of the server, measured at BOTH ends ────────
// The reducer read `evt.streamedText`, the server sends `streamText` (+ `streamTextTruncated`). `ChatEvent` is
// `Record<string, any>` -- tsc NEVER sees such a thing, and on the web the "missing beginning" was never added: whoever joined
// in the middle of a running turn did not see the beginning of the answer until the end of the run. iOS read both fields
// correctly from the start. So this test measures BOTH ends: that the reducer seeds from `streamText`, AND that the server
// sends exactly this name. A test on the client side only would have written the error along.
const ROUTES_JS = path.resolve(here, "..", "..", "server", "backend", "electron", "server", "chats", "routes.js");

test("connected: the reducer seeds from `streamText` -- the field the server really sends", (t) => {
  if (!mod) { t.skip("node_modules missing (tsc)"); return; }
  const h = new Wrapper();
  const evt = { type: "harness", subtype: "connected", running: true, streamText: "I am checking right now", streamTextTruncated: false };
  const bubbles = mod.reduceChatEvent([], evt, h.ctx());
  assert.equal(bubbles.length, 1, "the running turn yields exactly one assistant bubble");
  assert.equal(bubbles[0].role, "assistant");
  assert.equal(bubbles[0].streaming, true);
  assert.deepEqual(bubbles[0].blocks, [{ kind: "text", text: "I am checking right now" }]);

  // Counter-test -- the old name seeds NOTHING. Without it the test could not be told from one that is also green with
  // `streamedText`.
  assert.deepEqual(
    mod.reduceChatEvent([], { type: "harness", subtype: "connected", running: true, streamedText: "I am checking right now" }, h.ctx()),
    [],
    "a field the server does not send must seed nothing",
  );
  // Nor without a running turn: afterwards the history is complete in the DB.
  assert.deepEqual(
    mod.reduceChatEvent([], { type: "harness", subtype: "connected", running: false, streamText: "I am checking right now" }, h.ctx()),
    [],
    "after the end of the run the history leads, not the snapshot",
  );
});

test("connected: `streamTextTruncated` says that a piece is missing -- same wording as iOS", (t) => {
  if (!mod) { t.skip("node_modules missing (tsc)"); return; }
  const h = new Wrapper();
  const bubbles = mod.reduceChatEvent(
    [], { type: "harness", subtype: "connected", running: true, streamText: "Start", streamTextTruncated: true }, h.ctx(),
  );
  const text = bubbles[0].blocks.map((b) => b.text).join("");
  assert.match(text, /^Start\n\n… a piece is missing here/, `the cap is not named: ${JSON.stringify(text)}`);
  // The same wording is in iOS -- a cap that one surface hides and the other names is the same gap twice with two answers.
  const ios = fs.readFileSync(path.resolve(here, "..", "..", "mobile", "CbaseMobile", "Chat", "ChatViewModel+Blocks.swift"), "utf8");
  assert.ok(ios.includes("… a piece is missing here: the running turn's buffer was full."),
    "iOS carries a different wording -- both surfaces must name the same gap the same way");
});

test("connected: the server sends `streamText` and `streamTextTruncated` (counterpart to the reducer)", () => {
  const src = fs.readFileSync(ROUTES_JS, "utf8");
  const row = src.split("\n").find((z) => z.includes('subtype: "connected"'));
  assert.ok(row, "the connected row is no longer in chats/routes.js -- this contract needs a new anchor");
  assert.match(row, /\bstreamText:/, "the server sends the text under a different name than the reducer reads");
  assert.match(row, /\bstreamTextTruncated:/, "the cap hint is missing in the connected event");
  assert.doesNotMatch(row, /\bstreamedText\b/, "the old name is back -- then web and server talk past each other again");
});

// Two kinds under one role -- the history (buildBubbles) shows the completion notice like the stream as a system row.
// Counter-test (shown red): the switch `e.role === "user" && isCompletionNotice(e.text)` removed => user bubble.
test("background: the history shows the completion notice as a system row, never as a user bubble -- like the stream", (t) => {
  if (!mod) return t.skip("node_modules missing (tsc)");
  const log = JSON.parse(fs.readFileSync(path.join(STREAMS, "background.log.json"), "utf8"));
  const bs = mod.buildBubbles(deNormalize(log));
  assert.deepEqual(bs.map((b) => b.role), ["user", "assistant", "divider", "assistant"]);
  const row = bs[2];
  assert.equal(row.kind, "completionNotice");
  assert.equal(row.label, "Subagent \"{name}\" finished");
  assert.deepEqual(row.labelParams, { name: "Nebenher prüfen" });
  assert.ok(!bs.some((b) => b.role === "user" && b.blocks.some((bl) => bl.kind === "text" && bl.text.startsWith("<task-notification>"))));
});

// The wake-up call of a copy (stacks/inset.js, stacks/remove.js -- without `<name>` and `<status>`) and the completion notice of
// a graph workflow arrive on all three paths of the coding chat -- history (buildBubbles), `user_message`, `message_injected` --
// as THE SAME system row, with name and outcome instead of "system message" or "Subagent ...". The forms themselves (five
// outcomes, written by the real server) are held by web/test/completion-notice-binding.test.mjs; here the path through the
// reducer. The summaries are the English wire format of the server.
// COUNTER-TEST (shown red): the copy row in lib/completionNotice.ts `finishedRow` removed => "system message" on all three paths.
test("copy wake-up call and end of a graph workflow -- history and stream show the same system row with name and outcome", (t) => {
  if (!mod) return t.skip("node_modules missing (tsc)");
  const notice = (id, fields) => ["<task-notification>", `<task-id>${id}</task-id>`, ...fields, "</task-notification>"].join("\n");
  const READY = notice("copy-e2e1", ['<summary>Copy "e2e1" ready</summary>', "<result>Copy p/copy-e2e1 is ready.</result>", "<note>Systemmeldung</note>"]);
  const ERROR = notice("copy-e2e1", ['<summary>Copy "e2e1" not removed: docker rm: exit 1</summary>', "<result>docker rm: exit 1</result>"]);
  const GRAPH = notice("g1", ["<status>failed</status>", "<name>Job → Ship</name>", '<summary>Graph-Workflow "Job → Ship" failed: step 3</summary>']);
  const EXPECTED = [
    ["divider", "completionNotice", "Copy “{name}” ready", "e2e1"],
    ["divider", "completionNotice", "Copy “{name}” not removed", "e2e1"],
    ["divider", "completionNotice", "Workflow “{name}” failed", "Job → Ship"],
  ];
  const rows = (bs) => bs.filter((b) => b.role === "divider").map((b) => [b.role, b.kind ?? null, b.label ?? null, b.labelParams?.name ?? null]);
  // History
  const log = [READY, ERROR, GRAPH].map((text, i) => ({ id: `<msg-${i + 1}>`, role: "user", text, ts: T0 + i, attachments: null }));
  const fromHistory = mod.buildBubbles(log);
  assert.deepEqual(rows(fromHistory), EXPECTED, "history");
  assert.ok(!fromHistory.some((b) => b.role === "user"), "a notice became a user bubble");
  // Stream: into an idle chat (user_message) and in the middle of a turn (message_injected)
  for (const subtype of ["user_message", "message_injected"]) {
    const h = new Wrapper();
    let bubbles = [];
    for (const text of [READY, ERROR, GRAPH]) {
      const evt = { type: "harness", subtype, text, systemNotice: true };
      const ctx = h.ctx();
      bubbles = mod.reduceChatEvent(bubbles, evt, ctx);
      h.afterEvent(evt, mod.streamAfterEvent(evt, ctx));
    }
    assert.deepEqual(rows(bubbles), EXPECTED, subtype);
    assert.ok(!bubbles.some((b) => b.role === "user"), `${subtype}: a notice became a user bubble`);
  }
});

// ── Start and end mark of a dynamic workflow -- live AND from the loaded history ──
// The loader (`buildBubbles` over the recorded history dynworkflow.log.json) must show the same rows at the same place as the
// reducer over the stream: a kind of its own (`kind` workflow-start/-end), no user or answer bubble, at no parent block.
// Counter-test: remove the branch `MARKER_ROLE` in buildBubbles => this test fails; remove the branch `workflow_marker` in the
// reducer => "scenario dynworkflow" above fails.
test("dynworkflow: start and end mark stand in the history as in the stream -- own kind, no bubble", (t) => {
  if (!mod) { t.skip("node_modules missing (tsc)"); return; }
  const log = JSON.parse(fs.readFileSync(path.join(STREAMS, "dynworkflow.log.json"), "utf8"));
  const form = (bs) => bs.map((b) => [b.role, b.kind ?? null, b.label ?? null, b.labelParams?.name ?? null]);
  const fromHistory = form(mod.buildBubbles(deNormalize(log)));
  const fromStream = form(play("dynworkflow").bubbles);
  assert.deepEqual(fromHistory, fromStream, "history and stream show different rows");
  const markers = fromHistory.filter(([, a]) => a === "workflow-start" || a === "workflow-end");
  assert.deepEqual(markers, [
    ["divider", "workflow-start", "Workflow “{name}” started", "findings-collect"],
    ["divider", "workflow-end", "Workflow “{name}” finished", "findings-collect"],
  ]);
  // A mark with broken content is no row -- and never a user bubble with the raw JSON.
  assert.deepEqual(form(mod.buildBubbles([{ id: 1, role: "workflow_marker", text: "{broken", ts: T0 }])), []);
});

// ── The approval card of a dynamic workflow -- live AND from the loaded history ──
// The loader (`buildBubbles` over approval.log.json) shows the same card at the same place as the reducer over the stream, and
// both carry the decision. Counter-test: remove the branch `workflow_approval` in the reducer => "scenario approval" above and
// this test fail; remove the branch `workflow_approval_decided` (the card stays open in the stream) => both as well.
test("approval: the card stands in the history as in the stream -- own role, decided, no user bubble", (t) => {
  if (!mod) { t.skip("node_modules missing (tsc)"); return; }
  const log = JSON.parse(fs.readFileSync(path.join(STREAMS, "approval.log.json"), "utf8"));
  const form = (bs) => bs.map((b) => [b.role, b.kind ?? null, b.label ?? null, b.wfApproval ? [b.wfApproval.name, b.wfApproval.phases.length, b.wfApproval.decision] : null]);
  const fromHistory = form(mod.buildBubbles(deNormalize(log)));
  const fromStream = form(play("approval").bubbles);
  assert.deepEqual(fromHistory, fromStream, "history and stream show different rows");
  assert.deepEqual(fromHistory.filter(([r]) => r === "workflow_approval"), [["workflow_approval", null, null, ["findings-check", 2, "rejected"]]]);
  assert.deepEqual(fromHistory.filter(([r]) => r === "user").length, 1, "only the typed message is a user bubble -- the rejection is a system row");
  // Open as long as no decision stands; a second decision changes nothing; a broken row is no card.
  const card = log.find((z) => z.role === "workflow_approval");
  const open = mod.buildBubbles(deNormalize([card])).find((b) => b.role === "workflow_approval");
  assert.equal(open.wfApproval.decision, null);
  const rid = open.wfApproval.requestId;
  const two = mod.markWorkflowApproval(mod.markWorkflowApproval([open], rid, "rejected"), rid, "accepted");
  assert.equal(two[0].wfApproval.decision, "rejected", "the first decision counts");
  assert.deepEqual(form(mod.buildBubbles([{ id: 1, role: "workflow_approval", text: "{broken", ts: T0 }])), []);
});

// ── The start of a tool call from the loop engine ──────────────────────────────────
// The loop engine also reports the start of a call as `content_block_start`/tool_use (Claude's form, without `index`), while the
// model still streams the arguments; the input comes with the `assistant` event afterwards. For Claude the scenario "tool" above
// pins that start + assistant yield ONE row (the counter-test there: without the start no block changes). New is the time IN
// BETWEEN -- 32 s with a slow model: if a bubble of its own attaches (a monitor row; or, because the engine in approval mode
// announces call by call, the approval card of the PREVIOUS call of the same round), `upsertTool` found the block only in the
// LAST bubble and created a second one -- the first kept running without input and result as "running". Since then it searches
// over all bubbles (lib/tool-result.ts `applyToolInput`). Counter-test (shown red): the old chatBubbles.ts => "monitor row in
// between" and "approval card in between" red (two rows), "without bubble in between" green (it could do that already).
test("tool start (engine form): content_block_start + assistant with the same id yield ONE row -- also with a bubble in between", async (t) => {
  if (!mod) { t.skip("node_modules missing (tsc)"); return; }
  const WF = "mcp__cbase__cbase_dynamic_workflow";
  const start = (id, name) => ({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id, name, input: {} } } });
  const call = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (id, text) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: false }] } });
  const delta = (text) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
  const round = [
    { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } } } },
    { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 5 } } },
    { type: "assistant", message: { content: [{ type: "text", text: "I am starting a test workflow." }] } },
  ];
  const playFollowUp = (followUp) => {
    const h = new Wrapper();
    let bs = [];
    for (const evt of followUp) {
      const ctx = h.ctx();
      bs = mod.reduceChatEvent(bs, evt, ctx);
      h.afterEvent(evt, mod.streamAfterEvent(evt, ctx));
    }
    return bs;
  };
  const rows = (bs, id) => bs.flatMap((b, i) => b.blocks.filter((bl) => bl.kind === "tool" && bl.id === id).map((bl) => ({ bubble: i, input: bl.input, result: bl.result, done: bl.done })));
  const one = (middle, { withStart = true } = {}) => playFollowUp([
    { type: "harness", subtype: "run_started" },
    delta("I am starting a test workflow."),
    ...(withStart ? [start("call_wf", WF)] : []),
    ...middle,
    ...round,
    call("call_wf", WF, { script: "export default 1" }),
    result("call_wf", "started"),
    { type: "result", result: "I am starting a test workflow.", session_id: "s" },
    { type: "harness", subtype: "run_done" },
  ]);
  const desired = [{ bubble: 0, input: { script: "export default 1" }, result: "started", done: true }];

  // One subtest per case: a red case does not hide the others.
  // 1. Without a bubble in between: one row -- the same blocks as without the start (the start is redundant to the assistant row).
  await t.test("without bubble in between", () => {
    const withoutMiddle = one([]);
    assert.deepEqual(rows(withoutMiddle, "call_wf"), desired);
    assert.deepEqual(withoutClock(withoutMiddle), withoutClock(one([], { withStart: false })), "the start changes no block if nothing comes in between");
  });

  // 2. A monitor row attaches while the arguments stream.
  await t.test("monitor row in between", () => {
    const monitor = { type: "harness", subtype: "monitor", event: "fired", description: "Build", status: "ok" };
    assert.deepEqual(rows(one([monitor]), "call_wf"), desired, "two rows for one call");
  });

  // 3. The engine in approval mode: both starts stream in the round, announced call by call -- the card of the first stands
  //    as a bubble of its own before the second gets its assistant event.
  await t.test("approval card in between", () => {
    const bs = playFollowUp([
      { type: "harness", subtype: "run_started" },
      delta("I am looking."),
      start("c1", "Bash"), start("c2", "Bash"),
      ...round,
      call("c1", "Bash", { command: "ls" }),
      { type: "harness", subtype: "permission_request", requestId: "r1", toolName: "Bash", input: { command: "ls" }, at: T0 },
      { type: "harness", subtype: "approval_ruling", requestId: "r1", behavior: "allow", origin: "user", at: T0 },
      result("c1", "a.txt"),
      call("c2", "Bash", { command: "pwd" }),
      result("c2", "/tmp"),
      { type: "result", result: "", session_id: "s" },
      { type: "harness", subtype: "run_done" },
    ]);
    assert.deepEqual(rows(bs, "c1"), [{ bubble: 0, input: { command: "ls" }, result: "a.txt", done: true }], "c1");
    assert.deepEqual(rows(bs, "c2"), [{ bubble: 0, input: { command: "pwd" }, result: "/tmp", done: true }], "two rows for c2");
  });
});

// ── Channel cards (agent communication) ──────────────────────────
// The archive note at the sender (channels/delivery.js:channelArchiveHold) carries `seq = last` -- the same number as the "out"
// card the sender already has in the history -- and `messageId: null` with its own `noteId`. Before, `withChannelCard`
// de-duplicated by channelId + seq and discarded the note live. COUNTER-TEST (shown red): the old lib/channel-card.ts
// (comparison by channelId + seq) => after the note only ONE card stands.
test("channel: the archive note with the seq of an out card stays live, two notes of the same channel too, repeats do not", (t) => {
  if (!mod) { t.skip("node_modules missing (tsc)"); return; }
  const h = new Wrapper();
  const output = { channelId: "k1", channelName: "A ↔ B", messageId: 7, seq: 5, direction: "out", sender: { kind: "chat", chatId: "a", name: "A" }, recipient: { chatId: "b", name: "B" }, text: "Hello", at: T0 };
  const note = (last) => ({ channelId: "k1", channelName: "A ↔ B", messageId: null, noteId: `archiv:b:${last}`, seq: last, direction: "log", sender: { kind: "system", chatId: null, name: "" }, systemKind: "archived", text: "B is archived.", at: T0 });
  const ev = (card) => freeze({ type: "harness", subtype: "channel_message", card });
  const channelCards = (bs) => bs.filter((b) => b.role === "channel").map((b) => `${b.channel.direction}:${b.channel.seq}:${b.channel.systemKind || ""}`);
  let bs = [];
  for (const card of [output, note(5)]) bs = freeze(mod.reduceChatEvent(bs, ev(card), h.ctx()));
  assert.deepEqual(channelCards(bs), ["out:5:", "log:5:archived"], "the note with seq 5 next to the out card seq 5");
  bs = freeze(mod.reduceChatEvent(bs, ev(note(6)), h.ctx()));
  assert.deepEqual(channelCards(bs), ["out:5:", "log:5:archived", "log:6:archived"], "a second note of the same channel");
  for (const card of [note(5), output, note(6)]) bs = freeze(mod.reduceChatEvent(bs, ev(card), h.ctx()));
  assert.equal(channelCards(bs).length, 3, "the same card (messageId or noteId) appears only once");
  // An old server without messageId and noteId: two different cards of the same seq stay separate, the same one once.
  const prev = (direction, systemKind) => ({ channelId: "k2", channelName: "x", seq: 3, direction, sender: { kind: systemKind ? "system" : "chat", chatId: null, name: "" }, systemKind, text: "" });
  let old = [];
  for (const card of [prev("out"), prev("log", "archived"), prev("log", "archived")]) old = freeze(mod.reduceChatEvent(old, ev(card), h.ctx()));
  assert.equal(channelCards(old).length, 2);
});

// The title on "{n} waiting" in the channel bar. COUNTER-TEST (shown red): the branch `archived === true` removed
// => an archived target reads "Waiting for a workflow gate" or the old run text.
test("channel: the wait reason of a participant comes from its state -- missing fields mean unknown, not \"neither\"", (t) => {
  if (!channelCardMod) { t.skip("node_modules missing (tsc)"); return; }
  const g = channelCardMod.channelWaitReason;
  assert.equal(g({ running: true, archived: false, questionOpen: false }), "Delivered after its turn");
  assert.equal(g({ running: false, archived: true, questionOpen: true }), "Chat archived — delivered when you restore it");
  assert.equal(g({ running: false, archived: false, questionOpen: true }), "Waiting for your answer in the chat");
  assert.equal(g({ running: false, archived: false, questionOpen: false }), "Waiting for a workflow gate");
  // Older server: the two fields are missing => the old text, no invented gate.
  assert.equal(g({ running: false }), "Not delivered yet — the run is still going");
  assert.equal(g({ running: false, archived: false }), "Not delivered yet — the run is still going");
});

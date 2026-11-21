// Live stream = history after a reload, even if the client did not see the start of the turn. Symptom: under a finished
// subagent notice, the running turn showed several collective rows "Ran 3 commands ›" one below the other, after a reload ONE.
// The stored rows were right; the stream laid a second response bubble next to the stored one of the same turn:
//   1. Chat opened mid-run: open() resets the stream, the history ends with the stored response of this turn, and the
//      next tool opened a NEW bubble via `startAssistant` (`buildBubbles` appends it to the last response).
//   2. Reconcile mid-run (revalidateChat on open, "connected", older page, shortened row): the rows and the stream's open
//      response stood side by side — two bubbles, the calls that had already come live twice.
// The event sequence is that of a real turn (cbase_lsp ×2, cbase_artifacts_read, cbase_agenda_write,
// cbase_artifacts_write, Bash), the rows have the shape that runs/do-run.js writes.
//
// COUNTER-TEST: with `startAssistant` instead of `openResponse` in chatBubbles.ts and `[...fresh, ...extra]` instead of
// `withLiveTail` in lib/history-reconcile.ts the four stream tests are red (two response bubbles after the completion
// notice, in the second case with the first call twice); only the opposite direction stays green. The iOS binding below
// is red as soon as `startAssistant()` is back there.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let mod = null;
let reconcile = null;
const out = fs.existsSync(tsc) ? fs.mkdtempSync(path.join(webDir, "node_modules", ".live-history-test-")) : null;
if (out) {
  execFileSync(process.execPath, [
    tsc, path.join(webDir, "src", "components", "chat", "chatBubbles.ts"), path.join(webDir, "src", "lib", "history-reconcile.ts"),
    "--outDir", out, "--rootDir", path.join(webDir, "src"), "--module", "es2022", "--target", "es2022",
    "--moduleResolution", "bundler", "--noCheck", "--isolatedModules", "--skipLibCheck",
  ], { cwd: webDir, stdio: "pipe" });
  mod = await import(pathToFileURL(path.join(out, "components", "chat", "chatBubbles.js")).href);
  reconcile = await import(pathToFileURL(path.join(out, "lib", "history-reconcile.js")).href);
  try { fs.rmSync(out, { recursive: true, force: true }); }
  catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }
}

const js = (o) => JSON.stringify(o);
const FINISHED = "<task-notification>\n<task-id>a2e5776df-1</task-id>\n<tool-use-id>toolu_scan</tool-use-id>\n<status>completed</status>\n"
  + "<summary>Agent \"Status-Scan GEO\" completed</summary>\n</task-notification>";
// The turn: [name, id] per call — in the order in which the rows arise.
const CALLS = [
  ["mcp__cbase__cbase_lsp", "toolu_g1"],
  ["mcp__cbase__cbase_lsp", "toolu_g2"],
  ["mcp__cbase__cbase_artifacts_read", "toolu_r1"],
  ["mcp__cbase__cbase_agenda_write", "toolu_a1"],
  ["mcp__cbase__cbase_artifacts_write", "toolu_w1"],
  ["Bash", "toolu_b1"],
];

// The rows up to and including call `n` (0 = only the completion notice): the previous turn, the completion notice, tool + tool_result per call.
function rows(n = CALLS.length, end = false) {
  const z = [];
  const add = (role, text) => z.push({ id: z.length + 1, role, text, ts: z.length + 1, attachments: null });
  add("user", "/status");
  add("tool", js({ name: "mcp__cbase__cbase_agent", detail: "Status-Scan GEO", id: "toolu_scan", input: { description: "Status-Scan GEO" }, parent: null }));
  add("tool_result", js({ id: "toolu_scan", result: "running in the background", isError: false }));
  add("assistant", "The status scan is running in the background.");
  add("meta", js({ secs: 26, inTok: 1, outTok: 1 }));
  add("user", FINISHED);
  for (const [name, id] of CALLS.slice(0, n)) {
    add("tool", js({ name, detail: "", id, input: {}, parent: null }));
    add("tool_result", js({ id, result: "ok", isError: false }));
  }
  if (end) add("assistant", "**Status GEO** · since 10:16");
  return z;
}

// The events of ONE call, as the Claude CLI sends them (do-run.js passes them through).
const call = ([name, id]) => [
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } } },
  { type: "assistant", message: { content: [{ type: "tool_use", id, name, input: {} }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } },
];
const text = (s) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } } });

// The ChatPane shell, as far as the reducer needs it: advance the stream state (like `streamRef.current = streamAfterEvent`).
function stream(bubbles, state = { open: false, gotText: false }) {
  let st = state;
  let bs = bubbles;
  const ctx = () => ({ stream: st, now: 1, wfStatus: undefined, activeId: "c", joined: true, runStart: null, inTok: 0, outTok: 0,
    t: (s) => s, resultToText: (c) => String(c), lastId: 0 });
  return {
    ev(...evts) { for (const e of evts) { const c = ctx(); bs = mod.reduceChatEvent(bs, e, c); st = mod.streamAfterEvent(e, c); } return this; },
    set(fresh) { bs = fresh; return this; },
    get bubbles() { return bs; },
  };
}

// What one sees: per bubble the role or divider kind, per response the call ids and texts — streaming, summary and
// bookkeeping fields do not count.
const image = (bs) => bs.map((b) => (b.role === "assistant"
  ? { role: b.role, blocks: b.blocks.map((bl) => (bl.kind === "tool" ? `${bl.id}${bl.done ? "✓" : ""}` : `${bl.kind}:${bl.text}`)) }
  : { role: b.role, kind: b.kind ?? null }));
const responsesAfterFinished = (bs) => bs.slice(bs.findIndex((b) => b.kind === "completionNotice") + 1).filter((b) => b.role === "assistant").length;

test("chat opened mid-run: the next tool lands in the stored response of this turn, not in a second one", { skip: !mod }, () => {
  // open(): the history up to call 1, the stream closed; then the remaining calls and the closing text arrive live.
  const s = stream(mod.buildBubbles(rows(1)));
  for (const a of CALLS.slice(1)) s.ev(...call(a));
  s.ev(text("**Status GEO** · since 10:16"));
  assert.equal(responsesAfterFinished(s.bubbles), 1, "ONE response after the completion notice — otherwise two collective rows");
  assert.deepEqual(image(s.bubbles), image(mod.buildBubbles(rows(CALLS.length, true))));
});

test("reconcile mid-run: rows and open response become ONE bubble, without duplicate calls", { skip: !mod }, () => {
  // open() with a cache from BEFORE the completion notice: the first call arrives live (it opens the last stored response — that
  // of the previous turn, the client does not know the completion notice yet), then the reconcile applies the rows up to call 1.
  const cache = mod.buildBubbles(rows(0).slice(0, -1));
  const s = stream(cache).ev(...call(CALLS[0]));
  const fresh = mod.buildBubbles(rows(1));
  const prev = s.bubbles;
  s.set(reconcile.historyAfterReconcile(prev, cache, fresh, 8) ?? reconcile.historyWithLiveTail(prev, fresh, 8));
  for (const a of CALLS.slice(1)) s.ev(...call(a));
  assert.equal(responsesAfterFinished(s.bubbles), 1);
  assert.deepEqual(image(s.bubbles), image(mod.buildBubbles(rows())));
});

test("reconcile with unchanged base: the open response folds into the stored one (historyAfterReconcile)", { skip: !mod }, () => {
  // The cache ends with the completion notice (base untouched); two calls arrive live and open a bubble BEHIND the base; then
  // the reconcile brings the rows up to call 2 — the same two calls the open response already carries.
  const base = mod.buildBubbles(rows(0));
  const s = stream(base).ev(...call(CALLS[0]), ...call(CALLS[1]));
  const applied = reconcile.historyAfterReconcile(s.bubbles, base, mod.buildBubbles(rows(2)), 10);
  assert.ok(applied, "only live bubbles behind the base — the rule applies");
  s.set(applied);
  for (const a of CALLS.slice(2)) s.ev(...call(a));
  assert.deepEqual(image(s.bubbles), image(mod.buildBubbles(rows())));
  assert.equal(s.bubbles[s.bubbles.length - 1].streaming, true, "the folded bubble stays the open one");
});

test("opened mid-run with buffer text: the text belongs in the stored response", { skip: !mod }, () => {
  const s = stream(mod.buildBubbles(rows()));
  s.ev({ type: "harness", subtype: "connected", running: true, streamText: "**Status GEO** · since 10:16" });
  assert.deepEqual(image(s.bubbles), image(mod.buildBubbles(rows(CALLS.length, true))));
});

test("opposite direction: a pure error bubble and a card do not reopen a response", { skip: !mod }, () => {
  const error = mod.addError(mod.buildBubbles(rows(1)), "Error (exit 1)");
  const s = stream(error).ev(...call(CALLS[1]));
  assert.equal(s.bubbles.length, error.length + 1, "new bubble behind the error");
  assert.deepEqual(s.bubbles[s.bubbles.length - 2], error[error.length - 1]);
  // After a question card the stream begins a new response (the card sits between the responses in the history).
  const k = stream(mod.buildBubbles(rows(1)), { open: true, gotText: false })
    .ev({ type: "harness", subtype: "ask_request", requestId: "r1", questions: [] })
    .ev(...call(CALLS[1]));
  assert.deepEqual(k.bubbles.slice(-2).map((b) => b.role), ["ask", "assistant"]);
});

test("iOS (ChatViewModel+Blocks.swift): text, thinking and parentless tool open via openResponse, never bare startAssistant", () => {
  const src = fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatViewModel+Blocks.swift"), "utf8");
  assert.equal((src.match(/if !streamOpen \{ openResponse\(\) \}/g) || []).length, 2, "appendText and appendThinking");
  assert.match(src, /if parentId == nil, !streamOpen \{ openResponse\(\) \}/, "addTool");
  assert.doesNotMatch(src, /!streamOpen \{ startAssistant\(\) \}/);
  // Same rule as on the web: the last response becomes the open one again, a pure error row does not.
  const body = src.slice(src.indexOf("func openResponse()"), src.indexOf("func openResponse()") + 600);
  assert.match(body, /role == \.assistant/);
  assert.match(body, /allSatisfy \{ \$0\.kind == \.error \}/);
  assert.match(body, /\.streaming = true/);
});

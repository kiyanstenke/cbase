// Opening a chat: when a new message is in the chat and one then goes to the chat, either the message is missing or it is not scrolled
// all the way down. The guards of the web side — the server seam is held by server/backend/test/chat-stream-reconcile.test.js, the end
// anchor by web/test/end-anchor.test.mjs, the DOM proof by the probes chat-open/probe.mjs and chat-open-image/image.mjs (not in the gate).
//
// What is EXECUTED are the REAL leaves (compiled with tsc, as in reducer.test.mjs): `imageFrame` (B2), the key of the height memory
// (B3), the reconcile rules (C1/C2/C4/C5) and the event `row` in the reducer (C6, N2). The wiring in ChatPane, chatCache, ChatStage and
// contain.tsx is read as text below — it is what a refactoring silently loses (the rule would stay green, and nobody would call it).
//
// COUNTER-TESTS (each one sabotage, red):
//   in lib/history-reconcile.ts `historyAfterReconcile` the condition `b.streaming === true || b.rowId != null` shortened to
//     `b.rowId != null` ⇒ "the open answer of the running turn stays behind the rows" red (the result would have been discarded — C2:
//     the stream text landed on the OLD bubbles again).
//   finding 1 — `errorTail` returns `history.slice(history.length)` ⇒ "errorTail (finding 1) …" red (the error bubble of run_error
//              dropped out with the reload).
//   finding 2 — `const base = Promise.resolve(bubbles);` instead of the queue ⇒ "wiring C5/C6" red (the base would again be the
//              state before finish; the counter-image in the test shows that loading then never reconciled).
//   finding 3 — `reconcileInUpdater` reports `done(true)` ⇒ "reconcileInUpdater (finding 3) …" red (the fallback dropped out silently).
//   finding 4 — revalidateChat without applying in the Promise.all (`syncChatCache(id),`) ⇒ "wiring C1–C4" red.
//
// Run:  node --test web/test/chat-open.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => fs.readFileSync(path.resolve(webDir, rel), "utf8");

// chatBubbles.ts with its leaves (lib/bubbles-key, lib/history-reconcile, …) into ONE folder under web/node_modules — so
// the reducer and the test share the same instance of bubbles-key (the WeakMap of the built bubbles).
const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".chat-open-test-"));
execFileSync(process.execPath, [
  tsc,
  path.join(webDir, "src", "components", "chat", "chatBubbles.ts"),
  path.join(webDir, "src", "lib", "image-frame.ts"),
  "--outDir", out, "--rootDir", path.join(webDir, "src"), "--module", "es2022", "--target", "es2022",
  "--moduleResolution", "bundler", "--noCheck", "--isolatedModules", "--skipLibCheck",
], { cwd: webDir, stdio: "pipe" });
const load = (rel) => import(pathToFileURL(path.join(out, rel)).href);
const bubblesMod = await load("components/chat/chatBubbles.js");
const { imageFrame } = await load("lib/image-frame.js");
const { memoryKey, operable, rowOfTheBubble } = await load("lib/bubbles-key.js");
const { historyAfterReconcile, historyWithLiveTail, reconcileNeeded, appendRow, baseAfterQueued, reconcileInUpdater, errorTail, deltaAddsUp } = await load("lib/history-reconcile.js");
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory stayed behind:", String(e?.message || e).slice(0, 120)); }

// ── B2: the frame of an image before loading ──────────────────────────────────────────────────────────────────────

test("imageFrame (B2): aspect ratio from the dimensions, fitted into the height, never enlarged; null without valid dimensions", () => {
  // A capture 1600×900 at 384 px height: at most 682.67 px wide, and never wider than the column.
  assert.deepEqual(imageFrame(1600, 900, 384, "100%"), { aspectRatio: "1600 / 900", width: "min(100%, 682.67px)" });
  // A small image stays as large as it is.
  assert.deepEqual(imageFrame(120, 80, 384, "100%"), { aspectRatio: "120 / 80", width: "min(100%, 120px)" });
  // Portrait in the user attachment (176 × 220): the height limits.
  assert.deepEqual(imageFrame(1000, 2000, 176, "220px"), { aspectRatio: "1000 / 2000", width: "min(220px, 88px)" });
  // Empty is not unknown: no guessed aspect ratio.
  for (const [w, h] of [[undefined, undefined], [0, 100], [100, -1], ["x", 5], [NaN, 3], [100, Infinity]]) {
    assert.equal(imageFrame(w, h, 384, "100%"), null, `${w}×${h}`);
  }
});

// ── B3: the key of the height memory names the content ────────────────────────────────────────────────────────────

const rows = [
  { id: 11, role: "user", text: "Please check", ts: 1 },
  { id: 12, role: "assistant", text: "First answer", ts: 2 },
  { id: 13, role: "user", text: "Continue", ts: 3 },
];

test("Height memory (B3): built bubbles carry their log row, the key stays stable across rebuilds, a version with more content is a different one", () => {
  const a = bubblesMod.buildBubbles(rows);
  const b = bubblesMod.buildBubbles(rows);
  assert.deepEqual(a.map((x) => rowOfTheBubble(x)), [11, 12, 13], "every bubble knows its first row");
  for (let i = 0; i < a.length; i++) {
    assert.equal(memoryKey("c1", a[i], i), memoryKey("c1", b[i], i), `rebuild of the same rows: the same key (${i})`);
    assert.ok(operable(memoryKey("c1", a[i], i)), "built bubbles may be served from the memory");
  }
  // The same answer row with a second row behind it (a delta appends to the last answer): different height, different key.
  const more = bubblesMod.buildBubbles([...rows.slice(0, 2), { id: 14, role: "assistant", text: "and a whole paragraph more", ts: 4 }]);
  assert.equal(rowOfTheBubble(more[1]), 12);
  assert.notEqual(memoryKey("c1", more[1], 1), memoryKey("c1", a[1], 1), "grown answer: new key");
  // Another chat at the same position: foreign.
  assert.notEqual(memoryKey("c2", a[0], 0), memoryKey("c1", a[0], 0));
});

test("Height memory (B3): a bubble created or changed live is NEVER served from the memory", () => {
  const ctx = { stream: { open: false, gotText: false }, now: 0, activeId: "c1", joined: false, runStart: null, inTok: 0, outTok: 0, t: (k) => k, resultToText: (c) => String(c ?? "") };
  const built = bubblesMod.buildBubbles(rows);
  const started = bubblesMod.reduceChatEvent(built, { type: "harness", subtype: "run_started" }, ctx);
  const open = started[started.length - 1];
  assert.equal(open.streaming, true);
  const k = memoryKey("c1", open, started.length - 1);
  assert.equal(k, `c1:live:${started.length - 1}`, "the open answer is named after its position, with a live mark");
  assert.equal(operable(k), false, "its remembered height is not applied (the half-streamed height of the finished answer was B3)");
  // The blocks in it derive their key from that of the bubble (AssistantBlocks `ck`): the mark is inherited.
  assert.equal(operable(`${k}:tool:3`), false);
  // The unchanged bubbles before it keep their content key.
  assert.equal(memoryKey("c1", started[0], 0), memoryKey("c1", built[0], 0));
});

// ── C1/C2/C4/C5: the reconcile rules ──────────────────────────────────────────────────────────────────────────────

test("historyAfterReconcile: unchanged since the start ⇒ the new rows; base changed ⇒ null", () => {
  const base = [{ id: "a" }, { id: "b" }];
  const fresh = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(historyAfterReconcile(base, base, fresh, 3), fresh);
  const changed = [base[0], { id: "b", changed: true }];
  assert.equal(historyAfterReconcile(changed, base, fresh, 3), null, "a bubble of the base was replaced");
  assert.equal(historyAfterReconcile([base[0]], base, fresh, 3), null, "shorter than the base");
  // A user row (no live bubble) was added: not sure whether the rows carry it.
  assert.equal(historyAfterReconcile([...base, { id: "user" }], base, fresh, 3), null);
});

test("historyAfterReconcile: the open answer of the running turn stays behind the rows (C2)", () => {
  const base = [{ id: "a" }];
  const open = { id: "open", streaming: true };
  const fresh = [{ id: "a" }, { id: "fresh" }];
  assert.deepEqual(historyAfterReconcile([...base, open], base, fresh, 5), [...fresh, open]);
  // When opening without a cache the base is empty — the same.
  const empty = [];
  assert.deepEqual(historyAfterReconcile([open], empty, fresh, 5), [...fresh, open]);
});

test("historyAfterReconcile: `row` bubbles beyond the state stay, those already carried by the rows drop", () => {
  const base = [];
  const old = { id: "z4", rowId: 4 };
  const recent = { id: "z9", rowId: 9 };
  const fresh = [{ id: "a" }];
  assert.deepEqual(historyAfterReconcile([old, recent], base, fresh, 6), [...fresh, recent]);
});

test("historyWithLiveTail: if the rule did not reconcile, the rows stand and behind them only the live bubbles from the end", () => {
  const open = { id: "open", streaming: true };
  const user = { id: "user" };
  const fresh = [{ id: "a" }, { id: "user-from-db" }];
  // The user row that started the turn is in the rows — it drops out of `prev`, the open answer stays.
  assert.deepEqual(historyWithLiveTail([{ id: "alt" }, user, open], fresh, 7), [...fresh, open]);
  assert.deepEqual(historyWithLiveTail([{ id: "alt" }, user], fresh, 7), fresh);
  assert.deepEqual(historyWithLiveTail([{ id: "z", rowId: 3 }, { id: "z", rowId: 9 }, open], fresh, 7), [...fresh, { id: "z", rowId: 9 }, open]);
});

// ── React's queue (findings 1–3) ────────────────────────────────────────────────────────────────────────────────────
// A replica of what the reconciles need from React: a setter queues updaters, only `render()` applies them in their order and pulls the
// "ref" (`drawn`) along — like `bubblesRef.current = bubbles` in the body of the component.
function reactLike(start) {
  const r = { state: start, drawn: start, queue: [] };
  r.set = (u) => { r.queue.push(u); };
  r.render = () => { for (const u of r.queue.splice(0)) r.state = typeof u === "function" ? u(r.state) : u; r.drawn = r.state; };
  return r;
}

test("baseAfterQueued (finding 2): the base of a load right after `run_done` is the history AFTER finish — the load reconciles", async () => {
  const user = { id: "user" };
  const r = reactLike([user, { id: "response", streaming: true }]);
  // run_done: finish() queues — the open answer is completed, as a NEW object.
  r.set((prev) => [...prev.slice(0, -1), { ...prev[prev.length - 1], streaming: false }]);
  const fromTheRef = r.drawn; // the old way: `const base = bubblesRef.current` right afterwards
  const baseReady = baseAfterQueued(r.set); // open()
  r.render();
  const base = await baseReady;
  assert.equal(base, r.state, "the base is the history after finish");
  const fresh = [{ id: "user-db" }, { id: "response-db" }];
  assert.equal(historyAfterReconcile(r.state, fromTheRef, fresh, 9), null, "counter-image: with the base from the ref the load never reconciled (catch-up 1, 2, then standstill)");
  const absorbed = reconcileInUpdater(r.set, base, fresh, 9);
  r.render();
  assert.equal(await absorbed, true, "exactly one load: it reconciles, no catch-up");
  assert.equal(r.state, fresh);
});

test("reconcileInUpdater (finding 3): if the rule fails only in the updater, that is reported — and the rows stand there, not silently the old history", async () => {
  const base = [{ id: "a" }];
  const foreign = { id: "user-from-iphone" }; // a stream event, queued, not yet drawn
  const fresh = [{ id: "a" }, { id: "b" }];
  const r = reactLike(base);
  r.set((prev) => [...prev, foreign]);
  const result = reconcileInUpdater(r.set, base, fresh, 5);
  r.render();
  assert.equal(await result, false, "the caller learns it and takes the fallback (end of run or reload immediately)");
  assert.deepEqual(r.state, fresh, "the rows stand there (historyWithLiveTail) — the foreign row comes with the reload");
  // Counter-image: the old way checked against the DRAWN state (reconciled) and silently discarded in the updater (`?? prev`).
  const old = reactLike(base);
  old.set((prev) => [...prev, foreign]);
  const now = old.drawn;
  const probe = historyAfterReconcile(now, base, fresh, 5);
  assert.ok(probe);
  old.set((prev) => (prev === now ? probe : historyAfterReconcile(prev, base, fresh, 5) ?? prev));
  old.render();
  assert.deepEqual(old.state, [base[0], foreign], "counter-image: the rows silently dropped out");
});

test("errorTail (finding 1): joined in the middle of the run, then `run_error` — after the reload the error bubble stands behind the history", async () => {
  const ctx0 = { stream: { open: false, gotText: false }, now: 0, activeId: "c1", joined: true, runStart: null, inTok: 0, outTok: 0, t: (k) => k, resultToText: (c) => String(c ?? ""), lastId: 13 };
  // The reducer like ChatPane.onEvent: one setBubbles per event, then the stream state.
  const r = reactLike(bubblesMod.buildBubbles(rows));
  let stream = ctx0.stream;
  for (const evt of [{ type: "harness", subtype: "run_started" }, { type: "harness", subtype: "run_error", code: 1, stderr: "broken" }]) {
    const ctx = { ...ctx0, stream };
    r.set((prev) => bubblesMod.reduceChatEvent(prev, evt, ctx));
    stream = bubblesMod.streamAfterEvent(evt, ctx);
  }
  // run_error, joined: reloadOpenChatLog(id, { keepError: true }) reads the errors from the queue and loads.
  const errorReady = baseAfterQueued(r.set).then(errorTail);
  r.render();
  const error = await errorReady;
  assert.equal(error.length, 1, "exactly the error bubble of run_error");
  assert.deepEqual(error[0].blocks, [{ kind: "error", text: "Error (exit {code}):\n{stderr}" }]);
  const loaded = bubblesMod.buildBubbles([...rows, { id: 14, role: "assistant", text: "half an answer", ts: 4 }]);
  assert.ok(!loaded.some((b) => b.blocks?.some((bl) => bl.kind === "error")), "the DB carries no run_error");
  const after = [...loaded, ...error];
  assert.equal(after[after.length - 1], error[0], "the error bubble stands at the end of the newly loaded history");
  // The chat appends it to the loaded rows, and the rule lets it stand.
  assert.equal(historyAfterReconcile(r.state, r.state, after, 14)[after.length - 1], error[0]);
  // Only the tail: an error bubble in the middle of the history (older error, work continued afterwards) does not belong to it.
  assert.deepEqual(errorTail([error[0], { role: "user", blocks: [{ kind: "text", text: "further" }] }]), []);
  assert.deepEqual(errorTail([]), []);
});

test("reconcileNeeded (N1): state against the \"connected\"", () => {
  const state = { lastId: 40, count: 30 };
  assert.equal(reconcileNeeded(state, { lastId: 40, total: 30 }), false, "equal");
  assert.equal(reconcileNeeded(state, { lastId: 41, total: 31 }), true, "the server knows one more row");
  assert.equal(reconcileNeeded(state, { lastId: 40, total: 29 }), true, "a row deleted");
  assert.equal(reconcileNeeded(state, {}), true, "a server before N1: have a look");
  assert.equal(reconcileNeeded(null, { lastId: 1, total: 1 }), false, "without an own state (loader running) no — it checks itself afterwards");
});

test("appendRow (N2): only behind the state and only once", () => {
  assert.equal(appendRow({ id: 8 }, 5, () => false), true);
  assert.equal(appendRow({ id: 5 }, 5, () => false), false);
  assert.equal(appendRow({ id: 8 }, 5, (id) => id === 8), false);
  assert.equal(appendRow({ id: "x" }, 5, () => false), false);
  assert.equal(appendRow(null, 5, () => false), false);
});

// ── C6: the event `row` in the reducer of the coding chat ─────────────────────────────────────────────────────────

test("Reducer (C6): `row` appends a hint row — built as from the history, once, before the open answer", () => {
  const ctx = { stream: { open: false, gotText: false }, now: 0, activeId: "c1", joined: false, runStart: null, inTok: 0, outTok: 0, t: (k) => k, resultToText: (c) => String(c ?? ""), lastId: 13 };
  const built = bubblesMod.buildBubbles(rows);
  const row = { id: 20, role: "hint", text: "Effort now medium", ts: 5 };
  const after = bubblesMod.reduceChatEvent(built, { type: "row", row }, ctx);
  assert.equal(after.length, built.length + 1);
  const z = after[after.length - 1];
  assert.equal(z.rowId, 20);
  assert.deepEqual({ ...z, rowId: undefined }, { ...bubblesMod.buildBubbles([row])[0], rowId: undefined }, "the same bubble as after a reload");
  assert.equal(bubblesMod.reduceChatEvent(after, { type: "row", row }, ctx), after, "a second time: nothing");
  assert.equal(bubblesMod.reduceChatEvent(built, { type: "row", row: { ...row, id: 12 } }, ctx), built, "below the state: already in the history");
  // While an answer is running: before it, the open answer stays at the bottom.
  const running = bubblesMod.reduceChatEvent(built, { type: "harness", subtype: "run_started" }, ctx);
  const withRow = bubblesMod.reduceChatEvent(running, { type: "row", row }, { ...ctx, stream: bubblesMod.streamAfterEvent({ type: "harness", subtype: "run_started" }, ctx) });
  assert.equal(withRow[withRow.length - 1].streaming, true);
  assert.equal(withRow[withRow.length - 2].rowId, 20);
  // The stream state does not change through a row.
  assert.deepEqual(bubblesMod.streamAfterEvent({ type: "row", row }, { ...ctx, stream: { open: true, gotText: true } }), { open: true, gotText: true });
});

// ── Wiring ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("Wiring B2/B3: images with a frame, key by content, the memory serves only what it may", () => {
  const capture = read("src/components/CaptureCard.tsx");
  assert.match(capture, /const frame = imageFrame\(capture\.w, capture\.h, 384, "100%"\);/);
  assert.match(capture, /style=\{frame \?\? undefined\}/);
  assert.match(capture, /style=\{frame \? \{ aspectRatio: frame\.aspectRatio \} : undefined\}/);
  assert.match(read("src/components/chat/ChatBubbleRow.tsx"), /style=\{imageFrame\(a\.w, a\.h, 176, "220px"\) \?\? undefined\}/);
  assert.match(read("src/lib/api/workspace.ts"), /\n  w\?: number;\n  h\?: number;\n\}/, "the attachment carries the dimensions from N3");
  const stage = read("src/components/chat/ChatStage.tsx");
  assert.match(stage, /const ck = memoryKey\(activeId \?\? "", b, i\);/);
  // The envelope carries the first log row as `data-row` (target of the row jump of the timeline, lib/rows-jump.ts).
  assert.match(stage, /<Fragment key=\{i\}>\s*\{day && <DaySeparator key="day" marker=\{day\} \/>\}\s*<Contained key="row" ck=\{ck\} row=\{rowOfTheBubble\(b\)\}>/);
  assert.ok(!/ck=\{`\$\{activeId/.test(stage), "no position key any more at the stage");
  assert.match(read("src/components/chat/ChatBubbleRow.tsx"), /ck=\{chatId \? ck : ""\}/, "the blocks inherit the key of the bubble");
  assert.match(read("src/lib/contain.tsx"), /if \(known != null && !this\.paused && operable\(key\)\) this\.apply\(el, known\);/);
  // The arrow recomputes after every catch-up, and a clamped layout scroll catches up once more in the next frame.
  assert.match(stage, /if \(stickRef\.current\) anchor\.toEnd\(m\);\n      setJumpDown\(/);
  assert.match(stage, /bringAlongRef\.current = requestAnimationFrame\(/);
});

test("Wiring C1–C4 (coding chat): open() resets the run state, the stream comes first, every \"connected\" reconciles, run_error loads like run_done", () => {
  const pane = read("src/components/chat/ChatPane.tsx");
  assert.match(pane, /if \(!afterCreation\) \{ setBusy\(false\); busyRef\.current = false; joinedMidRunRef\.current = false; \}/, "C1: busy belonged to the abandoned chat");
  const withoutCache = pane.slice(pane.indexOf("const empty: Bubble[] = [];"));
  assert.ok(withoutCache.indexOf("attachChatStream(id);") >= 0 && withoutCache.indexOf("attachChatStream(id);") < withoutCache.indexOf("loadWindow(id)"), "C4: the stream before /log (the window since then)");
  assert.ok(!/attachChatStream\(id\);\s*\n\s*\}\n\n  \/\/ The hero draft/.test(pane), "no attaching AFTER the loading any more");
  assert.match(pane, /if \(activeIdRef\.current\) reconcileAfterConnected\(activeIdRef\.current, evt, !reconnected\);/);
  const runError = pane.slice(pane.indexOf('evt.subtype === "run_error"'), pane.indexOf('evt.subtype === "compacting"'));
  // Finding 1: the reload after run_error keeps the error bubble — it is in no row.
  assert.match(runError, /if \(joinedMidRunRef\.current && activeIdRef\.current\) \{ joinedMidRunRef\.current = false; reloadOpenChatLog\(activeIdRef\.current, \{ keepError: true \}\)/, "C3 with error bubble");
  const cache = read("src/components/chat/chatCache.ts");
  const reload = cache.slice(cache.indexOf("async function reloadOpenChatLog("), cache.indexOf("function applyReconcile("));
  assert.match(reload, /const error = opts\?\.keepError \? baseAfterQueued\(setBubbles\)\.then\(errorTail\) : null;/, "the errors from the queue, after the queued run_error");
  assert.match(reload, /setBubbles\(behind\.length \? \[\.\.\.bs, \.\.\.behind\] : bs\);/, "the error bubble behind the loaded rows");
  assert.ok(!/if \(bs && !busyRef\.current\) setBubbles\(bs\)/.test(cache), "the old guard \"only without busy\" is gone");
  // Findings 2/3: every base from the queue, every apply in the updater, the fallback afterwards; no ref to the drawn history.
  assert.ok(!/bubblesRef/.test(cache) && !/bubblesRef/.test(pane), "no ref to the drawn history any more — it only catches up on rendering");
  assert.match(cache, /reconcileInUpdater\(setBubbles, base, bs, lastId\)\n      \.then\(\(absorbed\) => \{\n        if \(absorbed \|\| activeIdRef\.current !== id\) return;\n        if \(busyRef\.current\) joinedMidRunRef\.current = true;\n        else reloadOpenChatLog\(id\)\.catch\(console\.error\);/, "applyReconcile: rule in the updater, fallback after rendering");
  assert.match(cache, /const base = baseAfterQueued\(setBubbles\);[^\n]*\n    syncChatCache\(id\)\n      \.then\(async \(r\) => \{ if \(r && activeIdRef\.current === id\) applyReconcile\(id, await base, r\.bs, r\.lastId\); \}\)/, "afterTheLoad");
  // Finding 4: revalidateChat applies AS SOON AS its reconcile is back — with its state —, never only after the chat row.
  const reval = cache.slice(cache.indexOf("async function revalidateChat("), cache.indexOf("\n  return { chatCacheRef,"));
  const beforeGet = reval.slice(0, reval.indexOf("if (!applies()) return;"));
  assert.match(beforeGet, /syncChatCache\(id\)\.then\(async \(r\) => \{ if \(r && applies\(\)\) applyReconcile\(id, await prior, r\.bs, r\.lastId\); \}\),\n    \]\);/, "revalidateChat applies in the Promise.all, next to the chat GET");
  assert.ok(!reval.slice(reval.indexOf("if (!applies()) return;")).includes("applyReconcile("), "no applying after the chat GET any more");
  assert.match(cache, /return \{ bs, lastId: rows\.length \? rows\[rows\.length - 1\]\.id : 0 \};/, "a reconcile carries its state");
});

// ── The window of the history (lib/api/log-window.ts, server chats/log-window.js) ──────────────────────────────────────
// The server part (window, boundary, truncation, delta against `total`) is in server/backend/test/log-window.test.js. Here: the client's
// rule and its wiring.
// Counter-test: in chatCache.ts `syncOnce` the old computation `delta.total === entry.rows.length + delta.rows.length` instead of
// `deltaAddsUp(entry, delta)` ⇒ "Window: wiring …" red.

test("Window: deltaAddsUp computes against the server's total, not against the held rows", () => {
  // A window: 300 of 16,213 rows held, the server reported 16,213; two new rows arrive.
  const state = { total: 16213, rows: new Array(300) };
  const delta = { total: 16215, rows: [{}, {}] };
  assert.equal(deltaAddsUp(state, delta), true, "two new rows on the server's state — append");
  assert.notEqual(delta.total, state.rows.length + delta.rows.length, "the old computation (rows in the cache + delta) would never reconcile in a window");
  assert.equal(deltaAddsUp(state, { total: 16214, rows: [{}, {}] }), false, "a row deleted — reload");
  assert.equal(deltaAddsUp({ total: 0 }, { total: 0, rows: [] }), true, "empty chat");
});

test("Window: wiring — open() loads the window, the reconcile computes via deltaAddsUp, the \"connected\" against total, reload in the same range", () => {
  const pane = read("src/components/chat/ChatPane.tsx");
  const cache = read("src/components/chat/chatCache.ts");
  const stage = read("src/components/chat/ChatStage.tsx");
  const jump = read("src/components/chat/chatRowsJump.ts");
  const blocks = read("src/components/AssistantBlocks.tsx");
  const has = (text, chunk, what) => assert.ok(text.includes(chunk), what);
  has(pane, "loadWindow(id).catch(", "open() loads only the end");
  assert.ok(!pane.includes("api<LogEntry[]>(`/api/chats/${id}/log`)"), "no full log on opening");
  has(cache, "const complete = deltaAddsUp(entry, delta);", "the reconcile computes against total");
  assert.ok(!/entry\.rows\.length \+ delta\.rows\.length/.test(cache), "the old computation is gone");
  has(cache, "reconcileNeeded({ lastId: entry.lastId, count: entry.total }, c)", "the \"connected\" compares with total");
  has(cache, "api<LogDelta>(deltaPath(id, entry.lastId))", "the delta comes truncated");
  has(cache, "loadWindow(id, { from: entry.rows[0]?.id })", "a deletion loads the same range, not the full history");
  has(cache, "loadWindow(id, { from: chatCacheRef.current.get(id)?.rows[0]?.id })", "reloadOpenChatLog loads the same range");
  assert.ok(!cache.includes("`/api/chats/${id}/log`"), "no full log in the cache hook");
  has(cache, "window.addEventListener(ROW_FULL_EVENT, on);", "the expanded row requests the full one");
  has(blocks, "window.dispatchEvent(new CustomEvent(ROW_FULL_EVENT, { detail: truncated }));", "ResultText sends the event");
  has(stage, "useOlderReload({ msgsRef, bubbles, activeId, chatLoading, older: timeWindow.older, loadOlder });", "scrolling up loads older");
  has(jump, "if (timeWindow.older && w.row < timeWindow.firstRow) {", "the jump loads up to the row");
  has(jump, "loadOlder(w.row)", "… with the row as target");
});

test("Window: buildBubbles carries the truncated row to the tool block", () => {
  const log = [
    { id: 1, role: "user", text: "hi", ts: 1 },
    { id: 2, role: "tool", text: JSON.stringify({ id: "t1", name: "Bash", detail: "ls" }), ts: 2 },
    { id: 3, role: "tool_result", text: JSON.stringify({ id: "t1", result: "x".repeat(10) }), ts: 3, truncated: 9999 },
    { id: 4, role: "tool", text: JSON.stringify({ id: "t2", name: "Bash", detail: "pwd" }), ts: 4 },
    { id: 5, role: "tool_result", text: JSON.stringify({ id: "t2", result: "ok" }), ts: 5 },
  ];
  const bs = bubblesMod.buildBubbles(log);
  const tools = bs.flatMap((b) => b.blocks).filter((b) => b.kind === "tool");
  assert.equal(tools[0].truncated, 3, "the row id of the truncated row");
  assert.ok(!("truncated" in tools[1]), "untruncated: no field (equality tests over bubbles stay put)");
});

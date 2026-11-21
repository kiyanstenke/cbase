// The pure rules of the streamed browser (src/lib/browser-stream.ts): the loop breaker — "gone" may trigger ensure() at most ONCE
// per incident — the ack channel, the ack bundling, the hidden tab and the input queue.
//
// The incident, measured on a real backend: after `act closeTab` on the last tab the session lived on with `tabs:0`, the stream said
// "gone", the client emptied its id and called ensure(), ensure returned the SAME session, the next stream said "gone" again — in
// the pane a permanent loop of re-subscribing. Since then the server creates replacement tabs (browsers.js, `saveTab`); this sheet
// holds the client in case the server does not cooperate once: gone → ensure, gone → stop with "Browser was closed." and the
// button; the first FRAME or the button reset. Not "hello": if Chromium dies after the connect, hello comes and then gone without a
// frame — a reset on hello would let the start loop run.
//
// No browser: the two pure functions are checked and — by path — that BrowserPane calls them at the three places where the rule
// acts (the ensure effect, the gone handler, the frame handler), resets the button, and that the gone handler closes the stream
// (otherwise EventSource reconnects every 3 s in viewer mode) and empties the chosen tab (otherwise the frame filter discards
// every image of the next session). A pane that no longer asks `ensureAfterGone(` would loop again, and no type error would see it.
//
// Counter-test (which sabotage turns which test red): `ensureAfterGone` turned to `state <= 2` turns "From the second gone in a row
// no more ensure" red; BrowserPane without the import turns "BrowserPane.tsx does not import …" red; a reset on hello, without
// es.close() and without setSelTab("") in the gone handler turns the binding red three times.
//
// The ack channel: the frame acknowledgement used to ride in the input POST, serialised behind mouse and keyboard — measured, that
// sent ONE ack per round trip and released ONE frame (fps ≈ 1/RTT, over Cloudflare 2 fps). Now a channel of its own: one POST in
// flight, only the newest seq. The rules are checked on sequences of frames and returns with a stubbed clock, and — by path — that
// BrowserPane drives the channel from this sheet and the frame handler no longer acknowledges through push().
// Counter-test: `ackDue` without the `inFlight` condition turns "one POST in flight" and "hello (new viewer)" red; the binding with
// the old frame handler (`push({ t: "ack", …})`) turns "the frame handler does not call ack(d.seq)" red.
//
// The ack waits for the burst: "immediately when the channel is free" acknowledged the FIRST frame of a burst alone, the rest came
// during the POST and went only after its return — two round trips per window, measured 16.8 fps at 150 as at 300 ms, where the
// window would carry 30. Now `ackDueFrom` says WHEN the ack is due: ACK_BUNDLE_MS (20) after the last frame, at the latest
// ACK_AT_LATEST_MS (50) after the first unacknowledged one; the clock is a parameter. Checked: first frame ⇒ due in 20 ms; further
// frames in the 16 ms tick push up to 50 ms after the first; a POST in flight ⇒ nothing; after the return with a waiting seq ⇒
// immediately (the time lies back) or scheduled; and the binding: flushAck schedules via setTimeout on `due - now`, the effect
// cleanup and the hello handler clear the timer.
// Counter-test: `ackDueFrom` with `Math.max` instead of `Math.min` turns four ack tests red ("the first frame", "further frames
// push", "after the return", "hello"); `ackSent` without `firstOpen: null` turns only "after the return … scheduled" red; the
// pane without the timer turns "ackDueFrom does not come from @/lib/browser-stream" and "flushAck does not clear the old timer
// first" red.
//
// The HIDDEN tab: measured in the built-in Chromium: in a background tab setTimeout(fn, 20) fires after 925–1077 ms (16 samples),
// in the front one after 21 — the bundled ack would come up to 1 s too late there, and the server (browsers.js, rememberRtt: the
// minimum per second, only empty sends) would read the BASE RTT from it, ackWindow(1000) = 24, for ten seconds after the return.
// `ackWithoutWait`: in a hidden tab the newest seq goes as soon as the channel is free; the pane asks document.visibilityState and
// on the switch to the background sends a scheduled ack at once (visibilitychange → flushAck). Also the gone handler clears the ack
// timer itself (in viewer mode with an empty tab no cleanup runs, a scheduled POST would go to a viewer that does not exist). And
// the bundle deadlines are bound across the package border: the backend simulator (server/backend/test/browser-flow-control.test.js)
// copies them, this test reads the copy by path — if it drifts, it turns red here, not silently there.
// Counter-test: `ackWithoutWait` as `ackDue(k, 0)` turns "without waiting" red; the pane without the hidden-tab handling turns
// "flushAck does not ask … ackWithoutWait in the hidden tab" and "ackWithoutWait does not come from @/lib/browser-stream" red;
// deleting the visibilitychange effect turns "no visibilitychange effect" red; deleting ackTimerClean in the gone handler turns
// "the gone handler does not clear the ack timer" red; BUNDLE_MS in the simulator set to 21 turns "copy BUNDLE_MS (21) deviates …"
// red.
//
// The input queue: deleting the wheel folding (every wheel single) turns "a wheel burst becomes ONE event" red; mouseMoved appended
// instead of replaced turns "hovering replaces" red; BrowserPane without foldInput turns the binding red.
//
// Run:  node --test web/test/browser-stream.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => fs.readFileSync(path.resolve(webDir, rel), "utf8");

// The source is compiled to JS with the local tsc and imported — the real module text is tested,
// not a replica (model: chat-bar.test.mjs).
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-browser-stream-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "browser-stream.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { foldInput, GONE_STATE_START, countGone, ensureAfterGone, ACK_CHANNEL_START, ACK_BUNDLE_MS, ACK_AT_LATEST_MS, ackNewViewer, rememberAck, ackDue, ackDueFrom, ackWithoutWait, ackSent, ackBack } = await import(pathToFileURL(path.join(out, "browser-stream.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

// A stream as a sequence of events, advanced as in BrowserPane; the result per step is whether
// the pane may call ensure().
const followUp = (events) => {
  let state = GONE_STATE_START;
  return events.map((e) => { state = countGone(state, e); return ensureAfterGone(state); });
};

test("The start is 0 and allows ensure — the pane fetches its browser on opening", () => {
  assert.equal(GONE_STATE_START, 0);
  assert.equal(ensureAfterGone(GONE_STATE_START), true);
});

test("The first gone allows exactly ONE ensure", () => {
  assert.deepEqual(followUp(["gone"]), [true]);
});

test("From the second gone in a row no more ensure — the loop breaks", () => {
  assert.deepEqual(followUp(["gone", "gone"]), [true, false]);
  assert.deepEqual(followUp(["gone", "gone", "gone", "gone"]), [true, false, false, false], "and it stays broken until something resets");
});

test("A frame resets: gone · frame · gone allows an ensure again", () => {
  assert.deepEqual(followUp(["gone", "frame", "gone"]), [true, true, true]);
  assert.deepEqual(followUp(["gone", "gone", "frame", "gone", "gone"]), [true, false, true, true, false], "after the reset the incident counts from the start");
  assert.equal(countGone(7, "frame"), GONE_STATE_START, "a frame sets to the start, not down by one");
});

test("The button \"Start browser\" is the second reset: the state becomes the start, and ensure is allowed again", () => {
  // The button sets `goneRef.current = GONE_STATE_START` in BrowserPane — the same constant the test above
  // checks. Here the computation behind it: after the broken loop the start applies.
  assert.equal(ensureAfterGone(countGone(countGone(GONE_STATE_START, "gone"), "gone")), false);
  assert.equal(ensureAfterGone(GONE_STATE_START), true);
});

// ── Binding by path ──────────────────────────────────────────────────────────────────────────

test("Binding: BrowserPane asks ensureAfterGone( in the ensure effect, counts gone/frame through countGone( (not hello), resets to GONE_STATE_START at the button — and the gone handler closes the stream and empties the tab", () => {
  const pane = read("src/components/BrowserPane.tsx");
  assert.ok(/import\s*\{[^}]*\bensureAfterGone\b[^}]*\}\s*from\s*"@\/lib\/browser-stream"/.test(pane),
    "BrowserPane.tsx does not import ensureAfterGone from @/lib/browser-stream — the rule would stand nowhere or in a replica");
  assert.ok(/import\s*\{[^}]*\bcountGone\b[^}]*\}\s*from\s*"@\/lib\/browser-stream"/.test(pane), "countGone comes from @/lib/browser-stream");
  assert.ok(/import\s*\{[^}]*\bGONE_STATE_START\b[^}]*\}\s*from\s*"@\/lib\/browser-stream"/.test(pane), "GONE_STATE_START comes from @/lib/browser-stream");
  // The effect that calls ensure() by itself is exactly ONE line — and it must ask the rule.
  assert.ok(/!fixedId && active && !browserId && ensureAfterGone\(goneRef\.current\)\) void ensure\(\)/.test(pane),
    "the ensure effect calls ensure() without ensureAfterGone(goneRef.current) — after the second gone the loop would run again");
  assert.ok(/countGone\(goneRef\.current, "gone"\)/.test(pane), "the gone handler does not count through countGone(goneRef.current, \"gone\")");
  assert.ok(/countGone\(goneRef\.current, "frame"\)/.test(pane), "the frame handler does not reset through countGone(goneRef.current, \"frame\")");
  assert.ok(!/countGone\(goneRef\.current, "hello"\)/.test(pane), "hello resets the state — if Chromium dies after the connect (hello, then gone, no frame), the start loop would run");
  assert.ok(/goneRef\.current = GONE_STATE_START; void ensure\(\)/.test(pane), "the button \"Start browser\" does not set the state to GONE_STATE_START before it calls ensure()");
  // Order in the gone handler: first count, then empty the id — the effect reads the state in the render
  // that setBrowserId("") triggers. The other way round it would still see the old state.
  const gone = pane.indexOf('es.addEventListener("gone"');
  const end = pane.indexOf("});", gone);
  const body = pane.slice(gone, end);
  const counts = pane.indexOf('countGone(goneRef.current, "gone")', gone);
  const clears = pane.indexOf("setBrowserId(fixedId || \"\")", gone);
  assert.ok(gone >= 0 && counts > gone && clears > counts && clears < end, "in the gone handler countGone must stand BEFORE setBrowserId");
  // The stream is ended by the server; without es.close() EventSource reconnects — in viewer mode
  // (fixedId) no effect cleans up, and attachViewer would write "gone" again every 3 s.
  assert.ok(/es\.close\(\);/.test(body), "the gone handler does not close the stream (es.close())");
  // The chosen tab belonged to the dead session: if it stays, the frame filter discards every
  // send of the next — the surface stays black until someone clicks a tab.
  assert.ok(/setSelTab\(""\);/.test(body), "the gone handler does not empty the chosen tab (setSelTab(\"\"))");
});

// ── The ack channel ─────────────────────────────────────────────────────────────────────────────
// A channel as in BrowserPane, with a stubbed clock: `frame(seq)` notes the frame at the time and
// calls flush; `until(t)` sets the clock and calls flush — that is the pane's setTimeout firing at
// the due time; `back()` is the return of the POST. `sent` collects what went out, with the time —
// that is the statement.
function channel() {
  let k = ACK_CHANNEL_START;
  let now = 0;
  const sent = [];
  const flush = () => { const seq = ackDue(k, now); if (seq !== null) { k = ackSent(k, seq); sent.push({ seq, at: now }); } };
  return {
    sent,
    seqs: () => sent.map((g) => g.seq),
    frame(seq) { k = rememberAck(k, seq, now); flush(); },
    until(t) { now = t; flush(); },
    back() { k = ackBack(k); flush(); },
    hello() { k = ackNewViewer(k); flush(); },
    state: () => k,
    dueFrom: () => ackDueFrom(k),
  };
}

test("Ack channel: the deadlines are 20 ms after the last frame and at the latest 50 after the first unacknowledged", () => {
  assert.equal(ACK_BUNDLE_MS, 20, "a burst comes with ≈ 16 ms spacing — the deadline must lie above it, otherwise it falls apart into single acks");
  assert.equal(ACK_AT_LATEST_MS, 50, "a continuous stream at 60 fps would push the 20 ms deadline forever — at the latest after 50 ms the ack goes");
  assert.ok(ACK_BUNDLE_MS > 16 && ACK_AT_LATEST_MS > ACK_BUNDLE_MS);
});

test("Ack channel: the first frame does NOT go at once — the ack is due 20 ms later, and only then does it go", () => {
  const c = channel();
  c.until(100); c.frame(1);
  assert.deepEqual(c.sent, [], "acknowledged at once the first frame of a burst would be alone (measured: half the rate)");
  assert.equal(c.dueFrom(), 120, "due ACK_BUNDLE_MS after the frame");
  c.until(119);
  assert.deepEqual(c.sent, [], "before the time nothing goes");
  c.until(120);
  assert.deepEqual(c.sent, [{ seq: 1, at: 120 }]);
  assert.equal(c.state().inFlight, true);
  assert.equal(c.dueFrom(), null, "a POST in flight — nothing due");
});

test("Ack channel: further frames in the 16 ms tick push the ack, but only up to 50 ms after the first unacknowledged", () => {
  const c = channel();
  c.until(100); c.frame(1);
  c.until(116); c.frame(2);
  assert.equal(c.dueFrom(), 136, "the second frame pushes to 20 ms after itself");
  c.until(132); c.frame(3);
  assert.equal(c.dueFrom(), 150, "the third would push to 152 — the limit is 50 ms after the first: 150");
  c.until(148); c.frame(4);
  assert.equal(c.dueFrom(), 150, "the limit stays, whatever still comes");
  c.until(150);
  assert.deepEqual(c.sent, [{ seq: 4, at: 150 }], "the ack goes with the newest seq — 1 to 3 are acknowledged with it");
  c.until(164); c.frame(5);
  assert.deepEqual(c.sent.length, 1, "a POST in flight — frame 5 waits");
  assert.equal(c.dueFrom(), null);
});

test("Ack channel: after the return with a waiting seq the ack goes — at once if its time lies back, otherwise scheduled", () => {
  const c = channel();
  c.until(0); c.frame(1); c.until(20);
  assert.deepEqual(c.seqs(), [1]);
  // During the POST (300 ms) a burst comes: 2 at 300, 3 at 316. The return at 340 finds the due time
  // (min(336, 350) = 336) in the past — the ack goes with the return.
  c.until(300); c.frame(2); c.until(316); c.frame(3);
  assert.equal(c.dueFrom(), null, "as long as the POST runs nothing is due");
  c.until(340); c.back();
  assert.deepEqual(c.sent.at(-1), { seq: 3, at: 340 }, "the time lay back ⇒ with the return");
  // If the frame comes only shortly before the return, the ack is not due yet: scheduled.
  c.until(600); c.frame(4);
  c.until(610); c.back();
  assert.equal(c.sent.length, 2, "at 610 the ack for the frame of 600 is not due");
  assert.equal(c.dueFrom(), 620, "scheduled 20 ms after the frame");
  c.until(620);
  assert.deepEqual(c.sent.at(-1), { seq: 4, at: 620 });
  c.until(900); c.back();
  assert.equal(c.sent.length, 3, "nothing new ⇒ no POST (an empty ack would be a round trip for nothing)");
});

test("Ack channel: an old seq after a newer one changes nothing (seq is monotonic, the server takes the maximum) — nor the deadlines", () => {
  const c = channel();
  c.until(0); c.frame(5); c.until(20); c.until(100); c.back();
  c.until(200); c.frame(3);
  assert.deepEqual(c.seqs(), [5], "3 is already acknowledged by 5");
  assert.equal(c.dueFrom(), null, "an old seq opens nothing");
  const k = rememberAck(rememberAck(ACK_CHANNEL_START, 5, 10), 3, 40);
  assert.equal(k.newest, 5);
  assert.equal(k.lastFrame, 10, "an old seq is no last frame — it would otherwise shift the burst's ack");
});

test("Ack channel: hello (new viewer) counts from the start — a running POST stays in flight until it is back, and the deadlines are empty", () => {
  const c = channel();
  c.until(0); c.frame(9); c.until(20);
  c.hello();
  c.until(30); c.frame(1);
  assert.deepEqual(c.seqs(), [9], "seq 1 of the new viewer waits for the return of the old POST");
  c.until(100); c.back();
  assert.deepEqual(c.sent.at(-1), { seq: 1, at: 100 }, "then it goes — its time (50) lay back");
  // Without a running POST hello is the bare start.
  assert.deepEqual(ackNewViewer({ newest: 7, sent: 7, inFlight: false, firstOpen: 3, lastFrame: 4 }), ACK_CHANNEL_START);
  assert.equal(ackDueFrom(ACK_CHANNEL_START), null, "at the start nothing is due");
});

test("Ack channel without waiting (hidden tab): the newest seq goes as soon as the channel is free and something new is there — the deadlines do not count, a POST in flight stays one", () => {
  let k = rememberAck(ACK_CHANNEL_START, 1, 100);
  assert.equal(ackDue(k, 100), null, "bundled the frame would be due only at 120");
  assert.equal(ackWithoutWait(k), 1, "without waiting it goes at once — in a background tab the 20 ms timer would fire only after ≈ 1 s");
  k = ackSent(k, 1);
  assert.equal(ackWithoutWait(k), null, "a POST in flight — also without waiting only one");
  k = rememberAck(k, 2, 110);
  assert.equal(ackWithoutWait(k), null, "frame 2 waits for the return");
  k = ackBack(k);
  assert.equal(ackWithoutWait(k), 2, "after the return the newest goes");
  k = ackSent(k, 2); k = ackBack(k);
  assert.equal(ackWithoutWait(k), null, "nothing new ⇒ no POST");
  assert.equal(ackWithoutWait(ACK_CHANNEL_START), null, "at the start nothing");
});

test("Binding: BrowserPane drives the ack channel from lib/browser-stream — the frame handler calls ack(d.seq), push() knows no ack any more, hello resets through ackNewViewer", () => {
  const pane = read("src/components/BrowserPane.tsx");
  for (const name of ["ACK_CHANNEL_START", "ackDue", "ackDueFrom", "ackSent", "rememberAck", "ackNewViewer", "ackBack"]) {
    assert.ok(new RegExp(String.raw`import\s*\{[^}]*\b${name}\b[^}]*\}\s*from\s*"@\/lib\/browser-stream"`).test(pane), `${name} does not come from @/lib/browser-stream`);
  }
  // The frame handler acknowledges through its own channel, not through the input queue.
  assert.ok(/if \(d\.seq && vidRef\.current\) ack\(d\.seq\);/.test(pane), "the frame handler does not call ack(d.seq)");
  assert.ok(!/push\(\{\s*t:\s*"ack"/.test(pane), "the frame handler still acknowledges through push() — serialised behind the input POST, one frame per round trip");
  assert.ok(!/e\.t === "ack"/.test(pane), "push() still carries the ack special branch — the channel would then exist twice");
  // The channel: due → sent → POST → back → due again; only one event per POST.
  const flush = pane.indexOf("const flushAck = useCallback(");
  assert.ok(flush >= 0, "flushAck missing");
  const body = pane.slice(flush, pane.indexOf("const ack = useCallback(", flush));
  assert.ok(/const seq = hidden \? ackWithoutWait\(ackRef\.current\) : ackDue\(ackRef\.current, now\)/.test(body), "flushAck does not ask ackDue(ackRef.current, now) in the visible and ackWithoutWait in the hidden tab — the clock must come from the pane, the rule knows no Date.now");
  assert.ok(/ackRef\.current = ackSent\(ackRef\.current, seq\)/.test(body), "flushAck does not mark the seq through ackSent");
  assert.ok(/events: \[\{ t: "ack", v: vidRef\.current, seq \}\]/.test(body), "the ack POST does not carry exactly the one ack event");
  assert.ok(/ackRef\.current = ackBack\(ackRef\.current\);\s*flushAck\(\);/.test(body), "after the return flushAck does not release the channel through ackBack and does not call itself again");
  assert.ok(/ackRef\.current = rememberAck\(ackRef\.current, seq, Date\.now\(\)\)/.test(pane), "ack() does not note the seq through rememberAck with the time");
  assert.ok(/ackRef\.current = ackNewViewer\(ackRef\.current\)/.test(pane), "the hello handler does not reset the channel through ackNewViewer");
});

test("Binding: flushAck schedules via setTimeout on the due time (ackDueFrom) instead of sending at once — and the effect cleanup like the hello handler clear the timer", () => {
  const pane = read("src/components/BrowserPane.tsx");
  const flush = pane.indexOf("const flushAck = useCallback(");
  const body = pane.slice(flush, pane.indexOf("const ack = useCallback(", flush));
  // First clear, then ask: every frame schedules anew, an old timer would otherwise fire twice.
  assert.ok(/const flushAck = useCallback\(\(\) => \{\s*ackTimerClean\(\);/.test(body), "flushAck does not clear the old timer first");
  assert.ok(/const start = ackDueFrom\(ackRef\.current\);\s*if \(start !== null\) ackTimer\.current = setTimeout\(flushAck, start - now\);/.test(body),
    "flushAck does not schedule through setTimeout(flushAck, due - now) on the due time — sent at once the first frame of a burst is alone (measured: 16.8 instead of 30 fps)");
  assert.ok(/const ackTimerClean = useCallback\(\(\) => \{ if \(ackTimer\.current\) \{ clearTimeout\(ackTimer\.current\); ackTimer\.current = null; \} \}, \[\]\);/.test(pane), "ackTimerClean missing or does not clear through clearTimeout");
  // The effect cleanup: after the end of the stream no scheduled POST may go out any more.
  const cleanup = pane.indexOf("return () => {\n      es.close();");
  assert.ok(cleanup >= 0, "the stream effect's cleanup does not begin with es.close()");
  const cleanupBody = pane.slice(cleanup, pane.indexOf("};", cleanup));
  assert.ok(/ackTimerClean\(\);/.test(cleanupBody), "the effect cleanup does not clear the ack timer");
  // The hello handler: a scheduled ack belonged to the old viewer (other vid, seq from the start).
  const hello = pane.indexOf('es.addEventListener("hello"');
  const helloBody = pane.slice(hello, pane.indexOf("});", hello));
  const cleans = helloBody.indexOf("ackTimerClean();");
  const fresh = helloBody.indexOf("ackRef.current = ackNewViewer(ackRef.current)");
  assert.ok(cleans >= 0 && fresh > cleans, "the hello handler does not clear the timer BEFORE the channel reset");
});


test("Binding: in the hidden tab the pane acknowledges without waiting (document.visibilityState), the switch to the background calls flushAck, and the gone handler clears the ack timer itself", () => {
  const pane = read("src/components/BrowserPane.tsx");
  assert.ok(/import\s*\{[^}]*\backWithoutWait\b[^}]*\}\s*from\s*"@\/lib\/browser-stream"/.test(pane), "ackWithoutWait does not come from @/lib/browser-stream");
  const flush = pane.indexOf("const flushAck = useCallback(");
  const body = pane.slice(flush, pane.indexOf("const ack = useCallback(", flush));
  // The timer of a hidden tab fires at the full second (measured 925–1077 ms for 20): the ack would
  // go too late, and the server would measure the base RTT from it.
  assert.ok(/const hidden = typeof document !== "undefined" && document\.visibilityState === "hidden";/.test(body), "flushAck does not read document.visibilityState — in a background tab the pane then acknowledges a second too late, and the server takes that for the path");
  // If the tab becomes hidden while an ack is scheduled, it must go now — not with the throttled timer.
  assert.ok(/document\.addEventListener\("visibilitychange", flushAck\);\s*return \(\) => document\.removeEventListener\("visibilitychange", flushAck\);/.test(pane), "no visibilitychange effect with flushAck (and its unsubscribing) — an ack scheduled on the switch would go with the throttled timer");
  // The gone handler: in viewer mode with an already empty tab no dependency of the stream effect changes,
  // the cleanup does not run — a scheduled POST would go to a dead viewer.
  const gone = pane.indexOf('es.addEventListener("gone"');
  const goneBody = pane.slice(gone, pane.indexOf("});", gone));
  assert.ok(/es\.close\(\);[\s\S]*ackTimerClean\(\);/.test(goneBody), "the gone handler does not clear the ack timer (after es.close())");
});

test("Binding across the package border: the backend simulator (server/backend/test/browser-flow-control.test.js) copies the bundle deadlines — the copy is the source", () => {
  // The backend test rebuilds the client (another package, no import from web/); its numbers are a
  // copy. If it drifts, the simulation there silently becomes another one — here it turns red.
  const sim = fs.readFileSync(path.resolve(webDir, "..", "server", "backend", "test", "browser-flow-control.test.js"), "utf8");
  const bundle = /^const BUNDLE_MS = (\d+);$/m.exec(sim);
  const atLatest = /^const AT_LATEST_MS = (\d+);$/m.exec(sim);
  assert.ok(bundle && atLatest, "the backend simulator no longer carries BUNDLE_MS/AT_LATEST_MS as lines of their own — the binding grips at nothing");
  assert.equal(Number(bundle[1]), ACK_BUNDLE_MS, `the copy BUNDLE_MS (${bundle[1]}) deviates from ACK_BUNDLE_MS (${ACK_BUNDLE_MS})`);
  assert.equal(Number(atLatest[1]), ACK_AT_LATEST_MS, `the copy AT_LATEST_MS (${atLatest[1]}) deviates from ACK_AT_LATEST_MS (${ACK_AT_LATEST_MS})`);
});

// ── The input queue ──
test("Input queue: a wheel burst becomes ONE event with the sum of the deltas and the last position", () => {
  let q = [];
  for (let i = 0; i < 30; i++) q = foldInput(q, { t: "mouse", type: "mouseWheel", x: i, y: 2 * i, deltaX: 1, deltaY: 60 });
  assert.equal(q.length, 1);
  assert.equal(q[0].deltaY, 1800);
  assert.equal(q[0].deltaX, 30);
  assert.equal(q[0].x, 29);
  assert.equal(q[0].y, 58);
});

test("Input queue: hovering replaces, click and key stay single and in order, the old list stays", () => {
  const prior = [{ t: "mouse", type: "mouseMoved", x: 1, y: 1 }];
  let q = foldInput(prior, { t: "mouse", type: "mouseMoved", x: 5, y: 5 });
  assert.deepEqual(q, [{ t: "mouse", type: "mouseMoved", x: 5, y: 5 }], "only the last position counts");
  assert.deepEqual(prior, [{ t: "mouse", type: "mouseMoved", x: 1, y: 1 }], "the old list stays unchanged");
  q = foldInput(q, { t: "mouse", type: "mousePressed", x: 5, y: 5 });
  q = foldInput(q, { t: "mouse", type: "mouseReleased", x: 5, y: 5 });
  q = foldInput(q, { t: "mouse", type: "mouseMoved", x: 6, y: 6 });
  q = foldInput(q, { t: "key", type: "keyDown", key: "a" });
  q = foldInput(q, { t: "key", type: "keyDown", key: "a" });
  q = foldInput(q, { t: "mouse", type: "mouseWheel", deltaY: 10 });
  assert.deepEqual(q.map((e) => `${e.type}${e.key || ""}`), ["mouseMoved", "mousePressed", "mouseReleased", "mouseMoved", "keyDowna", "keyDowna", "mouseWheel"]);
  // A wheel after a click does not fold across the click.
  q = foldInput([{ t: "mouse", type: "mouseWheel", deltaY: 10 }, { t: "mouse", type: "mousePressed" }], { t: "mouse", type: "mouseWheel", deltaY: 10 });
  assert.equal(q.length, 3);
});

test("Input queue: BrowserPane folds through foldInput", () => {
  const pane = read("src/components/BrowserPane.tsx");
  assert.match(pane, /queueRef\.current = foldInput\(queueRef\.current, /, "BrowserPane.push does not fold through foldInput");
});

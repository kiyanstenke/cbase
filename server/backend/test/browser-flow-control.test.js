// Flow control of the screencast: the window per viewer follows the link, not a constant. Without Chromium, without a
// server, with a set clock.
//
// The incident: the window was a fixed 2 and the client acked once per POST round trip — ONE frame per RTT got through:
// 60 fps locally, 6.8 fps at 150 ms ack latency, 3.5 fps at 300 ms, 2 fps over Cloudflare. Now (browsers.js) every frame
// carries its send time, the ack measures the RTT, and the window is `ackWindow(minRtt)` — the SMALLEST RTT of the last
// ten seconds times ACK_TARGET_FPS, clamped to [ACK_WINDOW_MIN, ACK_WINDOW_MAX].
//
// Checked: (a) the pure formula at its anchor points; (b) the credit logic on a fake viewer with a simulated link — frames
// at a 16 ms tick, 300 ms round trip, a client that acks like BrowserPane (at most one ack POST in flight, always the
// newest seq, BUNDLED: 20 ms after the last frame, at the latest 50 after the first unacked one — the rule is REBUILT here,
// not imported: another package; it is bound in web/test/browser-stream.test.mjs) — as a COUNT at a fixed simulated
// latency, not as a clock: time is a number the test advances itself; (b') the same link with LIMITED bandwidth (FIFO line:
// serialisation per frame, then latency) — the path on which the first version broke: every RTT contained the frames before
// it, after ten seconds the inflated minimum became the new minimum, the window ran to the cap and the image was 3 s old;
// (c) the folded ack (only the newest seq) frees the whole credit and pushes the waiting frame; (d) the credit reset when
// acks fail to appear — and that it takes the window back to the smallest; (e) the window takes the smallest RTT, not the
// last, and forgets it after the observation window (BBR pattern); (f) the idle probe on the fast link; (g) an ack above
// what was sent is clamped to what was sent (otherwise the send times would grow forever); (h) silence on the narrow link
// triggers no credit reset; (i) neither does a viewer whose first frame comes after ACK_RESET_MS; (j) the bundled client
// gets more through than the immediately acking one; (k)–(n) the ramp-up (slow start): (k) on the narrow link queue and
// image age as an old-versus-new comparison, (l) its price on the fast link as a count of acks until the full window, (m)
// and (n) the rule by hand — start, growth only when the window limited, end at the target and at exactly the threshold of
// the congestion brake; (o) after a credit reset the ramp-up starts anew.
//
// Counter-tests (which sabotage turns which test red):
//   - `ackWindow` pinned to `return ACK_WINDOW_MIN` (the old fixed window 2) => (b) red ("at 300 ms round trip 4.8 frames
//     per second got through — demands ≥ 12"), plus (a), (c) and (e).
//   - no idle probe and no congestion brake => (b') red ("window 24 … minRtt 3150 … image age 3018 ms") and (d) red
//     ("96 frames" instead of at most 30).
//   - ACK_TARGET_FPS back to 30 => (a) red, (b) red ("20.3 frames per second — demands ≥ 25"), plus (c) and (e); the 4 ms
//     test stays GREEN (it compares against the loaded module's ackWindow).
//   - `return u.now` as the due time in the simulator (no bundling) => (b) stays green (31.0 — target 60 alone carries
//     30), the 4 ms test red ("measured 4 ms"); (j) holds the gain of bundling.
//   - the old deadline (`v.deadlineFrom = now` on the empty send removed) => (h) red ("minRtt 1492 ms (base 282)"), (i) red
//     ("[1, 2, 3]" instead of "[1, 2]"); the simulator without bundling => (j) red ("bundled 31.0 against immediate 31.0").
//   - this file against the browsers.js before slow start => (b'), (k), (l), (m) and (n) red, the twelve others stay green
//     (`withoutAttempt` does not change their statement). Sabotages of the new source: SLOW_START_START 2 => (l), (k); no
//     growth => (b), (k), (l), (m), (n); growth without the limited condition => (m), (n); the brake does not end the ramp-up
//     => (k), (n); `>=` instead of `>` at the threshold => (n); +1 per ack instead of per frame => (l), (m), (n); the target
//     does not end it => (l), (m); the old start in newViewer => (b'), (k), (m), (n).
//
// Run:  CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 node --test server/backend/test/browser-flow-control.test.js
import assert from "node:assert/strict";
import test from "node:test";

import { ACK_WINDOW_MAX, ACK_WINDOW_MIN, ACK_TARGET_FPS, SLOW_START_FACTOR, SLOW_START_START, RTT_WINDOW_S, CONGESTION_FACTOR, _flow_control, ackWindow } from "../electron/server/browsers.js";

const { sendFrame, ackFrame, viewer, setClock } = _flow_control;
const FRAME = { data: "x", w: 1, h: 1 };
// The client's bundling deadlines (web/src/lib/browser-stream.ts: ACK_BUNDLE_MS, ACK_AT_LATEST_MS), copied here — they
// are bound there, here the number carries the result.
const BUNDLE_MS = 20;
const AT_LATEST_MS = 50;

// An SSE response object as sendFrame sees it: collects the seq of the written frames, has an empty Node buffer
// (writableLength 0 — the MAX_BUFFERED branch is not the subject here).
function fakeRes(atFrame = () => {}) {
  const seqs = [];
  return {
    seqs,
    writableLength: 0,
    write(s) {
      const m = /^event: frame\ndata: (.*)\n\n$/s.exec(String(s));
      if (m) { const seq = JSON.parse(m[1]).seq; seqs.push(seq); atFrame(seq); }
      return true;
    },
  };
}

// A set clock: `now` is the time browsers.js sees; the test advances it.
function clockPlaces() {
  const u = { now: 0 };
  setClock(() => u.now);
  return u;
}

// ── (a) The formula ────────────────────────────────────────────────────────────────────────────

test("ackWindow: smallest RTT times target fps, clamped — 4 ms → 2 (local unchanged), 150 → 9, 500 → 24 (cap), 5000 → 24, NaN/0 → 2", () => {
  assert.equal(ACK_TARGET_FPS, 60, "60, not 30: the formula covers the burst itself (W/60 s), otherwise half arrives");
  assert.equal(ACK_WINDOW_MIN, 2);
  assert.equal(ACK_WINDOW_MAX, 24);
  assert.equal(ackWindow(4), 2);
  assert.equal(ackWindow(150), 9);
  assert.equal(ackWindow(400), 24, "400 ms is the last RTT under the cap");
  assert.equal(ackWindow(500), 24, "above it the cap applies: it would be 30, 24 remain");
  assert.equal(ackWindow(5000), 24);
  assert.equal(ackWindow(NaN), 2);
  assert.equal(ackWindow(0), 2);
  assert.equal(ackWindow(undefined), 2);
  assert.equal(ackWindow(-1), 2);
  assert.equal(ackWindow("300"), 18, "a number as text counts like the number — the formula clamps via Number() itself, it does not rely on the caller");
});

// ── (b) The link, simulated ───
// Events with a time, processed in time order (same time: insertion order). Frames travel `lat/2` to the client, acks
// `lat/2` to the server, the POST response `lat/2` back — so the server measures `lat` as the RTT of an immediately
// acked frame. With `line` a FIFO line sits before the latency: every frame occupies it for `frameBytes / bytesPerMs`,
// the next waits — that is how the queue of a narrow link arises. Also counted: the age of every frame at arrival (send
// time to arrival) and the empty sends (nothing unacked before — the probes of the smallest RTT).
// `pause` = [from, to): during this time the page delivers no frames (static page, then scroll);
// `immediately` = the client acks without bundling (only for (j));
// `withoutAttempt` = the viewer starts as before slow start (cap at the top, no ramp-up — only for (k)).
// The simulation also counts the QUEUE (the most frames waiting for serialisation in the FIFO line at once — a number of
// frames, not a duration), the image age during ramp-up (arrivals before `attemptUntilMs`) and the acks the server saw
// until the window reached its target ackWindow(minRtt): the channel has at most one POST in flight, every ack is a round
// trip — that is the price of the ramp-up, counted.
function simulate({ durationMs, lat, tickMs = 16, measureFromMs, line = null, pause = null, immediately = false, withoutAttempt = false, attemptUntilMs = 4000 }) {
  const u = clockPlaces();
  const plan = [];
  const plane = (at, fn) => plan.push({ at, fn });
  const arrived = []; // arrival times of the frames at the client
  const ages = []; // image age per arrival from measureFromMs on
  let ageMax = 0; // the oldest image of the whole link, ramp-up included
  let longestGap = 0; // longest pause between two arrivals from measureFromMs on — the halt of the idle probe
  const sendTime = new Map();
  let empty = 0; // empty sends (probes)
  let lineFreeFrom = 0;
  const departures = []; // departure times from the FIFO line — what has not departed yet, waits
  let queueMax = 0; // the most frames waiting in the line at once (the one just sent included)
  const oldAttempt = []; // image age per arrival before attemptUntilMs
  let receipts = 0; // acks the server saw
  let receiptsUntilFull = null; // … until the window first reached its target ackWindow(minRtt)
  const windowHistory = []; // the window at the end of each second
  // The client like BrowserPane: an own ack channel, at most one POST in flight, always the newest seq — and bundled: due
  // BUNDLE_MS after the last received frame, at the latest AT_LATEST_MS after the first unacked one (rebuild of ackDueFrom in
  // web/src/lib/browser-stream.ts; the numbers there are ACK_BUNDLE_MS/ACK_AT_LATEST_MS). If the time is in the past (the
  // frames came while the POST ran), the ack goes out on its return.
  const client = { newest: 0, acknowledged: 0, inFlight: false, firstOpen: null, lastFrame: null, timer: null };
  let handle = null;
  const dueFrom = () => {
    if (client.inFlight || client.newest <= client.acknowledged) return null;
    if (immediately) return u.now;
    return Math.min(client.lastFrame + BUNDLE_MS, client.firstOpen + AT_LATEST_MS);
  };
  const sendAck = () => {
    const from = dueFrom();
    if (from === null) return;
    if (from > u.now) { planeAck(from); return; }
    const seq = client.newest;
    client.acknowledged = seq;
    client.inFlight = true;
    client.firstOpen = null;
    plane(u.now + lat / 2, () => {
      ackFrame(handle.v.vid, seq);
      receipts++;
      if (receiptsUntilFull === null && handle.v.minRtt > 0 && handle.v.window >= ackWindow(handle.v.minRtt)) receiptsUntilFull = receipts;
      plane(u.now + lat / 2, () => { client.inFlight = false; sendAck(); });
    });
  };
  // The pane's setTimeout: every frame replans, an old timer expires (like clearTimeout).
  const planeAck = (from) => {
    if (client.timer) client.timer.expired = true;
    const timer = { expired: false };
    client.timer = timer;
    plane(from, () => { if (timer.expired) return; client.timer = null; sendAck(); });
  };
  const frameReceived = (seq) => {
    if (seq <= client.newest) return;
    client.newest = seq;
    client.lastFrame = u.now;
    if (client.firstOpen === null) client.firstOpen = u.now;
    sendAck();
  };
  const res = fakeRes((seq) => {
    sendTime.set(seq, u.now);
    if (handle.v.sent - 1 === handle.v.acked) empty++; // sent is already incremented — before it nothing was open
    let departure = u.now;
    if (line) {
      departure = Math.max(u.now, lineFreeFrom) + line.frameBytes / line.bytesProMs;
      lineFreeFrom = departure;
      departures.push(departure);
      queueMax = Math.max(queueMax, departures.filter((a) => a > u.now).length);
    }
    plane(departure + lat / 2, () => {
      const last = arrived[arrived.length - 1];
      if (last !== undefined && last >= measureFromMs) longestGap = Math.max(longestGap, u.now - last);
      arrived.push(u.now);
      ageMax = Math.max(ageMax, u.now - sendTime.get(seq));
      if (u.now >= measureFromMs) ages.push(u.now - sendTime.get(seq));
      if (u.now < attemptUntilMs) oldAttempt.push(u.now - sendTime.get(seq));
      frameReceived(seq);
    });
  });
  handle = viewer(res, { withoutAttempt });
  for (let at = 0; at < durationMs; at += tickMs) {
    if (pause && at >= pause[0] && at < pause[1]) continue;
    plane(at, () => sendFrame(handle.t, handle.v, FRAME));
  }
  for (let at = 999; at < durationMs; at += 1000) plane(at, () => windowHistory.push(handle.v.window));
  try {
    while (plan.length) {
      let i = 0;
      for (let k = 1; k < plan.length; k++) if (plan[k].at < plan[i].at) i = k;
      const e = plan.splice(i, 1)[0];
      u.now = Math.max(u.now, e.at);
      e.fn();
    }
  } finally {
    handle.remove();
    setClock(null);
  }
  const measured = arrived.filter((at) => at >= measureFromMs && at < durationMs).length;
  const imageAge = ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;
  return {
    frames: res.seqs.length, measured, fps: measured / ((durationMs - measureFromMs) / 1000), window: handle.v.window, minRtt: handle.v.minRtt,
    empty, imageAge, ageMax, longestGap, windowMax: Math.max(...windowHistory.slice(1)), windowHistory,
    queueMax, receiptsUntilFull, attempt: handle.v.attempt,
    oldAttempt: oldAttempt.length ? Math.round(oldAttempt.reduce((a, b) => a + b, 0) / oldAttempt.length) : 0,
  };
}

test("link with 300 ms round trip, frames at a 16 ms tick: the window grows to 18 and more, and at least 25 frames per second get through (fixed 2 would give 5, target 30 with immediate ack 17)", (t) => {
  // The first two seconds are ramp-up (the window grows with the first measured RTT); counting starts afterwards. 25 is a
  // lower bound with margin — the simulation yields 35.5 (window 21: the RTT contains the client's bundling deadline, the
  // formula covers it).
  const s = simulate({ durationMs: 6000, lat: 300, measureFromMs: 2000 });
  t.diagnostic(`300 ms RTT: ${s.fps.toFixed(1)} frames/s at the client (window ${s.window}, minRtt ${s.minRtt} ms, ${s.frames} sent)`);
  assert.ok(s.minRtt >= 300 && s.minRtt <= 300 + AT_LATEST_MS, `the smallest measured RTT is the link plus at most the bundling deadline — ${s.minRtt} ms`);
  assert.equal(s.window, ackWindow(s.minRtt), "the window is the formula over the measured RTT");
  assert.ok(s.fps >= 25, `at 300 ms round trip ${s.fps.toFixed(1)} frames per second got through — demands ≥ 25 (with the fixed window 2 it would be 5, with target 30 and immediate ack 17)`);
});

// ── (j) The gain of bundling ───
// (b) holds a lower bound with margin (25), and target 60 carries it even with the immediately acking client (31.0). What
// bundling BRINGS is held by this comparison in simulated time: same server, same link, once bundled, once immediate —
// the bundled ack frees the whole window per round trip, the immediate one the first frame alone and the rest only with
// the next POST.
test("at 300 ms the bundled client gets more frames through than the immediately acking one — the reason for the bundling deadlines, as a comparison, not as a number", (t) => {
  const bundled = simulate({ durationMs: 6000, lat: 300, measureFromMs: 2000 });
  const immediately = simulate({ durationMs: 6000, lat: 300, measureFromMs: 2000, immediately: true });
  t.diagnostic(`300 ms RTT: bundled ${bundled.fps.toFixed(1)} frames/s (window ${bundled.window}), immediate ${immediately.fps.toFixed(1)} (window ${immediately.window})`);
  assert.ok(bundled.fps > immediately.fps, `bundling brings nothing any more — bundled ${bundled.fps.toFixed(1)} against immediate ${immediately.fps.toFixed(1)} frames/s`);
});

test("idle probe on the fast link (300 ms): after ten seconds of constant load the server stops once — at most two RTT — and measures the base anew", (t) => {
  const s = simulate({ durationMs: 13_000, lat: 300, measureFromMs: 2000 });
  t.diagnostic(`300 ms RTT, 13 s: ${s.empty} empty sends, longest gap ${s.longestGap} ms, minRtt ${s.minRtt} ms, ${s.fps.toFixed(1)} frames/s`);
  // Under constant load the server refills the credit before the next ack comes — the line is never empty by itself. With
  // the bundled client (measured, 33 s): two empty sends at the start (0 and 336 ms — the second because the window was
  // still 2 after the first probe), afterwards ONLY the forced probe every ≈ 10.5 s. With the immediately acking client every
  // burst began empty after the probe (one every 600 ms) — the bundled one keeps the line full.
  assert.ok(s.empty >= 3, `the idle probe did not occur — ${s.empty} empty sends in 13 s (two at the start, one forced after ten seconds)`);
  assert.ok(s.longestGap <= 2 * 300, `the probe halt lasts ${s.longestGap} ms — two RTT are allowed`);
  assert.ok(s.minRtt >= 300 && s.minRtt <= 300 + AT_LATEST_MS, `the probe measures the base (plus at most the client's bundling deadline), not the queue — ${s.minRtt} ms`);
});

// ── (b') The narrow link ───
// 2 Mbit/s (250 bytes/ms) carries 7.6 frames per second at 33 KB per frame — a tab screencast of a moving page wants 60.
// The base RTT is 150 + 132 (own serialisation) = 282 ms.
const NARROW = { bytesProMs: 250, frameBytes: 33_000 }; // 2 Mbit/s, 33 KB per frame: 132 ms serialisation per frame
const NARROW_BASE = 150 + NARROW.frameBytes / NARROW.bytesProMs; // 282 ms: latency plus the own serialisation
test("narrow link (150 ms, 2 Mbit/s, 33 KB per frame), 30 s constant load: the ramp-up second stays under the old transient (the formula over the first probe), afterwards the window does not run to the cap, the base RTT stays measurable, the image stays young from the fourth second on", (t) => {
  const s = simulate({ durationMs: 30_000, lat: 150, measureFromMs: 4000, line: NARROW });
  t.diagnostic(`narrow link: ${s.fps.toFixed(1)} frames/s, window ${s.window} (at most ${s.windowMax} from the second second on), minRtt ${s.minRtt} ms, image age avg ${s.imageAge} ms from 4 s, at most ${s.ageMax} ms (ramp-up), ${s.empty} empty sends; window per second: ${s.windowHistory.join(",")}`);
  // Without idle probe and congestion brake: window 24, minRtt 3150, image age 3018 ms.
  // The first second is a named TRANSIENT, not a guard that looks away: the first probe (302 ms) knows no bandwidth and
  // opens the window to ackWindow(302) = 19; 19 frames at 132 ms are 2.5 s of queue until the congestion brake sees the RTT
  // of a frame BEHIND it (seq 6 at 1054 ms) and pulls to 5. That hits every new viewer (start, tab switch, hello). So what
  // is held: the window from the SECOND second on, the oldest image of the whole link as the queue of the first window,
  // and the image age from the FOURTH second on. Slow start (the cap begins at MIN) now keeps the ramp-up UNDER the old
  // formula — measured 11 (SLOW_START_START 6, +1 per acked frame until the brake pulls). The comparison of queue and image
  // age old against new is held by (k).
  assert.ok(s.windowMax <= ACK_WINDOW_MAX / 2, `the window runs away from the queue — at most ${s.windowMax} from the second second on, allowed ${ACK_WINDOW_MAX / 2}`);
  assert.ok(s.windowHistory[0] < ackWindow(NARROW_BASE + 20), `the ramp-up second opens the window as before slow start to the formula over the first probe — ${s.windowHistory[0]}, the old transient was ${ackWindow(NARROW_BASE + 20)}`);
  const attemptLimit = ackWindow(NARROW_BASE + 20) * (NARROW.frameBytes / NARROW.bytesProMs) + NARROW_BASE;
  assert.ok(s.ageMax <= attemptLimit, `the transient is larger than the queue of the first window — oldest image ${s.ageMax} ms, allowed ${attemptLimit} (old: 2413)`);
  assert.ok(s.minRtt <= 2 * NARROW_BASE, `the smallest RTT is no base any more — ${s.minRtt} ms (base ${NARROW_BASE})`);
  assert.ok(s.imageAge <= 1200, `from the fourth second on the image at the client is ${s.imageAge} ms old on average — allowed 1200 (fixed 2: 207, run away: 3018)`);
  assert.ok(s.fps >= 6, `the link carries 7.6 frames per second, ${s.fps.toFixed(1)} got through`);
  // The idle probe: on this link the line is never empty by itself — after every RTT_WINDOW_S seconds the server stops
  // once and sends a probe. The first send is also empty.
  assert.ok(s.empty >= 1 + Math.floor(30 / RTT_WINDOW_S) - 1, `forced idle probes — measured ${s.empty} empty sends in 30 s`);
});

test("link with 4 ms round trip: the window stays small (3 — the RTT is the link plus the bundling deadline), and locally 60 fps get through", (t) => {
  const s = simulate({ durationMs: 3000, lat: 4, measureFromMs: 1000 });
  t.diagnostic(`4 ms RTT: ${s.fps.toFixed(1)} frames/s (window ${s.window}, minRtt ${s.minRtt} ms)`);
  assert.ok(s.minRtt > 4 && s.minRtt <= 4 + AT_LATEST_MS, `locally the server sees the link PLUS the client's bundling deadline (4 < RTT ≤ ${4 + AT_LATEST_MS}) — measured ${s.minRtt} ms`);
  assert.ok(s.window <= ackWindow(4 + AT_LATEST_MS), `locally the window must stay at link plus bundling deadline (≤ ${ackWindow(4 + AT_LATEST_MS)}) — it is ${s.window}`);
  assert.ok(s.fps >= 50, `locally the 16 ms tick must get through almost entirely — measured ${s.fps.toFixed(1)}`);
});

// ── (k)–(n) The ramp-up (slow start) ───
// Every new viewer (start, tab switch, hello) used to open the window with the FIRST ack to the formula over the base —
// the first probe knows no bandwidth. On the narrow link that put 18 frames in the line (22 at 300 ms latency), the oldest
// image was 2.4 s old (3.0) until the congestion brake saw the RTT of a frame BEHIND the queue. Now the cap begins at
// SLOW_START_START, grows per acked frame by SLOW_START_FACTOR − 1 (doubling per round trip, as far as the line acks) and
// only if the window limited; the ramp-up ends at the target ackWindow(minRtt) or at the congestion brake (RTT above
// CONGESTION_FACTOR × base — the same quantity).
const NARROW_LANG = 300; // the second narrow link: same line, 300 ms latency (base 432 ⇒ old window 24)

// (k) The gain, as a COMPARISON on the same link (same simulator, once with the viewer from before): the queue as a
// number of frames, the oldest image and the mean image age of the first four seconds — for both clients: the bundled
// acking one (web) and the immediately acking one (iOS acks over the serialised input channel, without bundling — its window
// comes from the same server). Measured (web) at 150 ms: 18 → 10 frames, 2413 → 1313 ms, 1185 → 696 ms; at 300 ms: 22 → 10,
// 2978 → 1394, 1571 → 726. Demanded is at most two thirds each — "clearly smaller" as a ratio, not as a duration.
const CLIENTS = [["bundled (web)", false], ["immediate (iOS)", true]];
test("ramp-up on the narrow link: queue, oldest image and image age of the first four seconds are at most two thirds of before — comparison old against new on the same link, for both clients, no duration bound", (t) => {
  for (const [client, immediately] of CLIENTS) for (const lat of [150, NARROW_LANG]) {
    const fresh = simulate({ durationMs: 8000, lat, measureFromMs: 4000, line: NARROW, immediately });
    const old = simulate({ durationMs: 8000, lat, measureFromMs: 4000, line: NARROW, immediately, withoutAttempt: true });
    const where = `${client}, ${lat} ms`;
    t.diagnostic(`narrow, ${where} latency: queue ${old.queueMax} → ${fresh.queueMax} frames, oldest image ${old.ageMax} → ${fresh.ageMax} ms, image age avg of the first 4 s ${old.oldAttempt} → ${fresh.oldAttempt} ms; window per second old ${old.windowHistory.join(",")}, new ${fresh.windowHistory.join(",")}`);
    assert.ok(fresh.queueMax * 3 <= old.queueMax * 2, `${where}: during ramp-up ${fresh.queueMax} frames waited in the line at once, before ${old.queueMax} — demands at most two thirds`);
    assert.ok(fresh.ageMax * 3 <= old.ageMax * 2, `${where}: the oldest image was ${fresh.ageMax} ms old, before ${old.ageMax} — demands at most two thirds`);
    assert.ok(fresh.oldAttempt * 3 <= old.oldAttempt * 2, `${where}: the image age of the first four seconds is ${fresh.oldAttempt} ms on average, before ${old.oldAttempt} — demands at most two thirds`);
    assert.equal(fresh.attempt, false, `${where}: on the narrow link the ramp-up ends at the congestion brake — it is still running`);
    assert.ok(fresh.measured >= old.measured * 0.9, `${where}: the ramp-up costs no throughput on the narrow link — ${fresh.measured} against ${old.measured} frames from the fourth second on`);
  }
});

// (l) The price: before, the window was full with the FIRST ack, now after a few. Counted are the acks (round trips of the
// ack channel, at most one POST in flight) until the window reaches its target ackWindow(minRtt). For the bundled client
// (web) it is at most four: the first ack measures the RTT, two doublings carry 6 → 24, and one more because per POST it
// only acks what arrived within 50 ms after the first frame (the rest goes with the next). The immediately acking one (iOS)
// acks even less per POST — from 500 ms at most five. Why 6 (grid over 105 narrow links — 1 to 5 Mbit/s, 50 to 500 ms, 20
// to 50 KB per frame — and the fast link from 4 to 800 ms, bundled client): with SLOW_START_START 2 the ramp-up cost five
// acks from 300 ms, with 4 from 400 ms, with 6 nowhere more than four; 8 saves one at 300 ms but removes only 43 % of the
// oldest image over the grid instead of 49 % (2: 54 %).
const ATTEMPT_RECEIPTS = { false: 4, true: 5 }; // per client: bundled (web) · immediate (iOS)
test("ramp-up on the fast link (4–800 ms, unlimited bandwidth): the window reaches its target within ATTEMPT_RECEIPTS acks per client — before, with the first", (t) => {
  for (const [client, immediately] of CLIENTS) {
    const row = [];
    for (const lat of [4, 50, 150, 300, 500, 800]) {
      const fresh = simulate({ durationMs: 6000, lat, measureFromMs: 2000, immediately });
      const old = simulate({ durationMs: 6000, lat, measureFromMs: 2000, immediately, withoutAttempt: true });
      const where = `${client}, ${lat} ms`;
      row.push(`${lat} ms: ${fresh.receiptsUntilFull} (before ${old.receiptsUntilFull}), window ${fresh.window}`);
      assert.equal(old.receiptsUntilFull, 1, `${where}: before, the window was full with the first ack — the simulation counts wrongly`);
      assert.ok(fresh.receiptsUntilFull !== null, `${where}: the window never reaches its target ${ackWindow(fresh.minRtt)} — it stands at ${fresh.window}`);
      assert.ok(fresh.receiptsUntilFull <= ATTEMPT_RECEIPTS[immediately], `${where}: the window needed ${fresh.receiptsUntilFull} acks to the target — allowed ${ATTEMPT_RECEIPTS[immediately]}`);
      assert.equal(fresh.attempt, false, `${where}: the ramp-up ends at the target — it is still running`);
      assert.equal(fresh.window, ackWindow(fresh.minRtt), `${where}: after the ramp-up the formula over the measured RTT applies`);
    }
    t.diagnostic(`acks until the full window, ${client} — ${row.join("; ")}`);
  }
});

// (m) The rule step by step: start, no growth without limiting, growth per acked frame, end at the target.
test("ramp-up by hand: the cap begins at SLOW_START_START, grows only if the window limited — then by one per acked frame —, and the ramp-up ends at the target ackWindow(minRtt)", () => {
  const u = clockPlaces();
  const res = fakeRes();
  const h = viewer(res);
  try {
    assert.equal(h.v.attempt, true, "a new viewer begins in ramp-up");
    assert.equal(h.v.cap, SLOW_START_START);
    assert.equal(h.v.window, ACK_WINDOW_MIN, "before the first ack the smallest window applies — as before slow start");
    sendFrame(h.t, h.v, FRAME);                      // seq 1 at 0: the first probe
    u.now = 300; ackFrame(h.v.vid, 1);            // RTT 300 => target ackWindow(300) = 18
    assert.equal(h.v.minRtt, 300);
    assert.equal(h.v.cap, SLOW_START_START, "nothing waited (a static page): the ramp-up does not grow — growth without a probe would be the same transient, only later");
    assert.equal(h.v.window, SLOW_START_START, "before: 18 with the first ack");
    // A moving page: SLOW_START_START + 1 frames at a 16 ms tick — SLOW_START_START go, the last one waits.
    for (let k = 0; k <= SLOW_START_START; k++) { u.now = 300 + 16 * k; sendFrame(h.t, h.v, FRAME); }
    assert.equal(h.v.sent - h.v.acked, SLOW_START_START, "the window is full");
    assert.ok(h.v.pending, "the last one waits — the window limited");
    u.now = 700; ackFrame(h.v.vid, h.v.sent);     // acks SLOW_START_START frames, none with congestion (RTT ≤ 400)
    assert.equal(h.v.cap, SLOW_START_START * SLOW_START_FACTOR, "per acked frame by SLOW_START_FACTOR − 1: the cap doubles per round trip");
    assert.equal(h.v.window, SLOW_START_START * SLOW_START_FACTOR);
    assert.equal(h.v.attempt, true, "the target 18 is not reached yet");
    assert.equal(h.v.sent - h.v.acked, 1, "the waiting frame went out with the ack");
    // One more round trip: window full again, one waits, everything acked => 24 ≥ 18: ramp-up over.
    const open = h.v.window;
    for (let k = 0; k < open; k++) { u.now = 716 + 16 * k; sendFrame(h.t, h.v, FRAME); }
    assert.equal(h.v.sent - h.v.acked, open, "the window is full again");
    assert.ok(h.v.pending);
    u.now = 1000; ackFrame(h.v.vid, h.v.sent);
    assert.equal(h.v.attempt, false, "the target is reached — the ramp-up is over");
    assert.equal(h.v.window, ackWindow(300), "from now on the formula over the smallest RTT applies");
    assert.equal(h.v.cap, ACK_WINDOW_MAX, "the cap stands above the target, clamped to ACK_WINDOW_MAX");
  } finally { h.remove(); setClock(null); }
});

// (n) The end at the congestion brake. The threshold is EXACTLY that of the congestion brake: an RTT of CONGESTION_FACTOR ×
// base is not yet congestion (the ramp-up grows), one millisecond more is (the brake sets the cap, the ramp-up is over).
function attemptUntilToReceipt(rtt) {
  const u = clockPlaces();
  const res = fakeRes();
  const h = viewer(res);
  sendFrame(h.t, h.v, FRAME);
  u.now = 300; ackFrame(h.v.vid, 1);             // base 300
  for (let k = 0; k <= SLOW_START_START; k++) { u.now = 300 + 16 * k; sendFrame(h.t, h.v, FRAME); } // full, one waits
  const e = h.v.sendTime.get(h.v.sent);           // the last one sent: at 380, five before it
  u.now = e.time + rtt; ackFrame(h.v.vid, h.v.sent);
  return { u, h, e };
}

test("ramp-up by hand: an RTT above CONGESTION_FACTOR × base ends it — exactly the congestion brake threshold, which then sets the cap; afterwards the cap only grows by one per probe without congestion", () => {
  const enabled = attemptUntilToReceipt(300 * CONGESTION_FACTOR);
  try {
    assert.equal(enabled.h.v.attempt, true, `RTT ${300 * CONGESTION_FACTOR} = CONGESTION_FACTOR × base is no congestion — the ramp-up continues`);
    assert.equal(enabled.h.v.cap, SLOW_START_START * SLOW_START_FACTOR, "and it grows: by one per acked frame");
  } finally { enabled.h.remove(); setClock(null); }
  const rtt = 300 * CONGESTION_FACTOR + 1;
  const { u, h, e } = attemptUntilToReceipt(rtt);
  try {
    assert.equal(h.v.attempt, false, `RTT ${rtt} is above CONGESTION_FACTOR × base — the queue is visible, the ramp-up is over`);
    assert.equal(h.v.cap, Math.max(ACK_WINDOW_MIN, Math.ceil((2 * (e.before + 1) * 300) / rtt)), "the congestion brake sets the cap — and the ramp-up no longer grows in this ack (that would be 12)");
    const afterBrake = h.v.cap;
    // A round trip without congestion: window full again, one waits, ack with a short RTT.
    const t0 = u.now;
    const open = h.v.window - (h.v.sent - h.v.acked);
    for (let k = 0; k <= open; k++) { u.now = t0 + 16 * (k + 1); sendFrame(h.t, h.v, FRAME); }
    assert.ok(h.v.pending, "the window limited again");
    u.now = t0 + 16 * (open + 1) + 300; ackFrame(h.v.vid, h.v.sent);
    assert.equal(h.v.cap, afterBrake + 1, `after the ramp-up by one per probe without congestion (congestion brake) — no longer per acked frame (that would be ${afterBrake + open})`);
  } finally { h.remove(); setClock(null); }
});

// ── (h) Silence on the narrow link ───
// A static page delivers no frames, hence no acks. If the reset deadline ran only from the last ack, after every pause above
// ACK_RESET_MS the first full burst reset the credit although nothing was overdue: the next frame went out as an idle probe
// BEHIND the burst and measured queue plus base. The normal case of a tab screencast is exactly that: read, scroll.
test("silence on the narrow link (6 s without frames, then scroll): no credit reset, no false probe — the base RTT stays, the window does not run to the cap, the image stays young", (t) => {
  const s = simulate({ durationMs: 20_000, lat: 150, measureFromMs: 13_000, line: NARROW, pause: [6000, 12_000] });
  const afterPause = s.windowHistory.slice(12); // the window at the end of seconds 13–20
  t.diagnostic(`silence 6–12 s: minRtt ${s.minRtt} ms, window after the pause at most ${Math.max(...afterPause)}, image age avg ${s.imageAge} ms from 13 s; window per second: ${s.windowHistory.join(",")}`);
  // With the old deadline (acks only): the eleventh frame after the pause (12160 ms) triggered the reset, the next one
  // measured 1492 ms as the "base", the window ran to 24, the image became 3 s old.
  assert.ok(s.minRtt <= 2 * NARROW_BASE, `after the silence a probe behind the burst measures the queue as the base — minRtt ${s.minRtt} ms (base ${NARROW_BASE}; the old deadline gave 1492)`);
  assert.ok(Math.max(...afterPause) <= ACK_WINDOW_MAX / 2, `after the silence the window runs to ${Math.max(...afterPause)} — allowed ${ACK_WINDOW_MAX / 2} (the old deadline gave 24)`);
  assert.ok(s.imageAge <= 1200, `after the silence the image is ${s.imageAge} ms old on average — allowed 1200 (the old deadline: up to 3012)`);
});

// ── (i) A viewer on a static page ───
// The deadline begins at attaching (newViewer); if the first frame comes only after ACK_RESET_MS, that must not count as
// "acks stay away" — until then there was nothing to ack.
test("a viewer whose first frame comes only after ACK_RESET_MS gets no credit reset: the third frame waits for the ack instead of going out as a false probe", () => {
  const u = clockPlaces();
  const res = fakeRes();
  const h = viewer(res);
  try {
    u.now = 3000; sendFrame(h.t, h.v, FRAME); // the page delivered nothing for three seconds
    u.now = 3016; sendFrame(h.t, h.v, FRAME);
    u.now = 3032; sendFrame(h.t, h.v, FRAME);
    assert.deepEqual(res.seqs, [1, 2], "window 2 full: the third waits — with the deadline from attaching it went out as a reset");
    assert.ok(h.v.pending, "the third frame waits for the ack");
    assert.deepEqual([...h.v.sendTime.keys()], [1, 2], "the send times of the first two stand — their acks are the probes");
    u.now = 3302; ackFrame(h.v.vid, 2);
    assert.equal(h.v.minRtt, 302, "the probe measures the link — not 0 after a reset that would have cleared its send time");
  } finally { h.remove(); setClock(null); }
});

// ── (c) The folded ack ───
// (c), (d) second part and (e) mean the STEADY state — credit, reset, smallest RTT —, not the ramp-up: their viewer therefore
// begins as before slow start (`withoutAttempt`), and their statements stand unchanged. The ramp-up is held by (k)–(n).

test("an ack on the newest seq frees the whole credit and pushes the waiting frame at once", () => {
  const u = clockPlaces();
  const res = fakeRes();
  const h = viewer(res, { withoutAttempt: true });
  try {
    // Window 2 at the start: two go, the third waits (and the fourth replaces it — only the NEWEST waits).
    sendFrame(h.t, h.v, FRAME); sendFrame(h.t, h.v, FRAME);
    sendFrame(h.t, h.v, { ...FRAME, data: "three" }); sendFrame(h.t, h.v, { ...FRAME, data: "four" });
    assert.deepEqual(res.seqs, [1, 2]);
    assert.equal(h.v.pending?.data, "four");
    assert.deepEqual([...h.v.sendTime.keys()], [1, 2]);
    u.now = 300;
    ackFrame(h.v.vid, 2); // jump over 1 — everything up to 2 is acked
    assert.equal(h.v.acked, 2);
    assert.deepEqual(res.seqs, [1, 2, 3], "the waiting frame went out with the ack");
    assert.equal(h.v.pending, null);
    assert.deepEqual([...h.v.sendTime.keys()], [3], "acked send times are gone, that of the pushed one stays");
    assert.equal(h.v.window, 18, "an RTT of 300 ms => window 18");
    // Now eighteen in the line, the nineteenth waits; an ack on 18 frees all eighteen.
    for (let k = 0; k < 18; k++) sendFrame(h.t, h.v, FRAME);
    assert.deepEqual(res.seqs.slice(-17), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    assert.equal(h.v.sent - h.v.acked, 18);
    assert.ok(h.v.pending, "the nineteenth waits");
    u.now = 600;
    ackFrame(h.v.vid, 20);
    assert.equal(h.v.sent - h.v.acked, 1, "everything up to 20 acked, the waiting one went out as 21");
    assert.equal(res.seqs[res.seqs.length - 1], 21);
    assert.deepEqual([...h.v.sendTime.keys()], [21]);
  } finally { h.remove(); setClock(null); }
});

// ── (d) Credit reset ──────────────────────────────────────────────────────────────────────────

test("if acks stay away, the viewer does not freeze: after ACK_RESET_MS a frame goes out again — throttled, and the open send times go with it", () => {
  const u = clockPlaces();
  const res = fakeRes();
  const h = viewer(res);
  try {
    sendFrame(h.t, h.v, FRAME); sendFrame(h.t, h.v, FRAME);
    u.now = 100; sendFrame(h.t, h.v, FRAME);
    assert.deepEqual(res.seqs, [1, 2], "window full, without an ack the third waits");
    u.now = 2400; sendFrame(h.t, h.v, FRAME);
    assert.deepEqual(res.seqs, [1, 2], "before the reset it stays waiting");
    u.now = 2600; sendFrame(h.t, h.v, FRAME);
    assert.deepEqual(res.seqs, [1, 2, 3], "after ACK_RESET_MS the credit is reset and the newest frame goes");
    assert.deepEqual([...h.v.sendTime.keys()], [3], "the send times of the never-acked frames are gone — a late ack on them would be no RTT of the link");
    u.now = 2700; ackFrame(h.v.vid, 2); // late ack on a cleared seq
    assert.equal(h.v.minRtt, 0, "an ack without a send time yields no RTT probe");
    assert.equal(h.v.window, ACK_WINDOW_MIN);
  } finally { h.remove(); setClock(null); }
});

test("a grown window falls back to the smallest at the credit reset: without acks two frames go per reset, not 24", () => {
  const u = clockPlaces();
  const res = fakeRes();
  const h = viewer(res, { withoutAttempt: true });
  try {
    sendFrame(h.t, h.v, FRAME);
    u.now = 1000; ackFrame(h.v.vid, 1); // a probe with 1000 ms => window 24 (cap)
    assert.equal(h.v.window, ACK_WINDOW_MAX);
    // Ten seconds of frames at a 16 ms tick, not a single ack any more: the first window (24) still goes out — it was valid —,
    // afterwards per reset (2.5 s) only ACK_WINDOW_MIN.
    for (let t = 1000; t < 11_000; t += 16) { u.now = t; sendFrame(h.t, h.v, FRAME); }
    const afterwards = res.seqs.length - 1;
    assert.ok(afterwards <= ACK_WINDOW_MAX + 3 * ACK_WINDOW_MIN, `in ten seconds without acks ${afterwards} frames went — allowed ${ACK_WINDOW_MAX + 3 * ACK_WINDOW_MIN} (without the fallback: 96)`);
    assert.equal(h.v.window, ACK_WINDOW_MIN, "after the reset the smallest window applies until an ack measures the link again");
  } finally { h.remove(); setClock(null); }
});

// ── (o) A new ramp-up after the reset ───
// The reset used to reset only the window; cap and ramp-up stayed, and the first ack after a stall reopened min(ackWindow(minRtt),
// cap) — the full window of the steady state, on a link that may have narrowed meanwhile. Now the ramp-up begins anew (TCP
// after an RTO). Counter-test: browsers.js without the line `v.attempt = true; v.cap = SLOW_START_START; v.limited = false;`
// => red with "opens 18 frames — allowed SLOW_START_START (6)".
test("after a stall above ACK_RESET_MS the ramp-up begins anew: the first ack afterwards opens SLOW_START_START, not the steady-state window", () => {
  const u = clockPlaces();
  const res = fakeRes();
  const h = viewer(res, { withoutAttempt: true });
  try {
    sendFrame(h.t, h.v, FRAME);
    u.now = 300; ackFrame(h.v.vid, 1);            // base 300 => window 18: steady, cap ACK_WINDOW_MAX
    assert.equal(h.v.window, ackWindow(300));
    const full = h.v.window;
    for (let k = 1; k <= full; k++) { u.now = 300 + 16 * k; sendFrame(h.t, h.v, FRAME); }
    assert.equal(h.v.sent - h.v.acked, full, "the window is full — then the line stalls");
    u.now = 300 + 16 * full + 2600; sendFrame(h.t, h.v, FRAME); // no ack for more than ACK_RESET_MS (2500, browsers.js)
    assert.equal(h.v.sent - h.v.acked, 1, "the reset: the credit is free, the newest frame went into the empty line");
    u.now += 300; ackFrame(h.v.vid, h.v.sent);    // the first ack after the stall, RTT 300 as before
    assert.equal(h.v.window, SLOW_START_START, `after the stall the first ack opens ${h.v.window} frames — allowed SLOW_START_START (${SLOW_START_START}), the steady-state window was ${full}`);
    assert.equal(h.v.attempt, true, "the reset began a new ramp-up, and the target ackWindow(300) is not reached yet");
    assert.equal(h.v.cap, SLOW_START_START, "nothing has limited since the reset — the cap did not grow");
    // It grows again as at the start: only if the window limited.
    for (let k = 0; k <= SLOW_START_START; k++) { u.now += 16; sendFrame(h.t, h.v, FRAME); }
    assert.ok(h.v.pending, "the window limited");
    u.now += 300; ackFrame(h.v.vid, h.v.sent);
    assert.equal(h.v.cap, SLOW_START_START * SLOW_START_FACTOR, "per acked frame by SLOW_START_FACTOR − 1");
  } finally { h.remove(); setClock(null); }
});

// ── (e) Smallest RTT, not the last ────────────────────────────────────────────────────────────

test("the window follows the SMALLEST RTT of the last ten seconds: a growing queue does not enlarge it, and the old probe expires afterwards", () => {
  const u = clockPlaces();
  const res = fakeRes();
  const h = viewer(res, { withoutAttempt: true });
  try {
    sendFrame(h.t, h.v, FRAME);                     // seq 1 at 0
    u.now = 300; ackFrame(h.v.vid, 1);           // RTT 300
    assert.equal(h.v.window, 18);
    u.now = 400; sendFrame(h.t, h.v, FRAME);      // seq 2 at 400
    u.now = 1600; ackFrame(h.v.vid, 2);          // RTT 1200 — queue, not link
    assert.equal(h.v.minRtt, 300, "the smallest RTT remains the link");
    assert.equal(h.v.window, 18, "the window does not run away from the queue");
    u.now = 12_000; sendFrame(h.t, h.v, FRAME);   // seq 3 at 12 s
    u.now = 13_200; ackFrame(h.v.vid, 3);        // RTT 1200, the 300 probe is older than ten seconds
    assert.equal(h.v.minRtt, 1200, "the old probe has expired");
    assert.equal(h.v.window, ACK_WINDOW_MAX, "1200 ms => 72, clamped to the cap");
    assert.ok(h.v.rttEimer.length <= 11, "the buckets are capped — one per second of the observation window");
  } finally { h.remove(); setClock(null); }
});

// ── (g) An ack above what was sent ───
// seq comes from the client's JSON. Unclamped, acked would stand above sent, the window would never be full, and the send
// times would grow forever.
test("an ack with a seq above what was sent counts like an ack on what was sent — the window stays effective, the send times stay capped", () => {
  const u = clockPlaces();
  const res = fakeRes();
  const h = viewer(res);
  try {
    sendFrame(h.t, h.v, FRAME);
    u.now = 100; ackFrame(h.v.vid, 1_000_000);
    assert.equal(h.v.acked, h.v.sent, "clamped to what was sent");
    for (let k = 0; k < 40; k++) { u.now += 16; sendFrame(h.t, h.v, FRAME); }
    assert.ok(h.v.sent - h.v.acked <= h.v.window, `the window holds — open ${h.v.sent - h.v.acked}, window ${h.v.window}`);
    assert.ok(h.v.sendTime.size <= h.v.window, `the send times grow beyond the window: ${h.v.sendTime.size}`);
  } finally { h.remove(); setClock(null); }
});

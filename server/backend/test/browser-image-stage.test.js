// The image stage of the streamed browser: smooth only while the human MOVES the page, sharp otherwise; plus the page
// tick — the pure rules from browser-image-stage.js with a set clock, and against REAL Chromium. (The stage names in the
// code are "sharp" and "smooth".)
//
// The incident: measured without any input over 10 s, a carousel (0.6 s transition every 2 s) changed the stage 10
// times, a page with a spinner stayed soft permanently, typing changed 3 times per 20 keys — dense frames and EVERY input
// made it smooth, and the quiet period counted from the last frame.
//
// Checked: (a) cast parameters per stage (sharp = area × min(dpr, DSF), smooth = area × 0.75, quality 60, without an
// area the old cap); (b) frames never change the stage — a page that moves by itself stays sharp; (c) which input moves
// (wheel, drag, scroll keys — not click, key, text, hover, ack); (d) quiet QUIET_MS after the last movement, frames do not
// extend it; (e) hysteresis: a wheel burst with pauses under QUIET_MS is ONE switch there and ONE back; (f) a recording
// holds sharp; (g) the page tick (delayed ack in the sharp stage); (h) real Chromium: a page with a spinner stays sharp at
// rest and on tick, typing stays sharp, scrolling becomes smooth (390 px) and ends with a sharp final image, measuring
// points only with measure; (i) real Chromium: the retry in startCast.
//
// Counter-tests (each alone): stageAfterFrame with the old density rule => (b), (d), (e) and (h) red; keys as movement
// (movementInput: every keyDown) => (c) and (h) red; quiet from the last frame => (d), (e) and (h) red; page tick 0 => (g)
// and (h) red; the retry in startCast removed => (i) red.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  QUIET_MS, SHARP_PIXEL_MAX, PAGE_TICK_MS, STAGES, movementInput, castParameter, humanInput, receiptDelay, quietDueFrom, stageAfterInput,
  stageAfterFrame, stageAfterQuiet, stageStart,
} from "../electron/server/browser-image-stage.js";
import { act, attachViewer, closeBrowser, dispatchInput, ensureUserBrowser, getBrowser, resolveChromium } from "../electron/server/browsers.js";

const CHROMIUM = resolveChromium();
const SURFACE = { width: 520, height: 860, dpr: 2 };
const WHEEL = { t: "mouse", type: "mouseWheel", x: 10, y: 10, deltaX: 0, deltaY: 40 };

test("(a) cast parameters: sharp in the client's device pixels, smooth in 0.75 × CSS pixels at lower quality", () => {
  assert.deepEqual(castParameter("sharp", SURFACE, 2), { format: "jpeg", quality: 80, maxWidth: 1040, maxHeight: 1720, everyNthFrame: 1 });
  assert.deepEqual(castParameter("smooth", SURFACE, 2), { format: "jpeg", quality: 60, maxWidth: 390, maxHeight: 645, everyNthFrame: 1 });
  assert.equal(STAGES.smooth.scale, 0.75);
  assert.ok(STAGES.smooth.quality < STAGES.sharp.quality, "smooth encodes coarser");
  assert.equal(castParameter("sharp", { ...SURFACE, dpr: 1 }, 2).maxWidth, 520, "dpr 1: no pixels the client throws away");
  assert.equal(castParameter("sharp", { ...SURFACE, dpr: 3 }, 2).maxWidth, 1040, "never more than Chromium's device factor");
  assert.equal(castParameter("sharp", { width: 520, height: 860 }, 2).maxWidth, 1040, "without dpr: the device factor");
  assert.deepEqual(castParameter("smooth", null, 2), { format: "jpeg", quality: 60, maxWidth: 2560, maxHeight: 1600, everyNthFrame: 1 });
  assert.equal(castParameter("nonsense", SURFACE, 2).quality, 80, "an unknown stage is sharp");
  // Pixel cap (live measurement: 1,809 × 1,080 at dpr 2 = 300 kB per image, ≤ 3.6 images/s).
  const wide = castParameter("sharp", { width: 1809, height: 1080, dpr: 2 }, 2);
  assert.ok(wide.maxWidth * wide.maxHeight <= SHARP_PIXEL_MAX * 1.01, `wide area over the cap: ${wide.maxWidth} × ${wide.maxHeight}`);
  assert.ok(wide.maxWidth >= 1809, "never below factor 1");
  assert.equal(castParameter("sharp", { width: 3000, height: 2000, dpr: 2 }, 2).maxWidth, 3000, "huge area: factor 1, not below");
});

test("(b) frames never change the stage: 60 images/s of an animation leave the tab sharp", () => {
  let st = stageStart(0);
  for (let t = 1000; t < 11_000; t += 16) st = stageAfterFrame(st, t);
  assert.equal(st.stage, "sharp");
  assert.equal(quietDueFrom(st), null);
});

test("(c) what moves: wheel, drag, scroll keys — not click, key, text, hover, ack", () => {
  const yes = [
    WHEEL,
    { t: "mouse", type: "mouseMoved", buttons: 1 },
    { t: "key", type: "keyDown", key: "PageDown" }, { t: "key", type: "keyDown", key: "PageUp" },
    { t: "key", type: "keyDown", key: "ArrowDown" }, { t: "key", type: "keyDown", key: "ArrowUp" },
  ];
  const no = [
    { t: "mouse", type: "mousePressed", buttons: 1 }, { t: "mouse", type: "mouseReleased" }, { t: "mouse", type: "mouseMoved", buttons: 0 },
    { t: "key", type: "keyDown", key: "a", text: "a" }, { t: "key", type: "keyUp", key: "ArrowDown" }, { t: "key", type: "keyDown", key: " " },
    { t: "key", type: "keyDown", key: "ArrowDown", modifiers: 8 }, { t: "key", type: "keyDown", key: "End" },
    { t: "text", text: "Hello" }, { t: "ack", v: "x", seq: 3 }, null,
  ];
  for (const e of yes) assert.equal(movementInput(e), true, `moves: ${JSON.stringify(e)}`);
  for (const e of no) assert.equal(movementInput(e), false, `does not move: ${JSON.stringify(e)}`);
  // And at the stage: twenty keys in rhythm leave the tab sharp (text stays sharp while typing).
  let st = stageStart(0);
  for (let i = 0; i < 20; i++) st = stageAfterInput(st, 1000 + i * 150, [{ t: "key", type: "keyDown", key: "a", text: "a" }, { t: "key", type: "keyUp", key: "a" }]);
  assert.equal(st.stage, "sharp", "typing made it smooth");
  assert.equal(stageAfterInput(st, 5000, [{ t: "mouse", type: "mousePressed" }, { t: "mouse", type: "mouseReleased" }]).stage, "sharp", "a click made it smooth");
  assert.equal(stageAfterInput(st, 5000, [WHEEL]).stage, "smooth");
});

test("(d) quiet: sharp QUIET_MS after the last movement — frames do not extend it", () => {
  let st = stageAfterInput(stageStart(0), 1000, [WHEEL]);
  assert.equal(quietDueFrom(st), 1000 + QUIET_MS);
  for (let t = 1000; t < 1000 + QUIET_MS + 500; t += 16) st = stageAfterFrame(st, t); // the page keeps scrolling (momentum)
  assert.equal(quietDueFrom(st), 1000 + QUIET_MS, "frames pushed the quiet period");
  assert.equal(stageAfterQuiet(st, 1000 + QUIET_MS - 1).stage, "smooth");
  const r = stageAfterQuiet(st, 1000 + QUIET_MS);
  assert.equal(r.stage, "sharp");
  assert.equal(quietDueFrom(r), null);
  st = stageAfterInput(st, 1200, [WHEEL]);
  assert.equal(quietDueFrom(st), 1200 + QUIET_MS, "a further movement pushes the quiet period");
});

// A sequence: wheel events at the times `wheels`, frames at a 16 ms tick in between, the alarm fires at the due time.
// Returns the switches as "<time>:<stage>".
function procedure(wheels, until) {
  let st = stageStart(0);
  const changeover = [];
  const remember = (n, now) => { if (n.stage !== st.stage) changeover.push(`${now}:${n.stage}`); st = n; };
  const events = [...wheels.map((t) => ({ t, wheel: true }))];
  for (let t = 0; t < until; t += 16) events.push({ t, wheel: false });
  events.sort((a, b) => a.t - b.t || (a.wheel ? -1 : 1));
  for (const e of events) {
    const fromIdx = quietDueFrom(st);
    if (fromIdx !== null && fromIdx <= e.t) remember(stageAfterQuiet(st, fromIdx), fromIdx);
    remember(e.wheel ? stageAfterInput(st, e.t, [WHEEL]) : stageAfterFrame(st, e.t), e.t);
  }
  const fromIdx = quietDueFrom(st);
  if (fromIdx !== null) remember(stageAfterQuiet(st, fromIdx), fromIdx);
  return changeover;
}

test("(e) hysteresis: a burst with pauses under QUIET_MS is ONE switch there and ONE back; only a longer pause separates bursts", () => {
  // 2 s of wheel at a 16 ms tick, with three pauses of QUIET_MS − 50 (a trackpad that briefly lifts off).
  const wheels = [];
  for (let t = 1000; t < 3000; t += 16) if (!(t % 600 < QUIET_MS - 50 && t > 1100)) wheels.push(t);
  const w = procedure(wheels, 5000);
  assert.equal(w.length, 2, `switches: ${w.join(", ")}`);
  assert.match(w[0], /:smooth$/);
  assert.equal(w[1], `${wheels[wheels.length - 1] + QUIET_MS}:sharp`);
  // Two bursts 1 s apart: two pairs.
  const two = [1000, 1016, 1032, 2500, 2516];
  assert.equal(procedure(two, 4000).length, 4);
});

test("(f) a recording holds sharp", () => {
  assert.equal(stageAfterInput(stageStart(0), 1000, [WHEEL], { recorder: true }).stage, "sharp");
  const fl = stageAfterInput(stageStart(0), 10, [WHEEL]);
  assert.equal(stageAfterFrame(fl, 30, { recorder: true }).stage, "sharp", "a recording that hits a smooth tab sets it sharp");
});

test("(g) page tick: in the sharp stage the ack waits PAGE_TICK_MS — not in smooth and not during a recording; human inputs recognised", () => {
  assert.equal(receiptDelay({ stage: "sharp" }), PAGE_TICK_MS);
  // An animation may fill at most ≈ 60 % of the link (1.5 MB/s) — with the heaviest sharp image (pixel cap, ≈ 0.075 B per pixel).
  assert.ok((1000 / PAGE_TICK_MS) * SHARP_PIXEL_MAX * 0.075 <= 0.6 * 1.5e6, "the tick is so short that an animation fills the link again");
  assert.equal(receiptDelay({ stage: "smooth" }), 0);
  assert.equal(receiptDelay({ stage: "sharp", recorder: true }), 0);
  for (const e of [{ t: "mouse", type: "mousePressed" }, { t: "mouse", type: "mouseWheel" }, { t: "key", type: "keyDown", key: "a" }, { t: "text", text: "x" }, { t: "mouse", type: "mouseMoved", buttons: 1 }]) {
    assert.equal(humanInput(e), true, JSON.stringify(e));
  }
  for (const e of [{ t: "mouse", type: "mouseMoved" }, { t: "ack", v: "x", seq: 1 }, null]) assert.equal(humanInput(e), false, JSON.stringify(e));
});

// ── against real Chromium ──
async function waitFor(what, fn, { tickMs = 20 } = {}) {
  const start = Date.now();
  let reported = 0;
  for (;;) {
    const v = await fn();
    if (v) return v;
    const sec = Math.floor((Date.now() - start) / 30_000);
    if (sec > reported) { reported = sec; console.error(`[waiting] for ${sec * 30} s: ${what}`); }
    await new Promise((r) => setTimeout(r, tickMs));
  }
}
// Width of a JPEG from the SOF segment.
function jpegWidth(b64) {
  const buf = Buffer.from(b64, "base64");
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) return 0;
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xc2) return buf.readUInt16BE(i + 7);
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return 0;
}
// A viewer that acks every frame at once and records it (time, width, measuring fields).
function viewer(id, tabRef) {
  const frames = [];
  let vid = "";
  const handlers = {};
  return {
    frames,
    writableLength: 0, destroyed: false,
    write(x) {
      const h = /^event: hello\ndata: (.*)$/m.exec(x);
      if (h) vid = JSON.parse(h[1]).vid;
      const f = /^event: frame\ndata: (.*)$/m.exec(x);
      if (f) {
        const d = JSON.parse(f[1]);
        frames.push({ time: Date.now(), width: jpegWidth(d.data), tc: d.tc, tr: d.tr, tb: d.tb });
        void dispatchInput(id, tabRef(), [{ t: "ack", v: vid, seq: d.seq }]);
      }
      return true;
    },
    end() {}, on(ev, fn) { handlers[ev] = fn; },
    close() { this.destroyed = true; handlers.close?.(); },
  };
}
async function cleanUp({ viewers, id, proc, web, root }) {
  for (const v of viewers) v.close();
  if (id) closeBrowser(id);
  if (proc) {
    await new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode) return resolve();
      const timer = setTimeout(resolve, 5000);
      proc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (web) await new Promise((r) => web.close(r));
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
}

// (i) The retry in startCast, deterministic: Chromium (the line set up as in browser-last-tab.test.js) rejects the first two
// Page.startScreencast with the measured wording; screencast images (tc > 0) must follow. Stands before (h): without the
// retry (h) would wait forever if its viewer hits the navigation (no deadline — the suite is the emergency brake).
test("(i) real Chromium: if Chromium rejects the screencast (navigation), startCast tries again", { skip: !CHROMIUM ? "Chromium missing" : false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-image-stage-again-"));
  const ctx = { viewers: [], id: "", proc: null, web: null, root };
  try {
    const b = await ensureUserBrowser({ scopeKey: `test:image-stage-again:${path.basename(root)}`, profileDir: path.join(root, "profile"), label: "Again", workspaceId: "ws-test" });
    ctx.id = b.id;
    const s = getBrowser(ctx.id);
    ctx.proc = s.proc;
    await waitFor("first tab", () => s.tabOrder.length >= 1);
    assert.deepEqual(await act(ctx.id, { type: "navigate", url: "data:text/html,<body style='height:5000px;background:linear-gradient(red,blue)'>x</body>" }), { ok: true });
    const cdpSend = s.cdp.send.bind(s.cdp);
    let rejected = 0;
    s.cdp.send = (m, p, sid) => {
      if (m === "Page.startScreencast" && rejected < 2) { rejected++; return Promise.reject(new Error("Not attached to an active page")); }
      return cdpSend(m, p, sid);
    };
    const tab = () => s.activeTargetId;
    const v = viewer(ctx.id, tab);
    ctx.viewers.push(v);
    await attachViewer(ctx.id, "", v, { measure: true });
    let wheel = 0;
    await waitFor("a screencast image", async () => {
      if (v.frames.some((f) => f.tc > 0)) return true;
      await dispatchInput(ctx.id, tab(), [{ ...WHEEL, x: 50, y: 50, deltaY: 30 }]);
      return ++wheel >= 40;
    }, { tickMs: 30 });
    assert.equal(rejected, 2, "the set-up line did not reject twice");
    assert.ok(v.frames.some((f) => f.tc > 0), `no screencast image after ${wheel} wheel events — only ${v.frames.length} image(s) from the screenshot`);
  } finally { await cleanUp(ctx); }
});

test("(h) real Chromium: spinner sharp at rest and on tick, typing sharp, scrolling smooth with a sharp final image; measuring points only with measure", { skip: !CHROMIUM ? "Chromium missing" : false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-image-stage-"));
  const page = `<!doctype html><meta charset=utf-8><style>@keyframes d{to{transform:rotate(360deg)}}#s{position:fixed;top:20px;right:20px;width:40px;height:40px;border:4px solid #ccc;border-top-color:#36c;border-radius:50%;animation:d 1s linear infinite}</style>
<body style="margin:0;font:16px sans-serif"><div id=s></div><input id=f style="position:fixed;top:80px;left:10px;font-size:18px">${Array.from({ length: 300 }, (_, i) => `<p style="background:hsl(${i * 7},60%,80%)">Row ${i}</p>`).join("")}`;
  const web = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(page); });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  const ctx = { viewers: [], id: "", proc: null, web, root };
  try {
    const b = await ensureUserBrowser({ scopeKey: `test:image-stage:${path.basename(root)}`, profileDir: path.join(root, "profile"), label: "Image stage", workspaceId: "ws-test" });
    ctx.id = b.id;
    const s = getBrowser(ctx.id);
    ctx.proc = s.proc;
    await waitFor("first tab", () => s.tabOrder.length >= 1);
    assert.deepEqual(await act(ctx.id, { type: "resize", width: 520, height: 860, dpr: 2 }), { ok: true });
    assert.deepEqual(await act(ctx.id, { type: "navigate", url: `http://127.0.0.1:${web.address().port}/` }), { ok: true });
    const tab = () => s.activeTargetId;
    const v = viewer(ctx.id, tab);
    ctx.viewers.push(v);
    await attachViewer(ctx.id, "", v, { measure: true });

    // Rest with a spinner: ten screencast images, all sharp, and they come on tick — at most one per PAGE_TICK_MS (the lower
    // bound of the span is the promise; there is no upper bound under load). Measured at `tr` (B receives the image from
    // Chromium — the tick acts there), not at the arrival at the viewer: its flow control holds an image back under load and
    // sends it almost together with the next one. The first two images after attaching do not count (ramp-up).
    await waitFor("viewer ramp-up", () => v.frames.filter((x) => x.tc > 0).length >= 2);
    const mark = v.frames.length;
    const ten = await waitFor("ten images of the spinner", () => { const f = v.frames.slice(mark).filter((x) => x.tc > 0); return f.length >= 10 ? f.slice(0, 10) : null; });
    assert.ok(ten.every((f) => f.width === 1040), `the spinner made the rest soft — widths ${JSON.stringify(ten.map((f) => f.width))}`);
    const span = ten[9].tr - ten[0].tr;
    assert.ok(span >= 9 * PAGE_TICK_MS - 100, `ten images of the spinner in ${span} ms (tr gaps ${ten.slice(1).map((f, i) => f.tr - ten[i].tr).join("/")}) — the tick demands ≥ ${9 * PAGE_TICK_MS - 100}`);

    // Typing: click into the field, ten keys — every image afterwards sharp.
    await dispatchInput(ctx.id, tab(), [{ t: "mouse", type: "mousePressed", x: 40, y: 92, button: "left", buttons: 1, clickCount: 1 }, { t: "mouse", type: "mouseReleased", x: 40, y: 92, button: "left", buttons: 0, clickCount: 1 }]);
    const fromTyping = v.frames.length;
    for (let i = 0; i < 10; i++) await dispatchInput(ctx.id, tab(), [{ t: "key", type: "keyDown", key: "a", code: "KeyA", text: "a", winCode: 65 }, { t: "key", type: "keyUp", key: "a", code: "KeyA", winCode: 65 }]);
    await waitFor("an image after typing", () => v.frames.length > fromTyping);
    assert.ok(v.frames.slice(fromTyping).every((f) => f.width === 1040), `typing made it soft — widths ${JSON.stringify(v.frames.slice(fromTyping).map((f) => f.width))}`);
    assert.equal(s.tabs.get(tab()).image.stage, "sharp", "after typing the tab is not sharp");

    // Scrolling: wheel every 30 ms until ten smooth images came (or 400 wheel events — then the assertion says what came).
    const fromRoles = v.frames.length;
    let wheel = 0;
    await waitFor("smooth images while scrolling", async () => {
      await dispatchInput(ctx.id, tab(), [{ ...WHEEL, x: 100, y: 300 }]);
      wheel++;
      return v.frames.slice(fromRoles).filter((f) => f.width === 390).length >= 10 || wheel > 400;
    }, { tickMs: 30 });
    const inRoles = v.frames.slice(fromRoles);
    assert.ok(inRoles.some((f) => f.width === 390), `no smooth image while scrolling — widths ${JSON.stringify(inRoles.map((f) => f.width))}`);
    const end = Date.now();
    // The sharp final image comes by itself, at the earliest QUIET_MS after the last wheel event.
    const end2 = await waitFor("sharp final image", () => v.frames.find((f) => f.time >= end && f.width === 1040));
    assert.ok(end2.time - end >= QUIET_MS - 40, `final image ${end2.time - end} ms after the last wheel event — demands ≥ QUIET_MS`);
    const tz = s.tabs.get(tab());
    await tz.castChain;
    assert.equal(tz.image.stage, "sharp", "after the final image the tab is not sharp");
    assert.equal(quietDueFrom(tz.image), null, "after the final image a quiet alarm is still due");
    t.diagnostic(`spinner: 10 images in ${span} ms; scrolling: ${inRoles.length} images, of which ${inRoles.filter((f) => f.width === 390).length} smooth; final image ${end2.time - end} ms after the last wheel event`);

    // Measuring points: with measure the screencast frames carry tc/tr/tb in this order; without measure no frame carries one.
    const measured = v.frames.filter((f) => f.tc > 0);
    for (const f of measured) assert.ok(f.tr >= f.tc - 50 && f.tb >= f.tr, `measuring points in the wrong order: ${JSON.stringify(f)}`);
    const without = viewer(ctx.id, tab);
    ctx.viewers.push(without);
    await attachViewer(ctx.id, "", without);
    await waitFor("an image without measure", () => without.frames.length > 0);
    assert.ok(without.frames.every((f) => f.tc === undefined && f.tr === undefined && f.tb === undefined), "without measure a frame carries measuring points");
  } finally { await cleanUp(ctx); }
});

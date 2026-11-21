// The end anchor of chat histories (lib/end-anchor.ts). Opening a chat by clicking its row: the release (window listener
// `pointerup`) opened a 300 ms user window; the layout scrolls of opening (anchoring while an image above grows; clamping)
// counted as user scrolls in it, `sticks()` said "not at the end", ChatStage set stickRef = false and the ResizeObserver stopped
// following, so the history stayed 324-380 px above the end. The rule fixes that.
//
// The REAL class runs (compiled with tsc, leaf without imports); the wiring is read as text: `pointercancel` like `pointerup`
// (lib/scroll.ts), `pointerBottom` on the scroll area of the chat.
//
// Counter-test map: removing the line `if (!this.pointerInHistory) return;` in `pointerTop` turns "a release without press in the
// history ..." red (the event decides with `false` instead of `null`) and the second part of "a press IN the history ..." (a second
// release opened a window again). Removing `performance.now() > this.userUntil &&` turns "toEdge: ..." red (inside the user window
// the anchor would take back the trackpad's pixel).
//
// Run:  node --test web/test/end-anchor.test.mjs
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

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-end-anchor-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "end-anchor.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--lib", "es2022,dom",
], { stdio: "pipe" });
const { EndAnchor, atEnd } = await import(pathToFileURL(path.join(out, "end-anchor.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

// A scroll area as in the browser: scrollTop is clamped to [0, scrollHeight - clientHeight].
function area(sh, ch) {
  let top = 0;
  return {
    clientHeight: ch,
    get scrollHeight() { return sh; },
    set height(v) { sh = v; top = Math.min(top, Math.max(0, sh - ch)); },
    get scrollTop() { return top; },
    set scrollTop(v) { top = Math.max(0, Math.min(v, sh - ch)); },
  };
}

test("atEnd: only the edge (1 px rounding), not \"almost at the bottom\"", () => {
  const m = area(1000, 400);
  m.scrollTop = 600;
  assert.equal(atEnd(m), true);
  m.scrollTop = 598;
  assert.equal(atEnd(m), false);
});

test("a release without press in the history (click on the chat row) opens NO user window - the layout scroll decides nothing", () => {
  const a = new EndAnchor();
  const m = area(2000, 600);
  a.toEnd(m); // opened: at the end
  assert.equal(a.sticks(m), null, "its own event");
  a.pointerTop(); // pointerup of the chat row (window listener)
  // An image above gets its height, anchoring shifts scrollTop: the scroll height changed, the history stands 350 px above the end.
  // That is NOT a user scroll.
  m.height = 2350;
  assert.equal(a.sticks(m), null, "a layout scroll after a foreign release decides nothing");
});

test("a press IN the history (dragging the scrollbar) and its release: the events are the user's", () => {
  const a = new EndAnchor();
  const m = area(2000, 600);
  a.toEnd(m);
  a.sticks(m);
  a.pointerBottom();
  m.scrollTop = 1000;
  m.height = 2100; // even with a changed scroll height: during the press everything is the user's
  assert.equal(a.sticks(m), false);
  a.pointerTop(); // user window 300 ms
  m.height = 2200;
  assert.equal(a.sticks(m), false, "inside the window after the release the event decides");
  // A SECOND release without a new press opens nothing.
  const b = new EndAnchor();
  const n = area(2000, 600);
  b.toEnd(n); b.sticks(n);
  b.pointerBottom(); b.pointerTop();
  b.userInput(-1); // the window is over
  b.pointerTop();
  n.height = 2400;
  assert.equal(b.sticks(n), null);
});

test("sticks(): an event with a changed scroll height outside any input is null; same scroll height is the user", () => {
  const a = new EndAnchor();
  const m = area(3000, 500);
  a.toEnd(m);
  a.sticks(m);
  m.height = 3300;
  assert.equal(a.sticks(m), null, "changed scroll height, no input: no verdict");
  m.scrollTop = 100;
  assert.equal(a.sticks(m), false, "same scroll height: the user scrolls");
});

test("toEnd remembers the position even without movement - a pending clamp event counts as its own, the mark is consumed once", () => {
  const a = new EndAnchor();
  const m = area(2000, 600);
  m.scrollTop = 1400; // already at the end
  a.toEnd(m); // no movement
  a.userInput(); // an open user window (wheel just before)
  m.height = 2000; // the event from the clamping before arrives with exactly this position
  assert.equal(a.sticks(m), null, "own event, even in the user window");
  // After that the mark is consumed: the user scrolls away and back to the end - that counts again.
  m.scrollTop = 800;
  assert.equal(a.sticks(m), false);
  m.scrollTop = 1400;
  assert.equal(a.sticks(m), true, "back at the end the history sticks again");
});

test("toEdge: a fraction above the edge without input belongs back at the end - never with open input (trackpad in 1 px steps)", () => {
  const a = new EndAnchor();
  const m = area(2000, 600);
  a.toEnd(m);
  a.sticks(m);
  // Anchoring shifts scrollTop by one pixel, the (integer) scroll height stays: sticks() takes it for the user, "at the end".
  m.scrollTop = 1399;
  assert.equal(a.sticks(m), true);
  assert.equal(a.toEdge(m), true, "without input: back to the edge");
  m.scrollTop = 1400;
  assert.equal(a.toEdge(m), false, "at the edge: nothing to do");
  // The user scrolls one pixel up with the trackpad: their movement stays.
  a.userInput();
  m.scrollTop = 1399;
  assert.equal(a.sticks(m), true);
  assert.equal(a.toEdge(m), false, "never inside the user window");
});

test("wiring: pointercancel like pointerup, pointerBottom on the scroll area of the chat", () => {
  const scroll = read("src/lib/scroll.ts");
  assert.match(scroll, /addEventListener\("pointercancel", onUp\)/);
  assert.match(scroll, /addEventListener\("pointerup", onUp\)/);
  assert.match(scroll, /export \{ atEnd, EndAnchor \} from "@\/lib\/end-anchor"/);
  for (const file of ["src/components/chat/ChatStage.tsx"]) {
    assert.match(read(file), /onPointerDown=\{\(\) => anchor\.pointerBottom\(\)\}/, `${file}: the press in the history is reported`);
    assert.match(read(file), /if \(k && anchor\.toEdge\((m|e\.currentTarget)\)\) anchor\.toEnd\(\1\);/, `${file}: a fraction above the edge is followed up`);
  }
});

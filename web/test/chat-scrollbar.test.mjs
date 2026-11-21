// The chat scroll bar at the composer edge: the part that can be checked without a browser. The RENDERED measure (right edge ==
// composer edge +-2 px, real wheel over the margin) is taken by hand in a real browser, not in the gate.
// Three things here:
//
//   1. The margin-wheel rule (web/src/lib/margin-wheel.ts), executed: which wheel is passed on and which is not, and the
//      `deltaMode` conversion. The helper is compiled with the local tsc (output under node_modules so the react import
//      resolves); the DOM classes it queries are small stand-ins in the global scope.
//   2. ONE helper for the view: the coding chat (chat/ChatStage.tsx) calls `useMarginWheel(msgsRef, userWheel)`, carries the
//      margin surface `@container/history` around the scroll area, and the wheel OVER the history goes through the same user
//      intent (`userWheel`) as the forwarded one: no second version, no own wheel listener in a view.
//   3. The scroll area fills the stage: NO width limit and no container query on the scroll area, the scroll bar sits at the
//      right edge of the stage; the reading column inside is the composer column (`max-w-[736px]`, centred).
//
// COUNTER-TESTS (each shown red once, then reverted): in margin-wheel.ts drop the check `scroller.contains(target)` => (1) red;
// bring back a class list with `@min-[816px]/history:max-w-[768px]` => (3) red; bring back the old
// `onWheel={(e) => { anchor.userInput(); ... }}` in ChatStage => (2) red; in margin-wheel.ts drop `onUserWheel(dy)` or move it
// behind the scrolling => the listener test red.
//
// Run:  node --test web/test/chat-scrollbar.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");

// ── Stand-ins for the DOM classes the helper queries ────────────────────────────────────────────
class Element {
  constructor(parent = null, style = {}, dimensions = {}) {
    this.parentElement = parent;
    this.style = { overflowY: "visible", ...style };
    Object.assign(this, { scrollTop: 0, scrollHeight: 100, clientHeight: 100, ...dimensions });
  }
  contains(n) { for (let k = n; k; k = k.parentElement) if (k === this) return true; return false; }
}
class HTMLElement extends Element { get isContentEditable() { return Boolean(this.editable); } }
class HTMLTextAreaElement extends HTMLElement {}
class HTMLInputElement extends HTMLElement {}
class HTMLSelectElement extends HTMLElement {}
Object.assign(globalThis, { Element, HTMLElement, HTMLTextAreaElement, HTMLInputElement, HTMLSelectElement });
globalThis.getComputedStyle = (el) => el.style;

const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".margin-wheel-test-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "margin-wheel.ts"), "--module", "esnext", "--target", "es2022",
  "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom", "--outDir", out,
], { cwd: webDir, stdio: "pipe" });
const { wheelPixel, marginWheelContinue, marginWheelListener, useMarginWheel } = await import(pathToFileURL(path.join(out, "margin-wheel.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

// A setup like the stage: the margin surface with the scroll area (one row) inside; beside it (in the margin) a box that can
// scroll itself, a text field and a plain node. Outside: the header.
function build() {
  const stage = new HTMLElement(null);
  const margin = new HTMLElement(stage);
  const scroller = new HTMLElement(margin, { overflowY: "auto" }, { scrollHeight: 4000, clientHeight: 800, scrollTop: 3200 });
  const row = new HTMLElement(scroller);
  const box = new HTMLElement(margin, { overflowY: "auto" }, { scrollHeight: 300, clientHeight: 100, scrollTop: 50 });
  const inBox = new HTMLElement(box);
  const field = new HTMLTextAreaElement(margin);
  const editable = Object.assign(new HTMLElement(margin), { editable: true });
  const empty = new HTMLElement(margin);
  const header = new HTMLElement(stage);
  return { stage, margin, scroller, row, box, inBox, field, editable, empty, header };
}
const wheel = (target, extra = {}) => ({ target, deltaX: 0, deltaY: -120, deltaMode: 0, ctrlKey: false, defaultPrevented: false, ...extra });

test("margin wheel (lib/margin-wheel.ts): only a vertical wheel over the EMPTY margin goes to the history", (t) => {
  const a = build();
  const cases = [
    ["target is the margin surface itself", wheel(a.margin), true],
    ["target is a plain node in the margin", wheel(a.empty), true],
    ["... also downwards", wheel(a.empty, { deltaY: 90 }), true],
    ["target is inside the scroll area (the browser scrolls there itself)", wheel(a.row), false],
    ["target is the scroll area", wheel(a.scroller), false],
    ["target is outside the margin surface (header, dock, bar)", wheel(a.header), false],
    ["target is a text field (even one that is not scrolling)", wheel(a.field), false],
    ["target is editable", wheel(a.editable), false],
    ["an ancestor scrolls in this direction itself (upwards, scrollTop 50)", wheel(a.inBox), false],
    ["zoom gesture (ctrlKey)", wheel(a.margin, { ctrlKey: true }), false],
    ["horizontal dominates", wheel(a.margin, { deltaX: 200, deltaY: 20 }), false],
    ["no vertical part", wheel(a.margin, { deltaY: 0 }), false],
    ["already ended by someone else (defaultPrevented)", wheel(a.margin, { defaultPrevented: true }), false],
    ["no element as target", wheel(null), false],
  ];
  for (const [what, e, desired] of cases) assert.equal(marginWheelContinue(e, a.margin, a.scroller), desired, what);
  // The same box at its top stop: it cannot scroll up any more, so the wheel may continue to the history.
  a.box.scrollTop = 0;
  assert.equal(marginWheelContinue(wheel(a.inBox), a.margin, a.scroller), true, "an ancestor at its stop does not scroll in this direction");
  assert.equal(marginWheelContinue(wheel(a.inBox, { deltaY: 120 }), a.margin, a.scroller), false, "... downwards it does");
  // The scroll area itself at its top stop: a wheel over the HISTORY stays the browser's business even if the scroll area
  // cannot scroll in this direction; the rule "no scrolling ancestor" alone would let it through, only "outside the scroll
  // area" holds it.
  a.scroller.scrollTop = 0;
  assert.equal(marginWheelContinue(wheel(a.row), a.margin, a.scroller), false, "target inside the scroll area at the top stop");
  t.diagnostic(`${cases.length + 3} cases of the pass-on rule`);
});

test("margin wheel: deltaMode line and page are converted to pixels, pixels stay", () => {
  assert.equal(wheelPixel({ deltaY: -120, deltaMode: 0 }, 26, 700), -120);
  assert.equal(wheelPixel({ deltaY: -3, deltaMode: 1 }, 26, 700), -78);
  assert.equal(wheelPixel({ deltaY: 1, deltaMode: 2 }, 26, 700), 700);
  assert.equal(typeof useMarginWheel, "function", "the hook is exported");
});

// The order in the listener: report the intent first, THEN scroll. The probe cannot see this reliably: without the callback the
// history's scroll handler usually still decides correctly (the scroll height is unchanged between wheel and scroll event);
// only when a piece of text arrives in the same frame would it take the jump for a layout scroll and pull the history back to
// the end. This test is the guard.
test("margin wheel: the listener reports the user intent BEFORE scrolling, scrolls by the converted amount and ends the event", () => {
  const a = build();
  a.scroller.style.lineHeight = "26px";
  const lane = [];
  let top = 3200;
  Object.defineProperty(a.scroller, "scrollTop", {
    get: () => top,
    set: (v) => { lane.push(["roles", v]); top = v; },
  });
  const listener = marginWheelListener(a.margin, () => a.scroller, (dy) => lane.push(["intent", dy, top]));
  const e = { ...wheel(a.empty, { deltaY: -3, deltaMode: 1 }), preventDefault() { lane.push(["ended"]); } };
  listener(e);
  assert.deepEqual(lane, [["ended"], ["intent", -78, 3200], ["roles", 3122]],
    "order: end, intent (with the state BEFORE scrolling), scroll by 3 lines x 26 px");
  // A wheel that is not passed on touches nothing: no intent, no scrolling, no preventDefault.
  lane.length = 0;
  listener({ ...wheel(a.row), preventDefault() { lane.push(["ended"]); } });
  listener({ ...wheel(a.header), preventDefault() { lane.push(["ended"]); } });
  assert.deepEqual(lane, [], "wheel inside the scroll area or outside the margin surface: nothing");
  // No scroll area (not mounted yet): nothing, and no throw.
  const without = marginWheelListener(a.margin, () => null, () => lane.push(["intent"]));
  without({ ...wheel(a.empty), preventDefault() { lane.push(["ended"]); } });
  assert.deepEqual(lane, [], "without a scroll area: nothing");
  // Without a readable line height (`normal`) the fallback applies.
  a.scroller.style.lineHeight = "normal";
  listener({ ...wheel(a.empty, { deltaY: 2, deltaMode: 1 }), preventDefault() {} });
  assert.deepEqual(lane, [["intent", 32, 3122], ["roles", 3154]], "line height \"normal\" => 16 px per line");
});

// ── 2. ONE helper for the view ──────────────────────────────────────────────────────────────────
const VIEWS = [
  ["chat/ChatStage.tsx", read("src/components/chat/ChatStage.tsx")],
];
// The opening tag of the scroll area: from `ref={msgsRef}` to the first `>` at a line end.
function scrollArea(source, name) {
  const i = source.indexOf("ref={msgsRef}");
  assert.ok(i >= 0, `${name}: ref={msgsRef} not found: update the anchor, do not delete the test`);
  const m = /\n[ ]*>\n/.exec(source.slice(i));
  assert.ok(m, `${name}: end of the scroll area's opening tag (a line with only ">") missing`);
  return { start: i, marker: source.slice(i, i + m.index) };
}

test("the view calls the ONE helper: margin surface around the scroll area, wheel over the history through the same user intent", () => {
  for (const [name, q] of VIEWS) {
    assert.match(q, /^import \{ useMarginWheel \} from "@\/lib\/margin-wheel";$/m, `${name}: imports useMarginWheel from lib/margin-wheel`);
    assert.match(q, /const marginRef = useMarginWheel\(msgsRef, userWheel\);/, `${name}: useMarginWheel(msgsRef, userWheel)`);
    // The user intent: ONE function, it reports the input to the anchor and releases sticking when scrolling up.
    const def = q.match(/const userWheel = useCallback\(\(dy: number\) => \{([^}]*)\}/);
    assert.ok(def, `${name}: userWheel is declared as useCallback`);
    assert.ok(def[1].includes("anchor.userInput()") && /if \(dy < 0\) stickRef\.current = false;/.test(def[1]),
      `${name}: userWheel reports the input and releases sticking upwards: ${def[1].trim()}`);
    const { start, marker } = scrollArea(q, name);
    assert.ok(marker.includes("onWheel={(e) => userWheel(e.deltaY)}"), `${name}: the wheel OVER the history goes through userWheel`);
    assert.ok(!/anchor\.userInput\(\);\s*if \(e\.deltaY/.test(q), `${name}: no second version of the user intent at the scroll area`);
    assert.ok(!/addEventListener\(\s*"wheel"/.test(q), `${name}: no own wheel listener: the wheel at the margin belongs to lib/margin-wheel.ts`);
    // The margin surface sits DIRECTLY before the scroll area (its parent) and carries the container.
    const prior = q.slice(q.lastIndexOf("<div", q.lastIndexOf("<div", start) - 1), start);
    assert.match(prior, /<div ref=\{marginRef\} className="@container\/history flex min-h-0 flex-1 flex-col" data-history-margin>\s*<div\s*$/,
      `${name}: the margin surface @container/history is the parent of the scroll area`);
    assert.ok(marker.includes("cb-chat-text"), `${name}: cb-chat-text stays on the scrolling element (the text-size probe measures there)`);
  }
});

// ── 3. The scroll area fills the stage ──────────────────────────────────────────────────────────
test("the scroll area fills the stage (scroll bar at the right edge), the reading column is the composer column", (t) => {
  const rows = [];
  for (const [name, q] of VIEWS) {
    const afterSocket = q.slice(q.indexOf("ref={dockRef}"));
    const column = afterSocket.match(/<div className="relative mx-auto flex w-full max-w-\[(\d+)px\] flex-col">/);
    assert.ok(column, `${name}: composer column (max-w-[Npx]) not found in the dock`);
    const columnPx = Number(column[1]);
    const { marker } = scrollArea(q, name);
    const cls = marker.match(/className="([^"]*)"/);
    assert.ok(cls, `${name}: classes of the scroll area not found`);
    const classes = cls[1].split(/\s+/);
    assert.ok(classes.includes("flex-1") && classes.includes("overflow-y-auto"), `${name}: the scroll area fills the stage and scrolls itself`);
    const limited = classes.filter((k) => /(^|:)(max-w-|w-\[|mx-auto$)/.test(k) || /@min-\[/.test(k));
    assert.deepEqual(limited, [], `${name}: the scroll area is limited or centred (${limited.join(" ")}); the scroll bar would then sit beside the column instead of at the right edge of the stage`);
    // The reading column is the composer column (736) and sits centred INSIDE the scroll area.
    assert.match(q, new RegExp(`ref=\\{msgsInnerRef\\} className="mx-auto flex w-full max-w-\\[${columnPx}px\\] flex-col`),
      `${name}: the reading column is as wide as the composer (max-w-[${columnPx}px]) and centred`);
    rows.push(`${name}: scroll area = stage, column ${columnPx}`);
  }
  t.diagnostic(rows.join(" · "));
});

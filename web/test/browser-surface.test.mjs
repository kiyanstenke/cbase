// The surface of the streamed browser (src/lib/browser-surface.ts) — fitting of the page image and the wheel rule, without a
// browser.
//
// The finding: in the right chat bar the viewport of an agent (1280 wide and more) was fitted with `max-h-full max-w-full` — in a
// 385 px bar a strip 240 px high at the top, empty surface below. The browser should be full size on the y axis and scroll on
// the x axis.
//
// What is checked is the computation that BrowserPane only CALLS:
//   (a) bar: the image fills the height, wider than the surface => it scrolls, and with a measured scrollbar it stands above it;
//       narrower => full height, centred (the pane centres, the computation names the width);
//   (b) the own browser (viewport = surface, rounded down) fits exactly, also with a rounding remainder — no scrollbar from one
//       pixel; and without oscillation: if the image scrolled only because the scrollbar is missing, it is fitted to the width;
//   (c) tab and extra window ("whole"): the whole image visible, fitted, never scrolling — a frame that fits stays fully
//       visible; missing sizes => null (the pane keeps its default);
//   (d) the wheel rule: vertical goes to the page, horizontal/Shift scrolls the surface as long as it can in THAT direction,
//       at the edge to the page; line deltas in pixels;
//   (e) bindings across file borders that no type error reports: BrowserPane calls the computation with the mode by variant,
//       listens to the wheel natively and not-passive (React reports `wheel` passive — without preventDefault the surface would
//       scroll along with every diagonal swipe), the surface scrolls only sideways and holds the swipe at the edge, the scroll
//       position starts at the left per tab, a press on the scrollbar does not go to the page, and the scroll track is visible
//       in the form system.
//
// Counter-test (which sabotage turns which test red): the bar's mode set to "whole" (like the old `max-h-full max-w-full`) turns
// (a) red "the bar fills the height" and (b) red; BrowserPane in the old form turns (e) red "BrowserPane.tsx does not import the
// fitting"; the wheel rule without the edge check turns (d) red "at the right edge to the page".
//
// Run:  node --test web/test/browser-surface.test.mjs
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

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-browser-surface-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "browser-surface.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { fitting, viewportMatches, wheelTarget, PASS_TOLERANCE, ROW_PX } = await import(pathToFileURL(path.join(out, "browser-surface.js")).href);

test("(a) bar: the image fills the height and scrolls where it is wider — above a measured scrollbar; narrower it stands at full height", () => {
  // The case: 1280 × 800 of the agent in a 385 px wide bar with a 700 px page view.
  const without = fitting({ frameW: 1280, frameH: 800, boxW: 385, boxH: 700, mode: "height", scrollbar: 0 });
  assert.deepEqual(without, { w: 1120, h: 700, scrolls: true }, "the bar fills the height (overlay scrollbar: all of it)");
  const including = fitting({ frameW: 1280, frameH: 800, boxW: 385, boxH: 700, mode: "height", scrollbar: 8 });
  assert.deepEqual(including, { w: 1107, h: 692, scrolls: true }, "with an 8 px scroll track the image stands above it, not hidden below");
  // Widening the bar: same height, less to scroll — no jump into another form.
  const wide = fitting({ frameW: 1280, frameH: 800, boxW: 640, boxH: 700, mode: "height", scrollbar: 8 });
  assert.equal(wide.h, 692);
  assert.equal(wide.scrolls, true);
  // Portrait (a narrow viewport): full height, width by aspect ratio, no scrolling.
  assert.deepEqual(fitting({ frameW: 300, frameH: 800, boxW: 385, boxH: 700, mode: "height" }), { w: 263, h: 700, scrolls: false });
  // A viewport that fits exactly is not scaled up — and one that is lower than the surface fills it.
  assert.deepEqual(fitting({ frameW: 1280, frameH: 600, boxW: 385, boxH: 900, mode: "height", scrollbar: 8 }), { w: 1903, h: 892, scrolls: true });
});

test("(b) the own browser fits exactly (also with a rounding remainder), and the image does not oscillate around the scrollbar", () => {
  assert.deepEqual(fitting({ frameW: 385, frameH: 700, boxW: 385, boxH: 700, mode: "height", scrollbar: 8 }), { w: 385, h: 700, scrolls: false });
  // The emulation rounds down (Math.floor of the pane size): one pixel of difference is no scrollbar.
  assert.deepEqual(fitting({ frameW: 384, frameH: 699, boxW: 385, boxH: 700, mode: "height", scrollbar: 8 }), { w: 385, h: 700, scrolls: false });
  assert.equal(fitting({ frameW: 385 + PASS_TOLERANCE, frameH: 700, boxW: 385, boxH: 700, mode: "height" }).scrolls, false, "up to the tolerance it fits");
  assert.equal(fitting({ frameW: 385 + PASS_TOLERANCE + 2, frameH: 700, boxW: 385, boxH: 700, mode: "height" }).scrolls, true, "above it, it scrolls");
  // The band: too wide without a scrollbar (1.7 %), narrow enough with it => fit to the width, do not scroll.
  const band = fitting({ frameW: 400, frameH: 700, boxW: 395, boxH: 700, mode: "height", scrollbar: 8 });
  assert.equal(band.scrolls, false, "an image that scrolls only BECAUSE the scrollbar is missing would oscillate between the two forms");
  assert.deepEqual([band.w, band.h], [395, Math.floor((395 * 700) / 400)], "fitted to the width");
});

test("(c) tab and extra window: fully visible, fitted, never scrolling; missing sizes => null", () => {
  // The extra window (window.open 1280 × 860, minus border, tab and address bar) with the agent's viewport.
  assert.deepEqual(fitting({ frameW: 1280, frameH: 800, boxW: 1256, boxH: 760, mode: "whole" }), { w: 1216, h: 760, scrolls: false });
  // A large surface the frame fits into: fully visible, not stretched to the height and cut off.
  const large = fitting({ frameW: 1280, frameH: 800, boxW: 1400, boxH: 900, mode: "whole" });
  assert.equal(large.scrolls, false);
  assert.ok(large.w <= 1400 && large.h <= 900 && Math.abs(large.w / large.h - 1.6) < 0.01, JSON.stringify(large));
  // Narrow is no reason to scroll in the tab — the form stays "whole".
  assert.deepEqual(fitting({ frameW: 1280, frameH: 800, boxW: 385, boxH: 700, mode: "whole" }), { w: 385, h: 240, scrolls: false });
  // The own browser fills its surface (its emulation) — here too.
  assert.deepEqual(fitting({ frameW: 1000, frameH: 700, boxW: 1000, boxH: 700, mode: "whole" }), { w: 1000, h: 700, scrolls: false });
  for (const [fw, fh, bw, bh] of [[0, 800, 385, 700], [1280, 0, 385, 700], [1280, 800, 0, 700], [1280, 800, 385, 0], [NaN, 800, 385, 700]]) {
    assert.equal(fitting({ frameW: fw, frameH: fh, boxW: bw, boxH: bh, mode: "height" }), null, `${fw}×${fh} in ${bw}×${bh}`);
  }
  assert.equal(viewportMatches({ w: 384, h: 699 }, { w: 385, h: 700 }), true);
  assert.equal(viewportMatches({ w: 1256, h: 760 }, { w: 385, h: 700 }), false, "another viewer holds the viewport (the extra window)");
  // The server clamps below 320 × 240 (browsers.js:applyMetrics) — otherwise "never fits" would mean a resize on every pointer entry.
  const server = fs.readFileSync(path.join(webDir, "..", "server/backend/electron/server/browsers.js"), "latin1");
  assert.match(server, /const w = Math\.max\(320, width \| 0\);\s*const h = Math\.max\(240, height \| 0\);/, "the server's clamp is no longer 320 × 240 — update VIEWPORT_MIN in lib/browser-surface.ts");
  // The emulation's device screen is its viewport: otherwise a frame's `metadata.deviceWidth` would fall back to the window
  // size after a screencast restart, and the fitting would compute with a foreign measure.
  assert.match(server, /width: w, height: h, screenWidth: w, screenHeight: h,/, "setDeviceMetricsOverride does not set screenWidth/-Height to the viewport");
  assert.equal(viewportMatches({ w: 320, h: 594 }, { w: 263, h: 594 }), true, "clamped to 320 — fits");
  assert.equal(viewportMatches({ w: 320, h: 240 }, { w: 300, h: 200 }), true, "clamped in both directions");
});

test("(d) wheel: vertical to the page; horizontal and Shift scroll the surface as long as it can in that direction; at the edge to the page", () => {
  const surface = { scrollLeft: 100, scrollWidth: 1107, clientWidth: 385 };
  assert.deepEqual(wheelTarget({ deltaX: 0, deltaY: 40, shift: false, ...surface }), { target: "page" }, "vertical scrolls the page");
  assert.deepEqual(wheelTarget({ deltaX: 3, deltaY: 40, shift: false, ...surface }), { target: "page" }, "a diagonal, mostly vertical swipe scrolls the page");
  assert.deepEqual(wheelTarget({ deltaX: 30, deltaY: 4, shift: false, ...surface }), { target: "surface", dx: 30 }, "trackpad swipe to the right");
  assert.deepEqual(wheelTarget({ deltaX: -30, deltaY: 0, shift: false, ...surface }), { target: "surface", dx: -30 }, "to the left");
  assert.deepEqual(wheelTarget({ deltaX: 0, deltaY: 40, shift: true, ...surface }), { target: "surface", dx: 40 }, "Shift+wheel (Chrome: deltaY) scrolls sideways");
  assert.deepEqual(wheelTarget({ deltaX: 40, deltaY: 0, shift: true, ...surface }), { target: "surface", dx: 40 }, "Shift+wheel (macOS: already deltaX)");
  assert.deepEqual(wheelTarget({ deltaX: 0, deltaY: 3, deltaMode: 1, shift: true, ...surface }), { target: "surface", dx: 3 * ROW_PX }, "lines in pixels");
  // The edges: what the surface can no longer scroll goes to the page (it may scroll sideways itself).
  const rightAtMargin = { scrollLeft: 1107 - 385, scrollWidth: 1107, clientWidth: 385 };
  assert.deepEqual(wheelTarget({ deltaX: 30, deltaY: 0, shift: false, ...rightAtMargin }), { target: "page" }, "at the right edge to the page");
  assert.deepEqual(wheelTarget({ deltaX: -30, deltaY: 0, shift: false, ...rightAtMargin }), { target: "surface", dx: -30 }, "back from the right edge the surface scrolls");
  assert.deepEqual(wheelTarget({ deltaX: -30, deltaY: 0, shift: false, scrollLeft: 0, scrollWidth: 1107, clientWidth: 385 }), { target: "page" }, "at the left edge to the page");
  // Tab and window ("whole"): the surface never scrolls — every wheel goes to the page.
  assert.deepEqual(wheelTarget({ deltaX: 30, deltaY: 0, shift: false, scrollLeft: 0, scrollWidth: 1216, clientWidth: 1216 }), { target: "page" });
  assert.deepEqual(wheelTarget({ deltaX: 0, deltaY: 0, shift: true, ...surface }), { target: "page" }, "no delta, no scrolling");
});

test("(e) bindings: BrowserPane calls the computation by variant, listens to the wheel natively, scrolls only sideways, starts at the left per tab, the scrollbar belongs to itself", () => {
  const pane = read("src/components/BrowserPane.tsx");
  const imp = /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/browser-surface"/.exec(pane);
  assert.ok(imp, "BrowserPane.tsx does not import the fitting from @/lib/browser-surface — the computation would stand in a replica");
  for (const f of ["fitting", "wheelTarget", "viewportMatches"]) assert.ok(new RegExp(String.raw`\b${f}\b`).test(imp[1]), `BrowserPane.tsx does not import ${f}`);
  assert.ok(/mode: variant === "bar" \? "height" : "whole"/.test(pane), "the mode does not follow the variant (bar: fill the height, tab/window: whole)");
  assert.ok(/style=\{situation \? \{ width: situation\.w, height: situation\.h/.test(pane), "the canvas does not get its size from the fitting");
  assert.ok(!/className=\{kind === "user" \? "h-full w-full" : "max-h-full max-w-full"\}/.test(pane), "the old fitting by max-h/max-w still stands as the only form");
  // The wheel: native and non-passive (React listens to `wheel` passively), no onWheel on the element any more, preventDefault before the rule.
  assert.ok(/addEventListener\("wheel", wheel, \{ passive: false \}\)/.test(pane), "no non-passive native listener hears the wheel — without preventDefault the surface would scroll along with every diagonal swipe");
  assert.ok(!/onWheel=/.test(pane), "a React onWheel still hangs on the element — the wheel would go to the page twice");
  const wheel = pane.slice(pane.indexOf("wheelRef.current = (e: WheelEvent) => {"), pane.indexOf("useEffect(() => {\n    if (!hostEl) return;"));
  assert.ok(/e\.preventDefault\(\);[\s\S]*wheelTarget\(/.test(wheel), "the wheel body does not call preventDefault first, then wheelTarget");
  assert.ok(/target\?\.target === "surface"\) \{ el\.scrollLeft \+= target\.dx; return; \}/.test(wheel), "what the surface scrolls would additionally go to the page");
  // The surface: scrollable sideways, not vertically, swipe held at the edge, visible track, centred without justify-center.
  const surface = pane.slice(pane.indexOf("ref={hostCb}"), pane.indexOf("<canvas", pane.indexOf("ref={hostCb}")));
  for (const k of ["overflow-x-auto", "overflow-y-hidden", "overscroll-x-contain", "cb-scroll-track", "data-browser-surface="]) {
    assert.ok(surface.includes(k), `the page view does not carry ${k}`);
  }
  assert.ok(!/justify-center/.test(surface), "justify-center on the scroll surface: a wider image would overhang on the left, where no scrollbar reaches");
  assert.ok(/useEffect\(\(\) => \{\s*if \(hostRef\.current\) hostRef\.current\.scrollLeft = 0;\s*\}, \[selTab, browserId\]\);/.test(pane), "the scroll position does not start at the left per tab and session");
  assert.ok(/if \(type === "mousePressed" && onScrollbar\(e\)\) \{/.test(pane) && /if \(handleRef\.current\) return;/.test(pane), "a press on the scrollbar would go as a click to the bottom edge of the page");
  assert.ok(/const lane = hostEl\.offsetHeight - hostEl\.clientHeight;/.test(pane), "the scrollbar's height is not measured — the image would stand below it");
  // What only the probe saw is now bound by the gate.
  const toPage = pane.slice(pane.indexOf("const toPage = "), pane.indexOf("\n  };", pane.indexOf("const toPage = ")));
  assert.ok(/canvasRef\.current\?\.getBoundingClientRect\(\)/.test(toPage), "toPage does not compute over the CANVAS rectangle — after scrolling every click would miss");
  assert.ok(/window\.addEventListener\("mouseup", \(\) => \{ handleRef\.current = false; \}, \{ once: true \}\)/.test(pane), "the scrollbar handle is not reset on release — every following click would be swallowed");
  assert.ok(/deltaX: e\.deltaX, deltaY: e\.deltaY, modifiers/.test(pane) && !/deltaY: -e\.deltaY/.test(pane), "the wheel does not go to the page with the DOM's sign (CDP mouseWheel scrolls like a DOM wheel; negated, every page would scroll the wrong way round)");
  assert.ok(/onMouseEnter=\{fetchViewport\}/.test(pane) && /viewportMatches\(frameGr, box\)/.test(pane), "the own browser does not take its viewport back when a second viewer has pulled it away");
  // The track in the form system: visible (WebKit pseudo-elements only — a scrollbar-width next to them would make it an
  // overlay bar in Chrome that appears only while scrolling).
  const css = read("src/app/globals.css");
  const lane = css.slice(css.indexOf(".cb-scroll-track::-webkit-scrollbar {"), css.indexOf("@supports not selector(::-webkit-scrollbar)"));
  assert.ok(lane.length > 50 && /height: 8px;/.test(lane), "globals.css: .cb-scroll-track::-webkit-scrollbar is missing or not 8 px high");
  assert.ok(!/scrollbar-width|scrollbar-color/.test(lane), "the scroll track sets scrollbar-width/-color outside @supports — Chrome would show it only while scrolling");
});

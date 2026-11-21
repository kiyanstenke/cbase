// The pure rules of the NATIVE browser (src/lib/browser-native.ts) and their bindings.
//
// In the client the user browser is no longer a streamed surface but a WebContentsView of the main window. The web draws only the
// frame and tells the client WHERE the page should lie — and when it has to disappear. Exactly these two statements are measured
// here, because both fail silently: a pane that sends no null bounds on teardown leaves a foreign page standing over the
// surface, and an overlay detection that hits too much freezes the browser behind a still frame — in both cases without a type
// error and without a red line.
//
// The hard part is the overlay rule, and it came from a measured finding: the "jump to end" button (ChatStage.tsx) permanently
// carried `.cb-pop` and only toggled its opacity; the palette and the sparring chat of the C4 planner were `.cb-pop` side sheets
// that stayed open. "Any marker in the document" would have replaced the chat bar's browser permanently with a still frame. Hence
// two filters: invisible does not count, and only what really CUTS the host surface covers it.
//
// The marker list is bound to the UI: every marker occurs under web/src/components (otherwise a dead selector stands here), and
// every full-screen veil there carries a marker of the list (otherwise a modal would lie behind the view). This is the guard that
// stops the list from ageing unnoticed — the SettingsModal case was found exactly so: its veil carries ONLY `cb-overlay-in`, not
// `cb-overlay`.
//
// Counter-test (which sabotage turns which test red): deleting `.cb-overlay-in` from OVERLAY_MARKER turns "veil without marker:
// SettingsModal.tsx:135" red; removing the cut check from `hatOverlay` (every visible overlay counts) turns "a menu beside the
// surface does not cover it" red; deleting `bridge.bounds(scope, hostId, null)` from the cleanup in BrowserNative.tsx turns "the
// cleanup reports no null bounds" red; softening the switch in BrowserPane.tsx to `props.browserId` turns "the agent browser
// streams in every case" red.
//
// Run:  node --test web/test/browser-native.test.mjs
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

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-browser-native-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "browser-native.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const {
  BRIDGE_FUNCTIONS, OVERLAY_MARKER, OVERLAY_SELECTOR, addressText, activeTab, touchedOverlay,
  hasOverlay, hostRect, nativeBridge, nativeAvailable, reportAgainNeeded, rectEqual, reduceState,
  cuts, scopeFromApiBase, visibleLoudStyle, stateEmpty,
} = await import(pathToFileURL(path.join(out, "browser-native.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

// An element as the pane gets it from querySelectorAll: class list + rectangle, plus the
// two attribute markers (`role`, `data-overlay`).
const el = (classes, rect, role, dataMarker = false) => ({
  matches: (s) => {
    if (s === "[data-overlay]") return dataMarker;
    if (s.startsWith("[role=")) return `[role="${role}"]` === s;
    return classes.includes(s.slice(1));
  },
  getBoundingClientRect: () => rect,
});
const R = (x, y, width, height) => ({ x, y, width, height });
const HOST = R(800, 100, 400, 500);

// ── Scope ────────────────────────────────────────────────────────────────────────────────────

test("scopeFromApiBase: the client's scope key is made from the pane's apiBase — and only from it", () => {
  assert.equal(scopeFromApiBase("/api/projects/abc"), "proj:abc");
  assert.equal(scopeFromApiBase("/api/workspaces/w1"), "ws:w1");
  assert.equal(scopeFromApiBase("/api/projects/a%20b"), "proj:a b", "the id is encoded in the URL");
  // Everything that is neither of the two levels has no scope — it stays with the stream instead of
  // the client creating views under an invented key.
  for (const wrong of ["", "/api/browsers/x", "/api/projects", "/api/projects/", "/api/projects/a/b",
    "/api/workspaces/w1/tail", "api/projects/abc", "/api/projects/abc?x=1"]) {
    assert.equal(scopeFromApiBase(wrong), null, `"${wrong}" is no scope`);
  }
});

// ── Bounds ───────────────────────────────────────────────────────────────────────────────────

test("hostRect: visible means a rounded rectangle with area, everything else null", () => {
  assert.deepEqual(hostRect(R(10.4, 20.6, 300.5, 200.4), true), { x: 10, y: 21, width: 301, height: 200 },
    "setBounds takes integers — a half edge only flickers");
  assert.equal(hostRect(R(0, 0, 300, 200), false), null, "invisible (tab switch, hidden, unmount) ⇒ the client hides the view");
  assert.equal(hostRect(R(0, 0, 0, 0), true), null, "`display:none` measures 0 × 0 — that is no area");
  assert.equal(hostRect(R(0, 0, 300, 0), true), null);
  assert.equal(hostRect(R(0, 0, 0.4, 200), true), null, "below half a pixel nothing is left after rounding");
  assert.deepEqual(hostRect(R(-40, -10, 300, 200), true), { x: -40, y: -10, width: 300, height: 200 },
    "a surface partly scrolled out of the window is still a surface");
  assert.equal(hostRect(R(NaN, 0, 300, 200), true), null, "a NaN rectangle must not go out as bounds");
});

test("rectEqual: only a CHANGE goes out as IPC", () => {
  assert.equal(rectEqual(null, null), true);
  assert.equal(rectEqual(R(1, 2, 3, 4), R(1, 2, 3, 4)), true);
  assert.equal(rectEqual(R(1, 2, 3, 4), R(1, 2, 3, 5)), false);
  assert.equal(rectEqual(null, R(1, 2, 3, 4)), false, "becoming visible is a change");
  assert.equal(rectEqual(R(1, 2, 3, 4), null), false, "and so is becoming invisible");
});

// ── State ──────────────────────────────────────────────────────────────────────────────────

test("reduceState: the client is the truth — its state replaces the old one, a foreign scope changes nothing", () => {
  const empty = stateEmpty("proj:a");
  assert.deepEqual(empty, { scope: "proj:a", tabs: [], devtools: false, error: null, bounds: null, visible: false });
  const full = { ...empty, tabs: [{ id: "t1", title: "A", url: "https://a", active: true, loading: false, canBack: false, canForward: false }], devtools: true };
  assert.deepEqual(reduceState(empty, full), full);
  // An error stays in the state until the next one comes WITHOUT an error — the pane holds nothing
  // itself (otherwise a long-healed error would stay as a card).
  const withError = { ...full, error: "View could not be created" };
  assert.equal(reduceState(full, withError).error, "View could not be created");
  assert.equal(reduceState(withError, full).error, null, "the next state without an error clears it");
  // The bridge sends to ALL listeners; two panes of different scopes are attached at the same time.
  assert.deepEqual(reduceState(full, { ...full, scope: "ws:x", tabs: [] }), full, "a foreign scope changes nothing");
  assert.deepEqual(reduceState(full, null), full);
});

test("activeTab / addressText: the active tab leads the address bar, about:blank is no address", () => {
  const tab = (id, active, url) => ({ id, title: id, url, active, loading: false, canBack: false, canForward: false });
  const z = { ...stateEmpty("ws:1"), tabs: [tab("a", false, "https://a"), tab("b", true, "https://b")] };
  assert.equal(activeTab(z)?.id, "b");
  assert.equal(activeTab({ ...z, tabs: [tab("a", false, "https://a")] })?.id, "a", "without a marker the first counts");
  assert.equal(activeTab(stateEmpty("ws:1")), undefined);
  assert.equal(addressText("https://a"), "https://a");
  assert.equal(addressText("about:blank"), "", "an empty tab shows no address but the placeholder");
  assert.equal(addressText(undefined), "");
});

// ── The bridge ───────────────────────────────────────────────────────────────────────────────

test("nativeAvailable: the switch demands EVERY function of the contract — half a bridge is none", () => {
  const full = () => Object.fromEntries(BRIDGE_FUNCTIONS.map((n) => [n, () => {}]));
  assert.equal(nativeAvailable({ cbaseClient: { browser: full() } }), true);
  assert.equal(nativeBridge({ cbaseClient: { browser: full() } })?.navigate instanceof Function, true);
  // An old client (ports, but no browser) and a web without a client fall back to the stream —
  // version switch, no error path.
  assert.equal(nativeAvailable({}), false, "web/local: no bridge");
  assert.equal(nativeAvailable({ cbaseClient: { ports: {} } }), false, "old client: ports yes, browser no");
  assert.equal(nativeAvailable({ cbaseClient: { browser: {} } }), false);
  assert.equal(nativeAvailable(undefined), false);
  assert.equal(nativeAvailable(null), false);
  assert.equal(nativeBridge({}), null);
  for (const missing of BRIDGE_FUNCTIONS) {
    const half = full();
    delete half[missing];
    assert.equal(nativeAvailable({ cbaseClient: { browser: half } }), false, `without ${missing} the bridge is incomplete — a call to it would be a TypeError in the middle of a click`);
  }
  console.log(`  [bridge] ${BRIDGE_FUNCTIONS.length} functions in the contract`);
});

test("Binding: the type NativeBridge and BRIDGE_FUNCTIONS are the same list", () => {
  // The type is the transcript of the list for the compiler. If they drift apart, `nativeAvailable`
  // checks something other than what the pane calls — without a type error.
  const source = read("src/lib/browser-native.ts");
  const m = /export type NativeBridge = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(m, "the declaration of NativeBridge stands in browser-native.ts — renamed? Update the anchor, do not delete the test");
  const inType = [...m[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]);
  assert.ok(inType.length, "NativeBridge is empty — does the regex still work?");
  assert.deepEqual([...inType].sort(), [...BRIDGE_FUNCTIONS].sort(), "NativeBridge != BRIDGE_FUNCTIONS");
});

// ── Overlays ─────────────────────────────────────────────────────────────────────────────────

test("visibleLoudStyle: what the browser draws but does not show covers nothing", () => {
  assert.equal(visibleLoudStyle({ visibility: "visible", opacity: "1", display: "flex" }), true);
  assert.equal(visibleLoudStyle({}), true, "without a value visible counts");
  assert.equal(visibleLoudStyle({ visibility: "hidden" }), false, "that is how the kit menu attaches its sheet until it has measured the position");
  assert.equal(visibleLoudStyle({ visibility: "collapse" }), false);
  assert.equal(visibleLoudStyle({ display: "none" }), false);
  assert.equal(visibleLoudStyle({ opacity: "0" }), false, "the \"jump to end\" button permanently carried .cb-pop and only fades out");
  assert.equal(visibleLoudStyle({ opacity: "0.02" }), true, "half translucent is visible");
});

test("cuts: only a real overlap counts", () => {
  assert.equal(cuts(R(0, 0, 100, 100), R(50, 50, 100, 100)), true);
  assert.equal(cuts(R(0, 0, 100, 100), R(100, 0, 100, 100)), false, "edge to edge is no overlap");
  assert.equal(cuts(R(0, 0, 100, 100), R(0, 0, 0, 0)), false, "a 0 × 0 covers nothing");
  assert.equal(cuts(R(0, 0, 0, 100), R(0, 0, 100, 100)), false);
  assert.equal(cuts(R(-10, -10, 2000, 2000), R(800, 100, 400, 500)), true, "a full-screen veil covers every surface");
});

test("hatOverlay: a modal over the surface switches the still frame on — a menu beside it does not", () => {
  const modal = el(["cb-overlay", "cb-overlay-in"], R(0, 0, 1600, 900));
  const menuBeside = el(["cb-pop"], R(10, 10, 200, 300));
  const menuAbove = el(["cb-pop"], R(820, 140, 200, 300));
  const dialog = el([], R(0, 0, 1600, 900), "dialog");
  assert.equal(hasOverlay([modal], HOST), true);
  assert.equal(hasOverlay([dialog], HOST), true, "[role=\"dialog\"] is the marker of the lightbox, the tasks pill's sheet and the ArtifactBrowser");
  assert.equal(hasOverlay([menuAbove], HOST), true);
  // `[data-overlay]` is the marker of the six drop-down sheets of the header: they draw their own
  // background and therefore must not carry `cb-pop` (as an unlayered rule it would beat every utility
  // on the element). Without a marker they would lie behind the view.
  assert.equal(hasOverlay([el([], R(820, 60, 320, 400), undefined, true)], HOST), true);
  assert.equal(hasOverlay([el([], R(10, 60, 320, 400), undefined, true)], HOST), false, "a drop-down sheet too counts only over the surface");
  assert.equal(hasOverlay([menuBeside], HOST), false, "a menu beside the surface does not cover it — otherwise a still frame would stand beside every chat");
  assert.equal(hasOverlay([menuBeside, modal], HOST), true, "one is enough");
  assert.equal(hasOverlay([], HOST), false);
  assert.equal(hasOverlay([modal], null), false, "without a visible surface there is nothing to cover");
  // An element without a marker is none, even if it lies over the surface.
  assert.equal(hasOverlay([el(["cb-kit-pane"], R(800, 100, 400, 500))], HOST), false);
  // Text nodes and everything without `matches` are skipped instead of running into a selector.
  assert.equal(hasOverlay([{}, null, modal], HOST), true);
  // If an element cannot deliver a rectangle it counts as an overlay: better one still frame too many than
  // a menu behind the view.
  assert.equal(hasOverlay([{ matches: () => true }], HOST), true);
});

test("touchedOverlay: the pre-check saves recomputing on every chat mutation — and lets attributes through", () => {
  const node = (marker) => ({ nodeType: 1, matches: (s) => s === marker, querySelector: () => null });
  const bubble = { nodeType: 1, matches: () => false, querySelector: () => null };
  const text = { nodeType: 3 };
  assert.equal(touchedOverlay([{ type: "childList", addedNodes: [node(".cb-pop")], removedNodes: [] }]), true);
  assert.equal(touchedOverlay([{ type: "childList", addedNodes: [], removedNodes: [node('[role="dialog"]')] }]), true,
    "the DISAPPEARING of an overlay must be recomputed too — otherwise the still frame would stay");
  assert.equal(touchedOverlay([{ type: "childList", addedNodes: [bubble, text], removedNodes: [] }]), false,
    "a streaming chat mutates dozens of times a second — that must not trigger a querySelectorAll over the page");
  // A wrapper without a marker of its own that contains an overlay (portals attach like this).
  assert.equal(touchedOverlay([{ type: "childList", addedNodes: [{ nodeType: 1, matches: () => false, querySelector: (s) => (s === OVERLAY_SELECTOR ? {} : null) }], removedNodes: [] }]), true);
  // Attributes: the kit menu attaches its sheet INVISIBLE and sets the position only in the layout effect.
  // Without this branch the pane would see only the invisible sheet and leave the view standing.
  assert.equal(touchedOverlay([{ type: "attributes", target: node(".cb-pop") }]), true);
  assert.equal(touchedOverlay([{ type: "attributes", target: bubble }]), false);
  // And ONLY the target itself: an ancestor that has a marked child somewhere does not count.
  // Otherwise the pre-check would be worthless — the "jump to end" button carried `.cb-pop` permanently
  // and hangs deep in the chat stage, so EVERY class/style change of an ancestor would hit it.
  const ancestor = { nodeType: 1, matches: () => false, querySelector: (s) => (s === OVERLAY_SELECTOR ? {} : null) };
  assert.equal(touchedOverlay([{ type: "attributes", target: ancestor }]), false);
  // On attaching, the subtree still counts (portals attach a wrapper, see above).
  assert.equal(touchedOverlay([{ type: "childList", addedNodes: [ancestor], removedNodes: [] }]), true);
  assert.equal(touchedOverlay([]), false);
});

test("reportAgainNeeded: if the client discards its hosts, the pane must resend its rectangle", () => {
  const rect = { x: 0, y: 60, width: 600, height: 400 };
  const withBounds = { ...stateEmpty("proj:a"), bounds: rect, visible: true };
  const withoutBounds = stateEmpty("proj:a");
  // The client throws away its host entries on every navigation of the window; the pane reports
  // only CHANGES (rectEqual). Without this follow-up the surface would stay empty until something
  // happens to move.
  assert.equal(reportAgainNeeded(withoutBounds, rect), true);
  assert.equal(reportAgainNeeded(withBounds, rect), false, "the client has a surface — nothing to follow up");
  assert.equal(reportAgainNeeded(withoutBounds, null), false, "we have reported nothing ourselves (tab closed)");
  assert.equal(reportAgainNeeded(null, rect), false);
  // Two hosts: if the other (chat bar) reports a surface, the state carries ITS rectangle —
  // then nothing was lost, even if it is not ours.
  assert.equal(reportAgainNeeded({ ...withBounds, bounds: { x: 9, y: 9, width: 1, height: 1 } }, rect), false);
});

test("Binding: every marker of OVERLAY_MARKER occurs under web/src/components — and every veil there carries one", () => {
  const files = [];
  const collect = (dir) => {
    for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, n.name);
      if (n.isDirectory()) collect(p);
      else if (n.name.endsWith(".tsx")) files.push(p);
    }
  };
  collect(path.resolve(webDir, "src", "components"));
  const sources = files.map((p) => ({ p: path.relative(webDir, p), text: fs.readFileSync(p, "utf8") }));

  // Comparison is on CLASSES, not on substrings. The difference is exactly the case that extended the list
  // by `.cb-overlay-in`: "cb-overlay" is contained as text in "cb-overlay-in", but
  // `el.matches(".cb-overlay")` does NOT hit an element with only that class. A substring check would
  // have considered the SettingsModal veil covered.
  const classesIn = (text) => {
    const outValue = new Set();
    for (const m of text.matchAll(/class(?:Name)?\s*=\s*(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)) {
      for (const k of (m[1] ?? m[2] ?? m[3] ?? "").split(/[\s`${}?:]+/)) if (k) outValue.add(k);
    }
    // Class constants outside className (popClass, glass, …) count the same.
    for (const m of text.matchAll(/"([^"]*cb-(?:overlay|pop|sheet)[^"]*)"/g)) {
      for (const k of m[1].split(/\s+/)) if (k) outValue.add(k);
    }
    return outValue;
  };
  // A marker hits a text if it stands there as a CLASS (dot markers) or as an attribute
  // (`[role="dialog"]`, `[data-overlay]` — the latter stands in the JSX without a value).
  const hits = (marker, text) => {
    if (marker.startsWith(".")) return classesIn(text).has(marker.slice(1));
    const m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(marker);
    assert.ok(m, `marker "${marker}" is neither class nor attribute — the guard cannot search for it`);
    return m[2] === undefined
      ? new RegExp(`[<\\s]${m[1]}(?=[\\s>=/])`).test(text)
      : text.includes(`${m[1]}="${m[2]}"`);
  };

  // (a) No dead selector: a marker that does not exist in the UI costs time on every
  //     querySelectorAll and gives the impression that a case is covered.
  const withoutCitation = OVERLAY_MARKER.filter((m) => !sources.some((q) => hits(m, q.text)));
  assert.deepEqual(withoutCitation, [], "marker from OVERLAY_MARKER does not occur as a class under web/src/components");

  // (b) No uncovered floating sheet. A candidate is EVERY element that lies over the content
  //     (`fixed`/`absolute` with z ≥ 30) AND is opaque (own background, glass or veil black) — not
  //     only a full-screen veil. The difference is measured: the six drop-down sheets of the header
  //     (ports, VS Code, runs, agent browser, bell, design) are `absolute … z-40/z-50 … bg-panel` and
  //     therefore all lay behind the native view — a version that knew only `fixed inset-0` missed
  //     them. The transparent click catchers (`fixed inset-0 z-40`, nothing else) cover nothing and
  //     are no candidates.
  //     The marker is searched in the ATTRIBUTE BLOCK of the element, not in the file: ImageLightbox
  //     carries `role="dialog"` five lines below its className because of the JSX line break, and a
  //     look at the whole file would let every NEW sheet through in a file that has a marker
  //     somewhere (so in almost every one).
  const FLOATS = /className="[^"]*(?:fixed|absolute)[^"]*\bz-\[?(\d+)/;
  const OPAQUE = /bg-(?:panel|bg|code|black\/|white)|backdrop-blur|cb-(?:pop|overlay|sheet)|cb-kit-pane|shadow-card/;
  // The attribute block of a JSX element: from the line with `<Tag` to the one that closes the
  // opening tag. Strings are emptied first so that a `>` in a Tailwind class (`[&>svg]:…`) does not
  // end the block early.
  const withoutText = (z) => z.replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, "``");
  const block = (rows, i) => {
    let a = i;
    while (a > 0 && !/^\s*<[A-Za-z]/.test(rows[a]) && i - a < 25) a--;
    let b = a;
    while (b < rows.length && b - a < 40 && !/>\s*$/.test(withoutText(rows[b]))) b++;
    const end = Math.min(b, rows.length - 1);
    return { text: rows.slice(a, end + 1).join("\n"), end, empty: /\/>\s*$/.test(withoutText(rows[end] || "")) };
  };

  let candidates = 0;
  const veil = [];
  for (const { p, text } of sources) {
    const rows = text.split("\n");
    rows.forEach((row, i) => {
      const m = FLOATS.exec(row);
      if (!m || Number(m[1]) < 30) return;
      const b = block(rows, i);
      // Two forms count. First: the element is itself opaque (the six drop-down sheets, every modal).
      // Second: it is a transparent CONTAINER that carries something opaque — that is how the service
      // notices (ServiceToasts: a `pointer-events-none` frame with `bg-panel` cards in it) and the menu
      // shells stand. An empty, self-closing element is a click catcher: it covers nothing.
      const children = b.empty ? "" : rows.slice(b.end + 1, b.end + 11).join("\n");
      const opaque = OPAQUE.test(row) || (!b.empty && OPAQUE.test(children));
      if (!opaque) return;
      candidates++;
      // The search is in the element's attribute block — and for a container also in what it carries:
      // there the marker sits on the opaque child, and at runtime `querySelectorAll` finds exactly that.
      if (OVERLAY_MARKER.some((mk) => hits(mk, b.text) || (!b.empty && hits(mk, children)))) return;
      veil.push(`${p}:${i + 1}`);
    });
  }
  console.log(`  [overlays] ${OVERLAY_MARKER.length} markers, ${sources.length} components, ${candidates} floating sheets checked`);
  assert.ok(candidates >= 15, `only ${candidates} floating sheets found — does the search still work?`);
  assert.deepEqual(veil, [], "floating, opaque sheet without a marker from OVERLAY_MARKER — it would lie behind the native view");
});

// ── Binding to the components ───────────────────────────────────────────────────────────────

test("Binding: BrowserPane switches to the native browser only with apiBase, only with a bridge, only after mount", () => {
  const pane = read("src/components/BrowserPane.tsx");
  assert.ok(/import\s*\{[^}]*\bnativeAvailable\b[^}]*\}\s*from\s*"@\/lib\/browser-native"/.test(pane),
    "BrowserPane.tsx does not import nativeAvailable from @/lib/browser-native — the switch would stand in a replica");
  assert.ok(/import\s*\{[^}]*\bscopeFromApiBase\b[^}]*\}\s*from\s*"@\/lib\/browser-native"/.test(pane), "scopeFromApiBase comes from @/lib/browser-native");
  assert.ok(/import\s*\{\s*BrowserNative\s*\}\s*from\s*"@\/components\/BrowserNative"/.test(pane), "BrowserPane.tsx does not import BrowserNative");
  // Decide after mount: the SSR build has no `window`, and a first render with the bridge would be
  // a hydration mismatch.
  assert.ok(/useEffect\(\(\) => \{ setNative\(nativeAvailable\(window\)\); \}, \[\]\);/.test(pane),
    "the switch does not ask nativeAvailable(window) in the effect — the SSR build has no window");
  assert.ok(/if \(native && scope && !props\.browserId && !props\.onlyStream\)/.test(pane),
    "the switch does not check (native && scope && !browserId && !onlyStream) — the agent browser streams in EVERY case, it belongs to the agent and runs in the container; " +
    "likewise the browser of a copy chat (`onlyStream`): the native one knows only main's scope");
  // And while the decision is pending NEITHER pane may mount: child effects run before parent
  // effects, a BrowserStream mounted in advance would call `/browser/ensure` and start the Chromium
  // in the container before it is thrown out of the tree.
  assert.ok(/useState<boolean \| null>\(null\)/.test(pane),
    "the switch state is two-valued — the first render then mounts a pane before the bridge is checked");
  assert.ok(/if \(native === null\) \{/.test(pane), "the switch mounts a pane before its decision — an unwanted /browser/ensure would be the result");
  // The streamed body stays in this file: browser-stream.test.mjs reads it by path.
  assert.ok(/function BrowserStream\(\{/.test(pane), "the streamed body is no longer called BrowserStream — it must stay in BrowserPane.tsx (browser-stream.test.mjs reads it by path)");
  assert.ok(/export function BrowserPane\(/.test(pane), "the export is still called BrowserPane — the callers stay unchanged");
});

test("Binding: BrowserNative reports bounds, cleans up on teardown and hangs on exactly the events that move the surface", () => {
  const native = read("src/components/BrowserNative.tsx");
  assert.ok(/data-browser-native-host/.test(native), "the host surface does not carry the marker data-browser-native-host (the probes grab it)");
  assert.ok(/const hostId = useId\(\)/.test(native), "the host id does not come from useId() — two hosts per scope (page + chat bar) would then be the same");
  assert.ok(/hostRect\(el\.getBoundingClientRect\(\), true\)/.test(native), "the rectangle is not computed through hostRect(");
  assert.ok(/if \(rectEqual\(rect, lastRect\.current\)\) return;/.test(native),
    "the pane reports every rectangle, not only changes — every scroll event would send an IPC that moves nothing");
  // The cleanup is the promise: a torn-down pane must not leave a view standing over a foreign page.
  // Without this line the browser would stay over the UI on a tab switch.
  assert.ok(/bridge\.bounds\(scope, hostId, null\);/.test(native), "the cleanup reports no null bounds — the view would stay over the next page");
  assert.ok(/window\.addEventListener\("resize", report\);[\s\S]{0,300}document\.addEventListener\("scroll", report, true\);/.test(native),
    "bounds do not follow resize AND scroll (capture — inner scroll events do not bubble to the window)");
  assert.ok(/window\.removeEventListener\("resize", report\);/.test(native) && /document\.removeEventListener\("scroll", report, true\);/.test(native),
    "the listeners are not unregistered again");
  // And the counterpart to thrift: bounds go out without an answer, and the client throws away its host
  // entries on every navigation of the window itself. If its state says "no surface" while we have
  // reported one, the pane must follow up — otherwise it would stay empty.
  assert.ok(/reportAgainNeeded\(z, lastRect\.current\)/.test(native),
    "the pane does not follow up after a lost bounds state (reportAgainNeeded) — the surface would stay empty");
  assert.ok(/lastRect\.current = null;\s*\n\s*reportRef\.current\(\);/.test(native),
    "the follow-up does not reset lastRect — rectEqual would suppress the report again at once");
});

test("Binding: BrowserNative switches the still frame through the overlay observer and unregisters from everything again", () => {
  const native = read("src/components/BrowserNative.tsx");
  for (const name of ["OVERLAY_SELECTOR", "touchedOverlay", "hasOverlay", "hostRect", "nativeBridge", "reduceState", "rectEqual", "visibleLoudStyle", "stateEmpty"]) {
    assert.ok(new RegExp(String.raw`\b${name}\b`).test(native.slice(0, native.indexOf("export function BrowserNative"))),
      `${name} does not come from @/lib/browser-native — the rule would stand in a replica`);
  }
  assert.ok(/new MutationObserver\(\(records\) => \{ if \(touchedOverlay\(records\)\) check\(\); \}\)/.test(native),
    "the observer recomputes on EVERY mutation instead of pre-filtering through touchedOverlay");
  assert.ok(/mo\.observe\(document\.body, \{ childList: true, subtree: true, attributes: true, attributeFilter: \["class", "style"\] \}\)/.test(native),
    "the observer does not run over the subtree with class/style — a modal in place (SettingsModal) or a menu made visible only later would stay behind the view");
  assert.ok(/\.filter\(\(k\) => visibleLoudStyle\(window\.getComputedStyle\(k\)\)\)/.test(native),
    "the candidates are not filtered by visibility — the \"jump to end\" button permanently carried .cb-pop");
  assert.ok(/bridge\.stillFrame\(scope, desired\)/.test(native), "the still frame is not fetched through bridge.stillFrame(scope, desired)");
  assert.ok(/void bridge\.stillFrame\(scope, false\)/.test(native), "the cleanup does not take back a standing still frame — the view would stay invisible");
  // The surface can change without a window resize and without a mutation (the right chat bar's handle
  // drags it between 280 and 640 px) — then a standing menu suddenly lies over it or no longer does.
  assert.ok(/const ro = new ResizeObserver\(check\);/.test(native),
    "the overlay effect does not depend on the host surface's size — a standing menu would stay misjudged");
  assert.ok(/ro\.disconnect\(\);/.test(overlayEffectHeader(native)), "the overlay effect's ResizeObserver is not disconnected again");
  // And the image itself: the effect reruns when `active` changes, `check` stays silent when the desired
  // state is unchanged — a left-standing still frame would cover the view with a photo.
  const overlayEffect = native.slice(native.indexOf("const mo = new MutationObserver("));
  assert.ok(/setStillFrame\(null\);/.test(overlayEffect.slice(0, overlayEffect.indexOf("}, [bridge, scope, active]);"))),
    "the overlay effect's cleanup does not clear the still frame (setStillFrame(null))");
  // The three subscriptions and their unsubscribing: a listener that keeps feeding a torn-down pane
  // sets state on a dead component.
  for (const name of ["onState", "onHint", "onAddressBar"]) {
    assert.ok(new RegExp(String.raw`bridge\.${name}\(`).test(native), `BrowserNative does not subscribe to ${name}`);
  }
  assert.ok(/return \(\) => \{ for \(const off of offs\) off\(\); \};/.test(native), "the subscriptions are not unsubscribed again");
  assert.ok(/bridge\.open\(scope\)/.test(native), "BrowserNative does not call bridge.open(scope) — without it the client creates no views");
});

// The body of the overlay effect up to its dependency list — the cleanup lines must stand there and only there.
function overlayEffectHeader(native) {
  const start = native.indexOf("const mo = new MutationObserver(");
  return native.slice(start, native.indexOf("}, [bridge, scope, active]);", start));
}

// The ports pill has merged into the services pill; the marker moves with it, the three regexes stay.
test("Binding: the services pill shows the marker of automatic forwards", () => {
  const pill = read("src/components/pills/ServicesPill.tsx");
  assert.ok(/source\?: "manual" \| "browser"/.test(pill),
    "the type Forward does not carry `source` as an OPTIONAL field — an older client does not send it, and a required field would mean `undefined` there instead of \"by hand\"");
  assert.ok(/f\.source === "browser"/.test(pill), "the pill does not distinguish automatic forwards from manual ones");
  assert.ok(/data-ports-source="browser"/.test(pill), "the marker carries no identifier (the probes grab it)");
});

test("Binding: every new text of the native pane has exactly one line in i18n-de.ts", () => {
  const native = read("src/components/BrowserNative.tsx");
  const en = read("src/lib/i18n-de.ts");
  const key = [...native.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  assert.ok(key.length, "no t(\"…\") found in BrowserNative.tsx — does the regex still work?");
  const missing = [...new Set(key)].filter((k) => !new RegExp(`^\\s*"${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":`, "m").test(en));
  console.log(`  [i18n] ${new Set(key).size} keys in BrowserNative.tsx`);
  assert.deepEqual(missing, [], "keys without a German entry — the UI would show English there");
});

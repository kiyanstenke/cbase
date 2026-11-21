// Pure rules of the native browser (client/browser-rules.js) — every function, every corner.
//
// The Electron integration itself (WebContentsView, sessions, IPC) is not covered by the gate.
// What can be tested is the decision, which is deliberately kept out of browser.js so it runs
// without a window. No Electron import, no clock, no network.
//
// Run:  node --test client/test/browser-rules.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTAINER_DEADLINE_MS, containerMeasurement, allowedPermission, forwardDecision, rememberedTabs, originIsLocal, clampRect,
  liveScopes, measurementCache, measurementForRequest, notMeasurableText, portFromUrl, scopeProfile, tabsToRemember, keyCommand, urlWithPort,
} from "../browser-rules.js";

// ── scopeProfile ──────────────────────────────────────────────────────────────
test("scopeProfile: persist:browser-<scope>, everything outside [a-z0-9] becomes a hyphen", () => {
  assert.equal(scopeProfile("proj:2909e420-60ea-4e4f-9abf-6f51edbe4eff"), "persist:browser-proj-2909e420-60ea-4e4f-9abf-6f51edbe4eff");
  assert.equal(scopeProfile("ws:abc"), "persist:browser-ws-abc");
  // Lowercase BEFORE replacing — otherwise two different scopes would share one folder.
  assert.notEqual(scopeProfile("proj:ABC"), scopeProfile("proj:XYZ"));
  assert.equal(scopeProfile("proj:ABC"), "persist:browser-proj-abc");
  // Spaces, slashes, umlauts: all hyphens; an empty scope still has a profile.
  assert.equal(scopeProfile("a b/ä"), "persist:browser-a-b--");
  assert.equal(scopeProfile(""), "persist:browser-empty");
  assert.equal(scopeProfile(undefined), "persist:browser-empty");
  // Always a persistent partition — a transient one would lose cookies and logins on restart.
  assert.match(scopeProfile("x"), /^persist:/);
});

// ── forwardDecision ──────────────────────────────────────────────────────
// The full table: 2 (ours) × 2 (localForeign) × 3 (containerHas) × 2 (main frame). Each row is a
// statement of the spec, not a result copied from the function.
test("forwardDecision: the whole table (local origin)", () => {
  const our = new Set([3000]);
  const cases = [
    // [port, localForeign, containerHas, mainFrame, expected]
    // (1) our port: always through, whatever else was measured
    [3000, false, true, true, "letThrough"],
    [3000, true, true, true, "letThrough"],
    [3000, true, false, false, "letThrough"],
    [3000, false, null, true, "letThrough"],
    // (2) taken by a foreign process: hint ONLY for a main frame AND when the container has it
    [5173, true, true, true, "hint"],
    [5173, true, true, false, "letThrough"],
    [5173, true, false, true, "letThrough"],
    [5173, true, false, false, "letThrough"],
    [5173, true, null, true, "letThrough"],
    [5173, true, null, false, "letThrough"],
    // (3) locally free: forward if the container has it — also for subrequests (HMR, API)
    [5173, false, true, true, "forward"],
    [5173, false, true, false, "forward"],
    [5173, false, false, true, "letThrough"],
    [5173, false, false, false, "letThrough"],
    // not measurable is not "does not have it" — the main frame says so instead of running into "connection refused"
    [5173, false, null, true, "not-measurable"],
    [5173, false, null, false, "letThrough"],
  ];
  for (const [port, localForeign, containerHas, mainFrame, expected] of cases) {
    const holds = forwardDecision({ port, ourLocalPorts: our, localForeign, containerHas, mainFrame, originLocal: true });
    assert.equal(holds, expected, `port ${port} localForeign=${localForeign} containerHas=${containerHas} mainFrame=${mainFrame}`);
  }
});

// Several project containers hold the port and none belongs to the scope. Counter-check: remove the
// `containerHas === "ambiguous"` line ⇒ red (main frame "letThrough").
test("forwardDecision: ambiguous ⇒ the main frame asks (\"choice\"), a subrequest goes through, our port stays ours", () => {
  const base = { port: 3000, ourLocalPorts: new Set(), containerHas: "ambiguous", originLocal: true };
  assert.equal(forwardDecision({ ...base, localForeign: false, mainFrame: true }), "choice");
  assert.equal(forwardDecision({ ...base, localForeign: true, mainFrame: true }), "choice", "also when taken locally: first the choice of project");
  assert.equal(forwardDecision({ ...base, localForeign: false, mainFrame: false }), "letThrough");
  assert.equal(forwardDecision({ ...base, localForeign: false, mainFrame: true, ourLocalPorts: new Set([3000]) }), "letThrough");
  // A foreign page cannot force this card with a subrequest either.
  assert.equal(forwardDecision({ ...base, localForeign: false, mainFrame: false, originLocal: false }), "letThrough");
});

test("forwardDecision: a FOREIGN page does not trigger a tunnel with its subrequests", () => {
  // `onBeforeRequest` sees only the target. Without this rule an <img src="http://localhost:5432/">
  // on any visited page would make the client bind a tunnel into the container that EVERY program
  // on this machine can then reach — without sign-in, for the rest of the session.
  const foreign = { port: 5432, ourLocalPorts: new Set(), localForeign: false, containerHas: true, originLocal: false };
  assert.equal(forwardDecision({ ...foreign, mainFrame: false }), "letThrough", "subrequest of a foreign page: no tunnel");
  assert.equal(forwardDecision({ ...foreign, mainFrame: true }), "forward", "a human triggered a main-frame navigation");
  // The hint is reserved for local pages too: a foreign page must not force a card about a port
  // running on this machine.
  assert.equal(forwardDecision({ ...foreign, localForeign: true, mainFrame: false }), "letThrough");
  // An unknown origin (no webContents, about:blank) is not a local one.
  assert.equal(forwardDecision({ ...foreign, mainFrame: false, originLocal: undefined }), "letThrough");
});

test("forwardDecision: rule 1 asks the LOCAL ports, not the container's", () => {
  // After choosing "other port" the forward maps container port 3000 to local 3001. Using the
  // container port here would mistake our own listener on 3001 for a foreign process.
  const local = new Set([3001]);
  assert.equal(forwardDecision({ port: 3001, ourLocalPorts: local, localForeign: true, containerHas: true, mainFrame: true, originLocal: true }), "letThrough");
  assert.equal(forwardDecision({ port: 3000, ourLocalPorts: local, localForeign: false, containerHas: true, mainFrame: true, originLocal: true }), "forward");
});

test("forwardDecision: without a set of own ports rule 1 does not apply", () => {
  assert.equal(forwardDecision({ port: 80, ourLocalPorts: undefined, localForeign: false, containerHas: true, mainFrame: true, originLocal: true }), "forward");
  // Only exactly `true` counts as "container has it" — a truthy object from a misread answer must
  // not open a tunnel.
  assert.equal(forwardDecision({ port: 80, ourLocalPorts: new Set(), localForeign: false, containerHas: { open: [] }, mainFrame: true, originLocal: true }), "letThrough");
  assert.equal(forwardDecision({ port: 80, ourLocalPorts: new Set(), localForeign: true, containerHas: "yes", mainFrame: true, originLocal: true }), "letThrough");
});

test("originIsLocal: only a page of this machine counts as origin", () => {
  for (const u of ["http://localhost:3000/", "http://127.0.0.1:8080/path", "https://localhost/", "http://0.0.0.0:3000/", "http://[::1]:7718/"]) {
    assert.equal(originIsLocal(u), true, u);
  }
  for (const u of ["https://example.com/", "about:blank", "", undefined, "file:///tmp/x.html", "http://localhost.evil.com/", "data:text/html,<img>"]) {
    assert.equal(originIsLocal(u), false, String(u));
  }
  // The hostname alone is not enough: a page under a foreign scheme is not a page of this machine,
  // even with "localhost" in it.
  assert.equal(originIsLocal("chrome://localhost/"), false);
  assert.equal(originIsLocal("ftp://localhost:21/"), false);
});

test("allowedPermission: pages in the native browser get nothing that concerns this machine", () => {
  // Electron's default without a handler is "allow everything" (camera, microphone, location,
  // notifications, clipboard read — all granted without a dialog).
  assert.equal(allowedPermission("fullscreen"), true);
  assert.equal(allowedPermission("clipboard-sanitized-write"), true, "a page may write to the clipboard — every copy button does");
  for (const permission of ["media", "geolocation", "notifications", "midi", "midiSysex", "pointerLock",
    "clipboard-read", "display-capture", "openExternal", "idle-detection", "window-management",
    "hid", "serial", "usb", "storage-access", "unknown", "", undefined]) {
    assert.equal(allowedPermission(permission), false, `a foreign page must not get "${permission}"`);
  }
});

// ── portFromUrl ───────────────────────────────────────────────────────────────
test("portFromUrl: only localhost, 127.0.0.1, 0.0.0.0 and [::1], default 80/443 per scheme", () => {
  assert.deepEqual(portFromUrl("http://localhost:3000/"), { host: "localhost", port: 3000 });
  assert.deepEqual(portFromUrl("http://127.0.0.1:8080/path?x=1#f"), { host: "127.0.0.1", port: 8080 });
  assert.deepEqual(portFromUrl("http://[::1]:7718/api"), { host: "[::1]", port: 7718 });
  // The address bar offers 0.0.0.0 as local (nav-url.ts), and every connection to it ends on this
  // machine — so it belongs to the same decision.
  assert.deepEqual(portFromUrl("http://0.0.0.0:3000/"), { host: "0.0.0.0", port: 3000 });
  assert.deepEqual(portFromUrl("http://localhost/"), { host: "localhost", port: 80 });
  assert.deepEqual(portFromUrl("https://localhost/"), { host: "localhost", port: 443 });
  assert.deepEqual(portFromUrl("ws://localhost:5173/hmr"), { host: "localhost", port: 5173 });
  assert.deepEqual(portFromUrl("ws://127.0.0.1/"), { host: "127.0.0.1", port: 80 });
  assert.deepEqual(portFromUrl("wss://localhost/"), { host: "localhost", port: 443 });
  // The URL itself normalizes the host's case.
  assert.deepEqual(portFromUrl("http://LOCALHOST:81/"), { host: "localhost", port: 81 });
});

test("portFromUrl: everything else is null — foreign hosts, foreign schemes, unreadable input", () => {
  assert.equal(portFromUrl("http://example.com:3000/"), null);
  assert.equal(portFromUrl("http://localhost.local:3000/"), null);
  assert.equal(portFromUrl("http://192.168.1.5:3000/"), null, "the LAN is not this machine");
  assert.equal(portFromUrl("file:///etc/hosts"), null);
  assert.equal(portFromUrl("about:blank"), null);
  assert.equal(portFromUrl("localhost:3000"), null, "without a scheme the URL parses to a scheme \"localhost:\"");
  assert.equal(portFromUrl(""), null);
  assert.equal(portFromUrl(undefined), null);
  assert.equal(portFromUrl("not a url"), null);
});

// ── urlWithPort ──────────────────────────────────────────────────────────────
test("urlWithPort: only the port changes; path, search and fragment stay", () => {
  assert.equal(urlWithPort("http://localhost:3000/app?x=1#top", 3001), "http://localhost:3001/app?x=1#top");
  assert.equal(urlWithPort("http://localhost/", 8080), "http://localhost:8080/");
  assert.equal(urlWithPort("http://[::1]:7718/a", 7719), "http://[::1]:7719/a");
  // The scheme's default port is dropped in serialization — that is WHATWG, not a bug.
  assert.equal(urlWithPort("http://localhost:3000/", 80), "http://localhost/");
  assert.equal(urlWithPort("broken", 3001), null);
  assert.equal(urlWithPort("http://localhost:3000/", 0), null);
  assert.equal(urlWithPort("http://localhost:3000/", 70000), null);
  assert.equal(urlWithPort("http://localhost:3000/", 3000.5), null);
});

// ── liveScopes ───────────────────────────────────────────────────────────────
test("liveScopes: current + last stay, older ones fall", () => {
  assert.deepEqual(liveScopes([], "a"), { stays: ["a"], falls: [] });
  assert.deepEqual(liveScopes(["a"], "b"), { stays: ["b", "a"], falls: [] });
  assert.deepEqual(liveScopes(["b", "a"], "c"), { stays: ["c", "b"], falls: ["a"] });
  // A reopened scope moves to the front; nothing falls because there are still two.
  assert.deepEqual(liveScopes(["b", "a"], "a"), { stays: ["a", "b"], falls: [] });
  // The current scope again: unchanged.
  assert.deepEqual(liveScopes(["b", "a"], "b"), { stays: ["b", "a"], falls: [] });
  // A queue that is too long (after a fault) is trimmed to two — everything from third place falls.
  assert.deepEqual(liveScopes(["c", "b", "a"], "d"), { stays: ["d", "c"], falls: ["b", "a"] });
  assert.deepEqual(liveScopes(["c", "b", "a"], "a"), { stays: ["a", "c"], falls: ["b"] });
  // The input stays untouched.
  const queue = ["b", "a"];
  liveScopes(queue, "c");
  assert.deepEqual(queue, ["b", "a"]);
});

// ── clampRect ────────────────────────────────────────────────────────────────
test("clampRect: whole numbers, inside the window content, DPR-neutral", () => {
  const content = { width: 1440, height: 900 };
  assert.deepEqual(clampRect({ x: 10.4, y: 20.6, width: 100.2, height: 50.5 }, content), { x: 10, y: 21, width: 101, height: 50 });
  // Fully inside: unchanged.
  assert.deepEqual(clampRect({ x: 0, y: 0, width: 1440, height: 900 }, content), { x: 0, y: 0, width: 1440, height: 900 });
  // Overhangs right/bottom: clipped, not moved.
  assert.deepEqual(clampRect({ x: 1400, y: 880, width: 100, height: 100 }, content), { x: 1400, y: 880, width: 40, height: 20 });
  // Negative left/top (host partly scrolled out of the window): the visible rest.
  assert.deepEqual(clampRect({ x: -30, y: -10, width: 100, height: 50 }, content), { x: 0, y: 0, width: 70, height: 40 });
  // A different device pixel ratio changes nothing about CSS pixels — same input, same output.
  assert.deepEqual(clampRect({ x: 10, y: 10, width: 100, height: 100, dpr: 2 }, content), { x: 10, y: 10, width: 100, height: 100 });
});

test("clampRect: the PAGE zoom converts CSS pixels to DIPs", () => {
  // The client's menu carries `{ role: "viewMenu" }`, which brings Zoom In/Out/Actual Size; Electron
  // remembers the level per origin. `getBoundingClientRect` then measures CSS pixels smaller than a
  // DIP — without the factor the page would sit too small in its area, offset growing with x and y.
  const content = { width: 1000, height: 672 };
  assert.deepEqual(clampRect({ x: 400, y: 80, width: 300, height: 200 }, content, 1.25), { x: 500, y: 100, width: 375, height: 250 });
  assert.deepEqual(clampRect({ x: 0, y: 0, width: 400, height: 200 }, content, 0.5), { x: 0, y: 0, width: 200, height: 100 });
  // Without a value and for nonsense, 1 applies — a zoom level of 0 or NaN must not erase the area.
  assert.deepEqual(clampRect({ x: 10, y: 10, width: 100, height: 100 }, content), { x: 10, y: 10, width: 100, height: 100 });
  for (const z of [0, -1, NaN, Infinity, null, "1.25"]) {
    assert.deepEqual(clampRect({ x: 10, y: 10, width: 100, height: 100 }, content, z), { x: 10, y: 10, width: 100, height: 100 }, `zoom ${z}`);
  }
  // Zoomed beyond the edge is still clipped, not moved.
  assert.deepEqual(clampRect({ x: 600, y: 0, width: 300, height: 100 }, content, 1.5), { x: 900, y: 0, width: 100, height: 150 });
});

test("clampRect: null for anything without area or without a number", () => {
  const content = { width: 1440, height: 900 };
  assert.equal(clampRect({ x: 0, y: 0, width: 0, height: 100 }, content), null);
  assert.equal(clampRect({ x: 0, y: 0, width: 100, height: -1 }, content), null);
  // Fully outside: nothing remains after clipping.
  assert.equal(clampRect({ x: 1500, y: 0, width: 100, height: 100 }, content), null);
  assert.equal(clampRect({ x: -200, y: 0, width: 100, height: 100 }, content), null);
  // Below half a pixel: rounds to width 0 → null, not a 0×n rectangle.
  assert.equal(clampRect({ x: 10, y: 10, width: 0.4, height: 100 }, content), null);
  assert.equal(clampRect(null, content), null);
  assert.equal(clampRect({ x: 0, y: 0, width: 10, height: 10 }, null), null);
  assert.equal(clampRect({ x: NaN, y: 0, width: 10, height: 10 }, content), null);
  assert.equal(clampRect({ x: 0, y: 0, width: Infinity, height: 10 }, content), null);
  assert.equal(clampRect({ x: "0", y: 0, width: 10, height: 10 }, content), null);
  assert.equal(clampRect({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 }), null);
});

// ── keyCommand ───────────────────────────────────────────────────────────────
test("keyCommand: six shortcuts with ⌘ or Ctrl, otherwise null", () => {
  const meta = (key, extra = {}) => ({ type: "keyDown", meta: true, control: false, shift: false, alt: false, key, ...extra });
  assert.equal(keyCommand(meta("l")), "address-bar");
  assert.equal(keyCommand(meta("L")), "address-bar");
  assert.equal(keyCommand(meta("r")), "reload");
  assert.equal(keyCommand(meta("t")), "newTab");
  assert.equal(keyCommand(meta("w")), "tabClose");
  assert.equal(keyCommand(meta("[")), "back");
  assert.equal(keyCommand(meta("]")), "before");
  // Ctrl instead of ⌘ (Linux/Windows) is equivalent.
  assert.equal(keyCommand({ type: "keyDown", meta: false, control: true, key: "w" }), "tabClose");
  // No modifier, with Shift/Alt, on key up, foreign keys: intercept nothing.
  assert.equal(keyCommand({ type: "keyDown", meta: false, control: false, key: "w" }), null);
  assert.equal(keyCommand(meta("t", { shift: true })), null);
  assert.equal(keyCommand(meta("w", { alt: true })), null);
  assert.equal(keyCommand(meta("w", { type: "keyUp" })), null);
  assert.equal(keyCommand(meta("q")), null, "⌘Q belongs to the app");
  assert.equal(keyCommand(meta("c")), null, "⌘C belongs to the page");
  assert.equal(keyCommand(null), null);
});

// ── tabsToRemember / rememberedTabs ──────────────────────────────────────────
test("tabsToRemember: URLs and active index, empty tabs drop out, nothing left = null", () => {
  const tabs = [{ id: "a", url: "about:blank" }, { id: "b", url: "http://localhost:3000/" }, { id: "c", url: "https://example.com/x" }];
  assert.deepEqual(tabsToRemember(tabs, "c"), { urls: ["http://localhost:3000/", "https://example.com/x"], active: 1 });
  // The active tab is an empty one: the index points to the first remembered tab.
  assert.deepEqual(tabsToRemember(tabs, "a"), { urls: ["http://localhost:3000/", "https://example.com/x"], active: 0 });
  assert.equal(tabsToRemember([{ id: "a", url: "about:blank" }], "a"), null);
  assert.equal(tabsToRemember([], null), null);
  assert.equal(tabsToRemember([{ id: "a", url: "" }, { id: "b" }], "a"), null);
});

test("rememberedTabs: the way back tolerates foreign types and an index out of range", () => {
  assert.deepEqual(rememberedTabs({ urls: ["http://localhost:3000/", "https://x.y/"], active: 1 }), { urls: ["http://localhost:3000/", "https://x.y/"], active: 1 });
  assert.deepEqual(rememberedTabs({ urls: ["http://localhost:3000/"], active: 7 }), { urls: ["http://localhost:3000/"], active: 0 });
  assert.deepEqual(rememberedTabs({ urls: ["http://localhost:3000/"], active: -1 }), { urls: ["http://localhost:3000/"], active: 0 });
  assert.deepEqual(rememberedTabs({ urls: [42, "", "http://a/"], active: "0" }), { urls: ["http://a/"], active: 0 });
  // Nothing remembered: exactly one empty tab.
  assert.deepEqual(rememberedTabs(undefined), { urls: ["about:blank"], active: 0 });
  assert.deepEqual(rememberedTabs({ urls: [] }), { urls: ["about:blank"], active: 0 });
  assert.deepEqual(rememberedTabs({ urls: "http://a/" }), { urls: ["about:blank"], active: 0 });
  // Round trip is lossless.
  const tabs = [{ id: "a", url: "http://localhost:3000/" }, { id: "b", url: "https://x.y/" }];
  assert.deepEqual(rememberedTabs(tabsToRemember(tabs, "b")), { urls: ["http://localhost:3000/", "https://x.y/"], active: 1 });
});

// ── The measurement "does the container have the port?" ──────────────────────
// The failure these tests hold: the question to the server was aborted at the default deadline of
// main.js sessionRequest (4 s) while a cold server needed up to 4.7 s; the expired deadline became
// `has: null` ⇒ "letThrough", and the page silently ran into "connection refused". No clock: the
// fake `question` models the deadline of sessionRequest as a NUMBER (it aborts if the server
// answers later than the deadline, otherwise it answers when the test opens the gate).
// A remembered null counts for subrequests only; the main frame re-measures only after an expired
// deadline and without a local listener; `has: null` carries the reason the pane names.

const SERVER_COLD_MS = 4700; // slowest cold answer observed
const DEFAULT_SESSION_MS = 4000; // main.js sessionRequest without `timeoutMs`
// The throws of main.js sessionRequest — same shape, bound in browser-wiring.test.mjs.
const deadlineThrow = () => Object.assign(new Error("timed out"), { deadline: true });
const statusThrow = (n) => Object.assign(new Error(`Server responded with ${n}`), { status: n, body: "" });

function gateQuestion(response, { serverMs = SERVER_COLD_MS } = {}) {
  const questions = [];
  let open;
  const gate = new Promise((r) => { open = r; });
  const question = async (url, opts) => {
    questions.push({ url, opts });
    const deadline = opts?.timeoutMs ?? DEFAULT_SESSION_MS;
    if (deadline <= serverMs) throw deadlineThrow();
    await gate;
    return JSON.stringify(response);
  };
  return { question, questions, open };
}

test("containerMeasurement: asks LIGHT with its own deadline above the server's docker cap — the slow answer arrives", async () => {
  // The cap lives in the server (ports.js INSTANCE_CAP_MS); the client's deadline must exceed it.
  const ports = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "server", "backend", "electron", "server", "ports.js"), "utf8");
  const m = /\bINSTANCE_CAP_MS = ([\d_]+);/.exec(ports);
  assert.ok(m, "ports.js: no line `INSTANCE_CAP_MS = …;` — the anchor no longer matches");
  const cap = Number(m[1].replaceAll("_", ""));
  assert.ok(CONTAINER_DEADLINE_MS > cap, `the client's deadline (${CONTAINER_DEADLINE_MS}) does not exceed the server's docker cap (${cap})`);

  const COPY = "pe/copy-e2e1";
  const { question, questions, open } = gateQuestion({ open: [{ port: 3195, instance: "pe/main" }, { port: 3195, instance: COPY }, { port: 3197, instance: "pe/main" }] });
  let active = "pe/main";
  const running = containerMeasurement({ question, base: "https://gw.example", port: 3195, scope: "proj:pe", activeInstance: () => active });
  // The choice changes while the server computes: what is chosen when the answer arrives applies.
  active = COPY;
  open();
  const result = await running;
  assert.deepEqual([result.has, result.instance], [true, COPY], "the copy holds the port — forward, not \"not measurable\"");
  assert.equal(questions.length, 1);
  assert.equal(questions[0].url, "https://gw.example/api/ports/running?ports=3195&registered=1", "the question is light (no process resolution)");
  assert.equal(questions[0].opts?.timeoutMs, CONTAINER_DEADLINE_MS);
});

test("containerMeasurement: no server, error, unreadable or no `open` means `has: null` — never \"does not have it\" — and names the reason", async () => {
  // `has: null` carries the cause — otherwise the pane would say "not in time" for a 401.
  const not = (reason) => ({ has: null, instance: null, nullTarget: undefined, reason });
  assert.deepEqual(await containerMeasurement({ question: undefined, base: "https://gw", port: 1, scope: "ws:w" }), not("no-server"));
  assert.deepEqual(await containerMeasurement({ question: async () => "{}", base: "", port: 1, scope: "ws:w" }), not("no-server"));
  assert.deepEqual(await containerMeasurement({ question: async () => { throw statusThrow(502); }, base: "https://gw", port: 1, scope: "ws:w" }), not("status:502"));
  assert.deepEqual(await containerMeasurement({ question: async () => { throw statusThrow(401); }, base: "https://gw", port: 1, scope: "ws:w" }), not("status:401"));
  assert.deepEqual(await containerMeasurement({ question: async () => { throw deadlineThrow(); }, base: "https://gw", port: 1, scope: "ws:w" }), not("deadline"));
  // Any other throw (main.js: `r.on("error")` passes the network error through) — and a "timed out"
  // message WITHOUT the marker is not a deadline: the reason hangs on the marker, not the wording.
  assert.deepEqual(await containerMeasurement({ question: async () => { throw new Error("net::ERR_CONNECTION_REFUSED"); }, base: "https://gw", port: 1, scope: "ws:w" }), not("network"));
  assert.deepEqual(await containerMeasurement({ question: async () => { throw new Error("timed out"); }, base: "https://gw", port: 1, scope: "ws:w" }), not("network"));
  assert.deepEqual(await containerMeasurement({ question: async () => "<html>", base: "https://gw", port: 1, scope: "ws:w" }), not("unreadable"));
  assert.deepEqual(await containerMeasurement({ question: async () => JSON.stringify({ error: "x" }), base: "https://gw", port: 1, scope: "ws:w" }), not("unreadable"));
  // A readable answer without the port, however, is a statement: nobody has it.
  assert.equal((await containerMeasurement({ question: async () => JSON.stringify({ open: [] }), base: "https://gw", port: 1, scope: "ws:w" })).has, false);
});

test("measurementCache: \"not measurable\" holds for subrequests, a main frame (`withoutNull`) re-measures; forgetting during a measurement keeps it out of the cache", async () => {
  let clock = 1000;
  const now = () => clock;
  const responses = [];
  let measured = 0;
  const cache = measurementCache({ appliesMs: 5000, now, measure: async () => { measured++; return responses.shift(); } });

  responses.push({ containerHas: null, reason: "deadline" }, { containerHas: true, instance: "p/main" });
  assert.equal((await cache.measurement(3000, "proj:p")).containerHas, null);
  // Right after (the clock stands still): a subrequest takes the remembered null — no second gateway request.
  assert.equal((await cache.measurement(3000, "proj:p")).containerHas, null);
  assert.equal(measured, 1, "\"not measurable\" was not cached — every wave of subrequests asked the gateway");
  // The main frame does not take it: it re-measures, and the result then holds for everyone.
  assert.equal((await cache.measurement(3000, "proj:p", { withoutNull: true })).containerHas, true);
  assert.equal(measured, 2, "the main frame took the remembered null — its re-measurement and a reload would have asked nobody");
  assert.equal((await cache.measurement(3000, "proj:p")).containerHas, true);
  assert.equal((await cache.measurement(3000, "proj:p", { withoutNull: true })).containerHas, true);
  assert.equal(measured, 2, "a result holds for `appliesMs` — for the main frame too");
  clock += 5000;
  responses.push({ containerHas: false });
  assert.equal((await cache.measurement(3000, "proj:p")).containerHas, false);
  assert.equal(measured, 3, "after `appliesMs` a new measurement is taken");
  // forgetPort: this port re-measures, another one stays remembered.
  responses.push({ containerHas: true, instance: "q/main" });
  await cache.measurement(5000, "proj:p");
  assert.equal(measured, 4);
  cache.forgetPort(3000);
  responses.push({ containerHas: true, instance: "p/main" });
  await cache.measurement(3000, "proj:p");
  await cache.measurement(5000, "proj:p");
  assert.equal(measured, 5, "forgetPort forgot the wrong port");

  // Many requests, ONE measurement — and one forgotten while measuring does not land in the cache.
  let release;
  const hold = new Promise((r) => { release = r; });
  let measured2 = 0;
  const c2 = measurementCache({ appliesMs: 5000, now, measure: async () => { measured2++; await hold; return { containerHas: true, instance: "alt" }; } });
  const a = c2.measurement(4000, "ws:w");
  const b = c2.measurement(4000, "ws:w");
  assert.equal(a, b, "two concurrent requests share one measurement");
  c2.clear(); // a new choice in the pill
  release();
  assert.equal((await a).instance, "alt", "those waiting get their result");
  await c2.measurement(4000, "ws:w");
  assert.equal(measured2, 2, "the answer measured against the old state was cached");
});

// If null were not remembered, EVERY wave of subrequests of an HMR page would start a new
// measurement while the gateway is failing (a gateway request plus a TCP attempt). No clock: `now`
// is a counter, the fake gateway throws like main.js sessionRequest.
test("count test: a fast-failing gateway — at most ONE measurement per window for subrequests, a main frame re-measures", async () => {
  let clock = 0;
  const questions = [];
  let thrown = statusThrow(502);
  const question = async (url) => { questions.push(url); throw thrown; };
  const cache = measurementCache({ appliesMs: 5000, now: () => clock, measure: async (port, scope) => {
    const c = await containerMeasurement({ question, base: "https://gw", port, scope });
    return { localForeign: false, containerHas: c.has, reason: c.reason, instance: c.instance };
  } });
  const under = () => measurementForRequest((o) => cache.measurement(3001, "proj:p", o), false);
  for (let wave = 0; wave < 8; wave++) {
    const ms = await Promise.all(Array.from({ length: 5 }, under));
    for (const m of ms) {
      assert.equal(forwardDecision({ port: 3001, ourLocalPorts: new Set(), localForeign: false, containerHas: m.containerHas, mainFrame: false, originLocal: true }), "letThrough");
    }
    clock += 125;
  }
  assert.equal(questions.length, 1, `40 subrequests in 8 waves within 1 s made ${questions.length} gateway requests instead of one`);
  // After the window: ONE again.
  clock += 5000;
  await Promise.all(Array.from({ length: 5 }, under));
  assert.equal(questions.length, 2);
  // A main frame in the same window does not take the remembered null: it re-measures — but after a
  // 401/502 only ONCE (asking again does not change the status), and the pane names the status.
  thrown = statusThrow(401);
  const h = await measurementForRequest((o) => cache.measurement(3001, "proj:p", o), true);
  assert.equal(questions.length, 3, "the main frame took the remembered null or re-measured after a 401");
  assert.equal(forwardDecision({ port: 3001, ourLocalPorts: new Set(), localForeign: false, containerHas: h.containerHas, mainFrame: true, originLocal: true }), "not-measurable");
  assert.equal(h.reason, "status:401");
  assert.doesNotMatch(notMeasurableText(3001, h.reason), /in time/);
});

test("measurementForRequest + forwardDecision: the main frame re-measures once after an expired deadline — only without a local listener", async () => {
  // The first question still hits the old state (server slower than the deadline), the second gets the answer.
  const situations = [{ containerHas: null, reason: "deadline" }, { containerHas: true, instance: "pe/copy-e2e1" }];
  let measured = 0;
  const optsSeen = [];
  const measure = async (o) => { measured++; optsSeen.push(o); return situations.shift(); };
  const base = { port: 3195, ourLocalPorts: new Set(), localForeign: false, originLocal: true };
  const m = await measurementForRequest(measure, true);
  assert.equal(measured, 2);
  assert.deepEqual(optsSeen, [{ withoutNull: true }, { withoutNull: true }], "the main frame took a remembered null");
  assert.equal(forwardDecision({ ...base, containerHas: m.containerHas, mainFrame: true }), "forward");
  // A subrequest does not re-measure (it goes through anyway) and takes what the cache knows.
  measured = 0;
  const u = await measurementForRequest(async (o) => { measured++; assert.ok(!o?.withoutNull); return { containerHas: null, reason: "deadline" }; }, false);
  assert.equal(measured, 1);
  assert.equal(forwardDecision({ ...base, containerHas: u.containerHas, mainFrame: false }), "letThrough");
  // If it stays null: the main frame gets "not-measurable" (the pane names the port), not a silent "letThrough".
  measured = 0;
  const h = await measurementForRequest(async () => { measured++; return { containerHas: null, reason: "deadline" }; }, true);
  assert.equal(measured, 2, "re-measured once, not more");
  assert.equal(forwardDecision({ ...base, containerHas: h.containerHas, mainFrame: true }), "not-measurable");
  assert.match(notMeasurableText(3195, h.reason), /^Port 3195: .*in time.*Reload/);
  // A 401, a 502, unreadable, no network: asking again changes nothing — ONE measurement.
  for (const reason of ["status:401", "status:502", "unreadable", "network", "no-server"]) {
    measured = 0;
    const g = await measurementForRequest(async () => { measured++; return { containerHas: null, reason }; }, true);
    assert.equal(measured, 1, `re-measured after "${reason}"`);
    assert.equal(forwardDecision({ ...base, containerHas: g.containerHas, mainFrame: true }), "not-measurable");
  }
  // With a local listener (foreign process or our forward) the main frame does NOT re-measure: it
  // would hold the page for up to 2 × CONTAINER_DEADLINE_MS, and at best turn "letThrough" into "hint".
  measured = 0;
  const l = await measurementForRequest(async () => { measured++; return { localForeign: true, containerHas: null, reason: "deadline" }; }, true);
  assert.equal(measured, 1, "re-measured despite a local listener — the page waited 24 s instead of 12");
  assert.equal(forwardDecision({ ...base, localForeign: l.localForeign, containerHas: l.containerHas, mainFrame: true }), "letThrough");
  // If a foreign process listens locally, the page talks to it — even without a measurement; our own port stays ours.
  assert.equal(forwardDecision({ ...base, localForeign: true, containerHas: null, mainFrame: true }), "letThrough");
  assert.equal(forwardDecision({ ...base, containerHas: null, mainFrame: true, ourLocalPorts: new Set([3195]) }), "letThrough");
});

test("notMeasurableText: the sentence names the cause — only an expired deadline says \"in time\"", () => {
  const sets = Object.fromEntries(["deadline", "status:401", "status:403", "status:502", "network", "unreadable", "no-server"].map((g) => [g, notMeasurableText(4100, g)]));
  for (const [reason, set] of Object.entries(sets)) {
    assert.match(set, /^Port 4100: /, `"${reason}": the sentence does not name the port`);
    assert.match(set, /page was not loaded/, `"${reason}": the sentence does not say that the page was not loaded`);
    assert.equal(/in time/.test(set), reason === "deadline", `"${reason}": "in time" is in the wrong sentence`);
  }
  assert.match(sets["status:401"], /\(401\).*sign-in has expired.*Sign in again, then reload/);
  assert.doesNotMatch(sets["status:401"], /Reload to measure again/, "for a 401 a reload alone does not help");
  assert.match(sets["status:403"], /\(403\).*sign-in/);
  assert.match(sets["status:502"], /answered 502.*Reload to measure again/);
  assert.match(sets.network, /unreachable/);
  assert.match(sets.unreadable, /unreadable/);
  assert.match(sets["no-server"], /server address/);
  assert.equal(new Set(Object.values(sets)).size, Object.keys(sets).length, "two causes share one sentence");
  // Without a reason (a measurement from earlier): the deadline sentence.
  assert.equal(notMeasurableText(4100), sets.deadline);
});

test("the whole path with the timing of sessionRequest: cold answer beyond the old 4 s limit ⇒ \"forward\"", async () => {
  // Measurement via containerMeasurement (deadline as a number against the cold server time), cache, re-measurement, decision.
  const { question, open } = gateQuestion({ open: [{ port: 3195, instance: "pe/copy-e2e1" }] });
  open();
  const cache = measurementCache({ appliesMs: 5000, now: () => 0, measure: async (port, scope) => {
    const c = await containerMeasurement({ question, base: "https://gw", port, scope, activeInstance: () => null });
    return { localForeign: false, containerHas: c.has, reason: c.reason, instance: c.instance };
  } });
  const m = await measurementForRequest((o) => cache.measurement(3195, "proj:pe", o), true);
  assert.deepEqual([m.containerHas, m.instance], [true, "pe/copy-e2e1"]);
  assert.equal(forwardDecision({ port: 3195, ourLocalPorts: new Set(), localForeign: false, containerHas: m.containerHas, mainFrame: true, originLocal: true }), "forward");
  // A server that also exceeds the deadline: asked twice, "not-measurable" with the deadline sentence.
  const toSlow = gateQuestion({ open: [] }, { serverMs: CONTAINER_DEADLINE_MS + 1 });
  const c2 = measurementCache({ appliesMs: 5000, now: () => 0, measure: async (port, scope) => {
    const c = await containerMeasurement({ question: toSlow.question, base: "https://gw", port, scope });
    return { localForeign: false, containerHas: c.has, reason: c.reason, instance: c.instance };
  } });
  const n = await measurementForRequest((o) => c2.measurement(3195, "proj:pe", o), true);
  assert.equal(toSlow.questions.length, 2);
  assert.equal(n.reason, "deadline");
  assert.equal(forwardDecision({ port: 3195, ourLocalPorts: new Set(), localForeign: false, containerHas: n.containerHas, mainFrame: true, originLocal: true }), "not-measurable");
  // A subrequest afterwards takes the remembered null — a reload of the main frame re-measures.
  await measurementForRequest((o) => c2.measurement(3195, "proj:pe", o), false);
  assert.equal(toSlow.questions.length, 2, "the subrequest asked the gateway despite a remembered \"not measurable\"");
  await measurementForRequest((o) => c2.measurement(3195, "proj:pe", o), true);
  assert.equal(toSlow.questions.length, 4, "a reload took the remembered null — \"reload to measure again\" would be false");
});

// Streamed browsers: server-side Chromium over CDP (screencast frames over SSE, input by POST) — the same transport pattern as the
// integrated terminal, so it also works through the gateway/Cloudflare (no WebSocket to the client needed). Two kinds of session:
//  • kind "user":  the browser tab (workspace/project). We start Chromium ourselves, headless, with a persistent profile per scope —
//    logins are kept. The browser runs in the same network as the hosted apps (in the container or locally), so it reaches
//    localhost services the client machine does not see.
//  • kind "agent": browsers started by the Playwright MCP of a chat run. They get a CDP port via the launch arg
//    --remote-debugging-port=0; we discover them through the DevToolsActivePort file Chromium writes in the Playwright profile and
//    attach only as a SECOND CDP client (Playwright keeps its pipe — watching + intervening possible without disturbing the agent).
// The ONE start function: the browser `proj:<id>` of a relocated project starts in the project container.
// The address: every session carries its `debugHost` (default 127.0.0.1 = B as before). A Chromium in the project container
// listens on ITS loopback; B reaches it via the instance's IP (DNAT on eth0). The CDP client's connection, the fetch of
// /json/version, the DevTools proxy and its upgrade go there — with `Host: <IP>:<port>` (Chromium rejects every host that is neither
// an IP nor localhost: 500; a WebSocket WITH Origin: 403 — so the Origin is dropped). Names (`<project>.cbase`) never work here.
import { inProject } from "./runtime/inProject.js";
import { browserCall, endGroup, killAllBrowserGroups, trackBrowser } from "./browser-process.js";
import { HEARTBEAT, HEARTBEAT_MS } from "./runtime/heartbeat.js";
import { castParameter, humanInput, receiptDelay, quietDueFrom, stageAfterInput, stageAfterFrame, stageAfterQuiet, stageStart } from "./browser-image-stage.js";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { leaveProfileSafely, profileLockAlive, profileLockVerdict, profileLockTarget, profileParts, mirrorLogins, takeOverLogins } from "./browser-profiles.js";
import { hostPort, instanceIp, urlWithHost } from "./projectbox/address.js";
import { devtoolsSource, devtoolsSourceEndImmediately, stopDevtoolsSource, revision, revisionsMatch } from "./projectbox/devtools-ui.js";
import { T } from "./i18n.js";
import { withoutForbiddenHeaders, passThroughUpgradeResponse } from "./runtime/response-header.js";
import { readDescriptor } from "./runtime/real-path.js";
import { DEVTOOLS_UPGRADE, STREAM_UPGRADE, upgradeWay } from "./runtime/upgrade-way.js";
import { readInput, foldInputs, viewerFromWs } from "./browser-wire.js";
import { WebSocketServer } from "ws";
import {
  removeInRuntimeFolder, createFolderInRuntimeFolder, readFromRuntimeFolder, openFromRuntimeFolder, writeInRuntimeFolder,
} from "./runs/runtime-write.js";

// The host of a session without an instance: B itself.
const HOST_B = "127.0.0.1";

// The DevTools address of a browser in the project container is a CLAIM of the project, not the truth. What answers on
// /json/version there — or what a process there reports about itself on stderr — would decide where B connects: a redirect to
// `http://127.0.0.1:<p>/…` or a ws URL `ws://127.0.0.1:<service of B>/…` would hit a service of B, and a CDP in B (a browser of B with
// its logins) would then hang under project identifier and chat id in the list. So with an instance: no redirect (`redirect:
// "error"`), and the reported address must be ws:, without credentials, query and anchor, with the path /devtools/browser/<id> and —
// where B knows it (the port file) — the port B asked at; the host becomes the instance's (urlWithHost), never the reported one.
// Anything else throws. Without an instance every path stays as it was.
const WITHOUT_FORWARDING = { redirect: "error" };
function wsUrlTheInstance(raw, host, port = null) {
  const u = new URL(String(raw));
  if (u.protocol !== "ws:") throw new Error(`DevTools address of the instance: protocol ${u.protocol}`);
  if (u.username || u.password || u.search || u.hash) throw new Error("DevTools address of the instance: credentials, query or anchor");
  if (!/^\/devtools\/browser\/[^/]+$/.test(u.pathname)) throw new Error(`DevTools address of the instance: path ${u.pathname}`);
  if (port !== null && Number(u.port || 80) !== Number(port)) throw new Error(`DevTools address of the instance: port ${u.port || 80} instead of ${port}`);
  return urlWithHost(u.href, host);
}

const inContainer = () => process.env.CBASE_CONTAINER === "1";
const IDLE_MS = Math.max(1, Number(process.env.CBASE_BROWSER_IDLE_MIN || 15)) * 60_000;
// SSE backpressure: if the client hangs (slow line), drop frames instead of buffering.
const MAX_BUFFERED = 1_500_000;
// End-to-end flow control: writableLength sees only Node buffers, not kernel/gateway — so the client acknowledges every received frame
// (ack through the input route). At most `v.window` frames are in flight; surplus ones are replaced by the LATEST — so no old images pile
// up on slow lines. If acks stay away (old client, lost packet), ACK_RESET_MS resets the credit instead of freezing.
//
// The window is ADAPTIVE per viewer. A constant window of 2 frees ONE frame per RTT with one ack per round trip: fps ≈ 1/RTT (150 ms ⇒
// 6.8 fps, 300 ms ⇒ 3.5 fps, over Cloudflare→tunnel→gateway→container 2 fps). So every frame carries its send time, the ack measures
// the RTT, and the window is the SMALLEST RTT of the last RTT_WINDOW_S seconds times ACK_TARGET_FPS. Locally it stays at 2–4 (the RTT
// includes the client's bundling deadline: 4 ms path plus 20–50 ms deadline ⇒ ackWindow(54) = 4); at 150 ms it becomes 9, from 400 ms
// the cap 24 applies. Three pieces are BBR patterns, each from a measurement (simulation of a bandwidth-limited line — without them
// the window hit the cap 24 at 2 Mbit/s and 33 KB per frame, and the image was 3 s old instead of 0.2):
//  (1) Only a frame that went into an EMPTY line counts as a probe for the smallest RTT. Every other RTT contains the serialization of
//      the frames before it, and a minimum of those would run away with the queue.
//  (2) The idle probe (ProbeRTT): if the last empty send is RTT_WINDOW_S back, the server holds the frames until everything is
//      acknowledged and the next one goes out empty. Under constant load there would otherwise never be a probe — the credit is
//      refilled before the next ack comes. The hold costs one to two RTTs without new frames.
//  (3) The congestion brake: if the RTT of a frame that had frames ahead of it is above CONGESTION_FACTOR × minRtt, the line carries
//      less than the window pushes in. From the frames before it and its RTT follows how many fit into a base RTT; the window is capped
//      at double that (BBR's cwnd_gain), and every such probe WITHOUT congestion raises the cap by one. Without congestion the formula
//      alone applies — with unlimited bandwidth the brake changes nothing.
// The client bundles its acks (20 ms after the last frame, at most 50 after the first unacknowledged — web/src/lib/browser-stream.ts),
// and ACK_TARGET_FPS is 60 because the formula must cover the burst ITSELF: W frames arrive at 60 fps, that takes W/60 s, and the
// throughput is W / (RTT + W/60). The cap 24 covers 400 ms; above it the throughput is 24/(RTT + 0.4). The measured RTT includes up to
// 50 ms of client wait; the window covers it.
//
// Slow start: a new viewer (start, tab switch, hello) would otherwise open the window with the first ack at ackWindow(base): the first
// probe knows no bandwidth, and on a narrow line (2 Mbit/s, 33 KB per frame, base 302 ms) 18 frames stood in the line, the oldest image
// 2.4 s old, until the congestion brake saw the RTT of a frame BEHIND the queue. So the cap starts at SLOW_START_START and grows per
// acknowledged frame by SLOW_START_FACTOR − 1 — doubling per round trip as far as the line acknowledges (like TCP slow start: the acks
// clock the growth, on a narrow line it grows with the bandwidth, not with the clock) — but only if a frame has waited for credit since
// the last ack. Slow start ends at the target ackWindow(minRtt) or at the congestion brake: an RTT above CONGESTION_FACTOR × minRtt —
// the same quantity, ONE place (the brake). The price: at most four acks to the full window instead of one (iOS acks without bundling
// and needs five from 500 ms) — logarithmic, not W. Every tab switch and every hello (a new viewer, newViewer) pays this price
// DELIBERATELY: a new tab may be another page with another frame size, and the first probe does not know its bandwidth. Slow start also
// begins anew after a credit reset (sendFrame). Rejected, each measured on a grid of 105 narrow lines (1–5 Mbit/s, 50–500 ms, 20–50 KB
// per frame), each with start 2: doubling per ROUND instead of per frame (grows faster than the line acknowledges), factor 3, a minimum
// doubling per round. SLOW_START_START 6 instead of 2 reaches the same four acks for +10 %; with 2 or 4 slow start costs a fifth from
// 300 or 400 ms. The tests that mean the settled state drive the viewer from before (`withoutAttempt: true`) — and test (k) compares
// with it on the same line.
const ACK_RESET_MS = 2500;
export const ACK_TARGET_FPS = 60;
export const ACK_WINDOW_MIN = 2;
export const ACK_WINDOW_MAX = 24;
export const RTT_WINDOW_S = 10; // observation window of the smallest RTT (second buckets) and spacing of the idle probes
export const CONGESTION_FACTOR = 2; // an RTT above double the base means a queue (BBR's tolerance: one base RTT)
export const SLOW_START_START = 6; // slow start: the cap a viewer begins with (before the first ack ACK_WINDOW_MIN applies; rationale above)
export const SLOW_START_FACTOR = 2; // slow start: the cap grows by this factor per acknowledged round trip (per acknowledged frame by SLOW_START_FACTOR − 1)
// Window from the smallest RTT: as many frames as ACK_TARGET_FPS need room for per RTT.
export function ackWindow(minRttMs) {
  const rtt = Number(minRttMs);
  if (!Number.isFinite(rtt) || rtt <= 0) return ACK_WINDOW_MIN;
  return Math.max(ACK_WINDOW_MIN, Math.min(ACK_WINDOW_MAX, Math.ceil((rtt * ACK_TARGET_FPS) / 1000)));
}
// The flow control's clock — replaceable so the test can set it deterministically.
let clock = () => Date.now();
const viewersById = new Map(); // vid -> { v, t, s } (ack routing)
// Heartbeat per viewer: a static page — the login page where the human intervenes for the agent — sends NOTHING after hello and the
// first frames (measured: 0 events in 12 s). iOS aborts a silent stream after 45 s (`timeoutIntervalForRequest`), Cloudflare after
// 100 s. A named event as in runtime/sse.js; web (EventSource without listener) and iOS (`default: break`) ignore it. Line and beat
// live in runtime/heartbeat.js.
setInterval(() => {
  for (const { v } of viewersById.values()) { try { if (!v.res.destroyed) v.res.write(HEARTBEAT); } catch { /* viewer is just leaving */ } }
}, HEARTBEAT_MS).unref();
// Fixed render scale of the user browsers (launch flag + emulation + cast cap must match).
// 2 = supersampling: retina clients see 1:1, 1× displays get a cleanly downscaled image.
const CAST_DSF = 2;

// ── Find the Chromium binary ─────────────────────────────────────────────────
export function resolveChromium() {
  const cands = [process.env.CBASE_CHROMIUM];
  if (process.platform === "darwin") {
    cands.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
    // Playwright cache (if no Chrome is installed)
    const cache = path.join(process.env.HOME || "", "Library", "Caches", "ms-playwright");
    try {
      for (const d of fs.readdirSync(cache)) {
        if (!d.startsWith("chromium-")) continue;
        for (const sub of ["chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"])
          cands.push(path.join(cache, d, sub));
      }
    } catch { /* no cache */ }
  } else {
    cands.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome");
  }
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  return null;
}

// ── Minimal CDP client (flatten sessions) over the global WebSocket (Node ≥22) ──
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.seq = 0; this.pending = new Map(); this.eventHandlers = new Set(); this.closeHandlers = new Set(); }
  connect() {
    if (typeof WebSocket === "undefined") return Promise.reject(new Error("WebSocket client missing (Node ≥ 22 required)"));
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || "CDP error")) : resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.eventHandlers) { try { h(msg); } catch { /* isolate handler errors */ } }
      }
    };
    this.ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP connection closed"));
      this.pending.clear();
      for (const h of this.closeHandlers) { try { h(); } catch {} }
    };
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("CDP connection failed"));
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (e) { this.pending.delete(id); reject(e); }
    });
  }
  onEvent(h) { this.eventHandlers.add(h); }
  onClose(h) { this.closeHandlers.add(h); }
  close() { try { this.ws?.close(); } catch {} }
}

// ── Session registry ─────────────────────────────────────────────────────────
const sessions = new Map(); // id -> Session
let changed = null; // callback for the global event stream (/api/events)
export function onBrowsersChanged(cb) { changed = cb; }
// An agent browser carries its IDENTITY: `profile` (the profile folder, "chat-<chatId>" or "chat-<chatId>-agent-<agentId>") plus
// `chatId`/`agentId`. The `id` is that of a SESSION — one Chromium process — and the agent starts a new one per turn or workflow step
// (one @playwright/mcp per run; measured: after the next step the same browser had a new id, and the right chat bar, which hung on the
// id, silently fell back to its own browser). So whoever watches an agent chooses the profile, not the session. `activeAt` (ms, 0 =
// never) and `agentTab` say what the agent did last: opened a tab or changed an address (see rememberActivity).
const summarize = (s) => ({
  id: s.id, kind: s.kind, label: s.label, workspaceId: s.workspaceId || "", scopeKey: s.scopeKey || "",
  tabs: s.tabOrder.length,
  profile: s.profile || "", chatId: s.chatId || "", agentId: s.agentId || "", activeAt: s.activeAt || 0, agentTab: s.agentTab || "",
  // The chat whose main agent currently holds this OWN browser ("" = none) — with two, the one that held first.
  agentChat: s.agentChats?.size ? [...s.agentChats.keys()][0] : "",
});
export const listBrowsers = () => [...sessions.values()].filter((s) => !s.closed).map(summarize);
const notify = () => { try { changed?.(listBrowsers()); } catch {} };
// The list to all clients, bundled: a page that rewrites its address on a beat (pushState while scrolling) should not send an event
// per change to every open surface. GET /api/browsers computes unbundled.
function scheduleNotify(s) {
  if (s.notifyTimer) return;
  s.notifyTimer = setTimeout(() => { s.notifyTimer = null; if (!s.closed) notify(); }, 250);
  s.notifyTimer.unref?.();
}

// A tab = a page target. The CDP page session is attached lazily (only when someone watches or types); the screencast runs only
// while viewers for exactly this tab are connected.
function makeSession({ id, kind, label, workspaceId, scopeKey, profileDir, proc, cdp, debugPort, debugHost = HOST_B, profile = "", chatId = "", agentId = "" }) {
  return {
    id, kind, label, workspaceId, scopeKey, profileDir, proc, cdp, debugPort: debugPort || 0,
    debugHost, // where the debug port listens, seen from B: 127.0.0.1 or the instance's IP
    profile, chatId, agentId, // only kind "agent": the identity beyond the process (see summarize)
    activeAt: 0, agentTab: null, discovered: false, notifyTimer: null, portMtime: 0,
    tabs: new Map(), // targetId -> { targetId, title, url, sessionId|null, viewers:Set<viewer>, casting:false }
    tabOrder: [], activeTargetId: null,
    viewSize: null, // { width, height, dpr } — only kind "user" (emulation)
    idleTimer: null, closed: false, metaTimer: null, saveTimer: null,
    tabCreation: null, // running createTarget of saveTab (never two replacement tabs)
    agentChats: new Map(), // only kind "user": chatId -> number of turns that hold it (holdForAgent)
    emptySince: Date.now(), // only kind "user": since when without viewers and hold (whoever yields first at the cap)
    end: null, // only kind "user": promise — the process is gone and the logins are back in the stock (endOf)
  };
}

// What an agent does right now the viewer sees only from outside — Playwright talks to the browser over ITS line, we hang next to it
// as a second client: a tab arises (browser_tabs new, a popup) or changes its address (navigation, also pushState). That is the
// "activity": the tab becomes the agent's (`agentTab`) and the active one — a viewer without a tab choice, an input without a tab and
// a screenshot without a tab thus hit the tab the agent works in. (The active tab of an agent session used to stay the FIRST, and
// whoever watched saw the tab the agent had long left.) A title change alone does not count (pages with a ticking title).
//
// On the browser of a chat, while its main agent holds it (holdForAgent), human and agent work in the same browser. There the agent's
// tab is only MARKED (`agentTab`, `activeAt`), never made active: the human's view never jumps by itself (web/src/lib/browser-stream.ts).
// A change within HUMAN_MS after an input or action of the human (rememberHuman) is his, not the agent's — otherwise the mark would
// wander to the tab he is clicking in himself.
const HUMAN_MS = 3_000;
const rememberHuman = (s) => { if (s.kind === "user") s.humanAt = Date.now(); };
function rememberActivity(s, targetId) {
  if (!s.tabs.has(targetId)) return;
  if (s.kind === "agent") {
    if (!s.discovered) return;
    s.activeTargetId = targetId;
  } else if (s.kind !== "user" || !s.agentChats.size || Date.now() - (s.humanAt || 0) < HUMAN_MS) return;
  s.activeAt = Date.now();
  s.agentTab = targetId;
  scheduleMeta(s);
  scheduleNotify(s);
}

// Create a tab entry — ONE shape for both ways a tab becomes known: the targetCreated event (wireTargets) and the answer of
// Target.createTarget (newTab). Idempotent, because event and answer arrive in any order.
function registerTab(s, ti) {
  const known = s.tabs.get(ti.targetId);
  if (known) return known;
  const t = { targetId: ti.targetId, title: ti.title || "", url: ti.url || "", sessionId: null, viewers: new Set(), recorders: new Set(), casting: false };
  s.tabs.set(ti.targetId, t);
  s.tabOrder.push(ti.targetId);
  if (!s.activeTargetId) s.activeTargetId = ti.targetId;
  scheduleMeta(s); notify();
  return t;
}

// Open a new tab and make it active (action newTab, replacement for the last tab).
async function newTab(s, url = "about:blank") {
  const r = await s.cdp.send("Target.createTarget", { url });
  const t = registerTab(s, { targetId: r.targetId, title: "", url });
  s.activeTargetId = r.targetId;
  scheduleMeta(s);
  return t;
}

// Create a replacement tab — only ONE createTarget at a time (s.tabCreation), on EVERY path: replacement tabs would otherwise pile up
// when targetDestroyed and a new viewer coincide or two closeTab calls arrive in parallel on the last tab (measured: two about:blank
// tabs from a double click on the ×).
function fallbackTab(s) {
  if (!s.tabCreation) s.tabCreation = newTab(s).finally(() => { s.tabCreation = null; });
  return s.tabCreation;
}

// A living user browser never has zero tabs. Without a tab the stream wrote "gone", the client called ensure(), ensure found the SAME
// session (it lives) and the next stream wrote "gone" again — the "reload tab" endless loop. Returns the active tab or creates an
// about:blank tab (fallbackTab). Not on shutdown: destroySession kills the process, the targets die one after the other, and each would
// otherwise request a replacement. Agent browsers belong to the run — there "without a tab" is a state.
function saveTab(s) {
  if (s.closed || s.kind !== "user") return Promise.resolve(null);
  const existing = s.tabs.get(s.activeTargetId) || [...s.tabs.values()][0];
  if (existing) return Promise.resolve(existing);
  return fallbackTab(s).catch(() => null);
}

// `agent`: the tab the agent last did something in (rememberActivity) — on an agent session and on the browser of a chat in which the
// main agent works, otherwise never.
function tabList(s) {
  return s.tabOrder
    .map((tid) => s.tabs.get(tid))
    .filter(Boolean)
    .map((t) => ({ id: t.targetId, title: t.title || "", url: t.url || "", active: t.targetId === s.activeTargetId, agent: Boolean(s.agentTab) && t.targetId === s.agentTab }));
}

// Push the tab list to all viewers of the session (debounced — targetInfoChanged fires often).
function scheduleMeta(s) {
  if (s.metaTimer) return;
  s.metaTimer = setTimeout(() => {
    s.metaTimer = null;
    const line = `event: tabs\ndata: ${JSON.stringify({ tabs: tabList(s), agentTab: s.agentTab || "" })}\n\n`;
    for (const t of s.tabs.values()) for (const v of t.viewers) { try { v.res.write(line); } catch {} }
    scheduleSaveTabs(s);
  }, 120);
  s.metaTimer.unref?.();
}

// Save the open tab URLs next to the profile → restore on the next start (only "user"). The profile of a relocated project
// (`<runtime>/browser-profiles/proj-<id>`) lies in the runtime folder the project container mounts rw — its Chromium runs there. A link
// in the place of cbase-tabs.json (`→ <data>/<db>`) would have B write the URL list (which the container determines by navigating) over
// a file of B. So there through the descriptor (runs/runtime-write.js), otherwise as before.
const tabsFile = (s) => (s.profileDir ? path.join(s.profileDir, "cbase-tabs.json") : null);
function tabsSave(s) {
  const urls = tabList(s).map((t) => t.url).filter((u) => u && !u.startsWith("about:") && !u.startsWith("data:"));
  const content = JSON.stringify({ urls, active: s.activeTargetId ? tabList(s).findIndex((t) => t.active) : 0 });
  try { if (!writeInRuntimeFolder(tabsFile(s), content)) fs.writeFileSync(tabsFile(s), content); } catch {}
}
// The READING of the same files: the tab list at start and the port file `DevToolsActivePort` (polled at start, in the scan per
// profile) lie in the profile — in the runtime folder the container places links and FIFOs there. `readFileSync` followed a link (the
// tab list as start URL, the first line of a file of B as a port in a request to the instance) and a FIFO stopped B's event loop. So
// there through the descriptor (runs/runtime-write.js readFromRuntimeFolder/openFromRuntimeFolder: no link, only a regular file); what
// cannot be read that way does not exist. Otherwise as before.
// Cap in the runtime folder: a sparse port file of 1.9 GB would otherwise be read in full by the scanner every 3 s. Larger ⇒
// `ETOOLARGE` before reading — the entry counts like an unreadable file (no browser). In B as before.
export const PORT_FILE_MAX = 4096;
export const TABS_MAX = 1024 * 1024;
function tabsRead(profileDir) {
  const file = path.join(profileDir, "cbase-tabs.json");
  const text = readFromRuntimeFolder(file, "utf8", { maxBytes: TABS_MAX });
  return JSON.parse(text === null ? fs.readFileSync(file, "utf8") : text);
}
function portFile(file) {
  const fd = openFromRuntimeFolder(file, { maxBytes: PORT_FILE_MAX });
  if (fd === null) return { port: fs.readFileSync(file, "utf8").trim().split("\n")[0], mtime: fs.statSync(file).mtimeMs };
  try { return { port: readDescriptor(fd, "utf8", { maxBytes: PORT_FILE_MAX, display: file }).trim().split("\n")[0], mtime: fs.fstatSync(fd).mtimeMs }; } finally { fs.closeSync(fd); }
}
function scheduleSaveTabs(s) {
  if (s.kind !== "user" || !tabsFile(s) || s.saveTimer) return;
  s.saveTimer = setTimeout(() => {
    s.saveTimer = null;
    tabsSave(s);
  }, 2000);
  s.saveTimer.unref?.();
}

const isPageTarget = (ti) => ti.type === "page" && !/^(devtools|chrome-extension):/.test(ti.url || "");

/** How long an agent may answer an open dialog itself before B declines (JavaScript dialog event below). */
export const DIALOG_DEADLINE_MS = 10_000;
const dialogDeadlineMs = () => Number(process.env.CBASE_BROWSER_DIALOG_DEADLINE_MS) || DIALOG_DEADLINE_MS;

// Target events of the browser connection → keep the tab registry current.
function wireTargets(s) {
  s.cdp.onEvent((msg) => {
    const { method, params } = msg;
    if (method === "Target.targetCreated" && isPageTarget(params.targetInfo)) {
      const fresh = !s.tabs.has(params.targetInfo.targetId);
      registerTab(s, params.targetInfo);
      const reg = s.tabs.get(params.targetInfo.targetId);
      if (reg && !s.closed) void connectTab(s, reg).catch(() => {}); // see dialogs (DIALOG_DEADLINE_MS)
      if (fresh) rememberActivity(s, params.targetInfo.targetId); // only after discovery (s.discovered) — before that they are the ones already open
    } else if (method === "Target.targetInfoChanged" && isPageTarget(params.targetInfo)) {
      const t = s.tabs.get(params.targetInfo.targetId);
      if (t) {
        // Attaching a viewer also reports targetInfoChanged (`attached`) — activity is only a NEW address.
        const addressNew = (params.targetInfo.url || "") !== (t.url || "");
        t.title = params.targetInfo.title; t.url = params.targetInfo.url; scheduleMeta(s);
        if (addressNew) rememberActivity(s, t.targetId);
      }
    } else if (method === "Target.targetDestroyed") {
      const t = s.tabs.get(params.targetId);
      if (t) {
        for (const v of t.viewers) { try { v.res.write(`event: tabclosed\ndata: {}\n\n`); } catch {} }
        for (const r of t.recorders) { try { r.onGone?.(); } catch {} }
        s.tabs.delete(params.targetId);
        s.tabOrder = s.tabOrder.filter((x) => x !== params.targetId);
        if (s.activeTargetId === params.targetId) s.activeTargetId = s.tabOrder[s.tabOrder.length - 1] || null;
        if (s.agentTab === params.targetId) s.agentTab = s.activeTargetId;
        scheduleMeta(s); notify();
        // If the last tab was closed from outside (window.close, DevTools), create a replacement — saveTab is silent on s.closed and for
        // agent browsers.
        if (!s.tabOrder.length) void saveTab(s);
      }
    } else if (method === "Page.screencastFrame") {
      // sessionId → find the tab, acknowledge the frame and distribute it to its viewers.
      const t = [...s.tabs.values()].find((x) => x.sessionId === msg.sessionId);
      const acknowledge = () => s.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, msg.sessionId).catch(() => {});
      if (!t) { acknowledge(); return; }
      // The page beat (receiptDelay in browser-image-stage.js): without input from the human the acknowledgement goes delayed —
      // Chromium sends the next frame only after it. An input acknowledges at once (dispatchInput, receiptNow).
      clearTimeout(t.receiptTimer);
      const delay = receiptDelay({ stage: imageOf(t).stage, recorder: t.recorders.size > 0 });
      if (!delay) { t.receipt = null; acknowledge(); }
      else {
        t.receipt = acknowledge;
        t.receiptTimer = setTimeout(() => receiptNow(t), delay);
        t.receiptTimer.unref?.();
      }
      // Remember the last frame: new viewers get an image at once (static pages deliver a screencast frame again only on the next
      // repaint). metadata.deviceWidth is reliable in CSS pixels thanks to --force-device-scale-factor (the JPEG itself comes in device
      // pixels) — exactly what the click mapping needs.
      t.lastFrame = { data: params.data, w: params.metadata.deviceWidth, h: params.metadata.deviceHeight, time: { tc: Math.round((params.metadata.timestamp || 0) * 1000), tr: Date.now() } };
      t.frameCount = (t.frameCount || 0) + 1; // restartCast: a real frame takes precedence over its substitute image
      for (const v of t.viewers) sendFrame(t, v, t.lastFrame);
      imageStage(s, t, stageAfterFrame(imageOf(t), Date.now(), { recorder: t.recorders.size > 0 }));
    } else if (method === "Page.javascriptDialogOpening") {
      // An open dialog freezes the page — and everyone waiting for it. If a human watches in the chat browser, B confirms at once (as
      // before; the UI cannot answer a dialog) and tells the viewers. Otherwise an agent operates the tab (Playwright over cdpEndpoint,
      // agent browser): it gets DIALOG_DEADLINE_MS to answer itself (browser_handle_dialog), after which B declines. Without this
      // deadline an agent hung 20 min: browser_press_key Escape triggered a confirm, the key press waited for the page, and
      // browser_handle_dialog stood in the MCP server's queue behind it. Decline, not confirm: the way out must not delete or discard
      // anything the agent did not explicitly want.
      const t = [...s.tabs.values()].find((x) => x.sessionId === msg.sessionId);
      const respond = (accept) => s.cdp.send("Page.handleJavaScriptDialog", { accept }, msg.sessionId).catch(() => {});
      if (s.kind === "user" && t?.viewers.size) {
        respond(params.type !== "beforeunload");
        for (const v of t.viewers) { try { v.res.write(`event: dialog\ndata: ${JSON.stringify({ type: params.type, message: params.message })}\n\n`); } catch {} }
      } else if (t) {
        clearTimeout(t.dialogDeadline);
        t.dialogDeadline = setTimeout(() => { t.dialogDeadline = null; if (!s.closed) respond(false); }, dialogDeadlineMs());
        t.dialogDeadline.unref?.();
      } else respond(false);
    } else if (method === "Page.javascriptDialogClosed") {
      const t = [...s.tabs.values()].find((x) => x.sessionId === msg.sessionId);
      if (t) { clearTimeout(t.dialogDeadline); t.dialogDeadline = null; }
    }
  });
  s.cdp.onClose(() => destroySession(s, "cdp-closed"));
}

// B connects to EVERY tab (Page.enable) as soon as it appears — otherwise B sees no dialog in a tab only an agent operates
// (DIALOG_DEADLINE_MS). Only connect: focus and surface (attachTab) B sets only when a human watches or B records itself, otherwise B
// would overwrite the surface the agent set via browser_resize. One promise per tab so two simultaneous calls do not attach twice.
function connectTab(s, t) {
  if (t.sessionId) return Promise.resolve(t.sessionId);
  t.connect ||= (async () => {
    const { sessionId } = await s.cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    t.sessionId = sessionId;
    await s.cdp.send("Page.enable", {}, sessionId).catch(() => {});
    return sessionId;
  })().finally(() => { t.connect = null; });
  return t.connect;
}

async function attachTab(s, t) {
  const sessionId = await connectTab(s, t);
  if (t.setUp) return sessionId;
  t.setUp = true;
  if (s.kind === "user") {
    // Pages should behave as focused (caret, :focus styles) and possibly adopt the pane size.
    await s.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => {});
    if (s.viewSize) await applyMetrics(s, t).catch(() => {});
  }
  return sessionId;
}

async function applyMetrics(s, t) {
  if (!s.viewSize || !t.sessionId) return;
  const { width, height } = s.viewSize;
  const w = Math.max(320, width | 0);
  const h = Math.max(240, height | 0);
  // screenWidth/-Height = the viewport: `metadata.deviceWidth` of a screencast frame is the width of the DEVICE SCREEN — without it,
  // after a restart of the screencast it fell back to the window (1280 × 657 at --window-size=1280,800), and the bar showed the own
  // browser at the wrong size (scrolling instead of fitting).
  await s.cdp.send("Emulation.setDeviceMetricsOverride", {
    width: w, height: h, screenWidth: w, screenHeight: h,
    deviceScaleFactor: CAST_DSF, mobile: false, // fixed — must match the launch flag
  }, t.sessionId);
}

async function startCast(s, t) {
  if (t.casting || (!t.viewers.size && !t.recorders.size)) return;
  await attachTab(s, t);
  t.casting = true;
  // Couple the frame resolution to the actual pane size, quality and scale by the tab's image stage (browser-image-stage.js): sharp =
  // surface × min(client dpr, CAST_DSF), fluid = surface × 1 at lower quality.
  const p = castParameter(imageOf(t).stage, s.kind === "user" ? s.viewSize : null, CAST_DSF);
  try {
    await s.cdp.send("Page.startScreencast", p, t.sessionId);
    t.castAttempts = 0;
  } catch {
    t.casting = false;
    // A viewer who arrives while the tab navigates gets "Not attached to an active page" — it used to stay that way: one image (the
    // screenshot from attachViewer) and none afterwards, not even when scrolling, until a resize or a new viewer happened to restart the
    // cast. Now a new attempt after CAST_AGAIN_MS as long as someone watches, at most CAST_ATTEMPTS times in a row (a tab that never has
    // a page again is no reason for an endless loop).
    if ((t.castAttempts = (t.castAttempts || 0) + 1) <= CAST_ATTEMPTS && !s.closed) {
      setTimeout(() => { if (!s.closed && s.tabs.get(t.targetId) === t) void castFollowUp(t, () => startCast(s, t)); }, CAST_AGAIN_MS).unref?.();
    }
  }
}
const CAST_AGAIN_MS = 150;
const CAST_ATTEMPTS = 40;
// Stop and start of a tab one after the other, never interleaved: two restarts at once (a resize and a stage change) would otherwise
// run stop, stop, start, start — the second start throws "Screencast is already active", and casting would be wrong.
function castFollowUp(t, fn) {
  const p = (t.castChain || Promise.resolve()).then(fn, fn);
  t.castChain = p.catch(() => {});
  return p;
}

// Send a delayed screencast acknowledgement now (beat expired, human input, new recording).
function receiptNow(t) {
  clearTimeout(t.receiptTimer);
  const q = t.receipt;
  t.receipt = null;
  if (q) q();
}

// ── The image stage (rules and measurement in browser-image-stage.js) ──
const imageOf = (t) => (t.image ||= stageStart(Date.now()));
// Adopt the new state; if the stage changes, the cast restarts (Chromium then delivers an image at once in the new stage — the sharp
// final image after the movement). If the tab is fluid, the quiet wakeup wakes at the due time.
function imageStage(s, t, fresh) {
  const old = imageOf(t).stage;
  t.image = fresh;
  if (fresh.stage !== old && t.casting && t.sessionId) {
    void castFollowUp(t, async () => {
      if (!t.casting || !t.sessionId || s.closed) return;
      await s.cdp.send("Page.stopScreencast", {}, t.sessionId).catch(() => {});
      t.casting = false;
      await startCast(s, t);
    });
  }
  clearTimeout(t.quietTimer);
  const start = quietDueFrom(fresh);
  if (start === null) return;
  t.quietTimer = setTimeout(() => { if (!s.closed) imageStage(s, t, stageAfterQuiet(imageOf(t), Date.now())); }, Math.max(0, start - Date.now()));
  t.quietTimer.unref?.();
}

// Restart a running screencast with the current dimensions (after a resize).
function restartCast(s, t) { return castFollowUp(t, () => restartCastNow(s, t)); }
async function restartCastNow(s, t) {
  if (!t.casting || !t.sessionId) return;
  await s.cdp.send("Page.stopScreencast", {}, t.sessionId).catch(() => {});
  t.casting = false;
  // Two counters per tab: a NEWER restart (two resizes in quick succession, bar and extra window) and a screencast frame that has
  // arrived meanwhile take precedence over this restart's image. Only "did a frame come?" did not suffice: the image of the OLDER
  // restart (still in the old size) then counted as a new frame and discarded the right one.
  const gen = (t.castGen = (t.castGen || 0) + 1);
  const frameSeq = t.frameCount || 0;
  await startCast(s, t);
  // A fresh image in the new dimensions: a static page delivers no screencast frame after the resize, the viewers stood at the old size
  // — the fitting (web/src/lib/browser-surface.ts) reads the size from the frame, and the image stayed narrow or scrolled in a surface
  // it fitted into. Like when attaching a viewer (attachViewer); if a screencast frame came meanwhile, that one counts.
  // The size is that of the emulation applyMetrics just set — NOT `Page.getLayoutMetrics`: measured, it reports the window size under
  // `setDeviceMetricsOverride` (1280 × 657 at --window-size=1280,800), and the bar then stood at the wrong size. Without emulation (no
  // viewSize) there is no safe size, hence no substitute image.
  const vs = s.viewSize;
  if (!vs) return;
  try {
    const shot = await s.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 80 }, t.sessionId);
    if (t.castGen !== gen || (t.frameCount || 0) !== frameSeq || s.viewSize !== vs) return;
    t.lastFrame = { data: shot.data, w: Math.max(320, vs.width | 0), h: Math.max(240, vs.height | 0) };
    for (const v of t.viewers) sendFrame(t, v, t.lastFrame);
  } catch { /* tab maybe just closed */ }
}
function stopCastIfIdle(s, t) {
  if (!t.casting || t.viewers.size || t.recorders.size) return;
  t.casting = false;
  if (t.sessionId) s.cdp.send("Page.stopScreencast", {}, t.sessionId).catch(() => {});
}

// Idle: close a user browser without viewers after IDLE_MS (profile + tabs stay saved). A browser a turn holds (the agent works in it,
// perhaps without viewers) is not empty — otherwise the deadline would close it in mid-turn, and Playwright would lose its connection.
// The deadline begins anew after the last release.
const occupied = (s) => [...s.tabs.values()].some((t) => t.viewers.size) || s.agentChats.size > 0;
function armIdle(s) {
  if (s.kind !== "user") return;
  clearTimeout(s.idleTimer);
  if (occupied(s)) return;
  s.emptySince = Date.now();
  s.idleTimer = setTimeout(() => {
    if (!occupied(s)) destroySession(s, "idle");
  }, IDLE_MS);
  s.idleTimer.unref?.();
}

function destroySession(s, _reason) {
  if (s.closed) return;
  s.closed = true;
  clearTimeout(s.idleTimer);
  clearTimeout(s.notifyTimer);
  // An agent browser whose connection we saw die is dead — its port file stays anyway (see startAgentScan). Remembered with the file's
  // timestamp: if a new browser of the same profile rewrites it, it counts.
  if (s.kind === "agent" && s.portMtime) deadKey.set(s.scopeKey, s.portMtime);
  for (const t of s.tabs.values()) {
    for (const v of t.viewers) { viewersById.delete(v.vid); try { v.res.write(`event: gone\ndata: {}\n\n`); v.res.end(); } catch {} }
    for (const r of t.recorders) { try { r.onGone?.(); } catch {} }
  }
  if (s.kind === "user" && s.proc && _reason !== "cdp-closed") endGentle(s);
  else {
    try { s.cdp.close(); } catch {}
    if (s.proc) endGroup(s.proc); // the whole group, hard after the grace (browser-process.js)
  }
  sessions.delete(s.id);
  notify();
}

// An own browser ends through `Browser.close` — Chromium writes its databases then. Measured: a permanent cookie set via CDP was NOT in
// the cookie database after SIGTERM (Chromium writes it bundled, about every 30 s), so mirroring the logins back (endOf) would have
// mirrored an empty state. If it does not answer within END_GENTLE_MS, as before: kill.
const END_GENTLE_MS = 5_000;
function endGentle(s) {
  const hart = () => { try { s.cdp.close(); } catch {} endGroup(s.proc); };
  const deadline = setTimeout(hart, END_GENTLE_MS);
  deadline.unref?.();
  // The helpers outlive the browser process by a moment — the group is ended too (it is empty soon after, or gets KILL).
  s.proc.once("exit", () => { clearTimeout(deadline); try { s.cdp.close(); } catch {} endGroup(s.proc, { graceMs: 1_000 }); });
  // No answer is the normal case (the line closes with the browser) — the deadline decides, not the rejection.
  Promise.resolve().then(() => s.cdp.send("Browser.close")).catch(() => {});
}

// ── User browser (browser tab) ───────────────────────────────────────────────
const ensureLocks = new Map(); // scopeKey -> Promise (bundle parallel ensure calls)

// `instance`: the browser of a relocated project (`proj:<id>`) starts in the project container (runtime/inProject.js); its DevTools
// address is the instance's IP (`debugHost`). Without an instance as before.
// An existing session only counts if it runs where the browser should run now — its `debugHost` is the instance's IP or HOST_B. If
// `proj:<id>` ran in B before the relocation, this session is closed and the browser restarted in the instance (the relocation needs
// no browser teardown of its own). An instance without an IP throws as at start (launchUserBrowser).
export function ensureUserBrowser({ scopeKey, profileDir, label, workspaceId, instance = null, stocks = [], initialFill = [] }) {
  const existing = [...sessions.values()].find((s) => s.kind === "user" && s.scopeKey === scopeKey && !s.closed);
  let prior = null;
  if (existing) {
    let target;
    try { target = instance ? instanceIp(instance) : HOST_B; } catch (e) { return Promise.reject(e); }
    // the same profile too — a chat that changed the project has its browser in another place.
    if (existing.debugHost === target && existing.profileDir === profileDir) return Promise.resolve(summarize(existing));
    destroySession(existing, "closed");
    prior = existing.end; // start only when the old process is gone and its profile mirrored back
  }
  if (ensureLocks.has(scopeKey)) return ensureLocks.get(scopeKey);
  try { if (isChatScope(scopeKey)) spaceForChatBrowser(scopeKey); } catch (e) { return Promise.reject(e); }
  const p = Promise.resolve(prior && withDeadline(prior, END_DEADLINE_MS))
    .then(() => launchUserBrowser({ scopeKey, profileDir, label, workspaceId, instance, stocks, initialFill }))
    .finally(() => ensureLocks.delete(scopeKey));
  ensureLocks.set(scopeKey, p);
  return p;
}

/** Does the own browser `scopeKey` run (or start)? Synchronous — for callers that only want to wait then (chats/delete.js). */
export const userBrowserOpen = (scopeKey) => ensureLocks.has(scopeKey)
  || [...sessions.values()].some((s) => s.kind === "user" && s.scopeKey === scopeKey && !s.closed);

// ── The own browser of a chat ──────────────────────────────────────────────────────────────────────────────────────────
// Scope `chat:<chatId>` (devtools/user-browser.js chatBrowserTarget). What sets it apart from the browsers of workspaces and projects
// lives here: the cap and closing with waiting (archiving/deleting/project change of the chat).
export const isChatScope = (scopeKey) => String(scopeKey || "").startsWith("chat:");
// At most this many chat browsers at once per backend (= per user container, 12 GiB). Measured: a headless Chrome with a real page
// (github.com) ≈ 1.0 GiB footprint over 11 processes — six of them are half the container, next to CLI runs, agent browsers and the
// projects' services. Estimated, not exhausted; CBASE_CHAT_BROWSER_MAX overrides.
export const chatBrowserCap = () => Math.max(1, Number(process.env.CBASE_CHAT_BROWSER_MAX) || 6);
export const CHAT_BROWSER_CAP_CODE = "CHAT_BROWSER_CAP";
// At the cap the longest unobserved chat browser without viewers and without hold yields (profile and tabs stay saved, as after the
// idle deadline). If all are in use, none starts — with a message that says it is a cap.
function spaceForChatBrowser(scopeKey) {
  const open = [...sessions.values()].filter((s) => s.kind === "user" && !s.closed && isChatScope(s.scopeKey) && s.scopeKey !== scopeKey);
  const starting = [...ensureLocks.keys()].filter((k) => isChatScope(k) && k !== scopeKey).length;
  const max = chatBrowserCap();
  const tooMany = open.length + starting + 1 - max;
  if (tooMany <= 0) return;
  const free = open.filter((s) => !occupied(s)).sort((a, b) => a.emptySince - b.emptySince);
  if (free.length < tooMany) {
    throw Object.assign(new Error(T`${max} chat browsers are already open, all in use (cap of ${max} per server, to protect memory). Close another chat's browser or wait until nobody is watching it.`),
    { code: CHAT_BROWSER_CAP_CODE });
  }
  for (const s of free.slice(0, tooMany)) destroySession(s, "cap");
}
const END_DEADLINE_MS = 20_000;
const withDeadline = (p, ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); Promise.resolve(p).finally(() => { clearTimeout(t); r(); }); });
// The end of the process: only when it is gone — in the project container the docker child ends before the Chromium in it (group
// kill, runtime/inProject.js), so additionally wait for the profile lock (at most 10 s) — the logins are mirrored back into the stock
// (browser-profiles.js mirrorLogins; if the lock still lives, it leaves it). Without stocks only the end.
function endOf(proc, profileDir, stocks) {
  const gone = proc.exitCode !== null || proc.signalCode ? Promise.resolve() : new Promise((r) => proc.once("exit", r));
  return gone.then(async () => {
    if (!stocks.length) return;
    for (let i = 0; i < 40 && (await profileLockAlive(profileDir).catch(() => true)); i++) await new Promise((r) => setTimeout(r, 250));
    await mirrorLogins({ source: profileDir, stocks });
  }).catch(() => {});
}
/**
 * Close the own browser `scopeKey` and wait until its process is gone and the profile mirrored back (at most END_DEADLINE_MS) —
 * afterwards a caller may delete the profile. One that is just starting is waited for first. → whether one was running.
 */
export async function closeUserBrowser(scopeKey) {
  const starting = ensureLocks.get(scopeKey);
  if (starting) await starting.catch(() => {});
  const s = [...sessions.values()].find((x) => x.kind === "user" && x.scopeKey === scopeKey && !x.closed);
  if (!s) return false;
  destroySession(s, "closed");
  await withDeadline(s.end, END_DEADLINE_MS);
  return true;
}

// The main agent of a chat holds the own browser `scopeKey` for the duration of its turn — returns the debug port (from the browser's
// machine or container: 127.0.0.1:<port>) and the release (idempotent), or null if there is no living own browser. Caller:
// devtools/user-browser.js (right after ensureUserBrowser).
// `instance` — the turn runs there; a browser in another place (B instead of the instance or vice versa) is not reachable from the CLI
// under 127.0.0.1 and counts as not there.
export function holdForAgent(scopeKey, chatId, { instance = null } = {}) {
  const s = [...sessions.values()].find((x) => x.kind === "user" && x.scopeKey === scopeKey && !x.closed);
  if (!s || !s.debugPort) return null;
  let host;
  try { host = instance ? instanceIp(instance) : HOST_B; } catch { return null; }
  if (s.debugHost !== host) return null;
  const id = String(chatId || "");
  s.agentChats.set(id, (s.agentChats.get(id) || 0) + 1);
  clearTimeout(s.idleTimer);
  notify();
  let free = false;
  const approve = () => {
    if (free) return;
    free = true;
    const n = (s.agentChats.get(id) || 0) - 1;
    if (n > 0) s.agentChats.set(id, n); else s.agentChats.delete(id);
    if (s.closed) return;
    if (!s.agentChats.size && s.agentTab) { s.agentTab = null; scheduleMeta(s); } // no agent in it any more: no agent marker on the tab
    armIdle(s);
    notify();
  };
  return { debugPort: s.debugPort, sessionId: s.id, approve };
}

// The profile folder before the start. In the runtime folder without links (runs/runtime-write.js): `browser-profiles → /somewhere`
// would otherwise create the folder in B, and the lock files below would fall there — also those of a LIVING Chromium in B, whose
// profile a second browser would then open. If the path leads out, no browser starts (EOUTSIDE). Otherwise as before.
function profilePrepare(profileDir) {
  if (!createFolderInRuntimeFolder(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
  // Remove orphaned singleton locks: if the container is ended hard (docker rm -f, idle stop), Chromium does not clean up its locks; on
  // restart the container has another hostname → Chromium refuses the profile ("in use by another computer"). Our ensure refcount
  // guarantees that never two instances open the same profile.
  // DevToolsActivePort MUST go too: a stale file from the last run lets the port poll below fetch against a foreign/booting Chromium.
  // Its aborting requests (RST in the accept queue) kill Chromium's debug HTTP accept loop PERMANENTLY (WS keeps running, HTTP hangs
  // forever) — on reuse of the ephemeral port that hits the OWN browser.
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"]) {
    try { if (!removeInRuntimeFolder(path.join(profileDir, f))) fs.rmSync(path.join(profileDir, f), { force: true }); } catch { /* ignore */ }
  }
}

async function launchUserBrowser({ scopeKey, profileDir, label, workspaceId, instance = null, stocks = [], initialFill = [] }) {
  const bin = resolveChromium();
  if (!bin) throw new Error(T("No Chromium found (set CBASE_CHROMIUM or install Chrome)"));
  // Where its debug port listens from B's view. An instance without an IP throws BEFORE the start: a browser B cannot reach would be a
  // process without a line — and 127.0.0.1 would hit a service of B on the same port.
  const debugHost = instance ? instanceIp(instance) : HOST_B;
  profilePrepare(profileDir);
  // The logins of the stocks (and once of the old profile) in before the start — never from a running one (browser-profiles.js).
  if (stocks.length || initialFill.length) await takeOverLogins({ target: profileDir, stocks, initialFill });
  // Restore previously open tabs (first URL as start URL, the rest after the connect).
  let restore = { urls: [] };
  try { restore = tabsRead(profileDir); } catch {}
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble",
    "--window-size=1280,800",
    // Forces DETERMINISTIC screencast frames: always device pixels (CSS×2, razor sharp on retina too), metadata always CSS pixels
    // (correct click mapping). Without the flag Chromium switches the frame format by renderer state (cast start: device pixels, after
    // cross-origin navigation: DIP) — verified empirically.
    `--force-device-scale-factor=${CAST_DSF}`,
    // Logins travel between this profile and the Playwright profiles (browser-profiles.js syncLogins) — the cookies must be encrypted
    // with the same, profile-independent key as there (Playwright starts Chromium with exactly these two).
    "--password-store=basic", "--use-mock-keychain",
  ];
  if (inContainer()) args.push("--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu");
  args.push(restore.urls?.[0] || "about:blank");
  // Its own process group, the death signal on Linux and the owner marker (browser-process.js) — without an instance; with one the
  // marker only rides along.
  const call = browserCall(bin, args, { stdio: ["ignore", "ignore", "pipe"] }, { instance });
  const proc = trackBrowser(inProject(instance, call.cmd, call.args, call.opts), { instance });
  // Read the WS URL from stderr; fallback: poll the DevToolsActivePort file.
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "", done = false;
    const finish = (v, e) => { if (done) return; done = true; clearInterval(poll); clearTimeout(to); e ? reject(e) : resolve(v); };
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      // In the project container Chromium reports ITS loopback — from B that is the instance's IP; checked like every claim of an
      // instance (wsUrlTheInstance — B does not know the port here yet, the host is the instance's anyway).
      if (m && !instance) finish(m[1]);
      else if (m) { try { finish(wsUrlTheInstance(m[1], debugHost)); } catch (e) { finish(null, e); } }
    });
    proc.on("exit", (c) => finish(null, new Error(`Chromium ended (code ${c}): ${buf.slice(-400)}`)));
    // Careful with abort timeouts: an abort whose connection still lies in Chromium's accept queue (RST before accept) ends its debug HTTP
    // accept loop PERMANENTLY. Hence a long timeout (the abort then practically never hits the boot phase) + never two fetches in parallel.
    let polling = false;
    const poll = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const { port } = portFile(path.join(profileDir, "DevToolsActivePort"));
        // Chromium builds webSocketDebuggerUrl from the request's host — asked at the IP, it points to the IP. At an instance without
        // redirect and with a pinned address (wsUrlTheInstance; if it throws, polling goes on).
        const v = await (await fetch(`http://${hostPort(debugHost, port)}/json/version`, { signal: AbortSignal.timeout(10_000), ...(instance ? WITHOUT_FORWARDING : {}) })).json();
        if (v.webSocketDebuggerUrl) finish(instance ? wsUrlTheInstance(v.webSocketDebuggerUrl, debugHost, port) : v.webSocketDebuggerUrl);
      } catch { /* not ready yet */ }
      polling = false;
    }, 500);
    const to = setTimeout(() => finish(null, new Error("Chromium start: timeout")), 20_000);
  });
  const cdp = new Cdp(wsUrl);
  await cdp.connect();
  let debugPort = 0;
  try { debugPort = Number(new URL(wsUrl).port) || 0; } catch { /* no DevTools proxy possible */ }
  const s = makeSession({ id: crypto.randomUUID(), kind: "user", label, workspaceId, scopeKey, profileDir, proc, cdp, debugPort, debugHost });
  s.end = endOf(proc, profileDir, stocks);
  sessions.set(s.id, s);
  wireTargets(s);
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  // Reopen the remaining saved tabs.
  for (const u of (restore.urls || []).slice(1)) cdp.send("Target.createTarget", { url: u }).catch(() => {});
  armIdle(s);
  notify();
  return summarize(s);
}

// ── Agent browser discovery (Playwright profiles) ────────────────────────────
// With --remote-debugging-port=0 Chromium writes the file DevToolsActivePort into the profile; the Playwright MCP entry gets this arg
// through its --config (see toolchain/playwright.js, playwrightMcpEntry).
let scanTimer = null;
let activeScan = null; // { cycle, stop } of the scanner started last (agentScanCycle)
const scanFailures = new Map(); // key -> ts (pause failed attempts briefly)
// key -> mtime of the port file: sessions whose connection we saw die (destroySession). Chromium leaves DevToolsActivePort in place on
// exit — measured: after every run of a @playwright/mcp (SIGTERM to npx, Chromium gone, lock gone, port file there). Without this list
// the scanner would ask the dead port again every 30 s, for every profile that ever browsed — and a port assigned to a FOREIGN process
// in the meantime would be a browser we ran under this chat's name as its agent browser (watching and inputs would then go to the wrong one).
const deadKey = new Map();
// key -> "<lock target>\n<port file mtime>": ONLY profiles of an instance whose lock docker CONFIRMED dead (exit 1 of `kill -0`;
// "unknown ⇒ alive" is never remembered). Without it the scanner would ask the corpse again in EVERY pass (3 s) — a `docker exec` per
// profile and pass, serial, forever; the lock is never cleaned up (prepareChatProfile leaves it, see browser-profiles.js "TWO WAYS").
// The key is the lock TOGETHER WITH the port file, not the container start: a dead process does not come alive again, and this profile
// only becomes alive through a NEW Chromium that writes a new lock AND (Playwright, `--remote-debugging-port=0`) a new port file —
// exactly then the entry changes and the scanner asks ONCE anew. A restart of the container without a new browser changes nothing
// about the corpse; asked anew it would even give the WRONG verdict: in the new pid namespace (small numbers) or after a wraparound
// `kill -0 <pid>` hits a foreign process and says "alive" — the scanner would then query a dead port (the pattern that kills Chromium's
// accept loop). Remembered only here: the verdict skips a fetch, it deletes nothing — releaseStaleLocks and the cleanup keep asking
// fresh every time. Why the scanner does not clean up the corpse itself (releaseStaleLocks): in the 3 s tick against a Chromium that is
// just starting in this profile in the container and that B does not see, every window between verdict and deletion would be a chance to
// delete the lock of a LIVING browser; Chromium cleans up its own corpse at the next start anyway (same hostname).
const abandonedLocks = new Map();

// describeProfile translates a profile folder into display name + workspace. The folders are either a workspace ("<wsId>") or the
// browser of a chat ("chat-<chatId>", "chat-<chatId>-agent-<agentId>" that of a subagent) — which one only the caller with DB access
// knows. Chat and agent (the identity) this module computes itself.
// `rootDir`: a profile root or a function that supplies the roots per pass (the flat one and that of every runtime folder,
// runs/runtime-location.js — a relocated project joins at run time). A root is a path (the browsers in it run in B, 127.0.0.1 is asked,
// key `agent:<dir>:<port>`) or `{ root, host, identifier }` — the profiles in an instance's runtime folder: their browsers run in the
// project container, `host` (the instance's IP) is asked, and the key carries the identifier, `agent:<identifier>:<dir>:<port>` — the
// same port in B and in an instance are two browsers. Which root an instance has only the caller knows (server.js,
// projectbox/browser-network.js agentScanRoots). An object without `host` drops out, never 127.0.0.1. For an instance root additionally:
// its answer is not believed (wsUrlTheInstance, no redirect), and its locks ask docker at most once per corpse (abandonedLocks) and never
// during the failed-attempt pause.
// Returns (test seam): `cycle()` — a whole pass AFTER the call (a running one is waited for first) instead of a duration; `stop()`
// stops this scanner's beat.
export const PROFILES_PER_ROOT = 256;
// How many entries of an instance root a pass reads AT MOST — if main and copies share a root (`only`), the entries of the others count
// too. Estimated: eight times the profile cap, ≈ 2 ms per pass.
export const ENTRIES_PER_ROOT = 8 * PROFILES_PER_ROOT;
const profileCapReported = new Set();
function profileCapReport(root, identifier) {
  if (profileCapReported.has(root)) return;
  profileCapReported.add(root);
  console.warn(`[browser] profile root ${root} (${identifier || "instance"}): more than ${PROFILES_PER_ROOT} profiles or ${ENTRIES_PER_ROOT} entries — the scanner reads only up to there (cap)`);
}
export function startAgentScan(rootDir, { describeProfile = (dir) => ({ label: dir, workspaceId: dir }) } = {}) {
  const scanOnce = async () => {
    const entries = [];
    let roots = [];
    try { roots = typeof rootDir === "function" ? rootDir() : [rootDir]; } catch { return; }
    // An instance root without a host drops out — never to 127.0.0.1 (a browser of B would lie at the same port there).
    // `only(dirName)` (projectbox/browser-network.js): if several instances share a root, each entry reads only the profiles of ITS
    // instance — without `only` all, as before.
    roots = roots.flatMap((w) => (typeof w === "string" ? [{ root: w, host: HOST_B, identifier: "", instance: false, only: null }]
      : w?.root && w.host ? [{ root: w.root, host: String(w.host), identifier: String(w.identifier || ""), instance: true, only: typeof w.only === "function" ? w.only : null }] : []));
    for (const { root, host, identifier, instance, only } of roots) {
      // The names as before; whether an entry is a browser only its port file says, and that is read in the runtime folder through the
      // descriptor — under `playwright-profiles → <profiles of B>` there is none. An instance root at most PROFILES_PER_ROOT entries:
      // the container can create any number of folders there, and each cost B a port file per pass (and a docker question). Above that a
      // message per root, in B as before. Read entry by entry (opendir) and at most ENTRIES_PER_ROOT — also those `only` discards:
      // readdirSync read the root ENTIRELY despite the cap, every 3 s on the main thread (200,000 entries ≈ 200 ms per pass). What lies
      // behind the cap the scanner does not see — decoys of the container thus hide at most browsers of the SAME project (the root
      // belongs to it); for B a pass never costs more than the cap.
      let d = null;
      try {
        d = fs.opendirSync(root);
        let n = 0;
        let read = 0;
        for (let e = d.readSync(); e; e = d.readSync()) {
          if (instance && ++read > ENTRIES_PER_ROOT) { profileCapReport(root, identifier); break; }
          const name = e.name;
          if (only && !only(name)) continue;
          if (instance && ++n > PROFILES_PER_ROOT) { profileCapReport(root, identifier); break; }
          entries.push({ root, host, identifier, instance, dirName: name });
        }
      } catch { /* root missing */ } finally { try { d?.closeSync(); } catch { /* already closed */ } }
    }
    if (!entries.length && !roots.some((w) => fs.existsSync(w.root))) return;
    const seen = new Set();
    for (const { root, host, identifier, instance, dirName } of entries) {
      const dir = path.join(root, dirName);
      let port = "";
      let mtime = 0;
      try {
        ({ port, mtime } = portFile(path.join(dir, "DevToolsActivePort")));
      } catch { continue; }
      const key = identifier ? `agent:${identifier}:${dirName}:${port}` : `agent:${dirName}:${port}`;
      seen.add(key);
      if ([...sessions.values()].some((s) => s.scopeKey === key && !s.closed)) continue;
      // We saw its line die, and the file is the same — but it is dead only if no lock with a living process stands any more: if only
      // the CDP line broke, Chromium lives on and is attached again (a fetch against a fully started, living browser is not the pattern of
      // the accept-loop bug). Both questions are asynchronous: docker answers the lock of a browser in the project container.
      if (!instance) {
        if (deadKey.get(key) === mtime && !(await profileLockAlive(dir))) continue;
        if (await leaveProfileSafely(dir)) continue; // lock there, its process dead: crashed — do not ask
        const failedAt = scanFailures.get(key);
        if (failedAt && Date.now() - failedAt < 30_000) continue;
      } else {
        // A profile of an instance: every question to the lock is a `docker exec`. The same three outcomes as above, but cheap first: the
        // pause after a failed attempt (a profile whose fetch just failed does not ask docker either), then a confirmed "dead" of this
        // lock and this port file (abandonedLocks), then ONE verdict for both questions.
        const failedAt = scanFailures.get(key);
        if (failedAt && Date.now() - failedAt < 30_000) continue;
        const target = profileLockTarget(dir);
        if (target !== null && abandonedLocks.get(key) === `${target}\n${mtime}`) continue;
        const u = await profileLockVerdict(dir);
        if (u.lock && !u.alive) { // crashed — do not ask, and do not ask docker again
          if (u.target !== null) abandonedLocks.set(key, `${u.target}\n${mtime}`);
          continue;
        }
        if (deadKey.get(key) === mtime && !u.alive) continue;
      }
      try {
        // Long abort timeout — short aborts can kill the accept loop of the (agent) Chromium permanently if they hit its boot/load phase
        // (see launchUserBrowser). Asked at the root's host; the answer points to it (Chromium builds it from the request's host). At an
        // instance without redirect, and the address is checked and pinned (wsUrlTheInstance).
        const v = await (await fetch(`http://${hostPort(host, port)}/json/version`, { signal: AbortSignal.timeout(10_000), ...(instance ? WITHOUT_FORWARDING : {}) })).json();
        if (!v.webSocketDebuggerUrl) throw new Error("no wsUrl");
        const cdp = new Cdp(instance ? wsUrlTheInstance(v.webSocketDebuggerUrl, host, port) : v.webSocketDebuggerUrl);
        await cdp.connect();
        const { label, workspaceId } = describeProfile(dirName) || {};
        const { chatId, agentId } = profileParts(dirName);
        const s = makeSession({
          id: crypto.randomUUID(), kind: "agent",
          label: label || dirName, workspaceId: workspaceId || "", scopeKey: key, profileDir: null, proc: null, cdp, debugPort: Number(port) || 0,
          debugHost: host, profile: dirName, chatId, agentId,
        });
        s.portMtime = mtime;
        sessions.set(s.id, s);
        wireTargets(s);
        await cdp.send("Target.setDiscoverTargets", { discover: true });
        // The already open tabs are there (targetCreated before the answer). From now on every new tab and every new address is the
        // agent's; the discovery itself too — an agent starts its browser to use it.
        s.discovered = true;
        s.activeAt = Date.now();
        s.agentTab = s.activeTargetId;
        notify();
      } catch { scanFailures.set(key, Date.now()); }
    }
    // Forget corpses whose file a new browser overwrote or whose profile is gone.
    for (const key of deadKey.keys()) if (!seen.has(key)) deadKey.delete(key);
    for (const key of abandonedLocks.keys()) if (!seen.has(key)) abandonedLocks.delete(key);
    for (const key of scanFailures.keys()) if (!seen.has(key)) scanFailures.delete(key);
  };
  // Never two passes at once: a fetch may hang up to 10 s, the beat is 3 s — two passes both saw the same port file as "still without a
  // session" and attached twice to the same browser (and two fetches in parallel against a booting Chromium are the pattern of the
  // accept-loop bug, see launchUserBrowser).
  let run = null;
  const tick = () => {
    if (!run) run = scanOnce().catch(() => { /* a pass must never take the server down */ }).finally(() => { run = null; });
    return run;
  };
  clearInterval(scanTimer);
  const timer = setInterval(tick, 3000);
  scanTimer = timer;
  timer.unref?.();
  tick();
  activeScan = {
    cycle: async () => { await run; return tick(); },
    stop: () => clearInterval(timer),
  };
  return activeScan;
}
/** Test seam: one whole pass of the most recently started scanner (the server's) instead of waiting for its beat. */
export const agentScanCycle = () => (activeScan ? activeScan.cycle() : Promise.resolve());

// ── API for the HTTP routes ──────────────────────────────────────────────────
export const getBrowser = (id) => { const s = sessions.get(id); return s && !s.closed ? s : null; };

// ── Capture primitives (screenshots/recordings of the agent browsers, see captures.js) ─────────────
// Find the agent browser of a Playwright profile (dirName "chat-<id>" or "chat-<id>-agent-<n>"). Exact segment comparison — a prefix
// match would confuse main and subagent browsers. If two sessions of the same profile are in the registry (the old one is dying, the
// new one already discovered), the NEWER wins — the registry is in discovery order.
export function findAgentBrowser(profileDirName) {
  let hits = null;
  for (const s of sessions.values()) {
    if (s.closed || s.kind !== "agent") continue;
    if (s.profile === profileDirName) hits = s;
  }
  return hits;
}

// The browser of a CHAT (scope `chat:<id>`): the main agent works in it (devtools/user-browser.js) — there is then no agent browser
// `chat-<id>`, and screenshot/recording (captures.js) must find this one instead.
export function findChatBrowser(chatId) {
  const key = `chat:${chatId}`;
  return [...sessions.values()].find((s) => s.kind === "user" && s.scopeKey === key && !s.closed) || null;
}

// Pick a tab: empty → active tab; number → 1-based index; otherwise a URL/title substring.
export function resolveTab(s, tabRef) {
  const ref = String(tabRef ?? "").trim();
  if (!ref) return s.tabs.get(s.activeTargetId) || [...s.tabs.values()][0] || null;
  const list = tabList(s);
  if (/^\d+$/.test(ref)) { const hit = list[Number(ref) - 1]; return hit ? s.tabs.get(hit.id) : null; }
  const low = ref.toLowerCase();
  const hit = list.find((t) => t.url.toLowerCase().includes(low) || t.title.toLowerCase().includes(low));
  return hit ? s.tabs.get(hit.id) : null;
}
export { tabList };

// Direct screenshot of a tab — independent of the screencast (pattern: initial frame in attachViewer).
export async function captureTabScreenshot(s, t) {
  await attachTab(s, t);
  const [shot, lm] = await Promise.all([
    s.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 80 }, t.sessionId),
    s.cdp.send("Page.getLayoutMetrics", {}, t.sessionId),
  ]);
  const vv = lm.cssVisualViewport || lm.visualViewport || {};
  return { data: shot.data, w: Math.round(vv.clientWidth || 0) || 1280, h: Math.round(vv.clientHeight || 0) || 800, url: t.url || "", title: t.title || "" };
}

// Frame source for recordings: keeps the screencast running independent of SSE viewers. getFrame returns the latest frame (base64
// JPEG, w/h in CSS pixels); onGone fires if the tab or browser dies during the recording. release() frees the screencast.
export async function acquireFrameSink(s, t, { onGone } = {}) {
  const token = { onGone };
  t.recorders.add(token);
  if (imageOf(t).stage !== "sharp") imageStage(s, t, { ...t.image, stage: "sharp", since: Date.now() }); // a recording is always sharp
  receiptNow(t); // and unthrottled (page beat)
  try {
    await startCast(s, t);
    // Static pages only deliver a frame on the next repaint — seed one directly.
    const first = await captureTabScreenshot(s, t);
    if (!t.lastFrame) t.lastFrame = { data: first.data, w: first.w, h: first.h };
  } catch (e) {
    t.recorders.delete(token);
    stopCastIfIdle(s, t);
    throw e;
  }
  return {
    getFrame: () => t.lastFrame || null,
    release: () => { t.recorders.delete(token); stopCastIfIdle(s, t); },
  };
}

// A viewer: credit (sent/acked/window), the waiting newest frame, the send times of the open frames (for the RTT measurement), the
// smallest RTT in one-second buckets, the cap of the congestion brake (during the start the slow-start cap) and the idle probe.
function newViewer(res) {
  return {
    res, vid: crypto.randomUUID(), sent: 0, acked: 0, pending: null,
    deadlineFrom: clock(), // the reset deadline runs from here: the last ack or the last send into an empty line (see sendFrame)
    window: ACK_WINDOW_MIN, minRtt: 0, cap: SLOW_START_START,
    attempt: true, limited: false, // slow start (see slowStartGrow): the cap starts small; limited = since the last ack a frame waited for credit
    sendTime: new Map(), // seq -> { time, before }: send time and the unacked frames ahead of it; deleted on ack — never more entries than the window
    rttEimer: [], // { sec, min } per second of the last RTT_WINDOW_S — the minimum is minRtt; empty sends only
    probe: false, probeDue: 0, // idle probe: due from this time; while it runs, frames hold until everything is acked
  };
}

// Record the RTT probe of an empty send: one bucket per second, old buckets drop out.
function rememberRtt(v, now, rtt) {
  const sec = Math.floor(now / 1000);
  const last = v.rttEimer[v.rttEimer.length - 1];
  if (last && last.sec === sec) last.min = Math.min(last.min, rtt);
  else v.rttEimer.push({ sec, min: rtt });
  while (v.rttEimer.length && v.rttEimer[0].sec < sec - RTT_WINDOW_S) v.rttEimer.shift();
  v.minRtt = Math.min(...v.rttEimer.map((e) => e.min));
}

// Congestion brake (see above): the cap from a probe that had frames in the line ahead of it. An empty send says nothing about the
// queue — it had none. During the start it also ends it (same threshold, ONE place); without congestion the cap grows there via
// slowStartGrow instead of by one.
function brake(v, e, rtt) {
  if (!e.before || !(v.minRtt > 0)) return;
  if (rtt > v.minRtt * CONGESTION_FACTOR) { v.cap = Math.max(ACK_WINDOW_MIN, Math.ceil((2 * (e.before + 1) * v.minRtt) / rtt)); v.attempt = false; }
  else if (!v.attempt) v.cap = Math.min(ACK_WINDOW_MAX, v.cap + 1);
}
// Slow start (see above): per acked frame the cap grows by SLOW_START_FACTOR − 1 — but only if a frame has waited for credit since
// the last ack (the window LIMITED; a static page never fills it, and growth without a probe would be the same transient, only
// later). The target is the formula over the smallest RTT; whoever reaches it leaves the start, and from then on the congestion
// brake applies.
function slowStartGrow(v, fresh) {
  if (!v.attempt || fresh <= 0) return;
  if (v.limited) v.cap = Math.min(ACK_WINDOW_MAX, v.cap + fresh * (SLOW_START_FACTOR - 1));
  v.limited = false;
  if (v.minRtt > 0 && v.cap >= ackWindow(v.minRtt)) v.attempt = false;
}
const windowCompute = (v) => { v.window = Math.min(ackWindow(v.minRtt), v.cap); };

// What a frame carries on the wire. The measuring points only for a viewer with `?measure=1`: tc = Chromium produced the image
// (metadata.timestamp), tr = B received it, tb = B writes it — milliseconds of the respective clock (Chromium and B share it, the
// client does not). Without measuring the frame stays as it was.
function frameData(t, v, frame) {
  const { time, jpeg, ...image } = frame;
  const d = { tab: t.targetId, seq: v.sent, ...image };
  if (v.measure) Object.assign(d, { tc: time?.tc || 0, tr: time?.tr || 0, tb: Date.now() });
  return d;
}

// Send a frame to a viewer — credit-controlled (see the adaptive window above).
function sendFrame(t, v, frame) {
  const now = clock();
  // Idle probe due: hold until the line is empty — otherwise the window applies.
  if (!v.probe && now >= v.probeDue) v.probe = true;
  if (v.probe ? v.sent > v.acked : v.sent - v.acked >= v.window) {
    if (!v.probe) v.limited = true; // the window holds this frame back — the start may grow with the next ack
    // Acks are missing → do not freeze, but throttle (the reset restarts the deadline). "Missing" means: no ack for ACK_RESET_MS
    // although something was open the whole time — the deadline runs from the last ack or the last send into an empty line
    // (deadlineFrom, see above). A deadline from the last ack alone is wrong: a static page delivers no frames, hence no acks, and
    // after every silence over ACK_RESET_MS the first full burst would reset the credit although nothing was overdue; the next
    // frame would then go out as an idle probe BEHIND the burst, measure queue plus base (1492 instead of 302 ms on the narrow
    // path), and the window would sit at the cap for ten seconds — exactly the queue the congestion brake is meant to prevent.
    // Not the age of the oldest open send either: that is a deadline per frame, not a sign-of-life deadline — in the start queue of
    // a narrow path (19 frames × 132 ms) a living client waits 2.5 s for single frames, and the reset would fire mid-burst.
    // The open send times go too: a late ack on them would not be an RTT of the path. The window falls back to the smallest: a grown
    // one would push up to 24 frames per reset at a client that acks nothing (measured: 96 in 10 s instead of 8). And the start
    // begins anew (as TCP after an RTO): cap SLOW_START_START, nothing has limited. Without it the first ack after the stall would
    // immediately open min(ackWindow(minRtt), cap) via windowCompute — the full steady-state window, on a path that may have
    // narrowed meanwhile: the very transient the start prevents at the beginning.
    if (now - v.deadlineFrom > ACK_RESET_MS) {
      v.acked = v.sent; v.deadlineFrom = now; v.sendTime.clear(); v.window = ACK_WINDOW_MIN;
      v.attempt = true; v.cap = SLOW_START_START; v.limited = false;
    }
    else { v.pending = frame; return; }
  }
  if (v.res.writableLength > MAX_BUFFERED) { v.pending = frame; return; }
  v.pending = null;
  const before = v.sent - v.acked;
  // Empty line: this send is the probe — and from now on the reset deadline runs (up to here nothing was open, a missing ack can
  // only be missing from this send on).
  if (!before) { v.probe = false; v.probeDue = now + RTT_WINDOW_S * 1000; v.deadlineFrom = now; }
  v.sent++;
  v.sendTime.set(v.sent, { time: now, before });
  try {
    // A viewer on the WebSocket (browser-wire.js) gets the JPEG bytes binary — decoded once per frame, not per viewer.
    if (v.res.binary) { const { data, ...header } = frameData(t, v, frame); v.res.sendFrame(header, (frame.jpeg ||= Buffer.from(data, "base64"))); }
    else v.res.write(`event: frame\ndata: ${JSON.stringify(frameData(t, v, frame))}\n\n`);
  } catch {}
}

// The client received frame <seq> — release credit, push the waiting (newest) frame after. The client folds acks together and only
// acks the newest seq: everything up to there is acked (acked = max). The RTT of this one seq is the probe for the congestion
// brake; for the smallest RTT the empty sends up to there count — a co-acked one gives an upper bound, harmless for a minimum.
export function ackFrame(vid, seq) {
  const reg = viewersById.get(String(vid || ""));
  if (!reg) return;
  const v = reg.v;
  const now = clock();
  seq = Math.min(seq | 0, v.sent); // there is nothing to ack above what was sent — unclamped, a false ack would defeat the window
  const own = v.sendTime.get(seq);
  for (const [s, e] of v.sendTime) { // insertion order = ascending
    if (s > seq) break;
    v.sendTime.delete(s);
    if (!e.before) rememberRtt(v, now, now - e.time);
  }
  if (own) brake(v, own, now - own.time);
  slowStartGrow(v, seq - v.acked);
  windowCompute(v);
  v.acked = Math.max(v.acked, seq);
  v.deadlineFrom = now;
  if (v.pending) sendFrame(reg.t, v, v.pending); // goes if credit is there — otherwise it keeps waiting
}

// Only for server/backend/test/runtime-write.test.js: saving the tab list on a session without Chromium (the line the timer calls in
// scheduleSaveTabs). No caller in the product.
export const _tabsSave = tabsSave;
// For the latch (agent-user-browser.test.js): what the idle deadline would do on expiry — without waiting 15 min.
export const _idleExpired = (id) => { const s = sessions.get(id); if (s && !s.closed && s.kind === "user" && !occupied(s)) destroySession(s, "idle"); };
// Likewise: preparing the profile folder before the start of a user browser, without Chromium.
export const _profilePrepare = profilePrepare;
// Only for server/backend/test/runtime-read.test.js: read the tab list as the start of a user browser does.
export const _tabsRead = tabsRead;

// Only for server/backend/test/browser-flow-control.test.js: the credit logic on a viewer without Chromium and without a session,
// with a set clock. No caller in the product — whoever needs one exports the function themselves instead of reaching through here.
export const _flow_control = {
  sendFrame,
  ackFrame,
  // withoutAttempt: the viewer starts as it did before slow start — cap at the top, no start. For comparing old against new on the
  // same path and for the tests that mean the steady state (credit, smallest RTT, reset), not the start.
  viewer(res, { withoutAttempt = false } = {}) {
    const t = { targetId: "test-tab", viewers: new Set() };
    const v = newViewer(res);
    if (withoutAttempt) { v.attempt = false; v.cap = ACK_WINDOW_MAX; }
    t.viewers.add(v);
    viewersById.set(v.vid, { v, t, s: null });
    return { v, t, remove: () => { t.viewers.delete(v); viewersById.delete(v.vid); } };
  },
  setClock(fn) { clock = fn || (() => Date.now()); },
};

// Attach an SSE viewer (res: headers already sent). Empty tabId → active tab. "gone" now only means: the session is gone — a living
// user browser without a tab gets one (the gone→ensure→gone loop, see saveTab).
export async function attachViewer(id, tabId, res, { measure = false } = {}) {
  const s = getBrowser(id);
  if (!s) { res.write("event: gone\ndata: {}\n\n"); res.end(); return; }
  const t = s.tabs.get(tabId) || s.tabs.get(s.activeTargetId) || [...s.tabs.values()][0] || await saveTab(s);
  if (!t) { res.write("event: gone\ndata: {}\n\n"); res.end(); return; }
  if (res.destroyed) return; // the viewer left during tab creation — do not register
  const v = newViewer(res);
  v.measure = Boolean(measure);
  t.viewers.add(v);
  viewersById.set(v.vid, { v, t, s });
  clearTimeout(s.idleTimer);
  res.write(`event: hello\ndata: ${JSON.stringify({ id: s.id, kind: s.kind, label: s.label, vid: v.vid, tab: t.targetId, tabs: tabList(s), agentTab: s.agentTab || "" })}\n\n`);
  if (t.lastFrame) sendFrame(t, v, t.lastFrame);
  res.on("close", () => { t.viewers.delete(v); viewersById.delete(v.vid); stopCastIfIdle(s, t); armIdle(s); });
  try {
    await startCast(s, t);
    // Force an initial frame: for fully static pages the screencast only delivers on the next repaint — a direct screenshot bridges
    // that reliably.
    const [shot, lm] = await Promise.all([
      s.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 80 }, t.sessionId),
      s.cdp.send("Page.getLayoutMetrics", {}, t.sessionId),
    ]);
    const vv = lm.cssVisualViewport || lm.visualViewport || {};
    // The size as for the screencast frames (metadata.deviceWidth = the set area): the visible viewport subtracts a scrollbar
    // (400 → 385 on a long page), so the first image reported a different size than every following one — the client mapped clicks
    // wrongly until the next frame. Without a set area as before.
    const vs = s.kind === "user" ? s.viewSize : null;
    const frame = vs && vs.width > 0
      ? { data: shot.data, w: Math.max(320, vs.width | 0), h: Math.max(240, vs.height | 0) }
      : { data: shot.data, w: Math.round(vv.clientWidth || 0) || 1280, h: Math.round(vv.clientHeight || 0) || 800 };
    t.lastFrame = t.lastFrame || frame;
    sendFrame(t, v, frame);
  } catch { /* tab perhaps just closed */ }
}

// Pass input (mouse/keyboard/text) on to a tab.
export async function dispatchInput(id, tabId, events) {
  const s = getBrowser(id);
  if (!s) return { ok: false };
  const t = s.tabs.get(tabId) || s.tabs.get(s.activeTargetId);
  if (!t) return { ok: false };
  const sid = await attachTab(s, t);
  // The human operates (rememberHuman): click, wheel, key, text — mere hovering and the acks do not count.
  if ((Array.isArray(events) ? events : []).some((e) => (e.t === "mouse" && e.type !== "mouseMoved") || e.t === "key" || e.t === "text")) rememberHuman(s);
  // Motion announces itself: an input puts the tab to fluid before it is delivered, so its first image already comes small.
  imageStage(s, t, stageAfterInput(imageOf(t), Date.now(), events, { recorder: t.recorders.size > 0 }));
  for (const e of Array.isArray(events) ? events : []) {
    try {
      if (e.t === "mouse") {
        await s.cdp.send("Input.dispatchMouseEvent", {
          type: e.type, x: Math.round(e.x || 0), y: Math.round(e.y || 0),
          button: e.button || "none", buttons: e.buttons | 0, clickCount: e.clickCount | 0,
          deltaX: e.deltaX || 0, deltaY: e.deltaY || 0, modifiers: e.modifiers | 0,
          pointerType: "mouse",
        }, sid);
      } else if (e.t === "key") {
        const down = e.type === "keyDown";
        await s.cdp.send("Input.dispatchKeyEvent", {
          type: down ? (e.text ? "keyDown" : "rawKeyDown") : "keyUp",
          key: e.key, code: e.code, text: down ? e.text || undefined : undefined,
          windowsVirtualKeyCode: e.winCode | 0, nativeVirtualKeyCode: e.winCode | 0,
          modifiers: e.modifiers | 0, autoRepeat: !!e.repeat,
        }, sid);
      } else if (e.t === "text" && e.text) {
        await s.cdp.send("Input.insertText", { text: String(e.text) }, sid);
      } else if (e.t === "ack") {
        // Frame ack of the viewer (flow control) — rides along on the input channel.
        ackFrame(e.v, e.seq);
      }
    } catch { /* discard a single event, deliver the rest */ }
  }
  // The page beat: AFTER delivery (Chromium has processed the input) the waiting screencast ack goes at once — the next image shows
  // the response without waiting for the beat; afterwards the beat applies again.
  if ((Array.isArray(events) ? events : []).some(humanInput)) receiptNow(t);
  return { ok: true };
}

// URL bar input → navigable URL. Careful: "localhost:5173" looks like a scheme ("localhost:") — host:port must be recognised BEFORE
// the scheme check.
export function normalizeNavUrl(input) {
  let u = String(input || "").trim();
  if (!u) return u;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(u)
    || /^(about|data|chrome|chrome-extension|devtools|file|view-source|blob|javascript|mailto):/i.test(u);
  if (hasScheme) return u;
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i.test(u);
  const hostPort = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+):\d+([/?#]|$)/i.test(u);
  if (/\s/.test(u) || (!u.includes(".") && !hostPort && !local)) {
    return `https://www.google.com/search?q=${encodeURIComponent(u)}`;
  }
  return `${local ? "http" : "https"}://${u}`;
}

// Browser actions (navigation, tabs, size).
export async function act(id, b = {}) {
  const s = getBrowser(id);
  if (!s) return { ok: false, error: T("Browser not found") };
  const t = s.tabs.get(b.tab) || s.tabs.get(s.activeTargetId);
  const need = async () => { if (!t) throw new Error(T("No tab")); return attachTab(s, t); };
  if (b.type !== "resize") rememberHuman(s); // address, tab choice, back … — the dimensions of the area are no operation
  try {
    switch (b.type) {
      case "navigate": {
        const sid = await need();
        const u = normalizeNavUrl(b.url);
        if (u) await s.cdp.send("Page.navigate", { url: u }, sid);
        return { ok: true };
      }
      case "back": case "forward": {
        const sid = await need();
        const h = await s.cdp.send("Page.getNavigationHistory", {}, sid);
        const idx = h.currentIndex + (b.type === "back" ? -1 : 1);
        if (h.entries[idx]) await s.cdp.send("Page.navigateToHistoryEntry", { entryId: h.entries[idx].id }, sid);
        return { ok: true };
      }
      case "reload": { const sid = await need(); await s.cdp.send("Page.reload", {}, sid); return { ok: true }; }
      case "stop": { const sid = await need(); await s.cdp.send("Page.stopLoading", {}, sid); return { ok: true }; }
      case "newTab": {
        const fresh = await newTab(s, b.url || "about:blank");
        return { ok: true, tab: fresh.targetId };
      }
      case "closeTab": {
        if (!t) return { ok: false };
        // Last tab of a user browser: create the replacement and activate it FIRST, THEN close — the client re-subscribes after
        // "tabclosed" and so finds a tab instead of "gone".
        if (s.kind === "user" && !s.tabOrder.some((x) => x !== t.targetId)) await fallbackTab(s);
        await s.cdp.send("Target.closeTarget", { targetId: t.targetId });
        return { ok: true };
      }
      case "selectTab": {
        if (!s.tabs.has(b.tab)) return { ok: false };
        s.activeTargetId = b.tab;
        s.cdp.send("Target.activateTarget", { targetId: b.tab }).catch(() => {});
        scheduleMeta(s);
        return { ok: true };
      }
      case "resize": {
        if (s.kind !== "user") return { ok: true }; // never touch the agent viewport (the agent's coordinates!)
        s.viewSize = { width: b.width | 0, height: b.height | 0, dpr: Number(b.dpr) || 1 };
        for (const tab of s.tabs.values()) if (tab.sessionId) {
          await applyMetrics(s, tab).catch(() => {});
          await restartCast(s, tab).catch(() => {}); // screencast dimensions follow the new size
        }
        return { ok: true };
      }
      default: return { ok: false, error: T("Unknown action") };
    }
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// ── Real Chrome DevTools ────────────────────────────────────────────────────
// Chromium serves its own DevTools frontend on the debug port (http://127.0.0.1:<port>/devtools/inspector.html). We proxy HTTP +
// WebSocket under /api/browsers/:id/devtools/* to it — so the client gets the REAL, version-matched DevTools (Elements/Console/
// Network/…) instead of a replica, and it works unchanged through the gateway (which splices the upgrade raw, as with the port
// tunnel). For a browser in a project container the files come from a Chromium in B, only the WebSocket from the container (below,
// "A browser in an INSTANCE").
// Two Chromium quirks are neutralised here:
//  • The HTTP handler demands an IP/localhost Host header (DNS-rebinding protection) → rewrite Host.
//  • Chromium rejects WebSockets WITH an Origin header without --remote-allow-origins → strip Origin.
// Injected into inspector.html: hides the screencast mirror view of the DevTools — the page is already visible in the browser pane,
// the drawer should show ONLY debug panels. Clicks the real "Toggle screencast" button (deep in the shadow DOM) once the frontend
// has booted; the button stays reachable for users who do want the mirror.
// It used to be an INLINE <script> behind the document — but inspector.html carries a meta CSP `script-src 'self'
// https://chrome-devtools-frontend.appspot.com` (no 'unsafe-inline', hash or nonce; read in Chromium 151 and 153), so the snippet
// sat in the DOM and never ran. Now a file of the SAME origin (`'self'` allows it, the iframe has the cbase origin), included
// relatively (resolves to …/devtools/cbase-screencast-off.js) and answered by cbase itself — BEFORE any forwarding, it goes neither
// to the Chromium in B nor to the container. And the script only clicks once the button is enabled (ScreencastApp creates it with
// `setEnabled(false)` and only enables it in `modelAdded`; `clicked` discards an earlier click), and only stops when the mirror is
// OFF (`toggled === false`) — an ineffective click is repeated on the next beat. The cap stays 100 × 300 ms.
const SCREENCAST_FROM_PATH = "/devtools/cbase-screencast-off.js";
const SCREENCAST_FROM_EMBED = `<script src="cbase-screencast-off.js"></script>`;
const SCREENCAST_FROM_SCRIPT = `(() => {
  let tries = 0;
  const finde = () => {
    let btn = null;
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (btn) return;
        if ((el.getAttribute && el.getAttribute("aria-label")) === "Toggle screencast") { btn = el; return; }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    try { walk(document); } catch (e) { /* boot not that far yet */ }
    return btn;
  };
  const frei = (btn) => btn.disabled !== true && !(btn.hasAttribute && btn.hasAttribute("disabled"));
  const iv = setInterval(() => {
    if (++tries > 100) return clearInterval(iv);
    const btn = finde();
    if (!btn) return;
    // Off (or no switch): done — also if a click of the previous beat only becomes visible now.
    if (btn.toggled !== true) return clearInterval(iv);
    if (!frei(btn)) return; // not enabled yet: a click would be lost
    btn.click();
    if (btn.toggled === false) clearInterval(iv);
  }, 300);
})();
`;
// The file itself: only GET/HEAD, as JavaScript with nosniff (the meta CSP admits it as a script, nosniff forbids any other reading),
// without cache binding to a version.
function screencastFromScript(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    try { res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": 0, "X-Content-Type-Options": "nosniff", Allow: "GET, HEAD" }); res.end(); } catch {}
    return;
  }
  const body = Buffer.from(SCREENCAST_FROM_SCRIPT);
  try {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch { /* client gone */ }
}

// A browser in an INSTANCE (debugHost ≠ B): its debug port belongs to the project container. No HTTP goes there any more — B
// delivers the interface (inspector.html, scripts, styles, images, localisation) from its own Chromium (projectbox/devtools-ui.js)
// if its version matches that of the browser (`Browser.getVersion` over the CDP line B holds anyway); otherwise B shows a notice,
// never a fallback to files of the container. Only the WebSocket /devtools/page|browser/<id> comes from the container (upgrade
// below), and its response head without the lines that set something at the user (runtime/response-header.js). Earlier, the
// container's files went into an unsandboxed iframe under the cbase origin: a process in the container thereby ran script as cbase
// (account, terminals in B) and set or deleted the session via Set-Cookie/Clear-Site-Data. Only an allowlist of the request head
// goes to the debug port (upgrade), the same to the source in B. A browser in B (HOST_B) gets head and files from its own Chromium
// as before.
const DEVTOOLS_HEADER_INSTANCE = /^(accept(-.*)?|if-none-match|range|user-agent)$/;
const allowlist = (req) => Object.fromEntries(Object.entries(req.headers || {}).filter(([k]) => DEVTOOLS_HEADER_INSTANCE.test(String(k).toLowerCase())));
// The WebSocket of an instance: only the two endpoints of the debug protocol (`/devtools/page/<target>`, `/devtools/browser/<id>`).
const DEVTOOLS_WS_INSTANCE = /^\/(page|browser)\/[A-Za-z0-9._-]{1,128}$/;
// Static files of the interface: under /devtools/, without `..` (the path comes normalised from the route — belt and braces).
const UI_PATH = /^\/devtools\/[^?#]*$/;
const VERSION_QUESTION_MS = 10_000; // CDP has no deadline of its own (estimated like the fetch of /json/version)

// The version of an instance's browser: ONCE per session over its CDP line (`Browser.getVersion`), remembered only if readable — a
// failure asks again on the next load.
function instanceRevision(s) {
  if (!s.uiRevision) {
    s.uiRevision = (async () => {
      let deadline = null;
      try {
        const v = await Promise.race([
          s.cdp.send("Browser.getVersion"),
          new Promise((_, no) => { deadline = setTimeout(() => no(new Error("timeout")), VERSION_QUESTION_MS); deadline.unref?.(); }),
        ]);
        return revision(v?.product, v?.revision);
      } catch { return null; } finally { clearTimeout(deadline); }
    })().then((f) => { if (!f) s.uiRevision = null; return f; });
  }
  return s.uiRevision;
}

/** Test seam and stop: the source of the interface in B (projectbox/devtools-ui.js). */
export { stopDevtoolsSource };

// Does an interface from B fit? `{ ok: true, port }` or `{ ok: false, reason, instance, b }` — `reason` "instance" (no readable
// version, the source is then not even started), "source" (no Chromium in B or its start failed), "version".
async function uiFor(s) {
  const inst = await instanceRevision(s);
  if (!inst) return { ok: false, reason: "instance", instance: "", b: "" };
  const q = await devtoolsSource(resolveChromium);
  if (!q) return { ok: false, reason: "source", instance: inst.number, b: "" };
  if (!revisionsMatch(q.revision, inst)) return { ok: false, reason: "version", instance: inst.number, b: q.revision.number };
  return { ok: true, port: q.port };
}

const asHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// The notice "no matching interface": ONE page from B, without script (CSP), with the marker `meta[name=cbase-devtools]` by which the
// web UI recognises it and shows it in its language and form (web/src/components/BrowserPane.tsx DevtoolsFrame). For any other file
// the same sentence as text. Status 409.
function noUi(res, filePath, u) {
  const title = T("cbase has no matching DevTools interface for this browser.");
  const reason = u.reason === "version"
    ? T`The browser in the project container is Chromium ${u.instance}; cbase ships the interface of Chromium ${u.b}. It will match again once the project container has been recreated with the current image.`
    : u.reason === "source"
      ? T("cbase could not start its own Chromium, which supplies the interface.")
      : T("The browser in the project container does not report a readable version.");
  const fence = T("cbase never loads the interface from the project container, only its data stream.");
  const asPage = /\.html?$/i.test(filePath);
  const body = asPage
    ? `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">`
      + `<meta name="cbase-devtools" content="no-ui" data-reason="${asHtml(u.reason)}" data-instance="${asHtml(u.instance)}" data-b="${asHtml(u.b)}">`
      + `<title>DevTools</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:13px/1.5 system-ui,-apple-system,sans-serif;background:#fff;color:#1f1f1f}`
      + `@media (prefers-color-scheme:dark){body{background:#181818;color:#f3f3f3}}main{max-width:440px;padding:16px}p{margin:0 0 8px}.dim{opacity:.7}</style></head>`
      + `<body><main><p><strong>${asHtml(title)}</strong></p><p>${asHtml(reason)}</p><p class="dim">${asHtml(fence)}</p></main></body></html>`
    : `${title} ${reason}`;
  try {
    res.writeHead(409, {
      "Content-Type": asPage ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      ...(asPage ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } : {}),
    });
    res.end(body);
  } catch { /* client gone */ }
}

// Fetch a file of the interface from a Chromium and deliver it — for a session in B from its own, for an instance from the source in
// B (`instance`: then without the forbidden header lines, with nosniff, and a deadline restarts the source).
function passOn({ host, port, req, res, subPath, header, instance }) {
  const isInspectorHtml = /^\/devtools\/inspector\.html/.test(subPath);
  // Target and Host header: 127.0.0.1 or an IP — never a name (Chromium rejects every host that is not an IP and not localhost).
  const fwdHeaders = { ...header, host: hostPort(host, port) };
  if (isInspectorHtml) delete fwdHeaders["accept-encoding"]; // request uncompressed → injection stays trivial
  const up = http.request({ host, port, path: subPath, method: req.method, headers: fwdHeaders }, (ur) => {
    let h = { ...ur.headers };
    delete h["x-frame-options"]; // the frontend runs in an iframe with us (drawer)
    if (instance) { h = withoutForbiddenHeaders(h); h["x-content-type-options"] = "nosniff"; }
    if (isInspectorHtml && (ur.statusCode || 200) === 200 && req.method !== "HEAD") {
      const chunks = [];
      ur.on("data", (c) => chunks.push(c));
      ur.on("end", () => {
        const body = Buffer.concat([...chunks, Buffer.from(SCREENCAST_FROM_EMBED)]);
        delete h["transfer-encoding"];
        h["content-length"] = body.length;
        try { res.writeHead(200, h); res.end(body); } catch { /* client gone */ }
      });
      ur.on("error", () => { try { res.writeHead(502); res.end(); } catch {} });
      return;
    }
    res.writeHead(ur.statusCode || 502, h);
    ur.pipe(res);
  });
  // Chromium's debug HTTP handler can get stuck (observed; WS keeps running then). Without a timeout such requests would hang forever
  // and bind sockets → 504 after 15 s, the frontend then shows the restart notice. The source in B restarts afterwards.
  up.setTimeout(15_000, () => { if (instance) stopDevtoolsSource(); up.destroy(new Error("timeout")); });
  up.on("error", () => { try { res.writeHead(504); res.end(); } catch {} });
  req.pipe(up);
}

export function proxyDevtools(id, req, res, subPath) {
  const s = getBrowser(id);
  if (!s || !s.debugPort) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: T("Browser not found") })); return; }
  // The script that inspector.html includes is answered by cbase itself — the same for B and every instance.
  if (String(subPath).split("?")[0] === SCREENCAST_FROM_PATH) return screencastFromScript(req, res);
  // In B as before: head and files from its own Chromium.
  if (s.debugHost === HOST_B) return passOn({ host: s.debugHost, port: s.debugPort, req, res, subPath, header: { ...req.headers }, instance: false });
  return uiFromB(s, req, res, subPath);
}

// An instance session: the file from the source in B or the notice — its debug port gets no HTTP request.
async function uiFromB(s, req, res, subPath) {
  const filePath = String(subPath).split("?")[0];
  const no = (status) => {
    try { res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": 0, "X-Content-Type-Options": "nosniff", ...(status === 405 ? { Allow: "GET, HEAD" } : {}) }); res.end(); } catch {}
  };
  if (req.method !== "GET" && req.method !== "HEAD") return no(405);
  if (!UI_PATH.test(filePath) || filePath.split("/").includes("..")) return no(404);
  let u;
  try { u = await uiFor(s); } catch { u = { ok: false, reason: "source", instance: "", b: "" }; }
  if (!u.ok) return noUi(res, filePath, u);
  passOn({ host: HOST_B, port: u.port, req, res, subPath, header: allowlist(req), instance: true });
}

// The division of the upgrade ways stands ONCE in runtime/upgrade-way.js.
function upgradeDeny(socket, verdict) {
  const text = verdict.status === 401 ? "Unauthorized" : verdict.status === 400 ? "Bad Request" : "Forbidden";
  const body = JSON.stringify({ error: verdict.reason || text });
  try { socket.write(`HTTP/1.1 ${verdict.status} ${text}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`); } catch {}
  try { socket.destroy(); } catch {}
}

// ── The WebSocket wire (browser-wire.js) ──
// Frames binary, events and inputs as text, ONE socket. Inputs run one after the other per socket (mouseReleased would otherwise
// overtake mousePressed — the rule the client used to keep with "one POST in flight"); acks go at once, past the beat. Whoever sends
// too much loses inputs above INPUTS_OPEN_MAX (acks never).
const streamServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
export const INPUTS_OPEN_MAX = 256;
function streamAccept(req, socket, head) {
  const m = String(req.url || "").match(STREAM_UPGRADE);
  if (!m || !getBrowser(m[1])) { try { socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); socket.destroy(); } catch {} return; }
  const id = m[1];
  let query;
  try { query = new URL(req.url, "http://x").searchParams; } catch { query = new URLSearchParams(); }
  streamServer.handleUpgrade(req, socket, head, (ws) => {
    try { socket.setNoDelay?.(true); } catch { /* ignore */ }
    // One delivery at a time; what arrives meanwhile waits folded (foldInputs) in the next bundle of the same tab.
    const wait = [];
    let running = false;
    const further = async () => {
      if (running) return;
      running = true;
      while (wait.length) { const b = wait.shift(); try { await dispatchInput(id, b.tab, b.events); } catch { /* go on */ } }
      running = false;
    };
    ws.on("message", (raw, binary) => {
      if (binary) return;
      const e = readInput(raw);
      if (!e) return;
      for (const q of e.events) if (q && q.t === "ack") ackFrame(q.v, q.seq); // acks at once, past the beat
      const rest = e.events.filter((q) => q && q.t !== "ack");
      if (!rest.length) return;
      let b = wait[wait.length - 1];
      if (!b || b.tab !== e.tab) wait.push((b = { tab: e.tab, events: [] }));
      for (const q of rest) if (wait.reduce((n, x) => n + x.events.length, 0) < INPUTS_OPEN_MAX) foldInputs(b.events, q);
      void further();
    });
    ws.on("error", () => { /* close follows */ });
    void attachViewer(id, query.get("tab") || "", viewerFromWs(ws), { measure: query.get("measure") === "1" });
  });
}

// `opts.fence` (project container, projectbox/fence.js): from a project network only browsers of the own project (401 without token,
// 403 foreign). Without the operating marker the verdict is "as before".
export function attachBrowserDevtools(server, { fence = null } = {}) {
  server.on("upgrade", (req, socket, head) => {
    if (socket.destroyed) return; // another upgrade way (tunnel.js) has already rejected it
    const way = upgradeWay(req.url);
    if (way === "tunnel") return; // /api/tunnel belongs to tunnel.js
    const verdict = fence ? fence(req) : null;
    if (verdict && !verdict.ok) { upgradeDeny(socket, verdict); return; }
    // Everything except tunnel and DevTools is an unknown upgrade → end it. Before, a path starting with "/api/tunnel" (`/api/tunnelx`,
    // `/api/tunnel/../a`) let BOTH ways return, and the socket hung open.
    if (way === "stream") { streamAccept(req, socket, head); return; }
    if (way !== "devtools") { try { socket.destroy(); } catch {} return; }
    const m = (req.url || "").match(DEVTOOLS_UPGRADE);
    const s = getBrowser(m[1]);
    if (!s || !s.debugPort) { try { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); } catch {} return; }
    // An instance: only the two WebSocket endpoints of the debug protocol — any other path would remain an HTTP request to the
    // container whose response B would pass on to the user.
    const instance = s.debugHost !== HOST_B;
    if (instance && !DEVTOOLS_WS_INSTANCE.test(m[2])) { try { socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); socket.destroy(); } catch {} return; }
    // To the session's debug host, Host header its IP:port; the Origin is dropped (Chromium: 403 with Origin) — only AFTER the gate
    // above (`opts.fence` = server.js upgrade gate): in the local server a foreign Origin or host name is already rejected there with
    // 403. Before, the proxy stripped it unchecked, and every web page got the browser's debug protocol.
    const up = net.connect({ host: s.debugHost, port: s.debugPort }, () => {
      // To an instance only the allowlist including the handshake head; in B as before.
      const h = { ...(!instance ? req.headers : Object.fromEntries(Object.entries(req.headers || {})
        .filter(([k]) => DEVTOOLS_HEADER_INSTANCE.test(String(k).toLowerCase()) || /^(upgrade|connection|sec-websocket-.*)$/i.test(k)))), host: hostPort(s.debugHost, s.debugPort) };
      delete h.origin; delete h.cookie;
      const lines = [`GET /devtools${m[2]} HTTP/1.1`];
      for (const [k, v] of Object.entries(h)) for (const vv of (Array.isArray(v) ? v : [v])) lines.push(`${k}: ${vv}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) up.write(head);
      socket.pipe(up);
      // The response of an instance (101 or an error) without the header lines that set something at the user — a browser accepts
      // cookies from the handshake too (runtime/response-header.js). In B as before.
      if (instance) passThroughUpgradeResponse(up, socket);
      else up.pipe(socket);
    });
    up.setNoDelay(true);
    socket.setNoDelay?.(true);
    socket.setTimeout?.(0);
    // Secure only the handshake phase — afterwards the WS connection may live as long as it likes.
    up.setTimeout(15_000, () => { if (!up.bytesRead) { try { socket.write("HTTP/1.1 504 Gateway Timeout\r\n\r\n"); } catch {} up.destroy(); } });
    up.on("data", () => up.setTimeout(0));
    const teardown = () => { try { up.destroy(); } catch {} try { socket.destroy(); } catch {} };
    up.on("error", () => { try { socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {} teardown(); });
    up.on("close", teardown);
    socket.on("error", teardown);
    socket.on("close", teardown);
  });
}

export function closeBrowser(id) {
  const s = getBrowser(id);
  if (!s) return false;
  if (s.kind !== "user") return false; // agent browsers belong to the run — do not end them from outside
  destroySession(s, "closed");
  return true;
}
/**
 * The end of the server run (server.js: hook "serverEnd" and `server.close`): every own browser ends — gently (Browser.close, the
 * logins mirrored back), its whole process group, hard after the grace. → promise, fulfilled when all are gone (at most
 * END_DEADLINE_MS each). Never throws.
 */
export async function closeAllUserBrowsers() {
  await Promise.all([...ensureLocks.values()].map((p) => p.catch(() => {})));
  const own = [...sessions.values()].filter((s) => s.kind === "user" && !s.closed);
  for (const s of own) destroySession(s, "server-end");
  await Promise.all(own.map(async (s) => {
    await withDeadline(s.end, END_DEADLINE_MS);
    if (s.proc) await withDeadline(endGroup(s.proc, { graceMs: 1_000 }), END_DEADLINE_MS);
  }));
  return own.length;
}
// Safety net: do not orphan Chromium children when the process ends hard — every own group gets KILL (browser-process.js holds
// the same net for the groups; here the docker children of instance browsers).
process.on("exit", () => {
  killAllBrowserGroups();
  for (const s of sessions.values()) { if (s.proc && !s.proc.cbaseGroup) { try { s.proc.kill(); } catch {} } }
  devtoolsSourceEndImmediately();
});

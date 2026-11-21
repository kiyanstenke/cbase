// Captures of the agent browsers: screenshots and screen recordings (MP4 via ffmpeg). What an agent of the chat captures (the
// main agent, profileKey = chat id, or a subagent `<chat>-agent-<id>`, also a workflow agent) carries the `show` flag and appears by
// itself as a card at the chat's next turn end (chats/captures-show.js, hook on "beforeRunBroadcast"). A subagent that
// outlives the turn reports back with a completion notice; its turn end shows its captures, so none is lost. To check its own
// work the agent uses browser_take_screenshot (Playwright), which never reaches this folder.
// Stored under <attachments>/<chatId>/captures/<captureId>/, deliberately NOT in the artifact store (10 MiB cap, no video
// MIME); deleting the chat removes the attachment folder anyway.
// The browser access is injectable (initCaptures({browser})) so ticker/manifest/ffmpeg can be tested without a real Chromium.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as browsersDefault from "./browsers.js";
import {
  removeInRuntimeFolder, copyInRuntimeFolder, createFolderInRuntimeFolder, readFromRuntimeFolder, openFromRuntimeFolder,
  writeInRuntimeFolder,
} from "./runs/runtime-write.js";

// A chat's attachment folder: `attachmentsOf(chatId)` (set from server.js; the folder lies in the project's runtime folder if the
// project is relocated; runs/runtime-location.js), otherwise `<attachmentsDir>/<id>` (the tests). This leaf does not know the store.
//
// IN THE RUNTIME FOLDER the attachment folder is mounted rw in the project container; a link it creates (`captures -> <B folder>`,
// `captures/<cid>/manifest.json -> <B file>`, `.../video.mp4 -> <B file>`; a capture's folder exists from its start, ffmpeg writes
// with `-y`) would divert manifest, poster, frames and video outside. So B writes there through runs/runtime-write.js (descriptor,
// no link), deletes through pinned folders, and frames plus ffmpeg run in a temp folder of B's own; only poster and video go into
// the runtime folder, copied through the descriptor. Otherwise (flat, the tests) as before.
//
// READING THERE: the same links would divert the readers: `manifest.json -> <B file>` was read by B as a manifest,
// `poster.jpg -> ~/.claude-login/.credentials.json` made the file route serve that file, a FIFO stalled B. And the manifest itself
// decided where to write and delete: `markSent` wrote to `m.chatId`/`m.id`, `prune` deleted `capDir(chat, m.id)`; with
// `"id": "../../../../../../home/agent/..."` the place lay outside any runtime folder, the helpers answered `false`, and the
// flat path wrote or deleted (rm -r) in B. So in the runtime folder: the manifest is read through the descriptor
// (runs/runtime-write.js readFromRuntimeFolder; readdirSync still lists the names, every entry goes through readManifest), and a
// manifest only counts if its `id` and `chatId` are exactly the ones it lies under; the file route serves through the opened
// descriptor (`captureFile`, runtime/http.js serveRanged with `fd`). A link, a FIFO or a foreign manifest means "does not exist".
// Flat as before. `doFinalize` ends the capture even if its manifest cannot be written (otherwise it stayed in `active` and every
// further capture of this profile ended with 409).
let attachmentsDir = null;
let attachmentsOf = null;
let browser = browsersDefault;
export function initCaptures(opts = {}) {
  if (opts.attachmentsDir) { attachmentsDir = opts.attachmentsDir; attachmentsOf = null; }
  if (typeof opts.attachmentsOf === "function") attachmentsOf = opts.attachmentsOf;
  if (opts.browser) browser = opts.browser;
}

const httpError = (status, message) => Object.assign(new Error(message), { status });
const NO_BROWSER_MSG = "No browser of this chat is active. First open a page with Playwright (directly after opening, wait a few seconds until the connection is up).";

// Caps: rate and length bound frames (= disk) and ffmpeg runtime.
const FPS_MIN = 1, FPS_MAX = 8, FPS_DEFAULT = 4;
const SECONDS_MAX = 300, SECONDS_DEFAULT = 120;
const MAX_CONCURRENT = 3;      // recordings per process
const MAX_PER_CHAT = 20;       // captures per chat (unsent ones are pruned, those still to be shown last)
const CAPTION_MAX = 2000;
// Encoding deadline: a 5 min capture at 8 frames/s tore the fixed 60 s deadline on the 2-core server and the video was missing.
// Now a 60 s base + 100 ms per frame, at most 10 min; plus preset veryfast (screen content: hardly any difference, several times faster).
export const ffmpegDeadline = (frames) => Math.min(600_000, 60_000 + Math.max(0, frames | 0) * 100);
const FILE_WHITELIST = new Set(["poster.jpg", "video.mp4"]);

// ── Find ffmpeg ───────────────────────────────────────────────────────────────
// CBASE_FFMPEG wins (uncached; tests switch it); otherwise a PATH probe + absolute candidates, because GUI apps start with a
// minimal PATH (same trap as NPX_BIN).
let ffmpegCache; // undefined = not searched yet, null = not found
export function resolveFfmpeg() {
  const env = process.env.CBASE_FFMPEG;
  if (env) return fs.existsSync(env) ? env : null;
  if (ffmpegCache !== undefined) return ffmpegCache;
  const cands = [];
  try {
    const r = spawnSync("which", ["ffmpeg"], { encoding: "utf8" });
    if (r.status === 0) cands.push(String(r.stdout).trim().split("\n")[0]);
  } catch { /* which is missing: the candidates suffice */ }
  cands.push("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg");
  ffmpegCache = cands.find((c) => c && fs.existsSync(c)) || null;
  return ffmpegCache;
}
export const FFMPEG_MISSING_MSG = "ffmpeg not found. Set CBASE_FFMPEG to the binary path or install it (macOS: `brew install ffmpeg`; the container image ships it). Screenshots also work without ffmpeg.";

// ── Storage & manifests ───────────────────────────────────────────────────────
const CID_RE = /^c-[0-9a-f-]{8,64}$/;
const chatDir = (chatId) => path.join(attachmentsOf ? attachmentsOf(String(chatId)) : path.join(attachmentsDir, String(chatId)), "captures");
const capDir = (chatId, cid) => path.join(chatDir(chatId), cid);
const manifestPath = (chatId, cid) => path.join(capDir(chatId, cid), "manifest.json");

// A manifest is a few hundred bytes; in the runtime folder at most 1 MB: a sparse file there would otherwise make B read it whole on
// every list. In B as before.
export const MANIFEST_MAX = 1024 * 1024;
function readManifest(chatId, cid) {
  try {
    const p = manifestPath(chatId, cid);
    const text = readFromRuntimeFolder(p, "utf8", { maxBytes: MANIFEST_MAX }); // larger => too large => does not exist
    if (text === null) return JSON.parse(fs.readFileSync(p, "utf8"));
    // In the runtime folder (see top): only a manifest that belongs to its place; otherwise it would decide itself where B writes and deletes.
    const m = JSON.parse(text);
    return m && typeof m === "object" && m.id === String(cid) && String(m.chatId) === String(chatId) ? m : null;
  } catch { return null; }
}
function writeManifest(m) {
  const p = manifestPath(m.chatId, m.id);
  const json = JSON.stringify(m, null, 2);
  if (!writeInRuntimeFolder(p, json)) fs.writeFileSync(p, json);
}

export function listCaptures(chatId) {
  let names = [];
  try { names = fs.readdirSync(chatDir(chatId)); } catch { return []; }
  const out = [];
  // Folders without a manifest are running captures: do not list, never prune.
  for (const n of names) { if (CID_RE.test(n)) { const m = readManifest(chatId, n); if (m) out.push(m); } }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
export const getCapture = (chatId, cid) => (CID_RE.test(String(cid)) ? readManifest(chatId, cid) : null);

export function captureFilePath(chatId, cid, name) {
  if (!CID_RE.test(String(cid)) || !FILE_WHITELIST.has(String(name))) return null;
  const f = path.join(capDir(chatId, cid), name);
  return fs.existsSync(f) ? f : null;
}

/** A capture's file for the file route -> `{ path, fd }` (`fd` in the runtime folder, opened without a link; the caller serves
 *  through it and closes it; otherwise `null`, and it reads the path as before) or `null` (does not exist). */
export function captureFile(chatId, cid, name) {
  if (!CID_RE.test(String(cid)) || !FILE_WHITELIST.has(String(name))) return null;
  const f = path.join(capDir(chatId, cid), name);
  let fd;
  try { fd = openFromRuntimeFolder(f); } catch { return null; } // a link, a FIFO, missing: does not exist (see top)
  if (fd !== null) return { path: f, fd };
  return fs.existsSync(f) ? { path: f, fd: null } : null;
}

// Mark as sent (once per capture, 409 the second time; "never shown twice" rests on it). Without `caption` the manifest's
// caption stays (the agent gave it when capturing).
export function markSent(chatId, cid, caption) {
  const m = getCapture(chatId, cid);
  if (!m) throw httpError(404, `Unknown capture: ${cid}`);
  if (m.sent) throw httpError(409, "This capture has already been sent to the user.");
  m.sent = true;
  if (caption !== undefined) m.caption = String(caption || "").slice(0, CAPTION_MAX);
  writeManifest(m);
  return m;
}

/** A chat's captures still to be shown in capture order (oldest first): `show` flag, not sent, and showable (a screenshot always,
 *  a recording only with video; a failed one stays, its error was in the tool result). Captures without the flag (from before the
 *  flag existed, which the user never saw and should not suddenly see) never appear. */
export function toShow(chatId) {
  return listCaptures(chatId)
    .filter((m) => m.show === true && !m.sent && (m.kind === "screenshot" || (m.kind === "recording" && m.video)))
    .sort((a, b) => a.createdAt - b.createdAt);
}

// The caption the agent gives when capturing (cbase_screenshot) or stopping (cbase_recording_stop); it appears under the card the
// turn end shows. Empty = none; a sent capture keeps its own.
// `show: false` (skill review-video: "only clips with usable control frames"): at stop the agent sees the control frames and holds
// back a failed clip; it stays in the folder and never appears. An already sent one stays as it is.
function label(chatId, cid, caption, show) {
  const text = String(caption || "").trim().slice(0, CAPTION_MAX);
  if (!text && show !== false) return null;
  const m = getCapture(chatId, cid);
  if (!m || m.sent) return m;
  if (text) m.caption = text;
  if (show === false) m.show = false;
  writeManifest(m);
  return m;
}

// Dispose of the oldest UNSENT captures once the cap is exceeded; sent ones are referenced by a chat row and stay.
function prune(chatId) {
  const all = listCaptures(chatId);
  if (all.length <= MAX_PER_CHAT) return;
  // Those still to be shown (`show` flag) last: otherwise old, never shown captures would eat nothing and the new ones would be lost
  // before the turn end.
  const removable = all.filter((m) => !m.sent).sort((a, b) => (a.show === true) - (b.show === true) || a.createdAt - b.createdAt);
  for (const m of removable.slice(0, all.length - MAX_PER_CHAT)) {
    try { if (!removeInRuntimeFolder(capDir(chatId, m.id))) fs.rmSync(capDir(chatId, m.id), { recursive: true, force: true }); } catch {}
  }
}

// ── Resolve browser ───────────────────────────────────────────────────────────
// profileKey = chatId (main agent) or "<chatId>-agent-<n>" (subagent); the profile folder is "chat-<profileKey>", exactly how
// browsers.js finds the session again.
// The main agent (profileKey = chatId, without "-agent-") works in the chat's browser; that is then its target if no agent browser
// of its own is running (with a workflow step there is the agent browser, and it wins as before).
function resolveTarget(profileKey, tabRef) {
  const key = String(profileKey);
  const s = browser.findAgentBrowser(`chat-${key}`) || (key.includes("-agent-") ? null : browser.findChatBrowser?.(key) || null);
  if (!s) throw httpError(409, NO_BROWSER_MSG);
  const t = browser.resolveTab(s, tabRef);
  if (!t) {
    const tabs = browser.tabList(s).map((x, i) => `${i + 1}: ${x.title || x.url}`).join(" · ");
    throw httpError(404, `Tab not found. Open tabs: ${tabs || "none"}`);
  }
  return { s, t };
}

// ── Screenshot ────────────────────────────────────────────────────────────────
// `show`: main agent (profileKey = chat id) and subagents of the chat (`<chat>-agent-<id>`), the two keys the route accepts
// (chats/routes.js captureKeyOf). Any other key (no way today) does not show.
// A capture's time is strictly increasing (within the process): the turn end shows in capture order, and two screenshots in the
// same millisecond would otherwise get the directory's order.
let lastTime = 0;
const captureTime = () => (lastTime = Math.max(Date.now(), lastTime + 1));
const showsTheChat = (chatId, profileKey) => String(profileKey) === String(chatId) || String(profileKey).startsWith(`${chatId}-agent-`);

export async function takeScreenshot({ chatId, profileKey, tab, caption, show }) {
  const { s, t } = resolveTarget(profileKey, tab);
  const shot = await browser.captureTabScreenshot(s, t);
  const id = `c-${crypto.randomUUID()}`;
  const dir = capDir(chatId, id);
  if (!createFolderInRuntimeFolder(dir)) fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.from(shot.data, "base64");
  if (!writeInRuntimeFolder(path.join(dir, "poster.jpg"), buf)) fs.writeFileSync(path.join(dir, "poster.jpg"), buf);
  const capture = {
    id, chatId, kind: "screenshot", createdAt: captureTime(), profileKey,
    url: shot.url, title: shot.title, w: shot.w, h: shot.h,
    poster: "poster.jpg", video: null, fps: 0, frames: 1, durationMs: 0,
    bytes: buf.length, autoStopped: false, sent: false, caption: String(caption || "").trim().slice(0, CAPTION_MAX),
    show: show !== false && showsTheChat(chatId, profileKey), // `show: false` (tool): stays in the folder, never in the chat
  };
  writeManifest(capture);
  prune(chatId);
  return { capture, data: shot.data };
}

// ── Recording ─────────────────────────────────────────────────────────────────
const active = new Map();   // profileKey -> rec
const finished = new Map(); // profileKey -> { capture, samples } (auto-stop, until stop collects it)

// JPEG dimensions from the SOF marker: the frames come in device pixels, the manifest's w/h in CSS pixels; for the scale/pad target we
// need the real pixels of the first frame.
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + (buf.readUInt16BE(i + 2) || 0);
  }
  return null;
}

export async function startRecording({ chatId, profileKey, tab, fps, maxSeconds }) {
  if (active.has(profileKey)) throw httpError(409, `A recording is already running (${active.get(profileKey).id}). First cbase_recording_stop.`);
  if (active.size >= MAX_CONCURRENT) throw httpError(409, `Too many concurrent recordings (max ${MAX_CONCURRENT}).`);
  if (!resolveFfmpeg()) throw httpError(424, FFMPEG_MISSING_MSG);
  fps = Math.min(FPS_MAX, Math.max(FPS_MIN, Number(fps) || FPS_DEFAULT));
  maxSeconds = Math.min(SECONDS_MAX, Math.max(1, Number(maxSeconds) || SECONDS_DEFAULT));
  const { s, t } = resolveTarget(profileKey, tab);

  const id = `c-${crypto.randomUUID()}`;
  const dir = capDir(chatId, id);
  // In the runtime folder (see top) only the capture's folder is created there (without manifest = still running); frames and ffmpeg
  // work in a temp folder of B's own (`own`) that the container does not see.
  let framesDir = path.join(dir, "frames");
  const own = createFolderInRuntimeFolder(dir);
  if (own) framesDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-capture-"));
  else fs.mkdirSync(framesDir, { recursive: true });
  const rec = {
    id, chatId, profileKey, fps, maxSeconds, framesDir, dir, own,
    frames: 0, startedAt: captureTime(), url: t.url || "", title: t.title || "",
    w: 0, h: 0, timer: null, sink: null, done: null, autoStopped: false, gone: false,
  };
  rec.sink = await browser.acquireFrameSink(s, t, {
    onGone: () => { rec.gone = true; void finalize(rec); },
  });

  const tick = () => {
    if (rec.done) return;
    const f = rec.sink.getFrame();
    if (!f) return;
    rec.frames++;
    if (rec.frames === 1) { rec.w = f.w; rec.h = f.h; }
    try {
      fs.writeFileSync(path.join(framesDir, `f-${String(rec.frames).padStart(5, "0")}.jpg`), Buffer.from(f.data, "base64"));
    } catch { rec.frames--; return; }
    if (rec.frames >= rec.fps * rec.maxSeconds) { rec.autoStopped = true; void finalize(rec); }
  };
  tick(); // frame 1 at once: a stop before the first interval tick must never come back empty
  rec.timer = setInterval(tick, Math.round(1000 / fps));
  rec.timer.unref?.();
  active.set(profileKey, rec);
  return { captureId: id, startedAt: rec.startedAt, fps, maxSeconds };
}

async function runFfmpeg(rec, videoPath) {
  const first = fs.readFileSync(path.join(rec.framesDir, "f-00001.jpg"));
  const size = jpegSize(first) || { w: 1280, h: 720 };
  const W = Math.max(2, size.w - (size.w % 2)), H = Math.max(2, size.h - (size.h % 2));
  const args = [
    "-y", "-framerate", String(rec.fps), "-i", path.join(rec.framesDir, "f-%05d.jpg"),
    // Navigation can change the frame size mid-recording; normalize everything to the (even) size of the first frame, otherwise
    // the encode aborts.
    "-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", videoPath,
  ];
  await new Promise((resolve, reject) => {
    const p = spawn(resolveFfmpeg(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (c) => { err = (err + c).slice(-2000); });
    const to = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, ffmpegDeadline(rec.frames));
    to.unref?.();
    p.on("error", (e) => { clearTimeout(to); reject(e); });
    p.on("close", (code) => { clearTimeout(to); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.split("\n").slice(-3).join(" ")}`)); });
  });
}

// Memoized: auto-stop, tab death and a concurrent stop share ONE finalization.
function finalize(rec) {
  if (!rec.done) rec.done = doFinalize(rec);
  return rec.done;
}

async function doFinalize(rec) {
  clearInterval(rec.timer);
  try { rec.sink.release(); } catch {}

  const capture = {
    id: rec.id, chatId: rec.chatId, kind: "recording", createdAt: rec.startedAt, profileKey: rec.profileKey,
    url: rec.url, title: rec.title, w: rec.w, h: rec.h,
    poster: "poster.jpg", video: null, fps: rec.fps, frames: rec.frames,
    durationMs: Math.round((rec.frames / rec.fps) * 1000), bytes: 0,
    autoStopped: rec.autoStopped, aborted: rec.gone, sent: false, caption: "",
    show: !rec.notShow && showsTheChat(rec.chatId, rec.profileKey), // set before the manifest (stopRecording): no window
  };
  const samples = [];
  try {
    if (!rec.frames) throw new Error("No frames captured.");
    // Secure control frames for the model BEFORE cleaning up (up to 4, evenly spread).
    const idxs = [...new Set([1, Math.ceil(rec.frames / 3), Math.ceil((2 * rec.frames) / 3), rec.frames])].filter((n) => n >= 1);
    for (const n of idxs) {
      try {
        const b = fs.readFileSync(path.join(rec.framesDir, `f-${String(n).padStart(5, "0")}.jpg`));
        samples.push({ data: b.toString("base64"), ts: Math.round(((n - 1) / rec.fps) * 1000) });
      } catch {}
    }
    const poster = path.join(rec.dir, "poster.jpg");
    if (!copyInRuntimeFolder(path.join(rec.framesDir, "f-00001.jpg"), poster)) fs.copyFileSync(path.join(rec.framesDir, "f-00001.jpg"), poster);
    const videoPath = path.join(rec.dir, "video.mp4");
    // In the runtime folder (`own`, see top) ffmpeg (a child process of B, `-y` follows every link) writes into the own temp folder,
    // and the finished video reaches its place through the descriptor.
    const encodeTarget = rec.own ? path.join(rec.framesDir, "video.mp4") : videoPath;
    await runFfmpeg(rec, encodeTarget);
    if (rec.own) copyInRuntimeFolder(encodeTarget, videoPath);
    capture.video = "video.mp4";
    capture.bytes = fs.statSync(encodeTarget).size;
  } catch (e) {
    capture.error = String(e.message || e);
  }
  try { fs.rmSync(rec.framesDir, { recursive: true, force: true }); } catch {}
  // The capture ends in every case (see top): a manifest that cannot be written (the place leads outside) stands as an error on the
  // capture, and the profile is free.
  try {
    writeManifest(capture);
    prune(rec.chatId);
  } catch (e) {
    capture.error = capture.error || `Manifest not written: ${String(e?.message || e)}`;
  } finally {
    active.delete(rec.profileKey);
  }
  finished.set(rec.profileKey, { capture, samples });
  return { capture, samples };
}

export async function stopRecording({ profileKey, caption, show }) {
  const rec = active.get(profileKey);
  let r = null;
  if (rec) { if (show === false) rec.notShow = true; r = await finalize(rec); finished.delete(profileKey); }
  // Auto-stop (maxSeconds) or tab death have already finalized: collect the result once.
  else if (finished.has(profileKey)) { r = finished.get(profileKey); finished.delete(profileKey); }
  else throw httpError(404, "No active recording.");
  const m = r.capture?.id ? label(r.capture.chatId, r.capture.id, caption, show) : null;
  return m ? { ...r, capture: m } : r;
}

/** The main agent's turn end (chats/captures-show.js, only its profile = chat id): a recording it left running ends here: nobody
 *  drives the browser any more, and without an end it would stand until maxSeconds (the video only comes with the end). A result
 *  the auto-stop kept ready for `stop` lapses: the turn that was to collect it is over. A subagent's recording keeps running (it may
 *  work beyond the turn end); it ends with its stop or the auto-stop and appears at the next turn end. */
export async function endCaptureAtTurnEnd(profileKey) {
  const rec = active.get(profileKey);
  if (rec) await finalize(rec);
  finished.delete(profileKey);
}

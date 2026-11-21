// The DevTools UI of a project browser comes from B. Otherwise the Chromium in the project container would serve `inspector.html`
// with its scripts under the cbase origin, and a process in the container could run its own script there as cbase (account,
// terminals in B).
//
// THE SOURCE. The UI is served by a Chromium of its own in B: the same program with which B starts its browsers (`resolveChromium`,
// in the image CBASE_CHROMIUM=/usr/bin/chromium), headless, with an empty throwaway profile, debug port only on 127.0.0.1 in B. Under
// /devtools/* Chromium serves EXACTLY the UI of its own version — it fits a browser in a project container if both carry the same
// version. By construction they do: both images (user container and project box) inherit Chromium from the same stage `basis`
// (server/backend/Dockerfile, one apt row; guard tools/check/projectbox-dockerfile.test.mjs "chromium only in basis"), and the
// Playwright MCP in the container starts /usr/bin/chromium too (toolchain/playwright.js). They diverge only between a deploy with a new
// `basis` and the recreation of the project container (projectbox/recreate.js) — hence the comparison below and the notice, never a
// fallback. The source is started only when an instance session asks for its UI; it ends after SOURCE_IDLE_MS without a request
// (default 10 min, knob CBASE_DEVTOOLS_SOURCE_IDLE_MIN) — the UI loads modules on demand, a stopped source then starts again (about 1 s).
//
// THE REVISION. `revision(product, revisionValue)` — from `Browser.getVersion` (CDP) or `/json/version` ("Browser" and the bracket of
// "WebKit-Version") — is `{ number, revision, key }`; two UIs fit if their `key` is equal (number AND revision). Measured on Chrome
// 154: product "Chrome/154.0.8037.92", revision "@334b65d…", /json/version "WebKit-Version": "537.36 (@334b65d…)" — the same revision
// in both places. What the container says about itself is a claim: checked strictly, and a lie costs only itself (it gets an unfitting
// UI from B, never files of its own).
//
// A leaf with `node:*`; the caller hands the program in (browsers.js resolveChromium — no re-import).
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const SOURCE_IDLE_MS = Math.max(1, Number(process.env.CBASE_DEVTOOLS_SOURCE_IDLE_MIN || 10)) * 60_000;
// Caps (estimated, like the start of a browser tab in browsers.js): start until the debug port reports, fetching the version.
const START_CAP_MS = 20_000;
const VERSION_CAP_MS = 10_000;

const PRODUCT = /^[A-Za-z][A-Za-z ]{0,40}\/(\d{1,4}(?:\.\d{1,6}){3})$/;
const REVISION = /^@?([0-9A-Za-z._-]{0,100})$/;

/** The revision of a UI from product ("HeadlessChrome/140.0.7339.185") and revision ("@<sha>" or empty); `null` if either does not
 *  look like that. */
export function revision(product, revisionValue) {
  const m = PRODUCT.exec(String(product ?? ""));
  if (!m) return null;
  const r = REVISION.exec(String(revisionValue ?? ""));
  if (!r) return null;
  return { number: m[1], revision: r[1], key: `${m[1]}@${r[1]}` };
}

/** The same revision from the answer to /json/version. */
export function revisionFromVersion(v) {
  const bracket = /^\S+ \((.*)\)$/.exec(String(v?.["WebKit-Version"] ?? ""));
  return revision(v?.Browser, bracket ? bracket[1] : "");
}

const matching = (a, b) => !!a && !!b && a.key === b.key;
export { matching as revisionsMatch };

// ── The source ──────────────────────────────────────────────────────────────────────────────────────────────────────
let source = null; // { kind, dir, ready: Promise<{ port, revision } | null>, timer, end: Promise }

function setIdle(q) {
  clearTimeout(q.timer);
  q.timer = setTimeout(() => { if (source === q) stopDevtoolsSource(); }, SOURCE_IDLE_MS);
  q.timer.unref?.();
}

function queryVersion(port) {
  return new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port, path: "/json/version", headers: { host: `127.0.0.1:${port}` }, agent: false }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { if (b.length < 65_536) b += d; });
      res.on("end", () => { try { resolve(res.statusCode === 200 ? revisionFromVersion(JSON.parse(b)) : null); } catch { resolve(null); } });
      res.on("error", () => resolve(null));
    });
    r.setTimeout(VERSION_CAP_MS, () => r.destroy(new Error("Cap")));
    r.on("error", () => resolve(null));
  });
}

function start(bin) {
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-devtools-source-")); } catch { return null; }
  const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check"];
  if (process.env.CBASE_CONTAINER === "1") args.push("--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu");
  args.push("about:blank");
  let subprocess;
  try { subprocess = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] }); } catch { fs.rmSync(dir, { recursive: true, force: true }); return null; }
  const q = { kind: subprocess, dir, timer: null };
  q.end = new Promise((resolve) => {
    subprocess.once("exit", () => { fs.rmSync(dir, { recursive: true, force: true }); if (source === q) source = null; clearTimeout(q.timer); resolve(); });
    subprocess.once("error", () => { fs.rmSync(dir, { recursive: true, force: true }); if (source === q) source = null; clearTimeout(q.timer); resolve(); });
  });
  q.ready = new Promise((resolve) => {
    let rest = "";
    let finished = false;
    const end = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      subprocess.stderr.removeAllListeners("data");
      subprocess.stderr.resume(); // keep draining, otherwise Chromium blocks on a full pipe
      if (!value) { try { subprocess.kill(); } catch {} }
      resolve(value);
    };
    const deadline = setTimeout(() => end(null), START_CAP_MS);
    deadline.unref?.();
    subprocess.stderr.setEncoding("utf8");
    subprocess.stderr.on("data", async (d) => {
      rest = (rest + d).slice(-4096);
      // Only our own loopback — the source is a process of B.
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(rest);
      if (!m || finished) return;
      rest = "";
      const port = Number(m[1]);
      const f = await queryVersion(port);
      end(f ? { port, revision: f } : null);
    });
    subprocess.once("exit", () => end(null));
    subprocess.once("error", () => end(null));
  });
  return q;
}

/** The running source (started at first need): `{ port, revision }` or `null` (no Chromium, start failed). Every call keeps it
 *  awake. `binary()` returns the program (browsers.js resolveChromium). */
export function devtoolsSource(binary) {
  if (!source) {
    const bin = binary();
    if (!bin) return Promise.resolve(null);
    source = start(bin);
    if (!source) return Promise.resolve(null);
  }
  const q = source;
  setIdle(q);
  return q.ready;
}

/** Stops the source (idle, a stuck source, tests); resolves when the process is gone. */
export function stopDevtoolsSource() {
  const q = source;
  if (!q) return Promise.resolve();
  source = null;
  clearTimeout(q.timer);
  try { q.kind.kill(); } catch {}
  return q.end;
}

/** For `process.on("exit")`: only the signal, synchronous. */
export function devtoolsSourceEndImmediately() {
  try { source?.kind.kill(); } catch {}
}

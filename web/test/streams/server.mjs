// Server shell of the stream recorder: real server (server/backend/electron/server), the fake CLI from
// fake-cli.cjs, two SSE readers (chat stream, global stream) and a cleanup that closes every open
// connection BEFORE server.close() — otherwise close would wait forever for the reader.
// The helpers freePort/json/waitFor/waitForIdle/stopAllRuns come from server-harness.mjs; only the shell
// is its own, because it needs a DIFFERENT fake CLI and no background tick.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { freePort, json, ok, stopAllRuns, waitFor, waitForIdle } from "../../../server/backend/test/server-harness.mjs";
import { isBarrier, tidyUp, waitRow } from "../../../server/backend/test/quiet.mjs";
import { startServer } from "../../../server/backend/electron/server/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = path.join(here, "fake-cli.cjs");

// SSE reader as in chat-stream-join.test.js: line buffer, frames at "\n\n", only data: lines. The heartbeat
// `event: ping` (every 25 s) carries an empty `data: {}` — it is counted when it comes; the scenarios are
// shorter, so it appears in no recording.
// The marker of the stream barrier (server/backend/test/quiet.mjs) does NOT go into `events` — the recording
// should show what the server sends by itself — but into `markers` (marker → position in `events` on arrival).
export async function openStream(url) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream" } });
  if (res.status !== 200) throw new Error(`stream ${url} → ${res.status}`);
  const events = [];
  const markers = new Map();
  const waiters = [];
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            let evt;
            try { evt = JSON.parse(line.slice(6)); } catch { continue; }
            if (isBarrier(evt)) { markers.set(evt.marker, events.length); continue; }
            events.push(evt);
            for (const w of waiters.slice()) {
              if (!w.pred(evt)) continue;
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(evt);
            }
          }
        }
      }
    } catch { /* the abort on close is expected */ }
  })();
  return {
    events,
    markers,
    // Wait for the Nth event satisfying `pred` (default: the first) — WITHOUT a deadline (no clock a test can
    // fail on): if it hangs, `what` is printed to stderr every 30 s, and the emergency brake is the deadline of
    // the suite or of the golden child (golden-harness.mjs DEADLINE_MS). `ms` is no longer read.
    waitFor(pred, { seq = 1, what = String(pred) } = {}) {
      const hits = () => events.filter(pred);
      if (hits().length >= seq) return Promise.resolve(hits()[seq - 1]);
      return new Promise((resolve) => {
        const to = waitRow(`event ${what}`);
        waiters.push({ pred: () => hits().length >= seq, resolve: () => { to(); resolve(hits()[seq - 1]); } });
      });
    },
    async close() { ac.abort(); await pump; },
  };
}

// A fresh server per scenario: own DB, own port, own fake-CLI environment. `scenario` goes to the CLI as
// CBASE_STREAM_SCENARIO; the deposit folder holds the marker files (fake ↔ runner).
// `webDir`: the folder the server serves as web client — the recorder needs none (empty folder), the DOM
// recorder in a real browser passes `web/out`, so the same server with the same fake CLI
// also runs in the browser.
// Three more knobs, all defaulting to the plain behaviour:
//   `role`     what the fake CLI plays (CBASE_STREAM_SCENARIO) — the golden recorder has scenarios whose
//              name is not the role (fixture folder ≠ fake role);
//   `env`      further environment variables BEFORE the server start (ticks, deadlines) — reset in the
//              finally like all others;
//   `prefix`   the name of the temp folder (the cleaner in tools/check/targets/check.mjs only removes
//              `cbase-*`).
// Plus CBASE_STREAM_SPAWN: the fake CLI logs every start (argv, cwd, MCP config) and every input there —
// the spawn log of the golden harness; the web recorder does not read it.
export async function withStreamServer(scenario, run, { webDir = null, role = scenario, env = {}, prefix = "cbase-streams" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${scenario}-`));
  const bin = path.join(root, "fake-claude");
  const deposit = path.join(root, "markers");
  const spawnLog = path.join(deposit, "spawn.jsonl");
  const prev = {};
  const setEnv = (k, v) => { if (!(k in prev)) prev[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  let server;
  let base = "";
  let error = null;
  const streams = [];
  try {
    fs.copyFileSync(FAKE_CLI, bin);
    fs.chmodSync(bin, 0o755);
    fs.mkdirSync(deposit, { recursive: true });
    setEnv("CLAUDE_BIN", bin);
    setEnv("CBASE_TRIGGER_POLL", "0");
    setEnv("CBASE_STREAM_SCENARIO", role);
    setEnv("CBASE_STREAM_DEPOSIT", deposit);
    setEnv("CBASE_STREAM_SPAWN", spawnLog);
    for (const [k, v] of Object.entries(env)) setEnv(k, v);
    // Keep the Anthropic usage endpoint out (as in auto-continue.test.js, isolateCredentials): without
    // credentials the limit path falls back to the reset hint in the message — the path to be recorded
    // here, and one that does not depend on the developer's account.
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim, { recursive: true });
    fs.writeFileSync(path.join(shim, "security"), "#!/bin/sh\nexit 1\n");
    fs.chmodSync(path.join(shim, "security"), 0o755);
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    setEnv("HOME", home);
    // On the first turn the server pre-warms the Playwright MCP via `npx -y …` (toolchain/playwright.js).
    // With an empty HOME npx has no cache and downloads from the registry — measured 14 s per scenario
    // during which the child process still hung on the network after closing. NPX_BIN is set to a no-op.
    fs.writeFileSync(path.join(shim, "npx"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(shim, "npx"), 0o755);
    setEnv("NPX_BIN", path.join(shim, "npx"));
    // Same for the embedding model (embeddings.js): without a cache in the empty HOME the server downloaded
    // ~130 MB from huggingface.co (12 s) — offline the lexical fallback remains, which no scenario needs.
    setEnv("CBASE_EMBED_OFFLINE", "1");
    setEnv("PATH", `${shim}:${process.env.PATH}`);
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath, { recursive: true });
    // KNOWN TRAP (server-harness.mjs): startServer({port:0}) sets BASE_URL to "…:0" — hence a real free
    // port beforehand.
    const port = await freePort();
    server = await startServer({
      port,
      dataRoot: path.join(root, "data-root"),
      webDir: webDir ?? path.join(root, "web"),
      pickDirectory: null,
      notify: null,
    });
    base = `http://127.0.0.1:${port}`;
    setEnv("CBASE_STREAM_BASE", base);
    const stream = async (url) => { const s = await openStream(url); streams.push(s); return s; };
    // `ok` throws from status 400 on with route and body — a scenario must not silently continue on a 409.
    const post = (url, body = {}) => ok(`${base}${url}`, { method: "POST", body: JSON.stringify(body) });
    return await run({
      base, root, wsPath, deposit, port, stream, post,
      dataRoot: path.join(root, "data-root"), spawnLog,
      json: (url, init) => json(`${base}${url}`, init),
      waitFor, waitForIdle: () => waitForIdle(base),
      marker: (name) => fs.writeFileSync(path.join(deposit, name), "1"),
      waitForMarker: (name) => waitFor(() => fs.existsSync(path.join(deposit, name)), `marker ${name} of the fake CLI`),
      setEnv,
    });
  } catch (e) {
    error = e;
    throw e;
  } finally {
    // Close the streams FIRST (server.close waits for every open connection), then stop the runs.
    for (const s of streams) { try { await s.close(); } catch { /* already closed */ } }
    // Release a waiting fake CLI so the run can end instead of standing until the deadline.
    try { fs.writeFileSync(path.join(deposit, "approval"), "1"); } catch { /* folder is gone */ }
    // Stop and wait for QUIET, without deadline and without throwing (quiet.mjs tidyUp): a 20 s idle wait that
    // only warned on expiry used to let the server close under a running turn.
    if (base) {
      await stopAllRuns(base);
      await tidyUp(base, { error, who: "streams" });
    }
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — the recording is unaffected.`); }
  }
}

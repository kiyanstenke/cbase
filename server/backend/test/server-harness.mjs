// Harness of the server tests: fake CLI, server shell and helpers. Registers NO test (hence .mjs, not .test.js; a .test.js must
// never be imported, otherwise its tests would run twice). What remains here is used by the coding tests.
// withServer carries running/finished and closeAllConnections in the finally.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../electron/server/server.js";
import { readJsonl as readJsonlValue } from "./jsonl.mjs";
import { tidyUp, streamBarrier, waitRow, waitForQuiet } from "./quiet.mjs";

const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));
const MODEL = "claude-haiku-4-5-20251001";

// Fake CLI serving both call forms of the real Claude CLI:
//  · Oneshot (runOnce): the prompt comes via stdin, the answer is {result} JSON — always "Title" (auto title).
//  · Turn (stream-json): every user line is written down with its ARGV and answered briefly — unless the text contains STAY-OPEN,
//    then the run stays open until the test stops it (needed to put /ask into a RUNNING child run).
//
// The distinction must not hang on `--input-format`: a oneshot WITH IMAGES uses the same switch (the CLI takes bytes only via
// stream-json) and would land here as a turn — the caller would wait forever for a result that never comes. What distinguishes
// reliably is `--append-system-prompt`: buildClaudeChatArgs sets it on EVERY chat and no oneshot does.
const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
const isChat = argv.includes("--append-system-prompt");
if (!isChat) {
  // Image oneshots come in as ONE stream-json row and want the answer back in the same format; plain text comes raw and gets a
  // single {result} object.
  const streamMode = argv.includes("--input-format");
  let stdin = "";
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    let prompt = stdin;
    let images = 0;
    let documents = 0;
    let mimes = [];
    if (streamMode) {
      try {
        const msg = JSON.parse(stdin.trim().split("\\n")[0]);
        const blocks = (msg.message && msg.message.content) || [];
        prompt = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
        images = blocks.filter((b) => b.type === "image").length;
        // Document blocks: for those the real CLI sends a PDF unrendered to the model, which looks at the pages itself. The MIME
        // types are recorded because a block with application/octet-stream would be rejected by the API.
        documents = blocks.filter((b) => b.type === "document").length;
        mimes = blocks.filter((b) => b.source).map((b) => b.source.media_type);
      } catch { /* unreadable — then the raw text */ }
    }
    // Record the cwd too: the isolation of derived tasks has two halves, and the second (empty working directory) cannot be seen
    // in the arguments.
    fs.appendFileSync(process.env.CBASE_TEST_ONESHOTS, JSON.stringify({ argv, cwd: process.cwd(), prompt, images, documents, mimes }) + "\\n");
    // The next line is a marker: archive.test.js puts its holder right before it.
    let result = "Title";
    if (streamMode) say({ type: "result", result, session_id: "oneshot-fake" });
    else process.stdout.write(JSON.stringify({ result }));
    process.exit(0);
  });
} else {
  process.stdin.on("end", () => process.exit(0));
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
    fs.appendFileSync(process.env.CBASE_TEST_TURNS, JSON.stringify({ argv, text }) + "\\n");
    if (text.includes("STAY-OPEN")) return;
    // Immediately, no delay: a delay orders nothing — whoever needs the run open says STAY-OPEN — and under load it was no promise anyway.
    say({ type: "assistant", message: { content: [{ type: "text", text: "OK" }] } });
    say({ type: "result", result: "OK", session_id: "server-fake" });
  });
}
`;

// KNOWN TRAP: startServer({port:0}) fixes BASE_URL to "…:0" — every MCP config of a run would then point into the void. So a real
// free port is determined BEFORE the start.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function json(url, init) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
async function ok(url, init) {
  const r = await json(url, init);
  assert.equal(r.status < 400, true, `${init?.method || "GET"} ${url} → ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

// Runs start asynchronously — wait for states, do not assume them (no fixed sleep). WITHOUT a deadline (no clock a test can fail on —
// the emergency brake is the suite deadline); the third argument stays only so old calls do not break, and is not read. If it
// hangs, `what` is printed on stderr every 30 s.
async function waitFor(check, what, _deadline) {
  const to = waitRow(what);
  try {
    for (;;) {
      const got = await check();
      if (got) return got;
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally { to(); }
}
// QUIET (quiet.mjs), without a deadline: waiting for `busy`/`runs` alone would miss everything that keeps working after the run end
// (title, verdicts, queue, oneshots). Name and parameters stay (many callers); the second argument is not read.
async function waitForIdle(base, _deadline) {
  return waitForQuiet(base);
}
// Minimal SSE reader (the same build as in chat-stream-join.test.js, only with the `waitFor` signature of THIS shell: predicate,
// plain text). It is ALWAYS closed in the test's finally — `server.close()` would otherwise wait for the open connection, and the
// first real failure would become an eternal hang instead of a red line.
async function openStream(url) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream" } });
  assert.equal(res.status, 200);
  const events = [];
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
            try { events.push(JSON.parse(line.slice(6))); } catch { /* partial line */ }
          }
        }
      }
    } catch { /* the abort on closing is expected */ }
  })();
  return {
    events,
    waitFor: (pred, what) => waitFor(async () => events.find(pred) || null, what),
    async close() { ac.abort(); await pump; },
  };
}

// End runs left open (STAY-OPEN CLI) before the teardown.
async function stopAllRuns(base) {
  try {
    const r = await json(`${base}/api/active-runs`);
    for (const it of r.body?.items || []) {
      if (it.chatId && (it.phase === "running" || it.phase === "waiting")) {
        await json(`${base}/api/chats/${it.chatId}/stop`, { method: "POST" });
      }
    }
  } catch { /* the server may already be closed */ }
}

// A child process writes the fake CLI's logs while the test reads — only completed lines (jsonl.mjs; a look into the middle of a
// long line would throw "Unterminated string").
const readJsonl = readJsonlValue;

// `restartGraceMs`: the restart pass (interrupted runs, queue) is a start timer of 2.5 s — under load it fires in the middle of a
// test and grabs what the test is just checking as state. So by default it stands at 24 h as in agent-harness.mjs; a test that needs
// it gives the delay (0 = at once).
async function withServer(run, { restartGraceMs = 24 * 3_600_000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-server-"));
  const bin = path.join(root, "fake-claude");
  const oneshotLog = path.join(root, "oneshots.jsonl");
  const turnLog = path.join(root, "turns.jsonl");
  const prev = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    CBASE_TRIGGER_POLL: process.env.CBASE_TRIGGER_POLL,
    CBASE_TEST_ONESHOTS: process.env.CBASE_TEST_ONESHOTS,
    CBASE_TEST_TURNS: process.env.CBASE_TEST_TURNS,
    CBASE_RESTART_GRACE_MS: process.env.CBASE_RESTART_GRACE_MS,
  };
  let server;
  let base = "";
  let ran = false;      // has the body begun …
  let finished = false;    // … and did it run through without an error?
  let error = null;
  try {
    process.env.CBASE_RESTART_GRACE_MS = String(restartGraceMs);
    fs.writeFileSync(bin, fakeClaude);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_TEST_ONESHOTS = oneshotLog;
    process.env.CBASE_TEST_TURNS = turnLog;
    const wsPath = path.join(root, "workspace");
    const projPath = path.join(wsPath, "till");
    fs.mkdirSync(projPath, { recursive: true });
    const port = await freePort();
    server = await startServer({
      port,
      dataRoot: path.join(root, "data-root"),
      webDir: path.join(root, "web"),
      pickDirectory: null,
      notify: null,
    });
    base = `http://127.0.0.1:${port}`;
    ran = true;
    await run({
      base, root, wsPath, projPath,
      turns: () => readJsonl(turnLog),
      oneshots: () => readJsonl(oneshotLog),
      scratchDir: path.join(root, "data-root", "data", "scratch"),
      ctxDir: (folderId) => path.join(root, "data-root", "data", "artifacts", "_ctx", folderId),
      // The harness core (quiet.mjs): the server does nothing by itself any more (no deadline), and an SSE reader has everything that
      // went into its stream so far (returns: the safe cut behind the marker).
      waitForQuiet: (opts) => waitForQuiet(base, opts),
      barrier: (reader, target) => streamBarrier(reader, target),
    });
    finished = true;
  } catch (e) {
    error = e;
    throw e;
  } finally {
    if (base) {
      // QUIET instead of idle (busy/runs): titles, verdicts and queue are through before the next test inherits the same module
      // state — and without a deadline (no clock a test can fail on; the emergency brake is the suite). After a failure the same
      // target via tidyUp: it stops actively, waits without a deadline and never throws — the body's error stays THE error.
      await stopAllRuns(base);
      if (finished) await waitForQuiet(base);
      else if (ran) await tidyUp(base, { error, who: "server-harness" });
    }
    // `closeAllConnections` BEFORE the close: a test that fails an assertion leaves its SSE reader open — without this line
    // server.close() would wait for it forever, and the failure would look like a hang.
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // A test must not fail because its temp directory does not go away: a child process still writing causes ENOTEMPTY, which is a
    // statement about the cleanup, not about the product. It is not kept quiet either — otherwise junk piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

const makeWorkspace = (base, name, wsPath) =>
  ok(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name, path: wsPath }) });
const makeProject = (base, wsId, projPath, name = "Till") =>
  ok(`${base}/api/workspaces/${wsId}/projects`, { method: "POST", body: JSON.stringify({ path: projPath, name }) });
const makeChat = (base, workspaceId) =>
  ok(`${base}/api/chats`, {
    method: "POST",
    body: JSON.stringify({ workspaceId, provider: "claude", model: MODEL, permissionMode: "bypassPermissions" }),
  });
// Local ISO date like the store (localIsoDate) — for validUntil expectations.
const iso = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Speak to the REAL MCP server (stdio, JSON-RPC).
async function withMcp(env, run) {
  const child = spawn(process.execPath, [MCP_SCRIPT], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  // Without a deadline: the wait is for the answer — or for the end of the child, the event after which none comes any more (then
  // it rejects instead of hanging).
  let ended = null;
  const rejected = new Map();
  child.on("exit", (code, signal) => {
    ended = `MCP server ended (${signal || `exit ${code}`})`;
    for (const [id, reject] of rejected) { pending.delete(id); reject(new Error(ended)); }
    rejected.clear();
  });
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (ended) { reject(new Error(`${ended}: ${method}`)); return; }
    const id = nextId++;
    const to = waitRow(`MCP ${method}`);
    pending.set(id, (msg) => { to(); rejected.delete(id); resolve(msg); });
    rejected.set(id, (e) => { to(); reject(e); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const listTools = async () => ((await rpc("tools/list", {})).result?.tools || []).map((t) => t.name);
  const call = async (name, args = {}) => {
    const res = await rpc("tools/call", { name, arguments: args });
    const text = res.result?.content?.[0]?.text ?? "";
    let data = text;
    try { data = JSON.parse(text); } catch { /* error texts are not JSON */ }
    // `content` raw too: a tool can return more than one block (images via `__content`), and without the raw content exactly that
    // would not be checkable.
    return { isError: Boolean(res.result?.isError), text, data, content: res.result?.content ?? [] };
  };
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18" });
    await run({ rpc, listTools, call });
  } finally {
    child.kill();
  }
}

export { MCP_SCRIPT, MODEL, fakeClaude, freePort, json, ok, openStream, waitFor, waitForIdle, stopAllRuns, readJsonl, withServer, makeWorkspace, makeProject, makeChat, iso, withMcp };

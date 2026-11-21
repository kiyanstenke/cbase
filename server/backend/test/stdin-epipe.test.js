// The guard against EPIPE on a child process's stdin.
//
// Measured failure: three tests died in CI with `failureType: uncaughtException, error: "write EPIPE"` — two through
// providers/connectors/claude.js (runOnceClaude) and one through the engine's hook runner.
//
// The cause is a mix-up of two emitters: `child.on("error", …)` catches the SPAWN error, errors of the stdin STREAM go to
// `child.stdin`. Without a listener there, an EPIPE is an unhandled exception — in a test the test process dies, in
// PRODUCTION the server process. And a `try { child.stdin.write(…) } catch {}` does NOT protect: the stream error arrives
// asynchronously.
//
// Two kinds of check are here:
//   1. functional — a child that ends IMMEDIATELY gets a payload the pipe buffer cannot hold. The test process must survive
//      that, and the caller must see a normal end. Counter-proof: without the handler exactly this test dies with
//      "write EPIPE".
//   2. static — no place under electron/server/ writes to or closes a child stdin bypassing `providers/kind-stdin.js`.
//      Exceptions are NAMED and printed on every run; the list is red in BOTH directions (an unknown place as well as an
//      entry whose place no longer exists) and may only shrink.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runChatClaude, runOnceClaude } from "../electron/server/providers/connectors/claude.js";
import { runChatViaEngine } from "../electron/server/providers/engine.js";
import { closeStdin, writeStdin, stdinOpen } from "../electron/server/providers/kind-stdin.js";

const SERVER_DIR = fileURLToPath(new URL("../electron/server/", import.meta.url));

// Larger than any pipe buffer (Linux 64 KiB, macOS up to 64 KiB): a small payload vanishes in the buffer and the error would
// be left to chance. 2 MiB is not tight.
const PAYLOAD = "x".repeat(2 * 1024 * 1024);

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "cbase-epipe-"));
const rm = (r) => { try { fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { console.warn(`[stdin-epipe] cleanup: ${e?.message || e}`); } };

// A "CLI" that ends immediately without reading its stdin — the measured case (missing binary, immediate abort, crash at
// start).
function deadCli(root, code = 0) {
  const p = path.join(root, "tote-cli.sh");
  fs.writeFileSync(p, `#!/bin/sh\nexit ${code}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

// Stand around for a moment after the call ends: a stream error arrives ASYNCHRONOUSLY, a test that returned at once would
// pin it on the next test instead of itself.
const reverb = (ms = 400) => new Promise((r) => setTimeout(r, ms));

test("A child that dies before reading does not take the process with it — writeStdin", async () => {
  const child = spawn("/bin/sh", ["-c", "exit 0"]);
  await new Promise((r) => child.on("close", r));
  // The stream is dead by now; the helper says so instead of trying.
  assert.equal(stdinOpen(child), false, "a finished child accepts nothing any more");
  assert.equal(writeStdin(child, PAYLOAD), false, "writeStdin must report the dead stream");
  assert.equal(closeStdin(child), false, "closeStdin on a dead stream has no effect");
  await reverb();
});

// The close-only path (Codex: the prompt goes as an argument, stdin is only closed). `end()` can also trigger a stream
// error; the contract is the same as for writing — the guard stands BEFORE the call. A real failure could not be forced here
// (200 × end() on a dying child, macOS: no uncaught), so the test measures the CONTRACT: after closeStdin the stream carries
// exactly ONE error handler. Counter-proof: striking the guard from closeStdin turns it red — no other test measures the
// pure close path on a LIVE child.
test("closeStdin registers the guard before it closes — even without a prior write (Codex path)", async () => {
  const child = spawn("/bin/sh", ["-c", "sleep 5"]);
  try {
    assert.equal(child.stdin.listenerCount("error"), 0, "precondition: no handler yet");
    assert.equal(closeStdin(child), true, "a live child can be closed");
    assert.equal(child.stdin.listenerCount("error"), 1, "closeStdin must register the guard — otherwise an EPIPE at end() is an unhandled exception");
    // Idempotent: a second close attaches no second listener and reports "was already closed".
    assert.equal(closeStdin(child), false);
    assert.equal(child.stdin.listenerCount("error"), 1);
  } finally {
    child.kill("SIGKILL");
    await new Promise((r) => child.on("close", r));
  }
});

test("runOnceClaude: the CLI ends before reading, the caller gets a normal error", async (t) => {
  const root = tmpRoot();
  const prior = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = deadCli(root);
  try {
    let error = null;
    try { await runOnceClaude(PAYLOAD, { cwd: root, timeoutMs: 20_000 }); }
    catch (e) { error = e; }
    assert.ok(error, "the call must reject, not resolve");
    // Exit 0 with empty stdout: the oneshot path reports the unreadable answer. The wording is a side issue here — what
    // matters: it is a REJECTED promise and not an exception into the void.
    assert.match(String(error.message), /not parseable|exit /, `unexpected wording: ${error.message}`);
    t.diagnostic(`payload on stdin: ${PAYLOAD.length} bytes, rejection: ${String(error.message).slice(0, 60)}`);
    await reverb();
  } finally { if (prior === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prior; rm(root); }
});

test("runChatClaude: the injection into a dead child reports false instead of throwing", async () => {
  const root = tmpRoot();
  const prior = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = deadCli(root);
  try {
    let kind = null;
    const res = await runChatClaude({
      spec: {
        cwd: root, input: PAYLOAD, systemPrompt: "", addDirs: [], permissionMode: "bypassPermissions",
        builtinTools: null, allowedTools: [], mcpConfigPath: path.join(root, "mcp.json"), model: "", effort: "",
      },
      onEvent: () => {},
      onSpawn: (c) => { kind = c; },
    });
    assert.equal(res.code, 0, "the run ends regularly with the child's exit code");
    assert.ok(kind, "onSpawn must deliver the child");
    // Exactly the answer the orchestrator needs: "did not go out" — without an exception and without a second marker next
    // to the stream.
    assert.equal(kind.cbaseInject("one more thing"), false);
    kind.cbaseEndInput(); // must not throw
    await reverb();
  } finally { if (prior === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prior; rm(root); }
});

// The second measured path: the loop engine's hook runner. The UserPromptSubmit hook gets the WHOLE prompt as JSON on stdin —
// with a payload above the pipe buffer the case is certain.
test("Loop engine: a hook command that ends immediately does not tip the run over", async (t) => {
  const root = tmpRoot();
  try {
    const connector = {
      id: "fake", label: "fake",
      models: [{ id: "m1", label: "M1", context: 200_000 }],
      caps: { ownsAgentLoop: false, nativeToolCalling: true, streaming: false, subagents: false, vision: false },
      cleanEnv: () => ({}),
      resolveModel: (m) => m || "m1",
      runOnce: async () => "",
      complete: async () => ({ text: "finished", thinking: "", toolCalls: [], usage: { input: 1, output: 1, cached: 0 }, stop: "end" }),
    };
    let handle = null;
    // The deadline MUST be cleaned up again: a standing setTimeout keeps the test process's event loop open (measured: 19.5 s
    // of lag after a green file). `unref` besides clearTimeout, so the error path does not forget it either.
    let deadline;
    const res = await Promise.race([
      runChatViaEngine(connector, {
        spec: {
          cwd: root, input: PAYLOAD, systemPrompt: "", addDirs: [], permissionMode: "bypassPermissions",
          mcpServers: {}, model: "", effort: "", transcript: [],
          engine: { hooks: [{ event: "UserPromptSubmit", matcher: "*", command: "exit 0" }] },
        },
        onSpawn: (h) => { handle = h; },
        onEvent: (e) => { if (e.type === "result") handle?.cbaseEndInput(); },
      }),
      new Promise((_, rej) => { deadline = setTimeout(() => rej(new Error("engine run hangs")), 20_000); deadline.unref(); }),
    ]);
    clearTimeout(deadline);
    assert.equal(res.code, 0, "the run must end regularly");
    assert.match(String(res.resultText || ""), /finished/);
    t.diagnostic(`Hook payload (prompt in the event): ${PAYLOAD.length} bytes`);
    await reverb();
  } finally { rm(root); }
});

// ── Static: one truth, one way ────────────────────────────────────────────────
//
// Named exceptions — each with a reason AND a follow-up job, printed on every run. The list may only shrink: an entry without
// a raw place is as red as a raw place without an entry.
const RAW_PLACES_ALLOWED = [
];

// The helper itself is the one place where raw writing is ALLOWED — it is the way.
const HELPER = "providers/kind-stdin.js";

// Strip comments before searching: a `.stdin.write(…)` in an explanatory text is not a place. (Same lesson as in
// tools/check/lib/tree-rules.mjs and import-direction.test.js.)
const withoutComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// `.stdin.write(` / `.stdin.end(` — also in the optional form `?.stdin?.end(`.
const RE_RAW = /\.\s*stdin\s*\??\s*\.\s*(write|end)\s*\(/g;

function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.isFile() && e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

test("No child stdin is written or closed bypassing kind-stdin.js", (t) => {
  const files = jsFiles(SERVER_DIR);
  const found = new Map(); // relative path → line numbers
  for (const abs of files) {
    const rel = path.relative(SERVER_DIR, abs).split(path.sep).join("/");
    if (rel === HELPER) continue; // the helper IS the way
    const rows = withoutComments(fs.readFileSync(abs, "utf8")).split("\n");
    const hits = [];
    rows.forEach((z, i) => { RE_RAW.lastIndex = 0; if (RE_RAW.test(z)) hits.push(i + 1); });
    if (hits.length) found.set(rel, hits);
  }

  const allowed = new Set(RAW_PLACES_ALLOWED.map((e) => e.file));
  const unknown = [...found.keys()].filter((d) => !allowed.has(d)).sort();
  const orphaned = [...allowed].filter((d) => !found.has(d)).sort();

  // The numbers belong in the printed line, not in the title — a number in a title ages silently.
  t.diagnostic(`${files.length} files under electron/server/ checked, ${found.size} with raw child stdin, ${allowed.size} of them named as allowed.`);
  for (const e of RAW_PLACES_ALLOWED) {
    t.diagnostic(`  allowed: ${e.file}:${(found.get(e.file) || []).join(",") || "—"} — ${e.reason} Follow-up job: ${e.followUpJob}`);
  }

  assert.deepEqual(unknown, [], `These places bypass kind-stdin.js: ${unknown.map((d) => `${d}:${found.get(d).join(",")}`).join(" | ")}`);
  assert.deepEqual(orphaned, [], `These entries in RAW_PLACES_ALLOWED no longer have a raw place — strike them: ${orphaned.join(", ")}`);
});

test("Every file that touches a child stdin imports the helper", (t) => {
  // Also git.js (hunk staging) — the helper is not only for providers. And projectbox/docker.js (`docker exec`/`image load`
  // with stdin). The engine's hooks run through providers/hook-run.js.
  const user = ["providers/connectors/claude.js", "providers/connectors/codex.js", "providers/hook-run.js", "providers/mcp-client.js", "git.js", "projectbox/docker.js"];
  for (const rel of user) {
    const source = fs.readFileSync(path.join(SERVER_DIR, rel), "utf8");
    // The path differs by folder depth (`./`, `../` or `./providers/`) — the check is about the module, not the path.
    // Deliberately a boolean comparison: an `assert.match` prints the WHOLE file on failure.
    assert.equal(/from "\.{1,2}\/(providers\/)?kind-stdin\.js"/.test(source), true, `${rel} must import providers/kind-stdin.js`);
  }
  t.diagnostic(`${user.length} files run their child stdin through the helper.`);
});

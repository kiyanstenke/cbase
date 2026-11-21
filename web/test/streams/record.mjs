#!/usr/bin/env node
// Stream recorder: per scenario, against the REAL server with the fake CLI (fake-cli.cjs), records three things —
//   <name>.sse.jsonl     all events of GET /api/chats/:id/stream, in order
//   <name>.events.jsonl  all events of GET /api/events (global stream) in the same period
//   <name>.log.json      the persisted history after quiet (GET /api/chats/:id/log)
// — normalised (normalize.mjs) so that two runs are byte-equal. Output: web/test/fixtures/streams/.
// The gate test web/test/streams.test.mjs reads them without a server.
//
// Usage (by hand, NOT in the gate):
//   node web/test/streams/record.mjs                    all scenarios
//   node web/test/streams/record.mjs --only run,tool
//   node web/test/streams/record.mjs --target /tmp/x      for the flakiness probe (then diff -r)
//   node web/test/streams/record.mjs --target /tmp/raw --raw   UNnormalised — shows what the
//                                                            normalisation actually catches
//
// Each scenario runs in its OWN child process (same file with --single): the server keeps state at module
// level (running chats, queues, limit timers, the bell numbers) — in one process a scenario would depend on
// the previous one and `--only` would change the recording. The golden harness
// (server/backend/test/golden-harness.mjs) reuses the same recorder: the scenario table and the normalisation
// are built for it, not just for the reducer test.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newTable, normalize, normalizeLogLine } from "./normalize.mjs";
import { withStreamServer } from "./server.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ITSELF = fileURLToPath(import.meta.url);
const FIXTURES = path.resolve(here, "..", "fixtures", "streams");
const MODEL = "claude-haiku-4-5-20251001";
// Linger time after the quiet criterion: the last events (bell, run end in the global stream) come right
// after run_done — the flakiness probe (README) is the proof that this is enough.
const LINGER_MS = 400;
// Deadline per scenario in the child process — the limit scenario waits out the measured reset (2 s + grace).
const DEADLINE_MS = 120_000;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

// ── Child: record ONE scenario ─────────────────────────────────────────────────────────────
async function individual(name, target, { raw = false } = {}) {
  const sz = SCENARIOS.find((s) => s.name === name);
  if (!sz) throw new Error(`unknown scenario: ${name}`);
  // `role`: the fake CLI plays a role whose name is not the scenario name (default: the same).
  await withStreamServer(name, async (ctx) => {
    // The global stream FIRST: it must see everything the scenario triggers (also chat_title).
    const globalStream = await ctx.stream(`${ctx.base}/api/events`);
    await globalStream.waitFor((e) => e.type === "init", { what: "init of the global stream" });
    const ws = await ctx.post("/api/workspaces", { name: "Streams", path: ctx.wsPath });
    const chat = await ctx.post("/api/chats", { workspaceId: ws.id, provider: "claude", model: MODEL, permissionMode: "bypassPermissions" });
    // Titled by hand (titled=1): otherwise the auto-title oneshot would run after the first turn, and
    // its `title` event would sit before or after run_done depending on process start.
    const r = await ctx.json(`/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: `Strom ${name}` }) });
    if (r.status >= 400) throw new Error(`PATCH title → ${r.status}`);
    ctx.setEnv("CBASE_STREAM_CHAT", chat.id);
    let chatStream = null;
    const openChatStream = async () => { chatStream = await ctx.stream(`${ctx.base}/api/chats/${chat.id}/stream`); return chatStream; };
    if (!sz.streamLater) {
      await openChatStream();
      await chatStream.waitFor((e) => e.type === "harness" && e.subtype === "connected", { what: "connected" });
    }
    const szCtx = () => ({ ...ctx, chat, ws, chatStream, globalStream, openChatStream });
    await sz.run(szCtx());
    await ctx.waitForIdle();
    if (sz.quiet) await sz.quiet(szCtx());
    await new Promise((res) => setTimeout(res, LINGER_MS));
    const log = await ctx.json(`/api/chats/${chat.id}/log`);
    if (log.status >= 400) throw new Error(`GET log → ${log.status}`);

    const table = newTable({ chatId: chat.id, workspaceId: ws.id, root: ctx.root, base: ctx.base, ...(sz.rules ? { rules: sz.rules } : {}) });
    const norm = raw ? (e) => e : (e) => normalize(e, table);
    const normRow = raw ? (z) => z : (z) => normalizeLogLine(z, table);
    const jsonl = (rows) => rows.map((e) => JSON.stringify(norm(e))).join("\n") + "\n";
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, `${name}.sse.jsonl`), jsonl(chatStream.events));
    fs.writeFileSync(path.join(target, `${name}.events.jsonl`), jsonl(globalStream.events));
    fs.writeFileSync(path.join(target, `${name}.log.json`), JSON.stringify(log.body.map(normRow), null, 2) + "\n");
    console.error(`[streams] ${name}: sse ${chatStream.events.length} · events ${globalStream.events.length} · log ${log.body.length}`);
  }, sz.role ? { role: sz.role } : {});
}

// ── Parent: one child per scenario, report at the end ──────────────────────────────────────────────
function kind(name, target, raw) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ITSELF, "--single", name, "--target", target, ...(raw ? ["--raw"] : [])], {
      stdio: ["ignore", "inherit", "inherit"],
      // The gate deadlines of the test bench (tools/check/targets/check.mjs): otherwise the limit
      // scenario would wait 45 s grace + 20 s minimum wait.
      env: { ...process.env, CBASE_LIMIT_GRACE_MS: "2000", CBASE_LIMIT_MIN_WAIT_MS: "2000" },
    });
    const timer = setTimeout(() => { console.error(`[streams] ${name}: deadline of ${DEADLINE_MS} ms expired — child is killed`); child.kill("SIGKILL"); }, DEADLINE_MS);
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve(signal ? 128 : (code ?? 1)); });
    child.on("error", () => { clearTimeout(timer); resolve(1); });
  });
}

async function all() {
  const only = (argValue("--only") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const target = path.resolve(argValue("--target") || FIXTURES);
  const raw = process.argv.includes("--raw");
  if (raw && target === FIXTURES) { console.error("--raw only with --target: the fixtures in the tree stay normalised"); process.exitCode = 2; return; }
  const selected = only.length ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
  const unknown = only.filter((n) => !SCENARIOS.some((s) => s.name === n));
  if (unknown.length) { console.error(`unknown scenarios: ${unknown.join(", ")} (known: ${SCENARIOS.map((s) => s.name).join(", ")})`); process.exitCode = 2; return; }
  const result = [];
  for (const sz of selected) {
    const t0 = Date.now();
    const code = await kind(sz.name, target, raw);
    result.push({ name: sz.name, code, ms: Date.now() - t0 });
  }
  const count = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length; } catch { return "-"; } };
  console.log(`\nRecording to ${target}`);
  for (const e of result) {
    const sse = count(path.join(target, `${e.name}.sse.jsonl`));
    const ev = count(path.join(target, `${e.name}.events.jsonl`));
    let logN = "-";
    try { logN = JSON.parse(fs.readFileSync(path.join(target, `${e.name}.log.json`), "utf8")).length; } catch { /* missing */ }
    console.log(`  ${e.code === 0 ? "ok " : "RED"} ${e.name.padEnd(12)} sse ${String(sse).padStart(3)} · events ${String(ev).padStart(3)} · log ${String(logN).padStart(3)} · ${(e.ms / 1000).toFixed(1)} s`);
  }
  if (result.some((e) => e.code !== 0)) process.exitCode = 1;
}

const individualName = argValue("--single");
if (individualName) {
  individual(individualName, path.resolve(argValue("--target") || FIXTURES), { raw: process.argv.includes("--raw") }).catch((e) => {
    console.error(`[streams] ${individualName}: ${e?.stack || e}`);
    process.exitCode = 1;
  });
} else {
  all().catch((e) => { console.error(e?.stack || e); process.exitCode = 1; });
}

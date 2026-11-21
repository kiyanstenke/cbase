// The sixth effort level is gone. A chat could once store the level `ultra`; it meant something different per provider
// (Claude ran it as max, Codex switched on its own proactive delegation). The order (`EFFORT_LEVELS`, workflows.js) now
// knows five levels — a stored old value would fall through as "no level" and run SILENTLY with the CLI's default. So it
// migrates to `max` at startup (`store/chats.js: migrateUltraToMax`, registered as "effort-ultra-max" in store.js):
//   - the column `chats.effort` at every start,
//   - the JSON of the run settings (`workflows.run_settings`) until the first migration that rewrote something (then a
//     marker) — parsed and rewritten, never by text pattern. A store without old values gets NO marker: otherwise every
//     golden fixture would carry one more app_settings row.
//
// Two tests: the migration at the database (no server; `initStore` rebinds the module-wide `db` and is called several
// times on the same store here, hence its own file) and the run afterwards at the REAL server with fake CLIs whose argv is
// recorded: "spawns with max" is a statement about the process, not about an intermediate function.
//
// Counter-test: comment out the line `registerSchema("effort-ultra-max", …)` in store.js => both tests red — the Claude
// chat spawns without `--effort`, the Codex chats without `model_reasoning_effort`, and the database keeps `ultra`.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { startServer } from "../electron/server/server.js";
import { readJsonl } from "./jsonl.mjs";
import { RIPCORD } from "./ripcord.mjs";
import { waitForQuiet } from "./quiet.mjs";
// The chat "g55" runs on the test model with the numbers of a model without max — otherwise the migration of switched-off
// models would move it to gpt-6-sol (which carries max) at startup.
import { GAP, withGapsModel } from "./gaps-model.mjs";

const MARKER = "migration.effort_ultra_max";
// The chat routes accept only ids from [0-9a-f-] (chats/routes.js) — so uuid-shaped, readable through the name.
const ID = {
  claude: "00000000-0000-4000-8000-000000000001",
  sol: "00000000-0000-4000-8000-000000000002",
  g55: "00000000-0000-4000-8000-000000000003",
  high: "00000000-0000-4000-8000-000000000004",
  empty: "00000000-0000-4000-8000-000000000005",
};
const NAME = Object.fromEntries(Object.entries(ID).map(([n, id]) => [id, n]));

// Everything the migration may touch, read raw — over its OWN connection so the comparison does not go through the
// store's read functions (they normalize; what is measured is what the file holds).
function rawText(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "automater.db"));
  try {
    return {
      chats: db.prepare("SELECT id, effort, updated_at FROM chats ORDER BY id").all().map((r) => ({ ...r })),
      workflows: db.prepare("SELECT id, run_settings, updated_at FROM workflows ORDER BY id").all().map((r) => ({ ...r })),
    };
  } finally { db.close(); }
}
function cleanUp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${dir} failed (${e.code || e.message}) — test unaffected.`); }
}

// The old state from the time of the sixth level. "ultra" deliberately also appears OUTSIDE the field `effort` — in a
// title and a model name: a migration by text pattern would rewrite those too, and exactly that it must not do.
function seedOldStatus(wsPath) {
  const t = 1_700_000_000_000;
  store.createWorkspace({ id: "ws-ultra", name: "Ultra", path: wsPath, createdAt: t });
  const chat = (id, provider, model, effort) => store.createChat({
    id, workspaceId: "ws-ultra", title: `Chat ${id}`, provider, model, effort, permissionMode: "bypassPermissions", createdAt: t, updatedAt: t,
  });
  chat(ID.claude, "claude", "claude-opus-5", "ultra");
  chat(ID.sol, "codex", "gpt-5.6-sol", "ultra");
  chat(ID.g55, "codex", GAP, "ultra");
  chat(ID.high, "claude", "claude-sonnet-5", "high");
  chat(ID.empty, "claude", "claude-sonnet-5", "");
  // Title set: no auto-title oneshot next to the run.
  for (const id of Object.values(ID)) store.updateChat(id, { titled: 1 });
}

function seedJson(dataDir) {
  const t = 1_700_000_000_000;
  const raw = new DatabaseSync(path.join(dataDir, "automater.db"));
  try {
    const wf = raw.prepare("INSERT INTO workflows (id, workspace_id, name, run_settings, created_at, updated_at) VALUES (?, 'ws-ultra', ?, ?, ?, ?)");
    // Key order deliberately with `effort` in the middle: the same object is rewritten, not a reordered one.
    wf.run("wf-ultra", "Ultra run", JSON.stringify({ provider: "codex", model: "ultra-model-x", effort: "ultra", todos: true, doneRounds: 3 }), t, t);
    wf.run("wf-high", "High run", JSON.stringify({ provider: "claude", effort: "high" }), t, t);
    wf.run("wf-text", "Only in text", JSON.stringify({ provider: "claude", model: "ultra", effort: "" }), t, t);
  } finally { raw.close(); }
}

test("migration: ultra becomes max in chat and run settings — parsed, not by text pattern; a second start changes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-ultra-migration-"));
  const dataDir = path.join(root, "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    store.initStore(dataDir);
    // A fresh store has nothing to migrate — and so gets no marker (the golden fixtures write app_settings too).
    assert.equal(store.getSetting(MARKER, ""), "", "a fresh store carries no marker");
    seedOldStatus(path.join(root, "ws"));
    seedJson(dataDir);
    const prior = rawText(dataDir);
    assert.deepEqual(prior.chats.filter((c) => c.effort === "ultra").map((c) => NAME[c.id]), ["claude", "sol", "g55"], "precondition: three ultra chats");

    store.initStore(dataDir);
    const after = rawText(dataDir);

    // Column: every ultra chat carries max, the others are untouched — updated_at too (the chat list sorts by it).
    const effort = Object.fromEntries(after.chats.map((c) => [NAME[c.id], c.effort]));
    assert.deepEqual(effort, { claude: "max", sol: "max", g55: "max", high: "high", empty: "" });
    assert.deepEqual(after.chats.map((c) => c.updated_at), prior.chats.map((c) => c.updated_at), "the migration is not a user change");

    // Run settings: exactly the field, the same object in the same key order.
    const wf = Object.fromEntries(after.workflows.map((w) => [w.id, w.run_settings]));
    assert.equal(wf["wf-ultra"], JSON.stringify({ provider: "codex", model: "ultra-model-x", effort: "max", todos: true, doneRounds: 3 }));
    assert.equal(wf["wf-high"], prior.workflows.find((w) => w.id === "wf-high").run_settings, "another level stays unchanged");
    assert.equal(wf["wf-text"], prior.workflows.find((w) => w.id === "wf-text").run_settings, "\"ultra\" as a model name is no level — no text pattern");
    assert.equal(store.getWorkflow("wf-ultra").run.effort, "max");

    const marker = store.getSetting(MARKER, "");
    assert.match(marker, / · 1 Workflow\(s\)$/, "the JSON migration leaves its marker with the count");

    // Nowhere a stored `ultra` as a level any more.
    const asLevel = (text) => { try { return JSON.parse(text)?.effort === "ultra"; } catch { return false; } };
    assert.equal(after.chats.filter((c) => c.effort === "ultra").length, 0);
    assert.equal(after.workflows.filter((w) => asLevel(w.run_settings)).length, 0);

    // A second start changes nothing — not the marker either.
    store.initStore(dataDir);
    assert.deepEqual(rawText(dataDir), after, "a second start is a no-op");
    assert.equal(store.getSetting(MARKER, ""), marker);

    // The column migrates at EVERY start: a row an old build still wrote after the first migration is max at the next start.
    store.updateChat(ID.high, { effort: "ultra" });
    store.initStore(dataDir);
    assert.equal(rawText(dataDir).chats.find((c) => c.id === ID.high).effort, "max");
  } finally {
    cleanUp(root);
  }
});

// ── The run afterwards, at the real server ───────────────────────────────────────────────────────────
// The fake CLIs write their argv to a file; the server starts them through the REAL connectors (CLAUDE_BIN, CODEX_BIN).
// Environment as in the stream recorder: empty HOME and a `security` that finds nothing (the Claude path would otherwise
// ask the developer's account), npx and the embedding model switched off.
const fakeClaude = (log) => `#!/usr/bin/env node
${RIPCORD}
const fs = require("node:fs");
const readline = require("node:readline");
const argv = process.argv.slice(2);
const say = (o) => console.log(JSON.stringify(o));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: "claude", argv }) + "\\n");
if (!argv.includes("--append-system-prompt")) {
  // Oneshot: prompt over stdin, answer a {result} JSON.
  process.stdin.resume();
  process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ result: "ok" })); });
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (l) => {
    let m; try { m = JSON.parse(l); } catch { return; }
    if (m.type !== "user") return;
    say({ type: "system", subtype: "init", session_id: "s-ultra", model: "claude-opus-5", tools: [] });
    say({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    say({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s-ultra" });
  });
}
`;
const fakeCodex = (log) => `#!/usr/bin/env node
${RIPCORD}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const say = (o) => console.log(JSON.stringify(o));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: "codex", argv }) + "\\n");
if (!argv.includes("--json")) {
  const o = argv.indexOf("-o");
  if (o >= 0 && argv[o + 1]) { try { fs.writeFileSync(argv[o + 1], "ok"); } catch {} }
  process.exit(0);
}
say({ type: "thread.started", thread_id: "codex-ultra" });
say({ type: "item.completed", item: { id: "a1", type: "agent_message", text: "ok" } });
say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
`;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
// Waits for the event, not a clock — the emergency brake is the suite.
const wait = async (fn) => {
  for (;;) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
};
// Only completed lines (jsonl.mjs): the fakes write the log while the test reads it.
const rows = (log) => readJsonl(log);
const chatRun = (z) => (z.bin === "claude" ? z.argv.includes("--append-system-prompt") : z.argv.includes("--json"));

test("an ultra chat spawns with max after the start — Claude --effort max, Codex max or xhigh on a model without max, never ultra", () => withGapsModel(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-ultra-run-"));
  const dataRoot = path.join(root, "data-root");
  const log = path.join(root, "argv.jsonl");
  const prior = {};
  const setEnv = (k, v) => { if (!(k in prior)) prior[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  let server;
  let base = "";
  let finished = false;
  try {
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim, { recursive: true });
    for (const [name, text] of [["security", "#!/bin/sh\nexit 1\n"], ["npx", "#!/bin/sh\nexit 0\n"], ["fake-claude", fakeClaude(log)], ["fake-codex", fakeCodex(log)]]) {
      fs.writeFileSync(path.join(shim, name), text);
      fs.chmodSync(path.join(shim, name), 0o755);
    }
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    setEnv("HOME", home);
    setEnv("CODEX_HOME", path.join(home, ".codex"));
    setEnv("PATH", `${shim}:${process.env.PATH}`);
    setEnv("NPX_BIN", path.join(shim, "npx"));
    setEnv("CBASE_EMBED_OFFLINE", "1");
    setEnv("CBASE_TRIGGER_POLL", "0");
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
    setEnv("CLAUDE_BIN", path.join(shim, "fake-claude"));
    setEnv("CODEX_BIN", path.join(shim, "fake-codex"));

    // The old state is in the store BEFORE the server starts — the migration is part of its start.
    const wsPath = path.join(root, "ws");
    fs.mkdirSync(wsPath, { recursive: true });
    fs.mkdirSync(path.join(dataRoot, "data"), { recursive: true });
    store.initStore(path.join(dataRoot, "data"));
    seedOldStatus(wsPath);
    assert.equal(store.getChat(ID.claude).effort, "ultra", "precondition: the old state carries ultra");

    const port = await freePort();
    server = await startServer({ port, dataRoot, webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${port}`;

    const send = async (id) => {
      const res = await fetch(`${base}/api/chats/${id}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "go" }) });
      assert.ok(res.status < 300, `${NAME[id]}: message rejected (${res.status})`);
    };
    // Quiet instead of an own idle copy (busy/runs): title oneshots and hooks of the run are done then too — the next
    // provider reads "the last argv" only afterwards.
    const idle = () => waitForQuiet(base);
    // One after the other: exactly one run per chat, and the run's argv is the provider's last.
    const run = {};
    for (const [name, bin] of [["claude", "claude"], ["sol", "codex"], ["g55", "codex"]]) {
      const n = rows(log).filter((z) => z.bin === bin && chatRun(z)).length;
      await send(ID[name]);
      run[name] = (await wait(() => rows(log).filter((z) => z.bin === bin && chatRun(z))[n])).argv;
      await idle();
    }

    const valueAfter = (argv, flag) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
    const codexLevel = (argv) => argv.filter((a, i) => argv[i - 1] === "-c" && /^model_reasoning_effort=/.test(a));
    assert.equal(valueAfter(run.claude, "--effort"), "max", "Claude: formerly ultra, runs with max");
    assert.deepEqual(codexLevel(run.sol), ['model_reasoning_effort="max"'], "Codex/Sol: max, nie ultra");
    assert.deepEqual(codexLevel(run.g55), ['model_reasoning_effort="xhigh"'], "Codex/model without max: max by the substitution rule => xhigh");
    // The database afterwards — checked only AFTER the spawn: without the migration the test should turn red at the run
    // (the ultra chat then spawns without a level), not already at the precondition.
    for (const n of ["claude", "sol", "g55"]) assert.equal(store.getChat(ID[n]).effort, "max", `${n}: max after the start`);
    // No spawn of this test — chat or oneshot — carries the former level as the value of a level flag.
    for (const z of rows(log)) {
      assert.notEqual(valueAfter(z.argv, "--effort"), "ultra", `${z.bin}: --effort ultra`);
      assert.ok(!z.argv.includes('model_reasoning_effort="ultra"'), `${z.bin}: model_reasoning_effort="ultra"`);
    }
    finished = true;
  } finally {
    // Wait for quiet only if the body passed (as in agent-harness.mjs) — after a failure a hanging run would otherwise
    // have no deadline.
    if (base && finished) await waitForQuiet(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanUp(root);
  }
}));

// Adjust: rephrase marked text according to an instruction - against the real server with a fake CLI. Own file because
// `initStore` rebinds the module-wide `db`.
//
// Checked at the server seam:
//  - POST /api/adjust with a new instruction: one-shot sealed off (empty cwd, fences in the prompt), the answer is sanitized (quotes
//    removed), the instruction then stands in the list with a default title.
//  - The same instruction again => no second entry, it moves to the front; a title replaces the old one. Via `promptId` => stored
//    text, usage moves it forward.
//  - PATCH (title, text) and DELETE; unknown id => 404; empty text/prompt => 400.
//  - The model fails => 502, and the instruction is NOT remembered.
//  - Cap: beyond MAX_PROMPTS the longest-unused one drops out.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import * as adjust from "../electron/server/adjust.js";
import { readJsonl as readJsonlValue } from "./jsonl.mjs";

// The fake CLI: as a one-shot (without --append-system-prompt) it answers the adjust prompt with the fence content in lower case
// after "yo, " - in quotation marks, so the sanitizing is checked. "FAILNOW" in the text => exit 2 (model unreachable).
const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
if (!argv.includes("--append-system-prompt")) {
  let stdin = "";
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    const m = stdin.match(/<text>\\n([\\s\\S]*?)\\n<\\/text>/);
    if (m) {
      fs.appendFileSync(process.env.CBASE_TEST_ONESHOTS, JSON.stringify({ argv, prompt: stdin, cwd: process.cwd() }) + "\\n");
      if (m[1].includes("FAILNOW")) { process.stderr.write("529 overloaded"); process.exit(2); }
      process.stdout.write(JSON.stringify({ result: "„yo, " + m[1].toLowerCase() + "“" }));
      process.exit(0);
    }
    if (argv.includes("--input-format")) say({ type: "result", result: "Title", session_id: "oneshot-fake" });
    else process.stdout.write(JSON.stringify({ result: "Title" }));
    process.exit(0);
  });
} else {
  process.stdin.on("end", () => process.exit(0));
  readline.createInterface({ input: process.stdin }).on("line", () => {});
}
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
async function ok(url, init) {
  const r = await json(url, init);
  assert.equal(r.status < 400, true, `${init?.method || "GET"} ${url} → ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}
// Only completed lines (jsonl.mjs): the fake CLI writes the log while the test reads.
const readJsonl = readJsonlValue;

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-adjust-"));
  const bin = path.join(root, "fake-claude");
  const oneshotLog = path.join(root, "oneshots.jsonl");
  const KEYS = ["CLAUDE_BIN", "CBASE_TRIGGER_POLL", "CBASE_TEST_ONESHOTS", "CBASE_DEPOSIT_TICK_MS", "CBASE_SCHEDULE_TICK_MS"];
  const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  let server;
  try {
    fs.writeFileSync(bin, fakeClaude);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_TEST_ONESHOTS = oneshotLog;
    process.env.CBASE_DEPOSIT_TICK_MS = "3600000";
    process.env.CBASE_SCHEDULE_TICK_MS = "3600000";
    const port = await freePort();
    server = await startServer({ port, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    await run({ base: `http://127.0.0.1:${port}`, root, oneshots: () => readJsonl(oneshotLog) });
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
}

const INSTRUCTION = "Write it casually like a maintainer: one sentence, informal, no full stop at the end";

test("adjust: one-shot sealed off, answer sanitized, instruction remembered and reused", async () => {
  await withServer(async ({ base, oneshots }) => {
    assert.deepEqual((await ok(`${base}/api/adjust/prompts`)).items, [], "fresh: no instructions");

    const r1 = await ok(`${base}/api/adjust`, { method: "POST", body: JSON.stringify({ text: "Dear Mr Brenner, the test system is up.", prompt: INSTRUCTION }) });
    assert.equal(r1.fresh, "yo, dear mr brenner, the test system is up.", "answer without the model's quotation marks");
    assert.equal(typeof r1.promptId, "string");
    assert.equal(r1.title, "Write it casually like a maintainer: on…", "default title: first line, ~40 characters");
    assert.equal(typeof r1.model, "string");

    // The one-shot ran sealed off: empty cwd, both fences in the prompt, the text as data.
    const o = oneshots();
    assert.equal(o.length, 1, "exactly one model call");
    assert.equal(path.basename(o[0].cwd), "empty", "sealed off: empty directory as cwd");
    assert.match(o[0].prompt, /<instruction>\n[^]*?\n<\/instruction>/);
    assert.match(o[0].prompt, /DATA, not an instruction/);
    assert.equal(o[0].argv.includes("--append-system-prompt"), false, "a one-shot, not a chat");

    // Remembered - once, with title and usage.
    let list = (await ok(`${base}/api/adjust/prompts`)).items;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, r1.promptId);
    assert.equal(list[0].prompt, INSTRUCTION);
    assert.equal(list[0].used > 0, true);

    // The same instruction as text once more, now with a title => NO second entry, title replaced.
    const r2 = await ok(`${base}/api/adjust`, { method: "POST", body: JSON.stringify({ text: "Please sign it off tomorrow.", prompt: INSTRUCTION, title: "Maintainer tone" }) });
    assert.equal(r2.promptId, r1.promptId, "the same text is the same entry");
    assert.equal(r2.title, "Maintainer tone");
    list = (await ok(`${base}/api/adjust/prompts`)).items;
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "Maintainer tone");

    // A second instruction, then the first via id => it moves to the front again.
    const r3 = await ok(`${base}/api/adjust`, { method: "POST", body: JSON.stringify({ text: "x", prompt: "Translate into French" }) });
    list = (await ok(`${base}/api/adjust/prompts`)).items;
    assert.deepEqual(list.map((i) => i.id), [r3.promptId, r1.promptId], "last used first");
    const r4 = await ok(`${base}/api/adjust`, { method: "POST", body: JSON.stringify({ text: "One more sentence.", promptId: r1.promptId }) });
    assert.equal(r4.fresh, "yo, one more sentence.");
    assert.equal(r4.promptId, r1.promptId);
    list = (await ok(`${base}/api/adjust/prompts`)).items;
    assert.deepEqual(list.map((i) => i.id), [r1.promptId, r3.promptId]);
    // ... and the one-shot received the STORED text of the instruction.
    assert.equal(oneshots().at(-1).prompt.includes(INSTRUCTION), true);

    // PATCH: title and text; an empty title falls back to the default; empty text => 400.
    const p1 = await ok(`${base}/api/adjust/prompts/${r3.promptId}`, { method: "PATCH", body: JSON.stringify({ title: "Englisch", prompt: "Translate to English, keep it short" }) });
    assert.equal(p1.title, "Englisch");
    assert.equal(p1.prompt, "Translate to English, keep it short");
    assert.equal((await ok(`${base}/api/adjust/prompts/${r3.promptId}`, { method: "PATCH", body: JSON.stringify({ title: "" }) })).title, "Translate to English, keep it short");
    assert.equal((await json(`${base}/api/adjust/prompts/${r3.promptId}`, { method: "PATCH", body: JSON.stringify({ prompt: "  " }) })).status, 400);
    assert.equal((await json(`${base}/api/adjust/prompts/exists-not`, { method: "PATCH", body: JSON.stringify({ title: "x" }) })).status, 404);

    // DELETE
    const d = await ok(`${base}/api/adjust/prompts/${r3.promptId}`, { method: "DELETE" });
    assert.deepEqual(d.items.map((i) => i.id), [r1.promptId]);
    assert.equal((await json(`${base}/api/adjust/prompts/${r3.promptId}`, { method: "DELETE" })).status, 404);
    assert.equal((await json(`${base}/api/adjust`, { method: "POST", body: JSON.stringify({ text: "x", promptId: r3.promptId }) })).status, 404, "deleted instruction via id");

    // Validation
    assert.equal((await json(`${base}/api/adjust`, { method: "POST", body: JSON.stringify({ text: "   ", prompt: "x" }) })).status, 400, "empty text");
    assert.equal((await json(`${base}/api/adjust`, { method: "POST", body: JSON.stringify({ text: "x", prompt: "  " }) })).status, 400, "empty instruction");
    assert.equal((await json(`${base}/api/adjust`, { method: "POST", body: JSON.stringify({ text: "x".repeat(adjust.TEXT_MAX + 1), prompt: "y" }) })).status, 400, "text over the cap");
    assert.equal(oneshots().length, 4, "no validation request reached the model");
  });
});

test("adjust: a model failure is a 502 - and the instruction is not remembered", async () => {
  await withServer(async ({ base, oneshots }) => {
    const r = await json(`${base}/api/adjust`, { method: "POST", body: JSON.stringify({ text: "FAILNOW please", prompt: "Shorter" }) });
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.match(String(r.body?.error || ""), /Anpassen fehlgeschlagen|Adjusting failed/);
    assert.equal(oneshots().length, 1, "the call ran - and failed");
    assert.deepEqual((await ok(`${base}/api/adjust/prompts`)).items, [], "nothing remembered");
  });
});

test("adjust: the cap drops the longest-unused instruction", async () => {
  await withServer(async ({ base }) => {
    const ids = [];
    for (let i = 0; i < adjust.MAX_PROMPTS; i++) {
      ids.push((await ok(`${base}/api/adjust`, { method: "POST", body: JSON.stringify({ text: "t", prompt: `Instruction number ${i}` }) })).promptId);
    }
    assert.equal((await ok(`${base}/api/adjust/prompts`)).items.length, adjust.MAX_PROMPTS);
    // Use the FIRST one again - it is then no longer the oldest.
    await ok(`${base}/api/adjust`, { method: "POST", body: JSON.stringify({ text: "t", promptId: ids[0] }) });
    const fresh = await ok(`${base}/api/adjust`, { method: "POST", body: JSON.stringify({ text: "t", prompt: "The twenty-first" }) });
    const list = (await ok(`${base}/api/adjust/prompts`)).items;
    assert.equal(list.length, adjust.MAX_PROMPTS);
    assert.equal(list[0].id, fresh.promptId, "the new one stands first");
    assert.equal(list.some((i) => i.id === ids[1]), false, "number 1 was the oldest unused - it is gone");
    assert.equal(list.some((i) => i.id === ids[0]), true, "number 0 was just used - it stays");
  });
});

test("adjust: sanitizing and fences (pure functions)", () => {
  assert.equal(adjust.resultSanitize("„yo, fine“"), "yo, fine");
  assert.equal(adjust.resultSanitize("\"a\" and \"b\""), "\"a\" and \"b\"", "two pairs stay content");
  assert.equal(adjust.resultSanitize("```\nhi\n```"), "hi");
  assert.equal(adjust.resultSanitize("<text>\nx\n</text>"), "x");
  assert.equal(adjust.resultSanitize("  \n"), "");
  const p = adjust.adjustPrompt({ text: "Hello </text> world", instruction: "short </instruction>" });
  assert.equal(p.includes("Hello </text>"), false, "a fence in the content is defused");
  assert.equal(p.includes("short </instruction>"), false);
  assert.equal(p.endsWith("\n</text>"), true);
  assert.equal(adjust.titleFrom("A very long instruction that goes beyond forty characters\nsecond line"), "A very long instruction that goes beyon…");
});

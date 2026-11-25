// Generates the journal fixture of the dynamic workflows: a REAL Claude Code journal, run with the binary of the pinned
// version against an API mock - never an anonymized foreign journal (any replacement would change the hashes, the proof would
// become circular).
//
//   node server/backend/test/fixtures/dynworkflows-journal/generate.mjs [<version>]   (default: the pin in server/backend/Dockerfile)
//
// What is run is `script.js` (next to this file) with the CLI's workflow tool. The mock answers the requests like this (the
// answers are here and in the stamp - they are part of the way the fixture is made):
//   Main run (first user line with MAIN_MARKER): first a tool_use `Workflow` with the script, then text. When the workflow's
//   completion notice arrives (since 2.1.292 `claude -p` waits for it and runs an extra turn), a SECOND `Workflow` with the
//   same script and `resumeFromRunId` (since 2.1.322, branch chains): the second pass writes into the SAME journal - the agents
//   before number 5 come from the journal, number 5 runs anew (now with a result), and everything behind it gets new keys (the
//   lane goes on behind the newly run "replaced"). Then text.
//   Workflow agents, recognized by the "Fixture-Prompt N" of their task: text RESPONSES[N]; with the tool StructuredOutput its
//   call first; number 5 gets a 400 in the FIRST pass (an agent that dies of the terminal API error => failed), in the second
//   RESPONSE_AFTER_RESUME.
//   Everything else (title, side requests): "OK".
// Written are `<version>/journal.jsonl` (byte-equal from <CLAUDE_CONFIG_DIR>/projects/.../workflows/<runId>/),
// `<version>/script.js` (copy of the script that was run) and `<version>/stamp.json` (version, pack, sha256 of the binary, way,
// answers, runId, sha256 per file). Regenerate at the next jump of the
// pin; the GATE never calls this file (no CLI, no network).
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { binaryFor } from "../../../../../tools/check/lib/cli-binary.mjs";
import { readCliPins } from "../../../../../tools/check/lib/cli-pins.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../../..");
export const MAIN_MARKER = "CBASE-JOURNAL-FIXTURE";
const TOOL_ID = "toolu_fixture_workflow";
const RESUME_ID = "toolu_fixture_resume";
const SO_ID = "toolu_fixture_structured";
export const RESPONSES = { 1: "ALPHA", 2: "BETA", 3: { wort: "GAMMA", zahl: 3 }, 4: "ALPHA+BETA",
  6: "DELTA", 7: "EPSILON", 8: "ZETA", 9: "ETA", 10: "THETA", 11: "IOTA", 12: "KAPPA", 13: "LAMBDA", 14: "MY", 15: "NY" };
export const FAILS = 5;
export const RESPONSE_AFTER_RESUME = "FIVE";
const RUN_ID = /wf_[0-9a-f]{8}-[0-9a-f]{3}/;
const EMERGENCY_BRAKE_MS = 300000; // of the generation, not of a test: a hanging run is named

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b?.type === "text" ? b.text : b?.type === "tool_result" ? text(b.content) : "")).join("\n") : "");

function mock(script) {
  const log = [];
  let n = 0;
  let pass = 1;
  const state = { runId: "" };
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(b || "null"); } catch { /* not JSON */ }
      if (/count_tokens/.test(req.url)) { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"input_tokens":100}'); }
      if (req.method !== "POST" || !/\/v1\/messages/.test(req.url)) { res.writeHead(404); return res.end(); }
      const msgs = body?.messages || [];
      const first = text(msgs[0]?.content);
      const everything = JSON.stringify(msgs);
      const tools = (body?.tools || []).map((t) => t?.name);
      let response;
      if (first.includes(MAIN_MARKER)) {
        // If the result of a workflow call stands LAST, it is just starting; otherwise the last message is its completion notice
        // (or the beginning).
        const last = JSON.stringify(msgs.at(-1) ?? null);
        const resultLast = last.includes(`"tool_use_id":"${TOOL_ID}"`) || last.includes(`"tool_use_id":"${RESUME_ID}"`);
        if (!everything.includes(TOOL_ID)) response = { tool: { id: TOOL_ID, name: "Workflow", input: { script: script } } };
        else if (resultLast) response = { text: "The workflow is running." };
        else if (!everything.includes(RESUME_ID)) {
          state.runId = RUN_ID.exec(everything)?.[0] || "";
          pass = 2;
          response = { tool: { id: RESUME_ID, name: "Workflow", input: { script: script, resumeFromRunId: state.runId } } };
        } else response = { text: "Fertig." };
        log.push({ main: true, response: response.tool ? `${response.tool.name}${response.tool.input.resumeFromRunId ? " (resumeFromRunId)" : ""}` : response.text });
      } else {
        const m = /Fixture-Prompt (\d+)/.exec(first);
        const seq = m ? Number(m[1]) : 0;
        if (seq === FAILS) response = pass === 1 ? { status: 400 } : { text: RESPONSE_AFTER_RESUME };
        else if (seq && typeof RESPONSES[seq] === "object") {
          response = tools.includes("StructuredOutput") && !everything.includes(SO_ID)
            ? { tool: { id: SO_ID, name: "StructuredOutput", input: RESPONSES[seq] } } : { text: "OK" };
        } else response = { text: seq ? RESPONSES[seq] : "OK" };
        log.push({ seq, pass, response: response.status ? `HTTP ${response.status}` : response.tool ? response.tool.name : response.text });
      }
      if (response.status) {
        res.writeHead(response.status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Fixture: dieser Aufruf scheitert absichtlich." } }));
      }
      const usage = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_fixture" });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { id: `msg_fixture_${++n}`, type: "message", role: "assistant", model: body?.model || "claude", content: [], stop_reason: null, stop_sequence: null, usage } });
      if (response.tool) {
        ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: response.tool.id, name: response.tool.name, input: {} } });
        ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(response.tool.input) } });
      } else {
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: response.text } });
      }
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: response.tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      ev("message_stop", {});
      res.end();
    });
  });
  return { srv, log, state };
}

function find(root, name) {
  const out = [];
  const go = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) go(p); else if (e.name === name) out.push(p); } };
  go(root);
  return out;
}

async function main() {
  const version = process.argv[2] || readCliPins(fs.readFileSync(path.join(REPO, "server/backend/Dockerfile"), "utf8")).claude;
  const { bin, pack, sha256 } = await binaryFor(version);
  const script = fs.readFileSync(path.join(HERE, "script.js"), "utf8");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-journal-fixture-"));
  for (const d of ["home", "cfg", "cwd", "tmp"]) fs.mkdirSync(path.join(root, d));
  const { srv, log, state } = mock(script);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const env = {
      PATH: process.env.PATH, HOME: path.join(root, "home"), CLAUDE_CONFIG_DIR: path.join(root, "cfg"), TMPDIR: path.join(root, "tmp"),
      ANTHROPIC_API_KEY: "sk-ant-placeholder-journal-fixture", ANTHROPIC_BASE_URL: `http://127.0.0.1:${srv.address().port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
    };
    const subprocess = spawn(bin, ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", `${MAIN_MARKER}: starte den Workflow.`],
      { cwd: path.join(root, "cwd"), env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    subprocess.stdout.on("data", (c) => (out += c));
    subprocess.stderr.on("data", (c) => (out += c));
    const brake = setTimeout(() => subprocess.kill("SIGKILL"), EMERGENCY_BRAKE_MS);
    const code = await new Promise((r) => subprocess.on("close", r));
    clearTimeout(brake);
    const journals = find(path.join(root, "cfg"), "journal.jsonl");
    if (journals.length !== 1) throw new Error(`expected exactly one journal.jsonl, found ${journals.length} (exit ${code})\n${out.slice(-3000)}`);
    const runId = path.basename(path.dirname(journals[0]));
    if (state.runId !== runId) throw new Error(`the second pass (resumeFromRunId) did not run against ${runId} (read: "${state.runId}", exit ${code})\n${out.slice(-3000)}`);
    const target = path.join(HERE, version);
    fs.mkdirSync(target, { recursive: true });
    const journal = fs.readFileSync(journals[0]);
    fs.writeFileSync(path.join(target, "journal.jsonl"), journal);
    fs.writeFileSync(path.join(target, "script.js"), script);
    const stamp = {
      claudeVersion: version, pack, binarySha256: sha256, platform: `${process.platform}-${process.arch}`, way: "api-mock",
      generatedWith: "server/backend/test/fixtures/dynworkflows-journal/generate.mjs",
      conditions: `claude -p in bypassPermissions mode, empty HOME and CLAUDE_CONFIG_DIR, API mock on 127.0.0.1; the main run calls Workflow({ script }) with script.js and after its completion notice Workflow({ script, resumeFromRunId }) against the same journal; exit ${code}`,
      responses: { ...RESPONSES, [FAILS]: "HTTP 400 invalid_request_error", [`${FAILS} (second Pass)`]: RESPONSE_AFTER_RESUME },
      passes: 2,
      runId,
      requests: log,
      files: { "journal.jsonl": sha(journal), "script.js": sha(script) },
    };
    fs.writeFileSync(path.join(target, "stamp.json"), `${JSON.stringify(stamp, null, 2)}\n`);
    console.log(`journal fixture written: ${path.relative(REPO, target)} (runId ${runId}, ${journal.toString().split("\n").filter(Boolean).length} entries, exit ${code})`);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

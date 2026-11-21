#!/usr/bin/env node
// Fake CLI of the stream recorder (web/test/streams/record.mjs) and of the golden harness
// (server/backend/test/golden-harness.mjs). It speaks the stream-json form of the real Claude CLI, the way the
// green backend tests have long played it (shapes from server/backend/test/{chat-stream-join,ask-card,
// auto-continue,chat-compact,usage-tally}.test.js, plus the built-in Agent tool
// with parent_tool_use_id).
//
// Two call forms, told apart by `--append-system-prompt` (set by buildClaudeChatArgs for EVERY chat, never for
// a oneshot):
//   · oneshot: prompt via stdin, answer a {result} JSON — the compact prompt ("=== HISTORY ===") gets a
//     summary, everything else (auto-title) "Title".
//   · chat: one turn per user line; WHAT is played is told by CBASE_STREAM_SCENARIO (the recorder sets it
//     before starting the server, which passes its environment on to the CLI).
//
// Fixed numbers everywhere (usage, duration_ms, block ids): the stream must be byte-equal twice. What depends on
// the clock (reset time in the limit text) is normalised by the recorder. The German texts the fake emits are
// recorded into the fixtures and stay German on purpose.
//
// Two more features, without effect on the web roles:
//   · SPAWN LOG: if CBASE_STREAM_SPAWN is set, every process writes one line at start (argv, cwd, the parsed
//     MCP config from --mcp-config) and one per input (oneshot: the whole prompt; chat: every raw stdin row) —
//     the golden harness turns it into spawn.json, the proof for the prompt bytes. Lines are O_APPEND writes,
//     told apart per process by pid; the order of the start lines is the order of the spawns.
//   · GOLDEN ROLES (below): channel, workflow, graph_start, subagent_native, subagent_background, schedule,
//     scheduled_approval, scheduled_dismissed, targetGate, ingest, curate — each taken from the green backend
//     test that already drives the path. Roles speaking the REAL MCP server (mcpCall): channel, graph_start,
//     subagent_native, subagent_background, scheduled_approval and the web roles dynworkflow and approval.
//     A oneshot may WAIT (marker) so that curator, title and follow-up turn answer in a fixed order — the
//     server starts them concurrently anyway; the spawn order is in the pids (the harness sorts by them).
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const say = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const isChat = argv.includes("--append-system-prompt");
const SCENARIO = process.env.CBASE_STREAM_SCENARIO || "run";
const DEPOSIT = process.env.CBASE_STREAM_DEPOSIT || process.cwd(); // marker files fake ↔ recorder
const marker = (name) => path.join(DEPOSIT, name);
const MODEL = "claude-haiku-4-5-20251001";
const SESSION = `sess-${SCENARIO}`;
// Emergency brake: a fake waiting for a marker that never comes must not hold the recorder forever.
setTimeout(() => process.exit(9), 120_000).unref();

// ── Spawn log ─────────────────────────────────────────────────────────────────────
const SPAWN = process.env.CBASE_STREAM_SPAWN || "";
const log = (entry) => {
  if (!SPAWN) return;
  try { fs.appendFileSync(SPAWN, JSON.stringify({ pid: process.pid, ...entry }) + "\n"); } catch { /* folder is gone */ }
};
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const mcpConfigPath = argOf("--mcp-config") || "";
const readMcpConfig = () => {
  if (!mcpConfigPath || mcpConfigPath.startsWith("{")) return null;
  try { return JSON.parse(fs.readFileSync(mcpConfigPath, "utf8")); } catch (e) { return { error: String(e.message) }; }
};
log({ kind: "start", genus: isChat ? "chat" : "oneshot", argv, cwd: process.cwd(), mcpConfig: readMcpConfig() });

// A REAL MCP call: start the cbase server named in the config and speak tools/call — the way the Claude CLI
// would (template: server/backend/test/native-agent-e2e.test.js). The roles needing it are listed in the header.
// `toolUseId`: the id of the call block, which the real CLI passes as `_meta.claudecode/toolUseId`.
function mcpCall(name, args, toolUseId) {
  return new Promise((resolve, reject) => {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8")).mcpServers.cbase; }
    catch (e) { return reject(new Error("MCP config unreadable: " + e.message)); }
    const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...(cfg.env || {}) }, stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } reject(new Error("MCP timeout")); }, 20_000);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) { clearTimeout(timer); try { child.stdin.end(); } catch { /* closed */ } resolve(m); }
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args, ...(toolUseId ? { _meta: { "claudecode/toolUseId": toolUseId } } : {}) } });
  });
}
const mcpText = (m) => (m && m.result && m.result.content && m.result.content[0] && m.result.content[0].text) || "";
// A counter across processes (file in the deposit): "which time" for verdicts that differ the first time
// from afterwards (completion gate, target gate).
const count = (name) => {
  let n = 0;
  try { n = Number(fs.readFileSync(marker(name), "utf8")) || 0; } catch { /* first time */ }
  fs.writeFileSync(marker(name), String(n + 1));
  return n;
};

// ── Oneshot ────────────────────────────────────────────────────────────────────────────────────
if (!isChat) {
  let stdin = "";
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", async () => {
    log({ kind: "prompt", prompt: stdin });
    const result = await oneshotResponse(stdin);
    process.stdout.write(JSON.stringify({ result }));
    process.exit(0);
  });
  return;
}
// What a oneshot answers depends on the prompt — for the web scenarios compaction (else "Title"), for the
// golden roles the verdicts:
//   "work step is DONE"        completion gate of a workflow step: first "not done", then "done"
//   "overarching target"       target gate (/goal): first "open", then "achieved"
//   "PASTED TEXT:"             project routing of a context dump (routeDumpToProject): "unsure" — the dump
//                              then lands in the workspace dumpster
//   "You are a curator"        post-run curator (curateContext): ONE proposal (scenario curate)
//   "SEHR kurzen, prägnanten Titel"  auto-title (maybeAutoTitle; the German i18n wording of the title prompt,
//                              as the golden run uses it): in the scenario that lets it run (curate) a fixed
//                              title — only AFTER the curator (marker "curator-finished" from the recorder),
//                              so the events come in a fixed order
async function oneshotResponse(prompt) {
  if (prompt.includes("=== HISTORY ===")) return "ZUSAMMENFASSUNG: Der Nutzer fragte nach dem Aufbau des Ereignisstroms; die drei Gattungen wurden erklärt.";
  if (prompt.includes("PASTED TEXT:")) return JSON.stringify({ decision: "unsure", projectId: null, candidates: [], question: "Kasse oder Shop — wohin gehört die Notiz?", reason: "beide passen" });
  if (prompt.includes("You are a curator for project-specific long-term knowledge")) {
    return JSON.stringify([{ op: "create", category: "decisions", title: "Kasse: Testsystem zuerst", summary: "Vor dem Umbau wird das Testsystem geprüft.", body: "# Entscheidung\nFirst das Testsystem prüfen, dann die Kasse umbauen.", tags: ["till"], validAsOf: "", reason: "im Chat entschieden" }]);
  }
  if (prompt.includes("SEHR kurzen, prägnanten Titel") && SCENARIO === "curate") {
    await waitForTruthy("curator-finished");
    return "Kasse: Testsystem prüfen";
  }
  if (/work step is DONE/.test(prompt)) return count("gate-verdicts") === 0 ? '{"done": false, "note": "der Bericht fehlt"}' : '{"done": true, "note": ""}';
  if (/overarching target/.test(prompt)) return count("target-verdicts") === 0 ? '{"achieved": false, "note": "noch offen"}' : '{"achieved": true, "note": "erledigt"}';
  return "Title";
}

// ── Chat: building blocks in the form of the real CLI ─────────────────────────────────────────────────
// Message ids run across PROCESSES (file in the deposit): a scenario with two runs (question, limit,
// compaction) starts the CLI twice, and the real CLI never issues the same id twice.
const nextMsgId = () => {
  let n = 0;
  try { n = Number(fs.readFileSync(marker("msg-counter"), "utf8")) || 0; } catch { /* first id */ }
  fs.writeFileSync(marker("msg-counter"), String(n + 1));
  return `msg_${n + 1}`;
};
const usage = (input, output = 0) => ({ input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output });
const wrap = (o, parent) => (parent ? { ...o, parent_tool_use_id: parent } : o);
const ev = (event, parent) => say(wrap({ type: "stream_event", event }, parent));
const message = (id, content, { input, output, stop }) => ({ id, type: "message", role: "assistant", model: MODEL, content, stop_reason: stop, stop_sequence: null, usage: usage(input, output) });

function init() {
  say({
    type: "system", subtype: "init", session_id: SESSION, cwd: process.cwd(), model: MODEL,
    tools: ["Bash", "Read", "Edit", "Agent"], mcp_servers: [{ name: "cbase", status: "connected" }],
    permissionMode: "bypassPermissions", apiKeySource: "none", claude_code_version: "2.1.273",
  });
}
// A text block as the CLI sends it with --include-partial-messages: message_start (input side), block open,
// deltas, block closed, message_delta (output side), message_stop — and then the complete assistant event
// the stored history lives on.
function textBlock(text, { parent = null, input = 120, output = 18, parts = null } = {}) {
  const id = nextMsgId();
  ev({ type: "message_start", message: message(id, [], { input, output: 0, stop: null }) }, parent);
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent);
  for (const t of parts || split(text)) ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, parent);
  ev({ type: "content_block_stop", index: 0 }, parent);
  ev({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: output } }, parent);
  ev({ type: "message_stop" }, parent);
  say(wrap({ type: "assistant", message: message(id, [{ type: "text", text }], { input, output, stop: "end_turn" }) }, parent));
}
// A tool call (tool_use block with its deltas) — WITHOUT a result, the caller supplies it.
function toolUse({ id, name, input, parent = null, inTok = 140, outTok = 30 }) {
  const mid = nextMsgId();
  ev({ type: "message_start", message: message(mid, [], { input: inTok, output: 0, stop: null }) }, parent);
  ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }, parent);
  ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }, parent);
  ev({ type: "content_block_stop", index: 0 }, parent);
  ev({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: outTok } }, parent);
  ev({ type: "message_stop" }, parent);
  say(wrap({ type: "assistant", message: message(mid, [{ type: "tool_use", id, name, input }], { input: inTok, output: outTok, stop: "tool_use" }) }, parent));
}
const toolResult = (id, content, { isError = false, parent = null } = {}) =>
  say(wrap({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } }, parent));
const result = (text, { turns = 1 } = {}) =>
  say({ type: "result", subtype: "success", is_error: false, duration_ms: 1234, duration_api_ms: 1000, num_turns: turns, result: text, session_id: SESSION, total_cost_usd: 0, usage: usage(120, 18) });
// Text in three deltas, at word boundaries — that is what a stream looks like, not ONE delta.
function split(text) {
  const w = text.split(" ");
  const a = Math.ceil(w.length / 3);
  return [w.slice(0, a).join(" ") + " ", w.slice(a, 2 * a).join(" ") + " ", w.slice(2 * a).join(" ")].filter((t) => t.trim());
}
async function waitForTruthy(file) {
  while (!fs.existsSync(marker(file))) await sleep(25);
}
const textOf = (msg) => {
  const c = msg.message && msg.message.content;
  return typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
};

// ── The scenarios ──────────────────────────────────────────────────────────────────────────────
let turn = 0;
const TURNS = {
  // An answer in deltas — the basic pattern.
  async run() {
    init();
    textBlock("Gern. Der Ereignisstrom eines Chats trägt drei Gattungen: Harness-Ereignisse des Servers, die stream-json-Events der CLI und das Ergebnis am Ende.");
    result("Gern. Der Ereignisstrom eines Chats trägt drei Gattungen.");
  },
  // A tool call with result, then a second API call with text (message_start twice).
  async tool() {
    init();
    toolUse({ id: "toolu_01", name: "Bash", input: { command: "ls web/test", description: "Testordner ansehen" } });
    toolResult("toolu_01", "agents.mjs\nstream.mjs\nstreams.mjs");
    textBlock("Im Ordner liegen drei Testdateien.", { input: 190, output: 9 });
    result("Im Ordner liegen drei Testdateien.", { turns: 2 });
  },
  // The built-in Agent tool: the CLI spins up by itself, the child events carry parent_tool_use_id
  // (shape of the real CLI).
  async subagent() {
    init();
    const parent = "toolu_agent_01";
    toolUse({ id: parent, name: "Agent", input: { description: "Testdatei lesen", prompt: "Lies web/test/stream.test.mjs und sag, was sie prüft." } });
    toolUse({ id: "toolu_sub_01", name: "Read", input: { file_path: "web/test/stream.test.mjs" }, parent: parent, inTok: 80, outTok: 12 });
    toolResult("toolu_sub_01", "// Was ein wiederverbundener Ereignisstrom nachträgt (src/lib/stream.ts) …", { parent: parent });
    textBlock("Die Datei prüft missingBeginning in sieben Fällen.", { parent: parent, input: 95, output: 11 });
    toolResult(parent, "Die Datei prüft missingBeginning in sieben Fällen.");
    textBlock("Der Subagent hat die Datei gelesen: sieben Fälle zu missingBeginning.", { input: 210, output: 14 });
    result("Der Subagent hat die Datei gelesen: sieben Fälle zu missingBeginning.", { turns: 2 });
  },
  // Question card via the REAL path: cbase_ask ⇒ POST /api/chats/:id/ask (like the MCP server), the turn
  // ends, the user's selection arrives as the next message (template: ask-card.test.js).
  async question(text) {
    init();
    if (text.includes("[Answer to your question")) {
      textBlock("Verstanden — getrennte Repos, wegen der Release-Zyklen. Ich lege die Struktur so an.");
      result("Verstanden — getrennte Repos, wegen der Release-Zyklen.");
      return;
    }
    const question = {
      header: "Layout",
      question: "Monorepo oder getrennte Repos?",
      options: [
        { label: "Monorepo (Empfehlung)", description: "Ein Repo, geteilte Tooling-Basis." },
        { label: "Getrennte Repos", description: "Unabhängige Release-Zyklen." },
      ],
    };
    toolUse({ id: "toolu_ask_01", name: "mcp__cbase__cbase_ask", input: { questions: [question] } });
    const res = await fetch(`${process.env.CBASE_STREAM_BASE}/api/chats/${process.env.CBASE_STREAM_CHAT}/ask`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questions: [question] }),
    });
    const body = await res.json();
    // The answer of the MCP tool (mcp/tools/agents.js, cbase_ask): route answer plus note (German, as recorded in the fixtures).
    toolResult("toolu_ask_01", JSON.stringify({ ...body, note: "Die Frage steht jetzt als anklickbare Karte im Chat. BEENDE JETZT DEINEN TURN — höchstens ein kurzer Satz, keine weitere Arbeit und keine weitere Frage. Die Auswahl des Nutzers erreicht dich als nächste Nachricht." }));
    textBlock("Ich habe eine Rückfrage gestellt und warte auf deine Auswahl.", { input: 160, output: 12 });
    result("Ich habe eine Rückfrage gestellt und warte auf deine Auswahl.", { turns: 2 });
  },
  // Usage limit: the first run dies with the CLI wording and a measured reset (template: auto-continue.test.js,
  // resetInSeconds), the server parks and continues by itself — the second run is a NEW process with the
  // same prompt; the counter therefore lives in a file.
  async limit(text) {
    let runs = 0;
    try { runs = Number(fs.readFileSync(marker("limit-runs"), "utf8")) || 0; } catch { /* first run */ }
    fs.writeFileSync(marker("limit-runs"), String(runs + 1));
    if (runs === 0) {
      process.stderr.write(`Claude usage limit reached · resets at ${new Date(Date.now() + 2000).toISOString()}\n`);
      await sleep(30);
      process.exit(1);
    }
    init();
    textBlock(`FINISHED: ${text.replace(/\s+/g, " ").slice(0, 60)}`);
    result("FINISHED");
  },
  // Compaction: ordinary turns; the summary itself comes from the oneshot above.
  async compaction(text) {
    init();
    textBlock(`Antwort auf: ${text.replace(/\s+/g, " ").slice(0, 80)}`);
    result("Response");
  },
  // Join in the middle of a block (template: chat-stream-join.test.js, second test): two deltas, then a marker
  // for the recorder, then wait for its release — in that gap it queues a second message and opens the
  // stream. The second turn is the INJECTED message (same process).
  async join(text) {
    init();
    if (turn > 1) {
      textBlock(`Antwort auf: ${text.replace(/\s+/g, " ").slice(0, 80)}`, { input: 170, output: 10 });
      result("Response", { turns: 2 });
      return;
    }
    const parts = ["Ich fange an ", "und schreibe weiter, ", "bis der Block endet."];
    const id = nextMsgId();
    ev({ type: "message_start", message: message(id, [], { input: 120, output: 0, stop: null }) });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: parts[0] } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: parts[1] } });
    fs.writeFileSync(marker("deltas-out"), "1");
    await waitForTruthy("approval");
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: parts[2] } });
    ev({ type: "content_block_stop", index: 0 });
    ev({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 18 } });
    ev({ type: "message_stop" });
    say({ type: "assistant", message: message(id, [{ type: "text", text: parts.join("") }], { input: 120, output: 18, stop: "end_turn" }) });
    result(parts.join(""));
  },

  // ── Golden roles (server/backend/test/golden-scenarios.mjs) ─────────────────────────────
  // Channel (template channel.test.js): the SAME fake CLI plays both ends — two coding chats; the counterpart
  // recognises itself by the channel message that only IT receives (the coding chat's answer, "Zahlungsfluss
  // geprüft: sauber" — message #2 to the coding chat says "sobald der Zahlungsfluss geprüft ist", a shorter
  // feature would match both).
  //   Coding, turn 1 (message #1 of the counterpart): marker "channel-turn-1", wait for "channel-free-1" — in
  //     the gap the recorder sends message #2, which can NOT be delivered (turn open) and only arrives after the
  //     run end via the post-run delivery hook. This is the spot the sabotage probe hits.
  //   Coding, turn 2 (message #2): answers via cbase_agent_send to channel:<id> (real MCP server) — that wakes
  //     the counterpart —, waits for "opposite-finished" (the recorder sets it after its run_done) and then
  //     finishes. So the two runs end in a FIXED order: first the counterpart, then coding.
  //   Counterpart (occasion "channel"): a short answer.
  async channel(text) {
    init();
    if (text.includes("Zahlungsfluss geprüft: sauber")) {
      textBlock("Danke für den Stand — bitte weiter so, und melde dich, wenn die Kasse steht.", { input: 260, output: 16 });
      result("Danke für den Stand.");
      return;
    }
    // Which turn of the coding chat: every turn is a NEW process (--resume), so the counter lives
    // in the deposit, not in the process.
    if (count("channel-coding-turns") === 0) {
      fs.writeFileSync(marker("channel-turn-1"), "1");
      await waitForTruthy("channel-free-1");
      textBlock("Verstanden, ich prüfe zuerst den Zahlungsfluss und baue danach die Kasse um.", { input: 210, output: 17 });
      result("Verstanden, ich prüfe zuerst den Zahlungsfluss.");
      return;
    }
    const m = /channel id: ([0-9a-f-]{36})/.exec(text);
    const channelId = m ? m[1] : "";
    const input = { to: `channel:${channelId}`, message: "Zahlungsfluss geprüft: sauber. Ich fange mit der Kasse an." };
    toolUse({ id: "toolu_channel_01", name: "mcp__cbase__cbase_agent_send", input: input, inTok: 230, outTok: 28 });
    const response = await mcpCall("cbase_agent_send", input)
    toolResult("toolu_channel_01", mcpText(response));
    await waitForTruthy("opposite-finished");
    textBlock("Stand im Kanal gemeldet, ich arbeite weiter.", { input: 290, output: 10 });
    result("Stand im Kanal gemeldet.", { turns: 2 });
  },
  // Workflow (template workflow-engine-e2e.test.js, completion gate): every turn echoes its task — so the
  // recording shows WHAT each step was sent off with; the verdicts come from the oneshot above (first
  // "not done", then "done").
  async workflow(text) {
    init();
    const out = "ERLEDIGT: " + text.replace(/\s+/g, " ").slice(0, 120);
    textBlock(out, { input: 130, output: 20 });
    result(out);
  },
  // Graph workflow via /workflow: (template server/backend/test/graph-start-run.test.js): the start turn reads
  // the rewritten message of the message route, calls cbase_workflow_start via the real MCP server (the
  // server earmarks it) and ends with one line; at the turn end the workflow begins — its step is a
  // SEPARATE turn that echoes its task like the role workflow. So the recording shows that the start turn is
  // no step: "Gestartet." appears in no step log.
  async graph_start(text) {
    init();
    if (text.includes("[cbase: The human starts these graph workflows with /workflow:")) {
      const job = { workflow: "golden-graph", input: "bitte los" };
      toolUse({ id: "toolu_graph_start", name: "mcp__cbase__cbase_workflow_start", input: job, inTok: 150, outTok: 24 });
      let response = "";
      try { response = mcpText(await mcpCall("cbase_workflow_start", job, "toolu_graph_start")); }
      catch (e) { response = "ERROR " + e.message; }
      toolResult("toolu_graph_start", response);
      textBlock(response.includes("\"earmarked\"") ? "Gestartet." : "kein Start", { input: 200, output: 4 });
      result("Gestartet.", { turns: 2 });
      return;
    }
    const out = "ERLEDIGT: " + text.replace(/\s+/g, " ").slice(0, 120);
    textBlock(out, { input: 130, output: 20 });
    result(out);
  },
  // Native subagent (template native-agent-e2e.test.js): the main agent calls cbase_agent via the real MCP
  // server, the server starts a SECOND fake run as subagent (recognisable by the subagent system prompt),
  // mirrors its events under the call block and returns the report as tool result. Both processes are in
  // the spawn log.
  async subagent_native() {
    init();
    if (argv.join(" ").includes("SUBAGENT of cbase")) {
      toolUse({ id: "toolu_sub_read", name: "Read", input: { file_path: "/tmp/sub" }, inTok: 80, outTok: 12 });
      toolResult("toolu_sub_read", "read");
      textBlock("Befund 42: die Datei ist gelesen.", { input: 95, output: 11 });
      result("Befund 42: die Datei ist gelesen.", { turns: 2 });
      return;
    }
    // Foreground EXPLICITLY: without it the subagent would run in the background and this scenario would
    // silently become another — the background case is its own role subagent_background.
    toolUse({ id: "toolu_agent_call", name: "mcp__cbase__cbase_agent", input: { description: "Befund holen", prompt: "Sieh nach und melde den Befund.", run_in_background: false }, inTok: 150, outTok: 34 });
    let report = "";
    try { report = mcpText(await mcpCall("cbase_agent", { description: "Befund holen", prompt: "Sieh nach und melde den Befund.", run_in_background: false }, "toolu_agent_call")); }
    catch (e) { report = "ERROR " + e.message; }
    toolResult("toolu_agent_call", report);
    textBlock("Ergebnis: " + (report.includes("Befund 42") ? "Befund 42 erhalten" : "kein Befund"), { input: 240, output: 9 });
    result("finished", { turns: 2 });
  },
  // Background subagent (template server/backend/test/agent-lifetime.test.js): the main agent starts it without
  // run_in_background and ends its turn; the subagent waits until the main agent's run is completely over
  // (marker "sub-free" from the scenario — otherwise a race would decide whether the notice comes mid-turn or
  // after), and its completion notice (<task-notification>) becomes its OWN run: a third process.
  async subagent_background(text) {
    init();
    if (argv.join(" ").includes("SUBAGENT of cbase")) {
      await waitForTruthy("sub-free");
      textBlock("Befund 42: im Hintergrund gefunden.", { input: 90, output: 10 });
      result("Befund 42: im Hintergrund gefunden.");
      return;
    }
    if (text.startsWith("<task-notification>")) {
      textBlock("Meldung verarbeitet: " + (text.includes("Befund 42") ? "Befund 42" : "kein Befund"), { input: 260, output: 8 });
      result("Meldung verarbeitet.");
      return;
    }
    const job = { description: "Nebenher prüfen", prompt: "Sieh nach und melde den Befund." };
    toolUse({ id: "toolu_agent_bg", name: "mcp__cbase__cbase_agent", input: job, inTok: 150, outTok: 30 });
    let response = "";
    try { response = mcpText(await mcpCall("cbase_agent", job, "toolu_agent_bg")); }
    catch (e) { response = "ERROR " + e.message; }
    toolResult("toolu_agent_bg", response);
    textBlock(response.includes("\"started\": true") ? "Der Subagent läuft im Hintergrund." : "kein Start", { input: 200, output: 9 });
    result("finished", { turns: 2 });
  },
  // Dynamic workflow (template server/backend/test/dynworkflows-run.test.js): the main agent calls
  // cbase_dynamic_workflow via the real MCP server with a script of two agent() in sequence; the turn ends at
  // once. The workflow agents wait for the marker "sub-free" (only after the main agent's run end), then the
  // run ends: end marker, completion notice, follow-up turn. Of the workflow the chat stream shows ONLY the
  // start and end marker.
  async dynworkflow(text) {
    init();
    if (argv.join(" ").includes("SUBAGENT of cbase")) {
      await waitForTruthy("sub-free");
      const finding = text.includes("Lies B") ? "Befund B" : "Befund A";
      textBlock(finding + ": gelesen.", { input: 90, output: 6 });
      result(finding + ": gelesen.");
      return;
    }
    if (text.startsWith("<task-notification>")) {
      textBlock("Workflow ausgewertet: " + (text.includes("Befund B") ? "beide Befunde da" : "Befund fehlt"), { input: 280, output: 9 });
      result("Workflow ausgewertet.");
      return;
    }
    const job = { script: "export const meta = { name: 'findings-collect', description: 'Zwei Befunde nacheinander', phases: [{ title: 'Lesen' }] }\nconst a = await agent('Lies A', { label: 'eins' });\nconst b = await agent('Lies B', { label: 'zwei' });\nreturn { a, b };\n" };
    toolUse({ id: "toolu_dynwf", name: "mcp__cbase__cbase_dynamic_workflow", input: job, inTok: 150, outTok: 40 });
    let response = "";
    try { response = mcpText(await mcpCall("cbase_dynamic_workflow", job, "toolu_dynwf")); }
    catch (e) { response = "ERROR " + e.message; }
    toolResult("toolu_dynwf", response);
    textBlock(response.includes("\"started\"") ? "Der Workflow läuft im Hintergrund." : "kein Start", { input: 210, output: 8 });
    result("finished", { turns: 2 });
  },
  // Approval card (template server/backend/test/dynworkflows-approval.test.js): the main agent calls
  // cbase_dynamic_workflow in a chat WITHOUT ultracode mode and without keyword — the answer is "wartet auf
  // Freigabe" (the product's status string), the turn ends. The rejection arrives as a system notice
  // (<task-notification>) in its own run.
  async approval(text) {
    init();
    if (text.includes("<task-notification>")) {
      textBlock(text.includes("was rejected by the user") ? "Verstanden, ohne Workflow." : "unerwartete Meldung", { input: 240, output: 7 });
      result("ohne Workflow");
      return;
    }
    const job = { script: "export const meta = { name: 'findings-check', description: 'Zwei Befunde gegenlesen', phases: [{ title: 'Lesen' }, { title: 'Urteilen', detail: 'je Befund' }] }\nreturn await agent('Lies A');\n" };
    toolUse({ id: "toolu_wffrei", name: "mcp__cbase__cbase_dynamic_workflow", input: job, inTok: 150, outTok: 40 });
    let response = "";
    try { response = mcpText(await mcpCall("cbase_dynamic_workflow", job, "toolu_wffrei")); }
    catch (e) { response = "ERROR " + e.message; }
    toolResult("toolu_wffrei", response);
    textBlock(response.includes("awaiting_approval") ? "Der Workflow wartet auf deine Freigabe." : "kein Warten", { input: 210, output: 8 });
    result("finished", { turns: 2 });
  },
  // Schedule (template scheduled-run.test.js): the appointment of a scheduled job; the run row and the
  // notice carry the first paragraph.
  async schedule() {
    init();
    textBlock("Erster Absatz der Antwort.\n\nMore dazu im zweiten.", { input: 300, output: 12 });
    result("Erster Absatz der Antwort.\n\nMore dazu im zweiten.");
  },
  // Approval in the scheduled turn (template server/backend/test/scheduled.test.js (4)): the job's chat runs in
  // permission mode "default", i.e. with --permission-prompt-tool. The appointment wants to run a command; like
  // the real CLI the fake asks the prompt tool via the real MCP server (cbase_permission_prompt ⇒ POST
  // …/permission-request, a long poll), the card stands, the recorder releases it, and only with the decision
  // does the tool result arrive.
  async scheduled_approval() {
    init();
    const command = { command: "ls notizen", description: "Notizen für das Briefing ansehen" };
    toolUse({ id: "toolu_approval_bash", name: "Bash", input: command, inTok: 300, outTok: 24 });
    let response = "";
    try { response = mcpText(await mcpCall("cbase_permission_prompt", { tool_name: "Bash", input: command, tool_use_id: "toolu_approval_bash" })); }
    catch (e) { response = "ERROR " + e.message; }
    const allowed = /"behavior":\s*"allow"/.test(response);
    toolResult("toolu_approval_bash", allowed ? "montag.md\ndienstag.md" : "nicht freigegeben: " + response, { isError: !allowed });
    textBlock(allowed ? "Freigabe erhalten, zwei Notizen gelesen.\n\nDas Briefing folgt im Chat." : "Ohne Freigabe kein Briefing.", { input: 340, output: 14 });
    result(allowed ? "Freigabe erhalten, zwei Notizen gelesen.\n\nDas Briefing folgt im Chat." : "Ohne Freigabe kein Briefing.", { turns: 2 });
  },
  // Dismissed appointment (template server/backend/test/scheduled-run.test.js (2)): the human keeps the job's
  // chat busy with a turn of their own (marker "human-turn", wait for "dismissed-free") — in the gap the
  // appointment is queued and dismissed by the human. An appointment turn never arrives in this scenario.
  async scheduled_dismissed() {
    init();
    fs.writeFileSync(marker("human-turn"), "1");
    await waitForTruthy("dismissed-free");
    textBlock("Die Vorbereitung steht, das Briefing kann kommen.", { input: 220, output: 11 });
    result("Die Vorbereitung steht.");
  },
  // Autocompact → target gate (template autocompact.test.js, second test): the FIRST turn reports 150,000 input
  // tokens (75 % of Haiku, threshold 60 %) — after the run the server compacts, THEN the target gate judges
  // "open" and starts the continuation without resume, with the summary; its turn stays small, the second
  // verdict says "achieved" and clears the target.
  async targetGate(text) {
    init();
    const first = !text.includes("[Target gate]");
    textBlock(first ? "Antwort auf die erste Frage." : "Fortsetzung nach der Verdichtung: alles zu Ende gebracht.", { input: first ? 150000 : 10000, output: 14 });
    result(first ? "Antwort auf die erste Frage." : "Fortsetzung: alles zu Ende gebracht.");
  },

  // ── More run kinds and two hook scenarios ──────────
  // Filing files (a coding chat, projects/coding-jobs.js): reads the named file with the built-in Read
  // tool and summarises; the filing itself (cbase_workspace_context_add) stays unrecorded.
  async ingest(text) {
    init();
    const m = /(\S+\/note\.md)/.exec(text);
    toolUse({ id: "toolu_ingest_read", name: "Read", input: { file_path: m ? m[1] : "note.md" }, inTok: 160, outTok: 14 });
    toolResult("toolu_ingest_read", "# Kasse\nDas Testsystem steht seit dem 1. September.");
    textBlock("Eine Datei gelesen: Notiz zur Kasse (Testsystem steht) — in den Workspace-Kontext einsortiert.", { input: 210, output: 16 });
    result("Eine Datei gelesen und einsortiert.", { turns: 2 });
  },
  // Project chat with curator (CURATOR_ENABLED=1), UNTITLED, with a queued second message that runs as a
  // FOLLOW-UP RUN (new process, --resume); after the run end the curator oneshot, title oneshot and follow-up
  // run happen. A message arriving DURING the turn is injected by the server into the running process
  // (message_injected, same process — see the web role join); a run of its own (takeNextRunInput) only comes
  // about if the process ends before the queue is empty — the server calls that "error/abort/spawn race".
  // Exactly that window is what the fake plays: after the result the server closes stdin (cbaseEndInput),
  // the fake reports it (marker "stdin-closed") and holds its exit until "exit-free"; in the gap the recorder
  // queues message #2, which can no longer be injected (inputOpen=false). The follow-up turn (new process)
  // waits for "title-finished" (the recorder sets it after the chat_title) so the events come in a fixed
  // order; which process was started FIRST is told by the pid order in spawn.json.
  async curate() {
    if (count("ku-turns") === 0) {
      holdExit = true;
      init();
      textBlock("Entschieden: wir prüfen zuerst das Testsystem der Kasse, dann bauen wir um.", { input: 230, output: 17 });
      result("Entschieden: erst Testsystem, dann Umbau.");
      return;
    }
    await waitForTruthy("title-finished");
    init();
    textBlock("Gern kurz: Testsystem prüfen, dann Umbau.", { input: 260, output: 10 });
    result("Gern kurz: Testsystem prüfen, dann Umbau.");
  },
};
// The first process of the role curate holds its exit after the stdin end (see there).
let holdExit = false;

process.stdin.on("end", async () => {
  if (holdExit) { fs.writeFileSync(marker("stdin-closed"), "1"); await waitForTruthy("exit-free"); }
  process.exit(0);
});
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  log({ kind: "input", row: line });
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  turn += 1;
  const script = TURNS[SCENARIO];
  if (!script) { process.stderr.write(`unknown scenario: ${SCENARIO}\n`); process.exit(2); }
  await sleep(30);
  await script(textOf(msg));
});

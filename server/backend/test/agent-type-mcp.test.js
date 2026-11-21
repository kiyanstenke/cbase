// The coding MCP servers of an agent type (toolchain/agent-mcp.js, runs/agent-set.js codingSet). Occasion: a type
// "status scanner" brings the Teams tools along without every subagent inheriting Teams. The promises:
//
//   (1) A type with server X, "subagents inherit" off for X => a subagent of this type has X in the MCP file AND in the
//       allowlist — with Claude and with Codex (there the shell in the file; Codex reads no allowlist, the airlock cuts).
//   (2) A subagent without this type does not have X.
//   (3) A selection of single tools cuts: allowlist per tool instead of the whole server, the airlock passes on only the
//       selection and rejects every other call.
//   (4) A server that the client does not have is not given to the subagent — neither from the main run (switched-off
//       server) nor from the parent agent (depth 2, computation codingSet).
//   (5) Route: unknown server => 400 with plain text; a PUT without `mcp` leaves the choice standing (iOS does not send
//       the field); the "start" view names what a type brings along.
//
// Counter-proof (which sabotage turns which test red): in toolchain/mcp-config.js the old line
// `if ((role === "subagent" || role === "workflow") && s.subagentsInherit === false) continue;` instead of the
// codingChoice switch => (1) red ("pg missing in the scanner's file"); in toolchain/airlock-routes.js the old role line =>
// (1)/(3) red at the airlock.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { codingSet } from "../electron/server/runs/agent-set.js";
import * as store from "../electron/server/store.js";
import { writeMcpConfig } from "../electron/server/toolchain/mcp-config.js";
import { offering, airlockSituation, verdictsCall } from "../electron/server/toolchain/airlock-routes.js";
import { issue } from "../electron/server/toolchain/airlock-token.js";
import * as texts from "../electron/server/toolchain/airlock-texts.js";

// ── The computation (without a server) ──────────────────────────────────────────────────────────────────────────────────

test("codingSet: type ∩ client, otherwise \"subagents inherit\" — a child never gets more than its parent agent", () => {
  const server = [{ id: "teams", subagentsInherit: false }, { id: "git", subagentsInherit: true }, { id: "pg", subagentsInherit: false }];
  // Depth 1 (client = main run, parent null): the type brings teams whole and pg with a selection, everyone inherits git.
  const one = codingSet({ parent: null, type: { teams: null, pg: ["query"] }, server });
  assert.deepEqual(one, { teams: null, git: null, pg: ["query"] });
  assert.deepEqual(codingSet({ parent: null, type: null, server }), { git: null }, "without a type only what inherits");
  // Depth 2: the parent agent has teams only with "read" and no pg — the child gets at most that.
  const parent = { teams: ["read"], git: null };
  assert.deepEqual(codingSet({ parent, type: { teams: null, pg: null }, server }), { teams: ["read"], git: null }, "the client does not have pg");
  assert.deepEqual(codingSet({ parent, type: { teams: ["read", "send"] }, server }), { teams: ["read"], git: null }, "list ∩ list");
  assert.deepEqual(codingSet({ parent, type: { teams: ["send"] }, server }), { git: null }, "empty intersection => no server");
  // A grandchild without a type does NOT inherit teams from the typed parent agent: there "subagents inherit" is off.
  assert.deepEqual(codingSet({ parent, type: null, server }), { git: null });
  t_diag(`codingSet depth 1 ${JSON.stringify(one)}`);
});
function t_diag(row) { console.log(`[agent-type-mcp] ${row}`); }

// ── Through the real run ────────────────────────────────────────────────────────────────────────────────────────────────

const SUB = `
  const marker = (/Job ([A-Z0-9-]+)/.exec(text) || [])[1] || "?";
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers; } catch {}
  fs.writeFileSync(path.join(LOCATION, "view-" + marker + ".json"), JSON.stringify({ server: Object.keys(cfg), allowed: arg("--allowedTools"),
    onlyMain: ((/Only the main agent has these MCP servers: (.+?) — /.exec(joined) || [])[1]) || null }));
  say({ type: "assistant", message: { id: "t-" + marker, content: [{ type: "text", text: "Report " + marker }] } });
  finished();
  say({ type: "result", result: "Report " + marker, session_id: "s-" + marker });`;

// Only the FIRST turn of the test chat starts: the subagents' reports come as new turns (the main agent never waits), and the
// outer-loop agents of the workspace (run end) run the same fake CLI — each of them would otherwise start five new ones, without end.
const main = (jobs) => `
  if (turn > 1 || !JSON.stringify(msg).includes("TYPES-START")) { finished(); say({ type: "result", result: "ok", session_id: "main-session" }); return; }
  const jobs = ${JSON.stringify(jobs)}.map((a) => ({ ...a, input: { run_in_background: false, ...a.input } }));
  say({ type: "assistant", message: { id: "main-1", content: jobs.map((a) => ({ type: "tool_use", id: a.id, name: "mcp__cbase__cbase_agent", input: a.input })) } });
  const rs = await Promise.all(jobs.map((a) => mcpCall("cbase_agent", a.input)));
  say({ type: "user", message: { content: jobs.map((a, i) => ({ type: "tool_result", tool_use_id: a.id, content: textOf(rs[i]) })) } });
  say({ type: "assistant", message: { id: "main-2", content: [{ type: "text", text: "finished" }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

// Fake Codex as a subagent: which MCP servers it got from the -c arguments.
const fakeCodexSub = () => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const LOCATION = ${JSON.stringify(LOCATION)};
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
const joined = argv.join(" ");
const server = new Set();
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "-c") continue;
  const s = /^mcp_servers\\.([A-Za-z0-9_-]+)\\./.exec(argv[i + 1] || "");
  if (s) server.add(s[1]);
}
say({ type: "thread.started", thread_id: "codex-sub" });
say({ type: "turn.started" });
const marker = (/Job ([A-Z0-9-]+)/.exec(joined) || [])[1] || "CODEX";
if (joined.includes("SUBAGENT of cbase")) {
  const t = path.join(LOCATION, ".view-" + marker + ".part");
  fs.writeFileSync(t, JSON.stringify({ server: [...server] }));
  fs.renameSync(t, path.join(LOCATION, "view-" + marker + ".json"));
}
say({ type: "item.completed", item: { id: "response", type: "agent_message", text: "Report CODEX" } });
say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
`;

const viewOf = (root, marker) => JSON.parse(fs.readFileSync(path.join(root, `view-${marker}.json`), "utf8"));
const raw = (url, init) => fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close" } });

test("agent type with coding MCP servers: file, allowlist and airlock — also without \"subagents inherit\", never more than the client", { timeout: 120_000 }, async () => {
  const claude = fakeClaude({
    sub: SUB,
    main: main([
      { id: "toolu_scan", input: { description: "Scanner", prompt: "Job SCANNER", subagent_type: "scanner" } },
      { id: "toolu_choice", input: { description: "Selection", prompt: "Job SELECTION", subagent_type: "selection" } },
      { id: "toolu_foreign", input: { description: "Foreign", prompt: "Job FOREIGN", subagent_type: "foreign" } },
      { id: "toolu_without", input: { description: "Without type", prompt: "Job WITHOUT" } },
      { id: "toolu_codex", input: { description: "Codex", prompt: "Job CODEX", subagent_type: "scanner", model: "codex::gpt-5.6-sol" } },
    ]),
  });
  await withAgentsServer(async ({ base, chat, ws, root, waitForLog }) => {
    const sv = {};
    for (const name of ["pg", "git", "off"]) {
      const r = await json(`${base}/api/workspaces/${ws.id}/mcp-servers`, { method: "POST", body: JSON.stringify({ name, transport: "stdio", command: "node", args: ["-e", "0"] }) });
      sv[name] = r.server?.id || r.id;
      assert.equal(store.getMcpServerInternal(sv[name]).subagentsInherit, false, `${name}: "subagents inherit" is off`);
    }
    const type = (name, mcp) => json(`${base}/api/workspaces/${ws.id}/agents`, { method: "POST", body: JSON.stringify({ name, description: `Type ${name}`, body: "You review.", mcp }) });

    // (5) Route: an unknown server is a 400 with plain text; an unreadable value too.
    const wrong = await raw(`${base}/api/workspaces/${ws.id}/agents`, { method: "POST", body: JSON.stringify({ name: "broken", mcp: { "exists-not": null } }) });
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /Unbekannter MCP-Server: exists-not/);
    const form = await raw(`${base}/api/workspaces/${ws.id}/agents`, { method: "POST", body: JSON.stringify({ name: "broken", mcp: { [sv.pg]: "all" } }) });
    assert.equal(form.status, 400, "neither null nor a list");

    const scanner = await type("scanner", { [sv.pg]: null });
    assert.deepEqual(scanner.mcp, { [sv.pg]: null });
    await type("selection", { [sv.git]: ["read", "send"] });
    await type("foreign", { [sv.off]: null });
    // A PUT without `mcp` (like iOS) leaves the choice standing.
    const afterPut = await json(`${base}/api/workspaces/${ws.id}/agents/${scanner.id}`, { method: "PUT", body: JSON.stringify({ description: "fresh" }) });
    assert.deepEqual(afterPut.mcp, { [sv.pg]: null }, "a missing field is no instruction");
    // (4) "off" is switched off — the main run does not have it, so no subagent either.
    await json(`${base}/api/mcp-servers/${sv.off}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });

    // (5) "start" view: what a type brings along, with names — and only what the chat has.
    const start = await json(`${base}/api/chats/${chat.id}/agents`);
    const row = (n) => start.types.find((x) => x.name === n);
    assert.deepEqual(row("scanner").mcp, [{ server: "pg", tools: "all" }]);
    assert.deepEqual(row("selection").mcp, [{ server: "git", tools: ["read", "send"] }]);
    assert.equal(row("foreign").mcp, undefined, "a switched-off server is not listed");

    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "TYPES-START" }) });
    await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
    // The subagents run in the background (the main agent never waits) — wait for their view files, not for a duration.
    const MARKERS = ["SCANNER", "SELECTION", "FOREIGN", "WITHOUT", "CODEX"];
    await waitForTruthy(() => MARKERS.every((m) => fs.existsSync(path.join(root, `view-${m}.json`))), "view files of all five subagents");
    const s = Object.fromEntries(MARKERS.map((m) => [m, viewOf(root, m)]));
    t_diag(`scanner ${JSON.stringify(s.SCANNER.server)} allowed ${s.SCANNER.allowed}; selection ${JSON.stringify(s.SELECTION.server)} allowed ${s.SELECTION.allowed}; without ${JSON.stringify(s.WITHOUT.server)}; Codex ${JSON.stringify(s.CODEX.server)}`);

    // (1) The type brings pg along — file and allowlist, Claude and Codex.
    assert.ok(s.SCANNER.server.includes("pg"), "pg is in the scanner's file");
    assert.ok(s.SCANNER.allowed.split(",").includes("mcp__pg"), "pg is in the scanner's allowlist");
    assert.ok(!s.SCANNER.server.includes("git"), "the scanner does not bring git along (and does not inherit it)");
    assert.equal(s.SCANNER.onlyMain, "git", "the frame names what only the main agent has");
    assert.ok(s.CODEX.server.includes("pg"), "Codex: the shell of pg is in its file");
    // (3) Selection: per tool in the allowlist, not the whole server.
    const allowedChoice = s.SELECTION.allowed.split(",");
    assert.ok(s.SELECTION.server.includes("git"));
    assert.ok(allowedChoice.includes("mcp__git__read") && allowedChoice.includes("mcp__git__send"));
    assert.ok(!allowedChoice.includes("mcp__git"), "not the whole server");
    // (2) Without a type: neither of the two (switch off).
    assert.ok(!s.WITHOUT.server.includes("pg") && !s.WITHOUT.server.includes("git"));
    assert.ok(!s.WITHOUT.allowed.split(",").some((n) => n.startsWith("mcp__pg") || n.startsWith("mcp__git")));
    // (4) Switched off: the type does not carry it through.
    assert.ok(!s.FOREIGN.server.includes("off"));

    // (1)/(3) at the airlock: the type agent's token carries pg through without the switch, the selection cuts tools/list and the call.
    const set = store.effectiveMcpServers(ws.id, null);
    const cfg = (n) => path.join(root, `${n}.mcp.json`);
    const tokenOf = (servers, name) => servers[name]?.env?.CBASE_AIRLOCK;
    const scanCoding = codingSet({ parent: null, type: { [sv.pg]: null }, server: set });
    const scanFile = writeMcpConfig(cfg("scan"), { chatId: chat.id, workspaceId: ws.id, extraServers: set, agentDepth: 1, profileKey: `${chat.id}-agent-s1`, agentId: "s1", codingChoice: scanCoding, fromType: [sv.pg] });
    const situationScan = airlockSituation(chat.id, tokenOf(scanFile.servers, "pg"), sv.pg);
    assert.equal(situationScan.not, undefined, "brought along by the type: no rejection despite \"subagents inherit\" off");
    const choiceCoding = codingSet({ parent: null, type: { [sv.git]: ["read", "send"] }, server: set });
    const choiceFile = writeMcpConfig(cfg("choice"), { chatId: chat.id, workspaceId: ws.id, extraServers: set, agentDepth: 1, profileKey: `${chat.id}-agent-w1`, agentId: "w1", codingChoice: choiceCoding, fromType: [sv.git] });
    const situationChoice = airlockSituation(chat.id, tokenOf(choiceFile.servers, "git"), sv.git);
    const gitServer = store.getMcpServerInternal(sv.git);
    assert.deepEqual(offering(situationChoice, gitServer, [{ name: "read" }, { name: "send" }, { name: "third" }]).map((w) => w.name), ["read", "send"]);
    const third = await verdictsCall(situationChoice, "third", {}, null);
    assert.deepEqual(third, { free: false, text: texts.typeNotSelected("third", "git") });
    assert.equal((await verdictsCall(situationChoice, "read", { a: 1 }, null)).free, true, "counter-check: a chosen tool goes through");
    // (2) Counter-check at the airlock: a subagent without a type (token without fromType) is rejected at pg.
    const withoutType = issue({ chatId: chat.id, role: "subagent", agentId: "o1", workspaceId: ws.id });
    assert.equal(airlockSituation(chat.id, withoutType, sv.pg).not, texts.onlyMain("pg"));
    // Without a computed set the file stays as before: no pg.
    assert.equal(writeMcpConfig(cfg("old"), { chatId: chat.id, workspaceId: ws.id, extraServers: set, agentDepth: 1, profileKey: `${chat.id}-agent-a1`, agentId: "a1" }).servers.pg, undefined);

    // A deleted server falls out of every choice (otherwise the type could no longer be changed by saving).
    await json(`${base}/api/mcp-servers/${sv.pg}`, { method: "DELETE" });
    assert.deepEqual(store.getAgent(scanner.id).mcp, {});
  }, { claude, codex: fakeCodexSub() });
});

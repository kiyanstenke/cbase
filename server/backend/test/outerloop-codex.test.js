// Codex as an outer-loop provider. Through the real server, the real core and the real spec factory (runs/agents.js); only the
// CLI is faked (agent-harness.mjs fakeCodex, which records its argv):
//   (1) without selected built-ins: argv carries CODEX_WITHOUT_FILE_ACCESS (shell and view_image off, measured at pin 0.153.1 —
//       on the wire; the goal tools too) and `-s read-only`; the frame
//       says "no commands and no file access" and NAMES apply_patch and the resource tools that Codex cannot switch off at the
//       pin (a "no built-in tools" line would be wrong)
//   (2) with selected built-ins: the shell stays (Codex has no allowlist) and the frame NAMES it with the read/write level —
//       EVERY built-in tool on the wire (CODEX_WITH_CHOICE_ON_WIRE below, measured); `Read` alone => read-only, `Edit` as well
//       => workspace-write — execution and description from ONE list (input.js CODEX_WRITES, run.js imports it)
//   (3) an HTTP server with headers: `env_http_headers` with the NAME of an environment variable in argv, the value only in the
//       environment of the Codex process (measured against the real CLI); without headers argv is unchanged
//
// COUNTER-TESTS (which sabotage turns which test red):
//   runs/agents.js without the line `codexWithoutFileAccess`               => (1) red (no `--disable shell_tool` in argv)
//   outerloop/input.js builtinRow without the Codex branch                 => (2) red (the frame says every other built-in tool
//                                                                             is refused, the shell is missing)
//   connectors/codex.js pushMcpConfig without the line `env_http_headers`  => (3) red
//   builtinRow without the branch "Codex without selection"               => (1) red ("no built-in tools" for Codex)
//   CODEX_WITHOUT_FILE_ACCESS without `--disable goals`                    => (1) red
//   buildCodexChatArgs without CODEX_WITHOUT_OWN_TOOLS in a run with selection => (2) red
//   builtinRow with the old wording "its shell and apply_patch"            => (2) red (exec_command, write_stdin, view_image and
//                                                                             the three resource tools are missing)
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/outerloop-codex.test.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { CODEX_WITHOUT_FILE_ACCESS, buildCodexChatArgs, mcpSecretEnvironment } from "../electron/server/providers/connectors/codex.js";
import { FRAME_IDENTIFIER_LINE } from "../electron/server/outerloop/input.js";
import { startOuterLoopRun } from "../electron/server/outerloop/run.js";
import { fakeCodex, withAgentsServer } from "./agent-harness.mjs";

const MODEL = "gpt-5.6-sol";
// The fake Codex writes its argv (hence the prompt with the frame, the last positional) to codex-argv-<pid>.json.
const CODEX = fakeCodex({ text: "Note from the Codex run." }).replace(
  "const argv = process.argv.slice(2);",
  "const argv = process.argv.slice(2); fs.writeFileSync(path.join(LOCATION, \"codex-argv-\" + process.pid + \".json\"), JSON.stringify(argv));",
);

const isClosed = (id) => ["finished", "error", "aborted"].includes(store.outerLoopRun(id)?.state);
const containsFollowUp = (list, followUp) => list.some((_, i) => followUp.every((x, j) => list[i + j] === x));

function activeAgent(ws, chat, fields) {
  const a = store.createOuterLoopAgent({ workspaceId: ws.id, name: "Codex reviewer", trigger: [{ kind: "quiet", minutes: 5 }], provider: "codex", model: MODEL, ...fields });
  store.setOuterLoopActive(a.id, chat.id, true, 0);
  return a;
}

// A run to its end => the argv of this run's CLI (the only one with the outer-loop frame).
async function run({ ws, chat, root, waitForTruthy }, fields) {
  for (const n of fs.readdirSync(root)) if (/^codex-argv-\d+\.json$/.test(n)) fs.rmSync(path.join(root, n));
  store.addMessage(chat.id, "user", `Please rebuild the checkout (${fields.id}).`, Date.now());
  const a = activeAgent(ws, chat, fields);
  const r = await startOuterLoopRun({ agent: a, chat, trigger: "quiet" });
  assert.equal(r.started, true, JSON.stringify(r));
  await waitForTruthy(() => isClosed(r.runId), "run finished");
  const l = store.outerLoopRun(r.runId);
  assert.equal(l.state, "finished", JSON.stringify(l));
  const argvs = fs.readdirSync(root).filter((n) => /^codex-argv-\d+\.json$/.test(n)).map((n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8")));
  const argv = argvs.find((x) => String(x[x.length - 1]).includes(FRAME_IDENTIFIER_LINE));
  assert.ok(argv, `no Codex call with the outer-loop frame (${argvs.length} calls)`);
  return { argv, prompt: String(argv[argv.length - 1]), run: l };
}

test("(1) Codex without selected built-ins: shell and view_image off, read-only — and the frame says what is true", async () => {
  await withAgentsServer(async (ctx) => {
    const { argv, prompt } = await run(ctx, { id: "c1000000-0000-4000-8000-000000000001" });
    assert.ok(containsFollowUp(argv, CODEX_WITHOUT_FILE_ACCESS), `CODEX_WITHOUT_FILE_ACCESS missing in argv: ${argv.slice(0, 30).join(" ")}`);
    assert.ok(containsFollowUp(argv, ["--disable", "shell_tool"]), "the shell is off (measured: --disable shell_tool removes exec_command)");
    assert.ok(containsFollowUp(argv, ["-s", "read-only"]), "read-only");
    // The goal tools are off (measured: --disable goals removes create_goal ...), and the frame names what Codex still
    // offers — "no built-in tools" would be wrong for Codex.
    assert.ok(containsFollowUp(argv, ["--disable", "goals"]), "the goal tools are off (sp7-codex-builtins.cjs)");
    assert.match(prompt, /Keine Befehle und kein Dateizugriff: Codex hat in diesem Lauf keine Shell und liest keine Datei\./);
    assert.match(prompt, /apply_patch an — der Sandkasten ist nur lesend und lehnt jede Änderung ab/);
    assert.match(prompt, /list_mcp_resources, list_mcp_resource_templates und read_mcp_resource/);
    assert.doesNotMatch(prompt, /Keine eingebauten Werkzeuge/, "the line for Claude/engine would be wrong for Codex (apply_patch is on the wire)");
    assert.doesNotMatch(prompt, /Codex kennt keine einzelnen eingebauten Werkzeuge/);
  }, { codex: CODEX });
});

// What Codex offers on the wire WITH selected built-ins (without the MCP tools of the run and the `exec`/`wait` wrappers of code
// mode): `ALL_TOOLS` in read-only AND workspace-write with CODEX_WITHOUT_OWN_TOOLS, measured at 0.162.1 and 0.153.1
// (on the wire). Literal here, not from input.js — a name that disappears there should
// turn this test red. A CLI jump measures the list anew.
const CODEX_WITH_CHOICE_ON_WIRE = ["exec_command", "write_stdin", "apply_patch", "view_image", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

test("(2) Codex with selected built-ins: the shell stays, the frame names it — Read => read-only, Edit => writing", async () => {
  await withAgentsServer(async (ctx) => {
    const read = await run(ctx, { id: "c2000000-0000-4000-8000-000000000002", builtin: ["Read"] });
    assert.equal(read.argv.includes("shell_tool"), false, "with a selection the shell stays (Codex has no allowlist)");
    // Codex's goal and question tools are off WITH a selection too (CODEX_WITHOUT_OWN_TOOLS in every run) — the frame does not
    // name them, and they are no longer on the wire.
    assert.ok(containsFollowUp(read.argv, ["--disable", "goals"]), "with selection: goal tools off");
    assert.ok(containsFollowUp(read.argv, ["-c", "tools.experimental_request_user_input.enabled=false"]), "with selection: request_user_input off");
    assert.doesNotMatch(read.prompt, /request_user_input|create_goal/, "the frame names neither of the two");
    assert.ok(containsFollowUp(read.argv, ["-s", "read-only"]));
    assert.match(read.prompt, /Codex kennt keine einzelnen eingebauten Werkzeuge: statt der gewählten \(Read\) hast du seine Shell/);
    // Wording = offering: the head says "you have no more" — every built-in tool on the wire is in the line, by name.
    const row = read.prompt.split("\n").find((z) => z.includes("Codex kennt keine einzelnen eingebauten Werkzeuge")) || "";
    for (const name of CODEX_WITH_CHOICE_ON_WIRE) assert.ok(new RegExp(`\\b${name}\\b`).test(row), `the frame omits ${name}: ${row}`);
    assert.match(row, /lesen nur, was die MCP-Server dieses Laufs als Ressource anbieten/);
    assert.match(read.prompt, /nur lesend/);
    assert.match(read.prompt, /Die Shell liest jede Datei, die dein Prozess lesen darf/);
    assert.doesNotMatch(read.prompt, /Jedes andere eingebaute Werkzeug wird abgelehnt/, "the line for Claude/engine would be wrong for Codex");

    const write = await run(ctx, { id: "c3000000-0000-4000-8000-000000000003", builtin: ["Read", "Edit"] });
    assert.ok(containsFollowUp(write.argv, ["-s", "workspace-write"]), "Edit ⇒ workspace-write (E9)");
    assert.match(write.prompt, /schreibend im Arbeitsordner/);
    const rowWrite = write.prompt.split("\n").find((z) => z.includes("Codex kennt keine einzelnen eingebauten Werkzeuge")) || "";
    for (const name of CODEX_WITH_CHOICE_ON_WIRE) assert.ok(new RegExp(`\\b${name}\\b`).test(rowWrite), `the frame (writing) omits ${name}`);
  }, { codex: CODEX });
});

test("(3) an HTTP server with headers: env_http_headers with the NAME in argv, the value only in the environment", () => {
  const servers = {
    teams: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer SECRET-123" } },
    without: { type: "http", url: "http://127.0.0.1:9/without" },
  };
  const args = buildCodexChatArgs({ cwd: "/tmp", permissionMode: "default", mcpServers: servers });
  const row = args.find((a) => a.startsWith("mcp_servers.teams.env_http_headers="));
  assert.equal(row, 'mcp_servers.teams.env_http_headers={ "Authorization" = "CBASE_MCP_HEADER_0_TEAMS_AUTHORIZATION" }');
  assert.equal(args.join(" ").includes("SECRET-123"), false, "the token never appears in argv");
  assert.equal(args.some((a) => a.startsWith("mcp_servers.without.env_http_headers")), false, "without headers argv stays as before");
  assert.deepEqual(mcpSecretEnvironment(servers), { CBASE_MCP_HEADER_0_TEAMS_AUTHORIZATION: "Bearer SECRET-123" });
  // Without selection/switch: no CODEX_WITHOUT_FILE_ACCESS (a coding chat keeps its shell).
  assert.equal(args.includes("shell_tool"), false);
});

test("(4) ONE list of writing built-ins for execution (run.js) and frame (input.js)", () => {
  const source = (rel) => fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "electron", "server", rel), "utf8");
  const runJs = source("outerloop/run.js");
  assert.match(runJs, /import \{[^}]*\bCODEX_WRITES\b[^}]*\} from "\.\/input\.js"/, "run.js reads the list from input.js");
  assert.doesNotMatch(runJs, /const CODEX_WRITES\s*=/, "run.js carries no version of its own"
);
});

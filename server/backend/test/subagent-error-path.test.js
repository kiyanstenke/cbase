// The error path of a subagent up to the parent agent.
//
// agent-runtime reports a subagent whose CLI dies at the usage limit as `status:"failed"` with the wording in `error`.
// For the parent run to turn that into a limit proof (runs/do-run.js keeps a subagent report only with `is_error` on the
// tool_result), the status must become `isError:true` at the hand-over point — before, it never did:
//   cbase-mcp.js, tools/call: a handler's result went out without `isError`; only a thrown error became one. But the route
//   POST /agent answers 201 regardless of the status. Now the report carries the marker `__isError:true` (agentReport),
//   tools/call reads it, strips it and answers `isError:true` — the report stays complete.
// (The engine's own hand-over to the subagent core is gone: the engine starts subagents via cbase_agent, i.e. through the
// MCP path above. The path up to the engine's parent agent is held by engine-task-core.test.js.)
// Counter-proof: without the marker handling in tools/call all cases are red (isError false / undefined).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));
const LIMIT = "Claude usage limit reached · resets at 2026-09-14T19:40:00Z";

// ── Part 1: the MCP server (stdio) against a stub of the subagent routes ────────────────
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
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    // The deadline THROWS — otherwise the test would report a functional error where only the clock ran out.
    setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 15_000).unref();
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  // Return `isError` RAW (not Boolean()): an absent field and `false` differ, and exactly that difference is the test
  // subject here.
  const call = async (name, args = {}) => {
    const res = await rpc("tools/call", { name, arguments: args });
    return { isError: res.result?.isError, content: res.result?.content || [] };
  };
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18" });
    await run({ call });
  } finally {
    child.kill();
  }
}

// Stub of the subagent routes: answers per path with what the test puts in — with 201 or 200 like the real server,
// REGARDLESS of the report's status (that is the gap).
async function withStub(responses, run) {
  const seen = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader("Content-Type", "application/json");
      const m = /\/api\/chats\/[^/]+\/(agent(?:\/output|\/send|\/stop)?)$/.exec(req.url || "");
      const rep = m && responses[m[1]];
      if (rep) { res.statusCode = m[1] === "agent" ? 201 : 200; return res.end(JSON.stringify(rep)); }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "nope" }));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${stub.address().port}`, seen);
  } finally {
    await new Promise((r) => stub.close(r));
  }
}

const report = (status, extra = {}) => ({
  status, error: status === "failed" ? LIMIT : "", agentId: "a1b2c3d4-1", name: "agent-1", description: "subtask",
  agentType: "general-purpose", provider: "claude", resolvedModel: "", skills: [],
  report: status === "completed" ? "REPORT of the subagent" : "", totalTokens: 12, tokenKind: "full",
  totalToolUseCount: 1, totalDurationMs: 800, cwd: "/x", worktree: "", outputFile: "", notes: status === "failed" ? `Error: ${LIMIT}` : "", note: "",
  ...extra,
});

test("MCP: a failed subagent report goes out as isError:true — complete, without the marker", async () => {
  await withStub({ agent: report("failed") }, async (base) => {
    await withMcp({ CBASE_CHAT_ID: "c1", CBASE_BASE_URL: base }, async ({ call }) => {
      const r = await call("cbase_agent", { prompt: "do that", description: "subtask" });
      assert.equal(r.isError, true, "status:failed must be an error result (old behavior: field missing)");
      assert.equal(r.content.length, 1);
      assert.equal(r.content[0].type, "text");
      const text = r.content[0].text;
      assert.ok(!text.includes("__isError"), `the marker must not be in the text:\n${text}`);
      // The report stays COMPLETE: the main agent reads the reason from it.
      const rep = JSON.parse(text);
      assert.equal(rep.status, "failed");
      assert.equal(rep.error, LIMIT);
      assert.equal(rep.agentId, "a1b2c3d4-1");
      assert.match(text, /usage limit reached/);
    });
  });
});

test("MCP: completed, running and stopped stay ordinary results — only \"failed\" is an error", async () => {
  const running = { status: "running", agentId: "a1b2c3d4-1", name: "agent-1", description: "subtask", agentType: "general-purpose", provider: "claude", resolvedModel: "", note: "still running", started: true, background: true };
  await withStub({ agent: report("completed"), "agent/output": running, "agent/send": report("stopped", { error: "Stopped by the human. No result." }) }, async (base) => {
    await withMcp({ CBASE_CHAT_ID: "c1", CBASE_BASE_URL: base }, async ({ call }) => {
      const finished = await call("cbase_agent", { prompt: "do that" });
      assert.equal(finished.isError, undefined, "a finished report is not an error — and the answer shape stays as before (no isError field)");
      assert.equal(JSON.parse(finished.content[0].text).report, "REPORT of the subagent");
      assert.ok(!finished.content[0].text.includes("__isError"));

      const running = await call("cbase_agent_output", { agentId: "a1b2c3d4-1", block: false });
      assert.equal(running.isError, undefined, "\"still running\" is not an error");
      assert.equal(JSON.parse(running.content[0].text).status, "running");

      // A deliberate stop is not an error: its result ("Stopped by the human") is in the report, and runs/do-run.js
      // must not keep it as a limit proof.
      const stopped = await call("cbase_agent_send", { agentId: "a1b2c3d4-1", message: "further" });
      assert.equal(stopped.isError, undefined, "stopped is not an error");
      assert.equal(JSON.parse(stopped.content[0].text).status, "stopped");
    });
  });
});

test("MCP: the collected (cbase_agent_output) and the follow-up (cbase_agent_send) report carry the error too", async () => {
  await withStub({ "agent/output": report("failed"), "agent/send": report("failed") }, async (base, seen) => {
    await withMcp({ CBASE_CHAT_ID: "c1", CBASE_BASE_URL: base }, async ({ call }) => {
      const collected = await call("cbase_agent_output", { agentId: "a1b2c3d4-1" });
      assert.equal(collected.isError, true, "a failed report collected via output is an error");
      assert.ok(!collected.content[0].text.includes("__isError"));
      assert.equal(JSON.parse(collected.content[0].text).error, LIMIT);

      const sentLater = await call("cbase_agent_send", { agentId: "a1b2c3d4-1", message: "further" });
      assert.equal(sentLater.isError, true, "a failed follow-up task is an error");
      assert.ok(!sentLater.content[0].text.includes("__isError"));
    });
    // The arguments go to the routes unchanged — the marker belongs to the ANSWER, not the call.
    assert.deepEqual(seen.map((s) => s.url.split("/").slice(-1)[0]), ["output", "send"]);
    assert.equal(seen[1].body.message, "further");
  });
});

test("MCP: a thrown error (route answers 4xx) stays what it was — error text with isError:true", async () => {
  await withStub({}, async (base) => {
    await withMcp({ CBASE_CHAT_ID: "c1", CBASE_BASE_URL: base }, async ({ call }) => {
      const r = await call("cbase_agent", { prompt: "do that" });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /^Error: nope/);
    });
  });
});

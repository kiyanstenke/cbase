// Tools and window of the agent browser - toolchain/playwright.js `playwrightMcpEntry` against the REAL @playwright/mcp of the
// pinned version.
//
// Promises, each with the way that breaks it:
//   (1) the configuration carries `capabilities` = network, storage, testing, vision - in the own profile AND on the user's
//       browser (cdpEndpoint); the own window is 1440x900, on the user's browser there is no window (theirs applies).
//       Counter-test: `cfg.capabilities = ...` removed => red; window also with cdp => red.
//   (2) the real MCP offers the tools of the four groups with this configuration (one checked each) and NONE from devtools/pdf;
//       without `capabilities` they would be missing (the MCP gives only core* by default). tools/list starts no browser.
//       Counter-test: a group removed from PLAYWRIGHT_CAPABILITIES => red.
//   (3) (inside test (2)) the fixed name list toolchain/playwright-tools.js (the Codex prefix names it, codex-prefix.js) is exactly
//       `tools/list` of this configuration, in the same order.
//       Counter-test: a name removed from PLAYWRIGHT_TOOLS => red.
//
// The server (withServer) sets the data folders the configuration file lives in.
// Run: CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/playwright-capabilities.test.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PLAYWRIGHT_CAPABILITIES, playwrightMcpEntry } from "../electron/server/toolchain/playwright.js";
import { PLAYWRIGHT_TOOLS } from "../electron/server/toolchain/playwright-tools.js";
import { withServer } from "./server-harness.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-pw-capable-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const config = (entry) => JSON.parse(fs.readFileSync(entry.args[entry.args.indexOf("--config") + 1], "utf8"));

test("(1) capabilities in both modes, window 1440x900 only in the own profile", () => withServer(async () => {
  assert.deepEqual([...PLAYWRIGHT_CAPABILITIES], ["network", "storage", "testing", "vision"]);
  const own = config(playwrightMcpEntry("npx", { userDataDir: path.join(tmp, "profile", "chat-a") }));
  assert.deepEqual(own.capabilities, ["network", "storage", "testing", "vision"]);
  assert.deepEqual(own.browser.contextOptions, { viewport: { width: 1440, height: 900 } });
  const user = config(playwrightMcpEntry("npx", { userDataDir: path.join(tmp, "profile", "chat-b"), cdpEndpoint: "http://127.0.0.1:9" }));
  assert.deepEqual(user.capabilities, ["network", "storage", "testing", "vision"]);
  assert.equal(user.browser.contextOptions, undefined, "on the user's browser their window applies");
  assert.equal(user.browser.cdpEndpoint, "http://127.0.0.1:9");
}));

test("(2) the real MCP offers the four groups, not devtools and pdf", { timeout: 300_000 }, () => withServer(async () => {
  const entry = playwrightMcpEntry("npx", { userDataDir: path.join(tmp, "profile", "chat-c") });
  const child = spawn(process.env.NPX_BIN || entry.command, entry.args, { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", stderr = "";
  const wait = new Map();
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const z = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(z); wait.get(m.id)?.(m); wait.delete(m.id); } catch { /* not a JSON row */ }
    }
  });
  const ended = new Promise((r) => child.on("exit", () => { for (const f of wait.values()) f({ error: { message: stderr.slice(-400) } }); r(); }));
  let nid = 1;
  const rpc = (method, params) => new Promise((resolve) => { const id = nid++; wait.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cbase-test", version: "1" } });
    assert.ok(!init.error, JSON.stringify(init.error));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const r = await rpc("tools/list", {});
    assert.ok(!r.error, JSON.stringify(r.error));
    const names = new Set(r.result.tools.map((t) => t.name));
    for (const n of ["browser_navigate", "browser_take_screenshot", "browser_route", "browser_cookie_list", "browser_verify_text_visible", "browser_mouse_click_xy"]) {
      assert.ok(names.has(n), `${n} missing (${[...names].join(", ")})`);
    }
    for (const n of ["browser_start_video", "browser_start_tracing", "browser_pdf_save", "browser_get_config"]) assert.ok(!names.has(n), `${n} should be missing`);
    // (3) The fixed name list of the Codex prefix is EXACTLY this offer (set and order).
    assert.deepEqual([...PLAYWRIGHT_TOOLS], r.result.tools.map((t) => t.name),
      "update toolchain/playwright-tools.js PLAYWRIGHT_TOOLS - the Codex prefix names these names (codex-prefix.js)");
  } finally {
    child.stdin.end();
    try { child.kill("SIGTERM"); } catch { /* gone */ }
    await ended;
  }
}));

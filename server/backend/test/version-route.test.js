// What the backend says it runs (VERSIONING.md): GET /api/version (the product version and the API level), and the product
// version in the MCP handshake (serverInfo of the cbase MCP server, clientInfo of the engine's MCP client) instead of a
// hard-coded "1.0.0".
//
// The backend knows no build id: the image carries no build stamp (it would change the image on every deploy). The route
// answers exactly { version, api } — a build field coming back would claim knowledge the backend does not have.
//
// COUNTER-PROOFS (each turns the named test red): the route not registered in ROUTES ⇒ 404 in "GET /api/version"; a `build`
// or `schema` field back in the answer ⇒ the key list in "GET /api/version"; SERVER_INFO or CLIENT_INFO back to "1.0.0" ⇒ the
// two MCP tests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { API_LEVEL } from "../electron/server/api-level.js";
import { readVersionInfo } from "../electron/server/version.js";
import { makeClient } from "../electron/server/providers/mcp-client.js";
import { MCP_SCRIPT, withServer } from "./server-harness.mjs";

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(BACKEND, "package.json"), "utf8")).version;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cbase-version-"));
}

test("API level: level 1, oldest 1, frozen", () => {
  assert.deepEqual({ ...API_LEVEL }, { level: 1, oldest: 1 });
  assert.ok(Object.isFrozen(API_LEVEL), "a module that hands out a mutable object lets one route change the level for all");
});

test("readVersionInfo: the version of package.json and the API level; null for an unreadable package.json", () => {
  const dir = tmpDir();
  try {
    const packageFile = path.join(dir, "package.json");
    fs.writeFileSync(packageFile, JSON.stringify({ version: "9.8.7" }));
    assert.deepEqual(readVersionInfo({ packageFile }), { version: "9.8.7", api: { level: 1, oldest: 1 } });
    fs.writeFileSync(packageFile, "{broken");
    assert.deepEqual(readVersionInfo({ packageFile }), { version: null, api: { level: 1, oldest: 1 } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("GET /api/version on the real server: exactly { version, api }", async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(`${base}/api/version`);
    assert.equal(r.status, 200, await r.clone().text());
    const body = await r.json();
    assert.deepEqual(body, { version: PACKAGE_VERSION, api: { level: API_LEVEL.level, oldest: API_LEVEL.oldest } });
  });
});

test("the cbase MCP server answers initialize with the product version as serverInfo", async () => {
  const child = spawn(process.execPath, [MCP_SCRIPT], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CBASE_BASE_URL: "http://127.0.0.1:9" } });
  try {
    const line = await new Promise((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) resolve(buf.slice(0, i)); });
      child.on("exit", (code) => reject(new Error(`MCP server ended (${code}) before answering`)));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } })}\n`);
    });
    const info = JSON.parse(line).result.serverInfo;
    assert.deepEqual(info, { name: "cbase", version: PACKAGE_VERSION });
  } finally { child.kill("SIGKILL"); }
});

test("the engine's MCP client sends the product version as clientInfo", async () => {
  const dir = tmpDir();
  const seen = path.join(dir, "initialize.json");
  // A stdio MCP server that writes down the initialize params and answers.
  const server = `const fs=require("node:fs");let b="";process.stdin.on("data",(d)=>{b+=d;let i;while((i=b.indexOf("\\n"))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==="initialize"){fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify(m.params));process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-06-18",capabilities:{},serverInfo:{name:"probe",version:"0"}}})+"\\n");}}});`;
  const client = makeClient("probe", { command: process.execPath, args: ["-e", server] }, { cwd: dir });
  try {
    await client.start();
    assert.deepEqual(JSON.parse(fs.readFileSync(seen, "utf8")).clientInfo, { name: "cbase-engine", version: PACKAGE_VERSION });
  } finally {
    try { client.child?.kill("SIGKILL"); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

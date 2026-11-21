import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startServer } from "../electron/server/server.js";

// Capture tools through the real MCP server (stdio): visibility (toolset/subagent), image pass-through as an MCP image
// block (__content), text fallback for providers without image understanding (CBASE_VISION=0) and against the real cbase
// server: cbase_capture_send no longer exists, the caption from cbase_screenshot/cbase_recording_stop goes into the manifest.

const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));

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
    setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 15_000).unref();
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  // Return full content blocks — the image pass-through is exactly the test subject here.
  const call = async (name, args = {}) => {
    const res = await rpc("tools/call", { name, arguments: args });
    return { isError: Boolean(res.result?.isError), content: res.result?.content || [] };
  };
  const listTools = async () => ((await rpc("tools/list", {})).result?.tools || []).map((t) => t.name);
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18" });
    await run({ call, listTools });
  } finally {
    child.kill();
  }
}

const CAPTURE_TOOLS = ["cbase_screenshot", "cbase_recording_start", "cbase_recording_stop"];

test("visibility: full catalog yes, subagent records; capture_send exists nowhere", async () => {
  await withMcp({ CBASE_CHAT_ID: "c1", CBASE_BASE_URL: "http://127.0.0.1:1" }, async ({ listTools }) => {
    const names = await listTools();
    for (const t of CAPTURE_TOOLS) assert.ok(names.includes(t), `${t} missing from the catalog`);
    assert.ok(!names.includes("cbase_capture_send"), "cbase_capture_send is gone");
  });
  await withMcp({ CBASE_CHAT_ID: "c1", CBASE_BASE_URL: "http://127.0.0.1:1", CBASE_AGENT_DEPTH: "1" }, async ({ listTools }) => {
    const names = await listTools();
    assert.ok(names.includes("cbase_screenshot"), "a subagent may record");
    assert.ok(names.includes("cbase_recording_start"));
    assert.ok(!names.includes("cbase_capture_send"));
  });
});

test("image pass-through: screenshot as an image block, CBASE_VISION=0 as text", async () => {
  // The stub server plays the capture routes — only the MCP side counts here (blocks, fallback).
  const capture = { id: "c-stub", w: 640, h: 480, url: "http://x/", title: "Stub", durationMs: 0 };
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url.endsWith("/captures") && req.method === "POST") {
        return res.end(JSON.stringify({ capture, data: Buffer.from("IMAGE").toString("base64") }));
      }
      if (req.url.endsWith("/captures/record") && req.method === "POST") {
        const b = JSON.parse(body || "{}");
        if (b.action === "start") return res.end(JSON.stringify({ recording: { captureId: "c-stub", fps: 4, maxSeconds: 120 } }));
        return res.end(JSON.stringify({
          capture: { ...capture, kind: "recording", frames: 8, durationMs: 2000, bytes: 99, autoStopped: false, video: "video.mp4" },
          samples: [{ data: Buffer.from("F1").toString("base64"), ts: 0 }, { data: Buffer.from("F2").toString("base64"), ts: 1000 }],
        }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "nope" }));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${stub.address().port}`;
  try {
    await withMcp({ CBASE_CHAT_ID: "c1", CBASE_BASE_URL: base }, async ({ call }) => {
      const shot = await call("cbase_screenshot", {});
      assert.equal(shot.isError, false);
      assert.equal(shot.content[0].type, "image");
      assert.equal(shot.content[0].mimeType, "image/jpeg");
      const info = JSON.parse(shot.content[1].text);
      assert.equal(info.captureId, "c-stub");
      assert.match(info.hint, /end of your turn/);
      assert.doesNotMatch(info.hint, /capture_send/);
      const stop = await call("cbase_recording_stop", {});
      assert.equal(stop.content.filter((b) => b.type === "image").length, 2);
      assert.match(stop.content.at(-1).text, /check frames/);
    });
    await withMcp({ CBASE_CHAT_ID: "c1", CBASE_BASE_URL: base, CBASE_VISION: "0" }, async ({ call }) => {
      const shot = await call("cbase_screenshot", {});
      assert.equal(shot.content.length, 1);
      assert.equal(shot.content[0].type, "text");
      const info = JSON.parse(shot.content[0].text);
      assert.equal(info.captureId, "c-stub");
      assert.match(info.note, /cannot see images/);
      const stop = await call("cbase_recording_stop", {});
      assert.equal(stop.content[0].type, "text");
    });
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

test("against the real server: 409 without a browser, capture_send is no longer a tool, no way bypasses the turn end", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-capmcp-"));
  let server;
  try {
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = async (url, init) => {
      const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
      const body = await res.json();
      if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
      return body;
    };
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "CapMcp", path: wsPath }) });
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude" }) });
    const cid = "c-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const dir = path.join(root, "data-root", "data", "attachments", chat.id, "captures", cid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "poster.jpg"), Buffer.from("JPEG"));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: cid, chatId: chat.id, kind: "screenshot", createdAt: Date.now(), profileKey: chat.id,
      url: "http://x/", title: "T", w: 10, h: 10, poster: "poster.jpg", video: null,
      fps: 0, frames: 1, durationMs: 0, bytes: 4, autoStopped: false, sent: false, caption: "",
    }));
    await withMcp({ CBASE_CHAT_ID: chat.id, CBASE_BASE_URL: base }, async ({ call }) => {
      const shot = await call("cbase_screenshot", {});
      assert.equal(shot.isError, true);
      assert.match(shot.content[0].text, /No browser/);
      const sent = await call("cbase_capture_send", { captureId: cid, caption: "Done." });
      assert.equal(sent.isError, true, "a remembered name is not a tool");
    });
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.equal(log.some((e) => e.role === "capture"), false, "no card without a turn end");
  } finally {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The chat log as a WINDOW (chats/log-window.js) and compressed JSON responses (runtime/http.js `send`).
//
// Promises this test holds:
//   (1) Without parameters the old contract stays: the full list (iOS before the window, agent dock).
//   (2) `?window=1` returns the end from a bubble boundary; the pages via `before` concatenated give EXACTLY the full
//       history; `from` loads everything from the boundary at or before a row (jump); `older`/`total`/`lastId` are right.
//   (3) Only a long tool result is truncated — never a subagent's (JSON the clients read) —, `truncated` carries the full
//       length, `GET …/log/row/<id>` returns the row untruncated; the delta truncates only with `truncate=1`.
//   (4) A window's reconciliation counts against `total` (web lib/history-reconcile.ts `deltaAddsUp`) — the old count
//       "rows in cache + delta" never adds up in a window (counter-check in the test).
//   (5) JSON responses from COMPRESS_FROM_CHARACTERS on come as br/gzip with a matching Accept-Encoding, unchanged without;
//       the SSE stream is NEVER compressed.
//   (6) The lists in two places are bound: subagent tools (web AGENT_TOOLS, iOS agentToolNames), parameter names (web
//       lib/api/log-window.ts), the truncation limit not below the web display limit (MAX_RESULT_CHARS).
//
// Counter-tests (one sabotage each turns red):
//   - log-window.js: `s = raw.length - WINDOW_ROWS` without the boundary search => (2) red ("the start is at a boundary").
//   - log-window.js: `staysWhole` always false => (3) red ("a subagent's report stays whole").
//   - http.js `send`: encoding always null => (5) red.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { AGENTS_TOOLS, WINDOW_PARAM, WINDOW_ROWS, BOUNDARY_ROLES, TRUNCATE_CHARACTERS } from "../electron/server/chats/log-window.js";
import { COMPRESS_FROM_CHARACTERS, encodingFor } from "../electron/server/runtime/http.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
/** An anchor that finds nothing throws — never an empty set. */
function anchor(text, re, what) {
  const m = re.exec(text);
  if (!m) throw new Error(`Anchor not found: ${what}`);
  return m;
}

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}
/** Raw via http.get — fetch would decompress itself and hide the encoding. `onlyHeader`: abort after the head (SSE). */
function raw(url, headers = {}, { onlyHeader = false } = {}) {
  return new Promise((finished, error) => {
    const req = http.get(url, { headers }, (res) => {
      if (onlyHeader) { finished({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0) }); req.destroy(); return; }
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => finished({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on("error", error);
    });
    req.on("error", (e) => (onlyHeader ? null : error(e)));
  });
}

const tool = (id, name) => JSON.stringify({ id, name, detail: name, input: {} });
const resultValue = (id, result) => JSON.stringify({ id, result, isError: false });

test("window, truncation, delta against total, compression — and the bindings", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-log-window-"));
  let server;
  try {
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Window", path: wsPath }) });
    const newChat = () => json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
    const chat = await newChat();
    const foreign = await newChat();

    // ── A history with short turns and one LONG one (more tool rows than a window, no boundary in between) ──
    let n = 0;
    const turn = (tools, longResult = null) => {
      store.addMessage(chat.id, "user", `Question ${n}`);
      store.addMessage(chat.id, "assistant", `Answer ${n}`);
      for (let i = 0; i < tools; i++) {
        const id = `t${n}-${i}`;
        store.addMessage(chat.id, "tool", tool(id, "Bash"));
        store.addMessage(chat.id, "tool_result", resultValue(id, i === 0 && longResult ? longResult : `ok ${i}`));
      }
      n++;
    };
    for (let i = 0; i < 20; i++) turn(5);
    turn(WINDOW_ROWS); // 2 + 600 rows without a boundary — the boundary search must go forward or far back
    for (let i = 0; i < 30; i++) turn(4);
    // The newest turn: a long Bash result (truncated) and a long subagent report (stays whole).
    const lang = "x".repeat(TRUNCATE_CHARACTERS * 3);
    store.addMessage(chat.id, "user", "Last question");
    store.addMessage(chat.id, "tool", tool("bash-lang", "Bash"));
    const idBash = store.addMessage(chat.id, "tool_result", resultValue("bash-lang", lang));
    store.addMessage(chat.id, "tool", tool("agent-lang", "mcp__cbase__cbase_agent"));
    const report = JSON.stringify({ agentId: "a1", status: "completed", result: lang });
    store.addMessage(chat.id, "tool_result", resultValue("agent-lang", report));
    store.addMessage(chat.id, "assistant", "Done");

    // (1) The old contract
    const full = await json(`${base}/api/chats/${chat.id}/log`);
    assert.ok(Array.isArray(full), "without parameters the full list");
    assert.deepEqual(full.map((r) => r.id), store.listMessages(chat.id).map((r) => r.id));
    assert.ok(full.every((r) => !("truncated" in r)), "the full log truncates nothing");

    // (2) The window and its pages
    const w = await json(`${base}/api/chats/${chat.id}/log?${WINDOW_PARAM.window}=1`);
    assert.equal(w.total, full.length);
    assert.equal(w.lastId, full.at(-1).id);
    assert.equal(w.older, true);
    assert.ok(w.rows.length < full.length && w.rows.length >= 1);
    assert.ok(BOUNDARY_ROLES.includes(w.rows[0].role), `the start is at a boundary (${w.rows[0].role})`);
    // Counter-check against the naive window: the last WINDOW_ROWS rows would start here in the middle of a tool group.
    assert.ok(!BOUNDARY_ROLES.includes(full[full.length - WINDOW_ROWS].role), "the test history enters the boundary-search path");
    const pages = [w];
    let first = w.rows[0].id;
    for (let i = 0; i < 50 && pages.at(-1).older; i++) {
      const s = await json(`${base}/api/chats/${chat.id}/log?${WINDOW_PARAM.window}=1&${WINDOW_PARAM.before}=${first}`);
      assert.ok(s.rows.length > 0, "an older page is never empty while `older` held");
      assert.ok(s.rows.at(-1).id < first, "the page ends before the previous one");
      // Every page starts at a boundary, at the start of the chat — or inside the LONG turn (more tool rows than window and boundary
      // search together: no boundary in reach there; the chaining stays gapless anyway).
      const inLong = s.rows[0].text.includes('"t20-');
      assert.ok(BOUNDARY_ROLES.includes(s.rows[0].role) || !s.older || inLong, `page start without boundary: ${s.rows[0].role} ${s.rows[0].text.slice(0, 40)}`);
      pages.push(s);
      first = s.rows[0].id;
    }
    assert.equal(pages.at(-1).older, false, "the pages end at the start of the chat");
    const chained = pages.slice().reverse().flatMap((s) => s.rows);
    assert.deepEqual(chained.map((r) => r.id), full.map((r) => r.id), "concatenated EXACTLY the full history");
    t.diagnostic(`rows ${full.length}, pages ${pages.length}, first window ${w.rows.length} rows`);

    // `from` (jump): the boundary at or before the row to the end — a tool row inside the long turn as target.
    const target = full.findIndex((r) => r.role === "tool" && r.text.includes(`"t20-150"`));
    const jump = await json(`${base}/api/chats/${chat.id}/log?${WINDOW_PARAM.window}=1&${WINDOW_PARAM.from}=${full[target].id}`);
    assert.ok(jump.rows[0].id <= full[target].id && BOUNDARY_ROLES.includes(jump.rows[0].role), "starts at the boundary before the target");
    assert.equal(jump.rows.at(-1).id, full.at(-1).id, "reaches to the end");
    assert.deepEqual(jump.rows.map((r) => r.id), full.slice(full.findIndex((r) => r.id === jump.rows[0].id)).map((r) => r.id), "gapless");
    // `from` + `before`: exactly the range before (reloading up to a row before the window)
    const untilTarget = await json(`${base}/api/chats/${chat.id}/log?${WINDOW_PARAM.window}=1&${WINDOW_PARAM.before}=${w.rows[0].id}&${WINDOW_PARAM.from}=${full[target].id}`);
    assert.equal(untilTarget.rows.at(-1).id, full[full.findIndex((r) => r.id === w.rows[0].id) - 1].id, "ends exactly before the window");

    // (3) Truncation
    const bash = w.rows.find((r) => r.id === idBash);
    assert.ok(bash, "the long Bash result is in the window");
    assert.equal(JSON.parse(bash.text).result.length, TRUNCATE_CHARACTERS, "truncated to TRUNCATE_CHARACTERS");
    assert.equal(bash.truncated, full.find((r) => r.id === idBash).text.length, "`truncated` carries the full length");
    const agent = w.rows.find((r) => r.role === "tool_result" && r.text.includes("agent-lang"));
    assert.equal(agent.text, full.find((r) => r.id === agent.id).text, "a subagent's report stays whole");
    assert.ok(!("truncated" in agent));
    const whole = await json(`${base}/api/chats/${chat.id}/log/row/${idBash}`);
    assert.equal(JSON.parse(whole.text).result, lang, "the row untruncated");
    assert.equal(whole.id, idBash);
    const notHere = await fetch(`${base}/api/chats/${foreign.id}/log/row/${idBash}`);
    assert.equal(notHere.status, 404, "a row of another chat is 404");
    await notHere.body?.cancel();
    const beforeBash = idBash - 1;
    const dRaw = await json(`${base}/api/chats/${chat.id}/log/delta?since=${beforeBash}`);
    assert.equal(dRaw.rows.find((r) => r.id === idBash).text.length, full.find((r) => r.id === idBash).text.length, "delta without truncate: untruncated");
    const dShort = await json(`${base}/api/chats/${chat.id}/log/delta?since=${beforeBash - 1}&${WINDOW_PARAM.truncate}=1`);
    assert.equal(dShort.rows.find((r) => r.id === idBash).truncated, bash.truncated, "delta with truncate=1: truncated like the window");

    // (4) A window's reconciliation against total
    store.addMessage(chat.id, "user", "One more");
    store.addMessage(chat.id, "assistant", "Gladly");
    const delta = await json(`${base}/api/chats/${chat.id}/log/delta?since=${w.lastId}&${WINDOW_PARAM.truncate}=1`);
    assert.equal(delta.rows.length, 2);
    assert.equal(delta.total, w.total + delta.rows.length, "the client rule (deltaAddsUp) adds up");
    assert.notEqual(delta.total, w.rows.length + delta.rows.length, "counter-check: the old count never adds up in a window — every reconciliation would reload");

    // (5) Compression
    const url = `${base}/api/chats/${chat.id}/log`;
    const gz = await raw(url, { "Accept-Encoding": "gzip" });
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.equal(gz.headers.vary, "Accept-Encoding");
    assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.body)).map((r) => r.id), full.map((r) => r.id).concat(delta.rows.map((r) => r.id)));
    const br = await raw(url, { "Accept-Encoding": "gzip, deflate, br" });
    assert.equal(br.headers["content-encoding"], "br");
    const brText = zlib.brotliDecompressSync(br.body);
    const without = await raw(url);
    assert.equal(without.headers["content-encoding"], undefined, "without Accept-Encoding uncompressed");
    assert.deepEqual(brText, without.body, "br unpacks to the same bytes");
    assert.equal((await raw(url, { "Accept-Encoding": "br;q=0, gzip" })).headers["content-encoding"], "gzip", "q=0 excludes");
    const small = await raw(`${base}/api/chats/${chat.id}`, { "Accept-Encoding": "gzip" });
    assert.ok(small.body.length < COMPRESS_FROM_CHARACTERS && small.headers["content-encoding"] === undefined, "a small response stays uncompressed");
    const sse = await raw(`${base}/api/chats/${chat.id}/stream`, { "Accept-Encoding": "gzip, br" }, { onlyHeader: true });
    assert.match(String(sse.headers["content-type"]), /text\/event-stream/);
    assert.equal(sse.headers["content-encoding"], undefined, "the SSE stream is NEVER compressed");
    assert.equal(encodingFor("identity"), null);
    assert.equal(encodingFor(""), null);
    t.diagnostic(`full log ${without.body.length} B, gzip ${gz.body.length} B, br ${br.body.length} B`);
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bindings: subagent tools (web, iOS), parameter names (web), truncation limit >= web display limit", () => {
  const blocks = read("web/src/components/AssistantBlocks.tsx");
  const webAgent = JSON.parse(`[${anchor(blocks, /const AGENT_TOOLS = new Set\(\[([^\]]+)\]\)/, "web AGENT_TOOLS")[1]}]`);
  assert.deepEqual([...webAgent].sort(), [...AGENTS_TOOLS].sort(), "web AGENT_TOOLS == AGENTS_TOOLS");
  const swift = read("mobile/CbaseMobile/Chat/ChatDetailSheet.swift");
  const iosAgent = JSON.parse(`[${anchor(swift, /static let agentToolNames: Set<String> = \[([^\]]+)\]/, "iOS agentToolNames")[1]}]`);
  assert.deepEqual([...iosAgent].sort(), [...AGENTS_TOOLS].sort(), "iOS agentToolNames == AGENTS_TOOLS");
  const max = Number(anchor(blocks, /const MAX_RESULT_CHARS = (\d+);/, "web MAX_RESULT_CHARS")[1]);
  assert.ok(TRUNCATE_CHARACTERS >= max, `the truncation (${TRUNCATE_CHARACTERS}) is not below the display (${max})`);
  const api = read("web/src/lib/api/log-window.ts");
  const param = anchor(api, /export const WINDOW_PARAM = (\{[^}]+\}) as const;/, "web WINDOW_PARAM")[1];
  const webParam = Object.fromEntries([...param.matchAll(/(\w+): "(\w+)"/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(webParam, { ...WINDOW_PARAM }, "web WINDOW_PARAM == Server");
  // iOS: the same names in the query building (Chat/ChatViewModel+Window.swift)
  const ios = read("mobile/CbaseMobile/Chat/ChatViewModel+Window.swift");
  for (const p of Object.values(WINDOW_PARAM)) anchor(ios, new RegExp(`"${p}"`), `iOS parameter ${p}`);
});

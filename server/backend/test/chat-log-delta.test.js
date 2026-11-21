// Incremental reloading of the history (GET /api/chats/:id/log/delta).
//
// When switching chats the UI used to wait for the COMPLETE log — for big chats two to three seconds in which the old chat was still
// shown. Now the clients show their cache at once and load only the delta. For that to hold, the server must guarantee three
// things, and this test checks exactly those:
//
//   1. Every history row has a stable, monotonically growing id (the basis of a row's identity in the client — without it the iOS
//      app rebuilds the whole history at every reconcile).
//   2. `?since=<id>` returns exactly the rows AFTER it — and `total` allows the cross-check "my state + delivered delta == total".
//   3. If rows are DELETED (the cleaned-up partial output of an aborted run), this calculation does NOT add up. Only so the client
//      notices it must reload completely — a pure delta would conceal the gap forever.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import { waitForQuiet } from "./quiet.mjs";

async function json(url, init) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// After a failure only a few looks at the quiet — the body's error stays the reported one, no hang.
async function shortWaitForQuiet(base) {
  for (let i = 0; i < 200; i++) {
    const st = await json(`${base}/api/runs/active`).catch(() => null);
    if (!st || st.quiet) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("delta history: row ids, reloading from `since` and detecting deletions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-log-delta-"));
  const bin = path.join(root, "fake-claude");
  const previousBin = process.env.CLAUDE_BIN;
  const previousPoll = process.env.CBASE_TRIGGER_POLL;
  let server;
  let base = "";
  let ok = false;
  try {
    fs.writeFileSync(bin, `#!/usr/bin/env node
const readline = require("node:readline");
const args = process.argv.slice(2);
if (!args.includes("stream-json")) {
  process.stdin.resume();
  process.stdin.on("end", () => console.log(JSON.stringify({ result: "Test title" })));
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const text = String(msg.message?.content?.[0]?.text || "");
    const answer = "Answer to: " + text;
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: answer }] } }));
    console.log(JSON.stringify({ type: "result", result: answer, session_id: "s1" }));
  });
}
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";

    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data-root"),
      webDir: path.join(root, "web"),
      pickDirectory: null,
      notify: null,
    });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, {
      method: "POST",
      body: JSON.stringify({ name: "Delta test", path: wsPath }),
    });
    const chat = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        provider: "claude",
        model: "claude-haiku-4-5-20251001",
        permissionMode: "bypassPermissions",
      }),
    });

    // ── Empty chat: the delta is empty and reports total 0 ──
    const empty = await json(`${base}/api/chats/${chat.id}/log/delta?since=0`);
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.total, 0);
    assert.equal(empty.lastId, 0);

    await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "First message" }),
    });
    await waitForQuiet(base);

    // ── Every row carries an id, ascending and without duplicates ──
    const full = await json(`${base}/api/chats/${chat.id}/log`);
    assert.ok(full.length >= 2, "the history should contain at least question and answer");
    assert.ok(full.every((row) => Number.isInteger(row.id) && row.id > 0), "every row needs an id");
    for (let i = 1; i < full.length; i++) {
      assert.ok(full[i].id > full[i - 1].id, "ids must ascend");
    }

    // ── Fully loaded cache: `since` = last id → nothing new ──
    const lastId = full[full.length - 1].id;
    const nothing = await json(`${base}/api/chats/${chat.id}/log/delta?since=${lastId}`);
    assert.deepEqual(nothing.rows, [], "without new rows the delta must return nothing");
    assert.equal(nothing.total, full.length);
    assert.equal(nothing.lastId, lastId);

    // ── Second turn: the delta returns EXACTLY the new rows ──
    await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Second message" }),
    });
    await waitForQuiet(base);

    const delta = await json(`${base}/api/chats/${chat.id}/log/delta?since=${lastId}`);
    assert.ok(delta.rows.length > 0, "after a turn there must be new rows");
    assert.ok(delta.rows.every((row) => row.id > lastId), "the delta must not repeat anything known");
    // The cross-check with which a client decides whether it may append.
    assert.equal(delta.total, full.length + delta.rows.length);

    // Appended, exactly the full history results — the cache stays gapless.
    const afterFull = await json(`${base}/api/chats/${chat.id}/log`);
    assert.deepEqual(
      [...full, ...delta.rows].map((row) => [row.id, row.role]),
      afterFull.map((row) => [row.id, row.role]),
    );

    // ── Deletion INSIDE the cached range. An aborted run cleans up its partial output (store.deleteMessagesFrom) — rows the client
    // already has disappear retroactively. A pure delta would notice nothing of that; the cross-check via `total` does, and only it
    // triggers the complete reload. ──
    const before = afterFull.length;
    const store = await import("../electron/server/store.js");
    store.deleteMessagesFrom(chat.id, full[1].ts); // from the SECOND row of the first turn on
    const shrunk = await json(`${base}/api/chats/${chat.id}/log/delta?since=${lastId}`);
    assert.ok(shrunk.total < before, "after the cleanup the total must be smaller");
    assert.ok(shrunk.total < full.length, "rows from the cached range must be missing");
    // Exactly this calculation fails at the client → it reloads completely.
    assert.notEqual(shrunk.total, full.length + shrunk.rows.length);
    ok = true;
  } finally {
    if (base && !ok) await shortWaitForQuiet(base);
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    if (previousPoll === undefined) delete process.env.CBASE_TRIGGER_POLL;
    else process.env.CBASE_TRIGGER_POLL = previousPoll;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

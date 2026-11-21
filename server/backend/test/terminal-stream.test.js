// A terminal's stream resumes instead of repeating (terminal-stream.js / terminal.js).
//
// The incident, measured in the user container: an IDLE terminal showed hundreds of prompts in a row. The stream
// `GET /api/terminal/:id/stream` had no heartbeat, Cloudflare cut the silent connection, the EventSource reconnected by itself - and
// every subscription got the whole buffer, which the client wrote into the SAME xterm.
//
// Checked through the real route (server harness, server in process) on sessions that the test creates through `createTerminal` in the
// same module the server uses - the workspace route starts a login shell whose prompt would only disturb here. With `/bin/cat`: it writes
// nothing by itself (the first fetch is certainly empty), and every input line comes back deterministically twice (pty echo + cat). With
// `node -e`: exactly the output a case needs (emoji across the buffer edge, line separators).
//   (a) a subscription with `Last-Event-ID` gets nothing of the old content, only new, and its first piece starts exactly at the point;
//   (b) without the header the whole buffer, marked `replaced` (EVERY full fetch - a client that reconnects without a point resets);
//   (c) `?from=` like the header, and the header wins;
//   (d) a point before the start of the buffer (overflowed) or an unreadable one => the whole buffer with `replaced`; the truncation
//       does not cut an emoji (a leading low surrogate would make Swift's JSONDecoder discard the whole catch-up event);
//   (e) the empty first fetch sets the state (`id: 0`);
//   (f) the heartbeat: the timer runs after the first subscription with the ONE value from runtime/heartbeat.js, and one round
//       (`heartbeatNow`, the same function the timer calls) brings `event: ping` without `id` - as a gate: then an input, and the ping
//       must be in the stream BEFORE its echo (the same connection keeps the order). No wait time, no hang.
//   (g) U+2028/U+2029/U+0085 go out as `\uXXXX` (iOS revisions with `AsyncBytes.lines` split the line there).
// Plus (h): the event line `event: ping` appears in the server tree exactly ONCE (runtime/heartbeat.js).
// Never wait on a duration, only on the event in the stream; every stream and every session ends in `finally`.
//
// COUNTER-TESTS: `catchUpTerminal` always returning the whole buffer (never `replaced`) => unit, (a)-(e) and (d) red; the route without the
// header (`from` only from the query) => (a)-(e) red ("the old content came back") - (d) stays green, there every full fetch is `replaced`
// anyway; `saveHeartbeat()` struck from `subscribeTerminal` => (f) red ("the timer is not running") instead of a hang; `truncateBuffer`
// without `withoutHalfCharacter` => unit and (d) red ("half unit (0xde00)"); `dataRow` without the escape => unit and (g) red; an own
// `"event: ping` literal in browsers.js => (h) red ("defined more than once: browsers.js:21, runtime/heartbeat.js:9").
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000
//   CBASE_AGENT_STALL_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/terminal-stream.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { withServer, json } from "./server-harness.mjs";
import { createTerminal, heartbeatNow, killTerminal, terminalHeartbeatRunning } from "../electron/server/terminal.js";
import { dataRow, truncateBuffer, MAX_BUFFER, catchUpTerminal } from "../electron/server/terminal-stream.js";
import { HEARTBEAT_MS } from "../electron/server/runtime/heartbeat.js";

const SERVER = fileURLToPath(new URL("../electron/server/", import.meta.url));
const isLow = (s) => { const c = s.charCodeAt(0); return c >= 0xdc00 && c <= 0xdfff; };

/** An SSE reader with header lines: collects `{ event, id, data }` (and the raw text) and wakes waiters as soon as an event matches. */
async function stream(url, headers = {}) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream", ...headers } });
  assert.equal(res.status, 200);
  const events = [];
  const waiting = new Set();
  const report = () => { for (const w of [...waiting]) { const t = w.pred(events); if (t) { waiting.delete(w); w.resolve(t); } } };
  let end = false;
  let raw = "";
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        raw += chunk;
        buf += chunk;
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const e = { event: "message", id: null, data: null };
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) e.event = line.slice(7);
            else if (line.startsWith("id: ")) e.id = line.slice(4);
            else if (line.startsWith("data: ")) e.data = JSON.parse(line.slice(6));
          }
          events.push(e);
          report();
        }
      }
    } catch { /* the abort on close is expected */ }
    end = true;
    for (const w of [...waiting]) { waiting.delete(w); w.reject(new Error(`Strom zu Ende, bevor ${w.what}`)); }
  })();
  const data = () => events.filter((e) => e.event === "message");
  return {
    events,
    data,
    raw: () => raw,
    text: () => data().map((e) => e.data.d).join(""),
    lastId: () => data().at(-1)?.id ?? null,
    first: () => data()[0] ?? null,
    /** Waits until `pred(events)` returns something truthy - without a deadline; the emergency brake is the suite. */
    wait(pred, what) {
      const t = pred(events);
      if (t) return Promise.resolve(t);
      if (end) return Promise.reject(new Error(`Stream ended before ${what}`));
      return new Promise((resolve, reject) => waiting.add({ pred, resolve, reject, what }));
    },
    async close() { ac.abort(); await pump; },
  };
}
const firstRow = (s) => s.wait((ev) => ev.find((e) => e.event === "message"), "the first line");

const input = (base, tid, data) => json(`${base}/api/terminal/${tid}/input`, { method: "POST", body: JSON.stringify({ data }) });

/** A session with `node -e <script>`: the script waits for the first input line, then writes `output` and stays. */
// The output comes from a file, not from the script text: Linux caps ONE argument at 128 KiB (MAX_ARG_STRLEN), and the 400 KB of
// the emoji test in `-e` made the spawn fail with E2BIG — the terminal ended before its first line (CI red; macOS has no such cap).
const OUTPUTS = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-terminal-stream-"));
process.on("exit", () => fs.rmSync(OUTPUTS, { recursive: true, force: true }));
let outputs = 0;
const nodeSession = (output) => {
  const file = path.join(OUTPUTS, `output-${++outputs}.txt`);
  fs.writeFileSync(file, output);
  return createTerminal({
    command: process.execPath,
    args: ["-e", `process.stdin.once("data", () => process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(file)}, "utf8")));`],
  });
};

test("Unit: catchUpTerminal - missing, in the buffer, at the end, before the start, unreadable; every full fetch is replaced", () => {
  const s = { buffer: "fghij", end: 10 }; // covers [5, 10)
  assert.deepEqual(catchUpTerminal(s, null), { d: "fghij", until: 10, replaced: true }, "missing => whole buffer, replaced");
  assert.deepEqual(catchUpTerminal(s, ""), { d: "fghij", until: 10, replaced: true }, "empty => like missing");
  assert.deepEqual(catchUpTerminal(s, "7"), { d: "hij", until: 10, replaced: false }, "in the buffer => the rest from there");
  assert.deepEqual(catchUpTerminal(s, "5"), { d: "fghij", until: 10, replaced: false }, "exactly at the start => everything, but a resume");
  assert.deepEqual(catchUpTerminal(s, "10"), { d: "", until: 10, replaced: false }, "at the end => nothing");
  assert.deepEqual(catchUpTerminal(s, "4"), { d: "fghij", until: 10, replaced: true }, "before the start => replaced");
  for (const raw of ["11", "-1", "abc", "7abc", "1e1", "7.0", "99999999999999999999"]) {
    assert.deepEqual(catchUpTerminal(s, raw), { d: "fghij", until: 10, replaced: true }, `unreadable/out of range ${JSON.stringify(raw)} => replaced`);
  }
  // An invented point in the middle of a surrogate pair: the rest never starts with a half unit.
  const e = { buffer: "a\u{1F600}b", end: 4 }; // a, High, Low, b
  assert.equal(catchUpTerminal(e, "2").d, "b", "the rest from a low surrogate loses the half unit");
});

test("Unit: truncateBuffer does not cut an emoji; dataRow escapes U+2028/U+2029/U+0085", () => {
  const emoji = "\u{1F600}";
  assert.equal(truncateBuffer("x".repeat(10), 20), "x".repeat(10), "unchanged under the limit");
  assert.equal(truncateBuffer("ab" + emoji + "cd", 3), "cd", "the edge hits the low surrogate => it drops");
  assert.equal(truncateBuffer("ab" + emoji + "cd", 4), emoji + "cd", "the edge hits the pair at the front => it stays whole");
  assert.equal(MAX_BUFFER, 200_000);
  const z = dataRow("A\u2028B\u2029C\u0085D", 7);
  assert.equal(/[\u2028\u2029\u0085]/.test(z), false, `raw in the line: ${JSON.stringify(z)}`);
  assert.equal(z, 'id: 7\ndata: {"d":"A\\u2028B\\u2029C\\u0085D","until":7}\n\n');
  assert.equal(JSON.parse(z.split("\n")[1].slice(6)).d, "A\u2028B\u2029C\u0085D", "equivalent JSON");
  assert.equal(dataRow("", 0, true), 'id: 0\ndata: {"d":"","until":0,"replaced":true}\n\n');
});

test("The stream resumes at Last-Event-ID; without the header the whole buffer (replaced); ?from= like the header; the empty first fetch sets the state", async () => {
  await withServer(async ({ base }) => {
    const { id: tid } = createTerminal({ command: "/bin/cat", args: [] });
    const open = [];
    const on = async (filePath, headers) => { const s = await stream(`${base}${filePath}`, headers); open.push(s); return s; };
    try {
      // (e) First fetch without header on an empty buffer: ONE line that sets the state - with `id: 0`, otherwise the browser would send no
      // header on the next reconnect, and the full buffer would come back. A full fetch, so `replaced` (without effect for a fresh
      // terminal).
      const s1 = await on(`/api/terminal/${tid}/stream`);
      const first = await firstRow(s1);
      assert.equal(first.id, "0", "the empty first fetch carries id: 0");
      assert.deepEqual(first.data, { d: "", until: 0, replaced: true }, "an empty piece with until 0, marked as a full fetch");

      await input(base, tid, "OLD\r");
      await s1.wait(() => s1.text().includes("OLD\r\nOLD\r\n"), "OLD twice (echo + cat)");
      const point = s1.lastId();
      assert.equal(point, String(s1.text().length), "the last id is the number of all characters delivered so far");
      for (const e of s1.data()) assert.equal(e.id, String(e.data.until), "id: and until carry the same number");
      assert.equal(s1.data().slice(1).some((e) => e.data.replaced), false, "live pieces are never replaced");
      await s1.close();

      // (a) Reconnected with the header the browser sets itself: nothing of the old content, only new.
      await input(base, tid, "NEW\r");
      const s2 = await on(`/api/terminal/${tid}/stream`, { "Last-Event-ID": point });
      await s2.wait(() => s2.text().includes("NEW\r\nNEW\r\n"), "NEW twice");
      assert.equal(s2.text().includes("OLD"), false, `the old content came back: ${JSON.stringify(s2.text())}`);
      const e2 = s2.first();
      assert.equal(e2.data.until - e2.data.d.length, Number(point), "the first piece starts exactly at the resume point");
      assert.equal(s2.data().some((e) => e.data.replaced), false, "no replacement with a valid point");
      const total = Number(s2.lastId());
      assert.equal(total, "OLD\r\nOLD\r\nNEW\r\nNEW\r\n".length);

      // (b) Without the header: the whole buffer in ONE piece, marked as a replacement.
      const s3 = await on(`/api/terminal/${tid}/stream`);
      const e3 = await firstRow(s3);
      assert.deepEqual(e3.data, { d: "OLD\r\nOLD\r\nNEW\r\nNEW\r\n", until: total, replaced: true });
      assert.equal(e3.id, String(total));

      // (c) `?from=` (the iOS way) like the header ...
      const s4 = await on(`/api/terminal/${tid}/stream?from=${point}`);
      assert.deepEqual((await firstRow(s4)).data, { d: "NEW\r\nNEW\r\n", until: total });
      // ... at the end: only the line that sets the state ...
      const s5 = await on(`/api/terminal/${tid}/stream?from=${total}`);
      const e5 = await firstRow(s5);
      assert.deepEqual(e5.data, { d: "", until: total });
      assert.equal(e5.id, String(total));
      // ... and the header wins over the query (it is the newer state).
      const s6 = await on(`/api/terminal/${tid}/stream?from=0`, { "Last-Event-ID": String(total) });
      assert.deepEqual((await firstRow(s6)).data, { d: "", until: total }, "the header wins over ?from=");

      // Unreadable point => the whole buffer with `replaced` (the client resets instead of appending).
      const s7 = await on(`/api/terminal/${tid}/stream`, { "Last-Event-ID": "broken" });
      assert.deepEqual((await firstRow(s7)).data, { d: "OLD\r\nOLD\r\nNEW\r\nNEW\r\n", until: total, replaced: true });

      // Live after the resume: a new piece goes to all open readers with a continuing id.
      await input(base, tid, "LIVE\r");
      await s5.wait(() => s5.text().includes("LIVE\r\nLIVE\r\n"), "LIVE at the reader with ?from=end");
      assert.equal(s5.text(), "LIVE\r\nLIVE\r\n", "the reader at the end sees only the new");
      assert.equal(Number(s5.lastId()), total + "LIVE\r\nLIVE\r\n".length);
    } finally {
      for (const s of open) await s.close();
      killTerminal(tid);
    }
  });
});

test("Overflowed buffer with emoji: a point before the start gets the whole buffer (replaced), and it never starts with a half unit", async () => {
  await withServer(async ({ base }) => {
    // 100,001 emoji (200,002 UTF-16 units) after the echo "run\r\n" (5), behind it "x\r\nDONE\r\n" (9): the last truncation lies
    // at 200,016 - 200,000 = 16, i.e. 11 units into the emoji - odd, in the middle of a pair. Without the correction the buffer
    // would start with a low surrogate.
    const { id: tid } = nodeSession("\u{1F600}".repeat(100_001) + "x\nDONE\n");
    const open = [];
    const on = async (filePath, headers) => { const s = await stream(`${base}${filePath}`, headers); open.push(s); return s; };
    try {
      const s1 = await on(`/api/terminal/${tid}/stream`);
      await firstRow(s1);
      await input(base, tid, "run\r");
      await s1.wait(() => s1.text().endsWith("DONE\r\n"), "the end marker");
      const total = Number(s1.lastId());
      assert.equal(total, s1.text().length);
      assert.equal(total, 200_016, "echo + emoji + end marker");

      // Point 5 (after "run\r\n") lies before the start of the buffer => everything the server still has, with replaced.
      const s2 = await on(`/api/terminal/${tid}/stream`, { "Last-Event-ID": "5" });
      const e2 = await firstRow(s2);
      assert.equal(e2.data.replaced, true, "replaced on lost data");
      assert.equal(isLow(e2.data.d), false, `the buffer starts with a half unit (0x${e2.data.d.charCodeAt(0).toString(16)})`);
      assert.ok(e2.data.d.length <= MAX_BUFFER && e2.data.d.length >= MAX_BUFFER - 1, `the whole (capped) buffer: ${e2.data.d.length}`);
      assert.equal(e2.data.d, s1.text().slice(-e2.data.d.length), "exactly the end of what the first reader saw");
      assert.equal(e2.data.until, total);

      // A point IN the buffer stays an ordinary resume.
      const s3 = await on(`/api/terminal/${tid}/stream?from=${total - 6}`);
      assert.deepEqual((await firstRow(s3)).data, { d: "DONE\r\n", until: total });
    } finally {
      for (const s of open) await s.close();
      killTerminal(tid);
    }
  });
});

test("(g) U+2028, U+2029 and U+0085 go out as \\uXXXX - the text arrives unchanged", async () => {
  await withServer(async ({ base }) => {
    const { id: tid } = nodeSession("A\u2028B\u2029C\u0085D\nDONE\n");
    let s = null;
    try {
      s = await stream(`${base}/api/terminal/${tid}/stream`);
      await firstRow(s);
      await input(base, tid, "run\r");
      await s.wait(() => s.text().includes("DONE\r\n"), "the end marker");
      assert.ok(s.text().includes("A\u2028B\u2029C\u0085D\r\n"), `the text arrived changed: ${JSON.stringify(s.text())}`);
      assert.equal(/[\u2028\u2029\u0085]/.test(s.raw()), false, "one of the three was raw in the stream");
      assert.ok(s.raw().includes("A\\u2028B\\u2029C\\u0085D"), "as an escape in the raw text");
      // Catching up too: a new reader gets the buffer with the same escapes.
      const n = await stream(`${base}/api/terminal/${tid}/stream`);
      try {
        await firstRow(n);
        assert.equal(/[\u2028\u2029\u0085]/.test(n.raw()), false, "raw in the caught-up buffer");
      } finally { await n.close(); }
    } finally {
      await s?.close();
      killTerminal(tid);
    }
  });
});

test("(f) Heartbeat: the timer runs after the first subscription; one round brings event: ping without id, before the next piece", async () => {
  await withServer(async ({ base }) => {
    const { id: tid } = createTerminal({ command: "/bin/cat", args: [] });
    let s = null;
    try {
      s = await stream(`${base}/api/terminal/${tid}/stream`);
      await firstRow(s);
      assert.equal(terminalHeartbeatRunning(), true, "the timer is not running - a silent stream would be cut");
      assert.equal(HEARTBEAT_MS, 25_000);
      heartbeatNow();
      await input(base, tid, "GATE\r");
      await s.wait(() => s.text().includes("GATE\r\nGATE\r\n"), "the gate (echo of the input after the heartbeat)");
      const gate = s.events.findIndex((e) => e.event === "message" && e.data.d.includes("GATE"));
      const ping = s.events.findIndex((e) => e.event === "ping");
      assert.ok(ping >= 0 && ping < gate, `no ping before the gate: ${JSON.stringify(s.events.map((e) => e.event))}`);
      assert.equal(s.events[ping].id, null, "the ping carries no id (does not move the resume point)");
      assert.deepEqual(s.events[ping].data, {});
    } finally {
      await s?.close();
      killTerminal(tid);
    }
  });
});

test("(h) The event line of the heartbeat appears in the server tree exactly once (runtime/heartbeat.js)", () => {
  const hits = [];
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") run(p); continue; }
      if (!e.name.endsWith(".js")) continue;
      const rows = fs.readFileSync(p, "utf8").split("\n");
      rows.forEach((z, i) => { if (/["'`]event: ping/.test(z) && !/^\s*\/\//.test(z)) hits.push(`${path.relative(SERVER, p)}:${i + 1}`); });
    }
  };
  run(SERVER);
  assert.deepEqual(hits.map((t) => t.replace(/:\d+$/, "")), ["runtime/heartbeat.js"], `the heartbeat is defined more than once: ${hits.join(", ")}`);
});

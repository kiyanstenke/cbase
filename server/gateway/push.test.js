import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RIPCORD_MS } from "../../server/backend/test/ripcord.mjs";
// As a namespace: a missing export turns the single test red, not the whole file.
import * as push from "./push.js";
import * as users from "./users.js";

const { notificationForEvent } = push;

test("push payload takes over navigation from an existing bell notice", () => {
  const notification = notificationForEvent({
    type: "notice",
    notice: {
      id: 17, kind: "review", title: "Review requested", body: "Please check on the iPhone",
      chatId: "chat-1", workspaceId: "ws-1", projectId: "proj-1",
    },
  });
  assert.equal(notification.title, "Review requested");
  assert.equal(notification.data.kind, "review");
  assert.equal(notification.data.chatId, "chat-1");
  assert.equal(notification.data.workspaceId, "ws-1");
  assert.equal(notification.data.projectId, "proj-1");
});

test("only answered, finished runs become push notifications", () => {
  assert.equal(notificationForEvent({ type: "run", running: true }), null);
  assert.equal(notificationForEvent({ type: "run", running: false, answered: false }), null);
  assert.equal(notificationForEvent({ type: "run", running: false, answered: true, push: false }), null);
  const notification = notificationForEvent({
    type: "run", running: false, answered: true, chatId: "chat-2", title: "Build done",
  });
  assert.equal(notification.title, "Build done");
  assert.equal(notification.data.chatId, "chat-2");
});

test("device registration replaces the token per installation and keeps the cursor monotonic", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-push-test-"));
  try {
    users.initUsers(dir);
    const user = users.createUser({ username: "push-test", password: "12345678" });
    users.upsertPushDevice(user.id, {
      installationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      token: "a".repeat(64), environment: "sandbox", locale: "de",
    });
    users.upsertPushDevice(user.id, {
      installationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      token: "b".repeat(64), environment: "production", locale: "en",
    });
    const devices = users.listPushDevices(user.id);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].token, "b".repeat(64));
    assert.equal(devices[0].environment, "production");
    assert.equal(users.getPushCursor(user.id), null);
    users.setPushCursor(user.id, 12);
    users.setPushCursor(user.id, 4);
    assert.equal(users.getPushCursor(user.id), 12);

    const other = users.createUser({ username: "push-test-2", password: "12345678" });
    users.upsertPushDevice(other.id, {
      installationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      token: "b".repeat(64), environment: "production", locale: "de",
    });
    assert.equal(users.listPushDevices(user.id).length, 0, "an account change removes the old owner");
    assert.equal(users.listPushDevices(other.id).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("push payload of a scheduled run carries the job's chat; manager fields no longer exist", () => {
  // An occurrence reports with the coding chat that carries its job (kind `schedule` with `chatId`). The fields
  // `managerChatId`/`managerPage` are gone — also the fallback to `managerChatId` for the collapse id: an old note with only
  // this field collapses per kind, no longer per manager chat.
  const notification = notificationForEvent({
    type: "notice",
    notice: { id: 18, kind: "schedule", title: "Working hours", body: "First paragraph.", chatId: "chat-1", workspaceId: "ws-1" },
  });
  assert.equal(notification.data.chatId, "chat-1");
  assert.equal(notification.collapseId, "chat-1-schedule");
  assert.ok(!("managerChatId" in notification.data) && !("managerPage" in notification.data), JSON.stringify(notification.data));
  const old = notificationForEvent({ type: "notice", notice: { id: 19, kind: "schedule", title: "x", managerChatId: "mgr-1", managerPage: "extraction" } });
  assert.equal(old.data.chatId, "");
  assert.equal(old.collapseId, "cbase-schedule", "no fallback to managerChatId");
  assert.ok(!("managerChatId" in old.data));
});

test("schedule occurrences per user: set, read, list only the upcoming ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-gw-termine-"));
  users.initUsers(dir);
  try {
    assert.equal(users.getScheduleOccurrence("u1"), 0);
    users.setScheduleOccurrence("u1", 1_800_000_000_000);
    users.setScheduleOccurrence("u2", 0);
    assert.equal(users.getScheduleOccurrence("u1"), 1_800_000_000_000);
    assert.deepEqual(users.listScheduleTermine().map((t) => t.userId), ["u1"], "0 means: no occurrence");
    users.setScheduleOccurrence("u1", 1_900_000_000_000);
    assert.equal(users.getScheduleOccurrence("u1"), 1_900_000_000_000, "overwrites");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── notifications ────────────────────────────────────────────────────────────

test("the gateway obeys the backend's stamp and does not decide itself", () => {
  // It knows neither chats nor settings — the verdict is made over there and travels along.
  assert.equal(notificationForEvent({ type: "notice", notice: { id: 1, kind: "question", title: "x", push: false } }), null);
  assert.equal(notificationForEvent({ type: "run", running: false, answered: true, push: false }), null);
  // An OLD backend without a stamp keeps delivering — otherwise it would fall silent during a partial deploy.
  assert.ok(notificationForEvent({ type: "notice", notice: { id: 2, kind: "question", title: "x" } }));
});

test("lock screen: the chat name on top, the kind below, the questions in the text", () => {
  const n = notificationForEvent({
    type: "notice",
    notice: {
      id: 7, kind: "question", category: "question",
      title: "Question: prepare Orbit epics",   // as it stands in the bell
      chatTitle: "Prepare Orbit epics",           // and as on the phone
      pushSubtitle: "Question",
      body: "Which repo split do you prefer?", chatId: "chat-1", push: true,
    },
  });
  assert.equal(n.title, "Prepare Orbit epics", "the prefix \"Question: \" would eat into the name");
  assert.equal(n.subtitle, "Question");
  assert.equal(n.body, "Which repo split do you prefer?");
  assert.equal(n.data.category, "question");
});

test("a notification replaces only the previous one of the SAME chat and the SAME kind", () => {
  const question1 = notificationForEvent({ type: "notice", notice: { id: 1, kind: "question", category: "question", chatId: "c1", title: "a" } });
  const question2 = notificationForEvent({ type: "notice", notice: { id: 2, kind: "question", category: "question", chatId: "c1", title: "b" } });
  const finished = notificationForEvent({ type: "run", running: false, answered: true, chatId: "c1", title: "c" });
  const foreign = notificationForEvent({ type: "notice", notice: { id: 3, kind: "question", category: "question", chatId: "c2", title: "d" } });
  assert.equal(question1.collapseId, question2.collapseId, "the second question is the current one");
  assert.notEqual(question1.collapseId, finished.collapseId, "\"done\" must not overwrite an open question");
  assert.notEqual(question1.collapseId, foreign.collapseId, "other chats stay side by side");
  assert.ok(question1.collapseId.length <= 64, "APNs caps the collapse id at 64 characters");
});

test("\"answer done\" carries the teaser of the answer, not just an alarm", () => {
  const n = notificationForEvent({
    type: "run", running: false, answered: true, chatId: "c1",
    title: "Orbit Epics", pushTitle: "Orbit Epics", pushSubtitle: "Answer done",
    pushBody: "I formed 14 epics and 41 stories.",
  });
  assert.equal(n.subtitle, "Answer done");
  assert.equal(n.body, "I formed 14 epics and 41 stories.");
  // Without a teaser (old server, empty answer) the old fixed line stays.
  const without = notificationForEvent({ type: "run", running: false, answered: true, chatId: "c1", title: "X" });
  assert.equal(without.body, "cbase finished the answer.");
});

test("a restarted event counter must not shut down delivery permanently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-push-follow-up-"));
  try {
    users.initUsers(dir);
    const user = users.createUser({ username: "follow-up-test", password: "12345678" });
    users.setPushCursor(user.id, 192);
    // The normal set clamps with MAX() — exactly there the reconciliation would have been ineffective.
    users.setPushCursor(user.id, 53);
    assert.equal(users.getPushCursor(user.id), 192, "the normal way must never lower the value");
    // The explicit reset path may. Without it `id <= cursor` discarded EVERY notice after an
    // emptied ring buffer (notes 1..53 against 192).
    users.resetPushCursor(user.id, 53);
    assert.equal(users.getPushCursor(user.id), 53);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { console.warn("cleanup failed"); }
  }
});

test("collapse id from the note: one notification per approval, not per chat", () => {
  // An approval brings its id ALONG (`<chat>-approval-<request>`): two open
  // cards are two decisions, so two notifications — unlike the question, whose
  // second replaces the first. Without an id the collapsing per chat and kind still applies.
  const f1 = notificationForEvent({ type: "notice", notice: { id: 1, kind: "approval", category: "approval", chatId: "c1", title: "a", collapseId: "c1-approval-r1" } });
  const f2 = notificationForEvent({ type: "notice", notice: { id: 2, kind: "approval", category: "approval", chatId: "c1", title: "b", collapseId: "c1-approval-r2" } });
  assert.equal(f1.collapseId, "c1-approval-r1");
  assert.notEqual(f1.collapseId, f2.collapseId, "two approvals of the same chat stand side by side");
  const without = notificationForEvent({ type: "notice", notice: { id: 3, kind: "approval", category: "approval", chatId: "c1", title: "c" } });
  const question = notificationForEvent({ type: "notice", notice: { id: 4, kind: "question", category: "question", chatId: "c1", title: "d" } });
  assert.notEqual(without.collapseId, question.collapseId, "without its own id, chat + kind still collapse");
  const lang = notificationForEvent({ type: "notice", notice: { id: 5, kind: "approval", category: "approval", chatId: "c1", title: "e", collapseId: "x".repeat(200) } });
  assert.equal(lang.collapseId.length, 64, "APNs caps the collapse id at 64 characters");
});

// ── the event stream of a container cannot paralyze the control plane ───────────────────────────────────────────────────────
// Without limits watchBackend would collect the stream unbounded, search for the blank line in the WHOLE buffer on every chunk
// and have no deadline: a backend (the listener on 7718 belongs to every agent in B) that writes without a blank line drove the
// gateway to gigabytes and an event loop at utilization 1.0 — login, proxy, tunnel and push of all users stood still.
// What is measured is, from the BACKEND side, who closes the connection: a fake backend writes at the reader's pace (drain) up to
// a limit and then ends it ITSELF. If the gateway closes earlier, it capped. Without the cap it reads everything and the backend
// closes — the test is red without hanging (in the silence probe the fakes' ripcord ends the backend).
// Sabotage: without the cap/deadline in push.js — red: flood ("backend" instead of "gateway"), event flood and silence (after the
// ripcord), splitter (missing).
function eventBackend(fall) {
  const connections = [];
  const waiters = [];
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/api/services/events")) { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"events":[],"seq":0}'); }
    if (!req.url.startsWith("/api/events")) { res.writeHead(404); return res.end(); }
    const v = { seq: connections.length + 1, written: 0, finished: false };
    let ripcord = null;
    v.whenClosed = new Promise((r) => res.on("close", () => { clearTimeout(ripcord); r(v.finished ? "backend" : "gateway"); }));
    // The emergency brake: a gateway that never closes lets the backend end itself after RIPCORD_MS.
    ripcord = setTimeout(() => { v.finished = true; res.end(); }, RIPCORD_MS);
    ripcord.unref();
    connections.push(v);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    fall(v, res);
    for (const w of [...waiters]) if (connections.length >= w.n) { waiters.splice(waiters.indexOf(w), 1); w.resolve(connections[w.n - 1]); }
  });
  return {
    srv, connections,
    listen: () => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port))),
    connection: (n) => connections.length >= n ? Promise.resolve(connections[n - 1]) : new Promise((resolve) => waiters.push({ n, resolve })),
    shutdown: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}
// Writes `chunk` at the reader's pace until `limit` is reached; then the backend ends itself.
function writeUntil(v, res, chunk, limit) {
  const further = () => {
    while (v.written < limit && !res.destroyed) {
      v.written += chunk.length;
      if (!res.write(chunk)) { res.once("drain", further); return; }
    }
    if (!res.destroyed) { v.finished = true; res.end(); }
  };
  further();
}
async function withUser(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-push-h4-"));
  users.initUsers(dir);
  const u = users.createUser({ username: `h4-${Date.now()}`, password: "12345678" });
  try { await fn(u, dir); } finally {
    push.unwatchBackend(u.id);
    delete process.env.GW_PUSH_GAP_MS;
    delete process.env.GW_PUSH_SILENCE_MS;
    delete process.env.GW_PUSH_SHORT_MS;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const until = async (condition) => { while (!condition()) await new Promise((r) => setImmediate(r)); };

test("an event without a blank line is discarded after PUSH_EVENT_CAP, the gap grows — the reconnection reads again, also across chunk boundaries", async () => {
  const EIGHT_MIB = 8 * 1024 * 1024;
  const b = eventBackend((v, res) => {
    if (v.seq === 1) return writeUntil(v, res, "x".repeat(64 * 1024), EIGHT_MIB);
    // The reconnection: a valid event, the blank line spread over two writes.
    res.write('data: {"type":"notice","notice":{"id":7,"push":false}}\n');
    setImmediate(() => res.write("\n"));
  });
  const port = await b.listen();
  try {
    await withUser(async (u) => {
      process.env.GW_PUSH_GAP_MS = "10";
      push.watchBackend(u.id, port);
      const first = await b.connection(1);
      assert.equal(await first.whenClosed, "gateway", `the gateway read the flood to the end (${first.written} bytes)`);
      assert.ok(first.written < EIGHT_MIB);
      const situation = push.pushObserver?.(u.id);
      assert.equal(situation?.lastViolation, "event-too-large", JSON.stringify(situation));
      assert.ok(situation.gapMs >= 20, `the gap did not grow: ${situation.gapMs}`);
      await b.connection(2);
      await until(() => users.getPushCursor(u.id) === 7);
    });
  } finally { await b.shutdown(); }
});

test("a flood of valid small events exceeds the budget per window — discarded, not processed", async () => {
  const count = (push.PUSH_WINDOW_EVENTS ?? 3000) + 500;
  const b = eventBackend((v, res) => {
    if (v.seq === 1) { res.write('data: {"type":"x"}\n\n'.repeat(count)); return; } // then silently open
  });
  const port = await b.listen();
  try {
    await withUser(async (u) => {
      push.watchBackend(u.id, port);
      const first = await b.connection(1);
      assert.equal(await first.whenClosed, "gateway", "the gateway processed the flood and kept the stream open");
      assert.equal(push.pushObserver?.(u.id)?.lastViolation, "too-many-events");
    });
  } finally { await b.shutdown(); }
});

test("a silent event stream (no heartbeat) is rebuilt after the idle deadline", async () => {
  const b = eventBackend(() => { /* header sent, then nothing more */ });
  const port = await b.listen();
  try {
    await withUser(async (u) => {
      process.env.GW_PUSH_SILENCE_MS = "200";
      process.env.GW_PUSH_GAP_MS = "10";
      push.watchBackend(u.id, port);
      const first = await b.connection(1);
      assert.equal(await first.whenClosed, "gateway", "the gateway waited on a silent stream without a deadline");
      await b.connection(2);
      assert.equal(push.pushObserver?.(u.id)?.violations, 0, "silence is no violation — the gap stays at the base value");
    });
  } finally { await b.shutdown(); }
});

test("sseSplitter — the blank line across the chunk boundary, the incomplete remainder capped", () => {
  const events = [];
  const z = push.sseSplitter?.({ cap: 16, atEvent: (t) => events.push(t) });
  assert.ok(z, "no splitter");
  assert.equal(z.shift("data: a\n"), true);
  assert.equal(z.shift("\ndata: b\n\nda"), true);
  assert.deepEqual(events, ["data: a", "data: b"]);
  assert.equal(z.rest, 2);
  assert.equal(z.shift("x".repeat(20)), false, "over the cap");
});

test("no observer for a locked user — watchBackend does not connect", async () => {
  const b = eventBackend(() => {});
  const port = await b.listen();
  try {
    await withUser(async (u) => {
      users.lockUser(u.id);
      push.watchBackend(u.id, port);
      assert.equal(push.pushObserver?.(u.id) ?? null, null);
      assert.equal(b.connections.length, 0);
    });
  } finally { await b.shutdown(); }
});

// ── catching up was capped only when fetching, not when processing ───────────────────────────────────────────────────────────
// fetchNotices fetched up to 4 MiB (about 157,000 notes) and processed each: read the cursor, deliver, write the cursor
// (autocommit), never releasing the event loop — ONE fetch held it for 84 s. And a B that closed the event stream at once was no
// violation: reconnection and catching up ran at the base pace. Counting happens without a clock — through triggers in gateway.db
// (a second connection creates them; they also fire for the writes of users.js): every write of the cursor, every delivery
// (notePushResult on a device for which the gateway has no APNs key — nothing goes to the network).
// Sabotage: without the cap/batching in push.js — red: flood (300 deliveries, 300 writes, gap 10), cursor once (3 writes
// instead of 1), short stream (no violation).
function catchUpBackend({ stream, notes }) {
  const count = { connections: 0, retrievals: 0 };
  const waiters = [];
  const wake = () => { for (const w of [...waiters]) if (count[w.kind] >= w.n) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); } };
  const srv = http.createServer((req, res) => {
    req.resume();
    if (req.url.startsWith("/api/events")) {
      count.connections += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      stream(res);
    } else if (req.url.startsWith("/api/services/events")) {
      count.retrievals += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(notes(count.retrievals)));
    } else { res.writeHead(404); res.end(); }
    wake();
  });
  return {
    count,
    listen: () => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port))),
    wait: (kind, n) => (count[kind] >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ kind, n, resolve }))),
    shutdown: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}
function counter(dir) {
  const db = new DatabaseSync(path.join(dir, "gateway.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS t_counter (kind TEXT PRIMARY KEY, n INTEGER NOT NULL);
    INSERT OR IGNORE INTO t_counter (kind, n) VALUES ('cursor', 0), ('delivery', 0);
    CREATE TRIGGER IF NOT EXISTS t_cursor_new AFTER INSERT ON push_cursors BEGIN UPDATE t_counter SET n = n + 1 WHERE kind = 'cursor'; END;
    CREATE TRIGGER IF NOT EXISTS t_cursor_alt AFTER UPDATE ON push_cursors BEGIN UPDATE t_counter SET n = n + 1 WHERE kind = 'cursor'; END;
    CREATE TRIGGER IF NOT EXISTS t_delivery AFTER UPDATE OF last_push_at ON push_devices BEGIN UPDATE t_counter SET n = n + 1 WHERE kind = 'delivery'; END;
  `);
  const read = (kind) => Number(db.prepare("SELECT n FROM t_counter WHERE kind = ?").get(kind).n);
  return { cursor: () => read("cursor"), deliveries: () => read("delivery"), shutdown: () => db.close() };
}
const DEVICE = { installationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", token: "a".repeat(64), environment: "sandbox", locale: "de" };
const notes = (n, start = 1) => Array.from({ length: n }, (_, i) => ({ id: start + i, kind: "info", title: `Note ${start + i}` }));

test("a catch-up response over CATCH_UP_CAP_NOTES is discarded — nothing delivered, the cursor written once, the gap grows", async () => {
  const cap = push.CATCH_UP_CAP_NOTES ?? 200;
  const count = cap + 100;
  // B closes the event stream at once and delivers more notes when catching up than its ring buffer (100) can ever hold.
  const b = catchUpBackend({ stream: (res) => res.end(": bye\n\n"), notes: () => ({ events: notes(count), seq: count }) });
  const port = await b.listen();
  try {
    await withUser(async (u, dir) => {
      assert.equal(push.pushConfiguration().sandbox, false, "precondition: no APNs key (otherwise the test would go to the network)");
      users.upsertPushDevice(u.id, DEVICE);
      users.setPushCursor(u.id, 0); // push was already active — otherwise the first catch-up only marks
      const z = counter(dir);
      try {
        process.env.GW_PUSH_GAP_MS = "10";
        push.watchBackend(u.id, port);
        await until(() => z.cursor() >= 1); // the first catch-up is processed
        assert.equal(z.deliveries(), 0, `delivered: ${z.deliveries()} of ${count} — over the cap nothing is delivered`);
        assert.ok(z.cursor() <= b.count.retrievals, `the cursor was written ${z.cursor()} times (${b.count.retrievals} fetches)`);
        assert.equal(users.getPushCursor(u.id), count, "the cursor jumps to the highest of the discarded response");
        const situation = push.pushObserver?.(u.id);
        assert.ok(situation?.violations >= 1, `no violation booked: ${JSON.stringify(situation)}`);
        assert.ok(situation.gapMs >= 20, `the gap did not grow: ${JSON.stringify(situation)}`);
      } finally { z.shutdown(); }
    });
  } finally { await b.shutdown(); }
});

test("a catch-up under the cap delivers every new note and writes the cursor ONCE (before sending)", async () => {
  const b = catchUpBackend({ stream: (res) => res.write(": hello\n\n"), notes: () => ({ events: notes(3), seq: 3 }) });
  const port = await b.listen();
  try {
    await withUser(async (u, dir) => {
      users.upsertPushDevice(u.id, DEVICE);
      users.setPushCursor(u.id, 0);
      const z = counter(dir);
      try {
        push.watchBackend(u.id, port);
        await until(() => z.deliveries() >= 3);
        assert.equal(z.deliveries(), 3);
        assert.equal(z.cursor(), 1, `the cursor was written per note (${z.cursor()} times)`);
        assert.equal(users.getPushCursor(u.id), 3);
        assert.equal(push.pushObserver?.(u.id)?.violations, 0, "an open stream with three notes is no violation");
      } finally { z.shutdown(); }
    });
  } finally { await b.shutdown(); }
});

test("an event stream the backend closes at once is a violation — closing and catching up do not run at the base pace", async () => {
  const b = catchUpBackend({ stream: (res) => res.end(": bye\n\n"), notes: () => ({ events: [], seq: 0 }) });
  const port = await b.listen();
  try {
    await withUser(async (u) => {
      process.env.GW_PUSH_GAP_MS = "10";
      process.env.GW_PUSH_SHORT_MS = "600000"; // every connection of this test is "short" — independent of the machine's load
      push.watchBackend(u.id, port);
      await b.wait("connections", 3); // the third connection: the first two are closed and booked
      const situation = push.pushObserver?.(u.id);
      assert.ok(situation?.violations >= 2, `a stream closed at once did not count: ${JSON.stringify(situation)}`);
      assert.equal(situation.lastViolation, "stream-too-short");
      assert.ok(situation.gapMs >= 40, `the gap did not grow: ${JSON.stringify(situation)}`);
    });
  } finally { await b.shutdown(); }
});

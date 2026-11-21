// Native iPhone notifications: watch backend events and deliver them centrally via APNs.
// The private APNs key deliberately stays in the gateway — users have shell access to their backend containers and must
// therefore never receive it there.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import * as users from "./users.js";
import { fetchJsonFromBackend } from "./proxy.js";

const TOPIC = process.env.GW_APNS_TOPIC || "dev.cbase.mobile";
const TEAM_ID = process.env.GW_APNS_TEAM_ID || "";
const connections = new Map(); // environment -> ClientHttp2Session
const jwtCache = new Map(); // environment -> { token, at, fingerprint }
const watchers = new Map(); // userId -> { port, request, retry, violation, responseAt, still }
// Per user across reconnects: gap before the next reconnect, budget of the current window, last violation.
const situation = new Map(); // userId -> { gapMs, windowStart, windowCharacter, windowEvents, violations, lastViolation }

const b64url = (value) => Buffer.from(value).toString("base64url");

function apnsConfig(environment) {
  const prefix = environment === "sandbox" ? "GW_APNS_SANDBOX" : "GW_APNS_PRODUCTION";
  const keyPath = process.env[`${prefix}_KEY_PATH`] || process.env.GW_APNS_KEY_PATH || "";
  const keyId = process.env[`${prefix}_KEY_ID`] || process.env.GW_APNS_KEY_ID || "";
  if (!TEAM_ID || !keyId || !keyPath) return null;
  try {
    return { keyId, keyPath, key: fs.readFileSync(keyPath, "utf8") };
  } catch (error) {
    console.error(`[push] APNs key not readable (${environment}):`, error?.message || error);
    return null;
  }
}

function providerToken(environment, config) {
  const now = Math.floor(Date.now() / 1000);
  const fingerprint = `${config.keyId}:${config.keyPath}`;
  const cached = jwtCache.get(environment);
  // Apple allows no more frequent rotation than every 20 minutes; 50 minutes keeps a safe distance from the hard one-hour limit.
  if (cached && cached.fingerprint === fingerprint && now - cached.at < 50 * 60) return cached.token;
  const head = b64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = b64url(JSON.stringify({ iss: TEAM_ID, iat: now }));
  const input = `${head}.${claims}`;
  const signature = crypto.sign("sha256", Buffer.from(input), {
    key: config.key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  const token = `${input}.${signature}`;
  jwtCache.set(environment, { token, at: now, fingerprint });
  return token;
}

function connection(environment) {
  const existing = connections.get(environment);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const host = environment === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
  const session = http2.connect(host);
  session.on("error", (error) => console.error(`[push] APNs connection (${environment}):`, error?.message || error));
  session.on("close", () => { if (connections.get(environment) === session) connections.delete(environment); });
  connections.set(environment, session);
  return session;
}

function cleanText(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// A notification already on the lock screen replaces the previous one of the SAME chat and the SAME kind: a run's second
// question is the current one, a fifth workflow step reached makes the fourth obsolete. Different kinds stay side by side —
// "it is done" must not overwrite a still unanswered question.
const collapse = (chatId, category) => `${chatId || "cbase"}-${category}`.slice(0, 64);

export function notificationForEvent(event) {
  if (event?.type === "notice" && event.notice) {
    const n = event.notice;
    // The verdict is made in the backend (it has chat and settings, we have neither). An old backend without the stamp yields
    // `undefined` — then delivery stays as before.
    if (n.push === false) return null;
    const category = String(n.category || n.kind || "notice");
    // A scheduled occurrence reports with the chat that carries its job (`chatId`) — the app opens it like any coding chat.
    const chatId = n.chatId || n.agentChatId || "";
    return {
      // The CHAT NAME on top, the kind below. The bell title ("Question: Foo") carries the prefix in front and would cut the
      // name off for any longer chat.
      title: cleanText(n.chatTitle || n.title, 120) || "cbase",
      subtitle: cleanText(n.pushSubtitle, 80),
      body: cleanText(n.body, 700),
      // A note may bring its own collapse id (approvals: two open cards in the same chat are two notifications); otherwise per
      // chat and kind.
      collapseId: n.collapseId ? cleanText(n.collapseId, 64) : collapse(chatId, category),
      data: {
        kind: String(n.kind || "notice"), category, noticeId: Number(n.id) || 0,
        chatId: n.chatId || "", agentChatId: n.agentChatId || "",
        workspaceId: n.workspaceId || "", projectId: n.projectId || "",
      },
    };
  }
  if (event?.type === "run" && event.running === false && event.answered === true && event.push !== false) {
    return {
      title: cleanText(event.pushTitle || event.title, 120) || "Answer ready",
      subtitle: cleanText(event.pushSubtitle, 80),
      body: cleanText(event.pushBody, 700) || "cbase finished the answer.",
      collapseId: collapse(event.chatId, "finished"),
      data: {
        kind: "chat", category: "finished", chatId: event.chatId || "", agentChatId: "",
        workspaceId: event.workspaceId || "", projectId: event.projectId || "",
      },
    };
  }
  return null;
}

async function sendOne(device, notification) {
  const config = apnsConfig(device.environment);
  if (!config) return { skipped: true };
  const payload = JSON.stringify({
    aps: {
      alert: {
        title: notification.title,
        // iOS shows the subtitle as a second, smaller line — without it the lock screen cannot tell whether this chat is ASKING
        // or merely done.
        ...(notification.subtitle ? { subtitle: notification.subtitle } : {}),
        body: notification.body,
      },
      sound: "default",
      "thread-id": notification.data.chatId || notification.data.kind || "cbase",
    },
    ...notification.data,
  });
  const session = connection(device.environment);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const request = session.request({
      ":method": "POST",
      ":path": `/3/device/${device.token}`,
      authorization: `bearer ${providerToken(device.environment, config)}`,
      "apns-topic": TOPIC,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": "0",
      "apns-collapse-id": notification.collapseId.slice(0, 64),
    });
    let status = 0;
    let body = "";
    request.setEncoding("utf8");
    request.on("response", (headers) => { status = Number(headers[":status"] || 0); });
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let reason = "";
      try { reason = JSON.parse(body).reason || ""; } catch {}
      finish({ status, reason });
    });
    request.on("error", (error) => finish({ status: 0, reason: error?.message || String(error) }));
    request.end(payload);
  });
}

export async function dispatchPush(userId, event) {
  const notification = notificationForEvent(event);
  if (!notification) return;
  const devices = users.listPushDevices(userId);
  if (!devices.length) return;
  const results = await Promise.all(devices.map(async (device) => {
    try {
      return { device, result: await sendOne(device, notification) };
    } catch (error) {
      // Even a broken/rotated key must damage neither the event stream nor the gateway process with an unhandled promise rejection.
      return { device, result: { status: 0, reason: error?.message || String(error) } };
    }
  }));
  for (const { device, result } of results) {
    if (result.skipped) {
      try { users.notePushResult(userId, device.token, device.environment, { status: 0, reason: "No APNs key in the gateway" }); } catch {}
    } else {
      try { users.notePushResult(userId, device.token, device.environment, result); } catch {}
    }
    if (result.status === 410 || ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(result.reason)) {
      users.removePushToken(userId, device.token, device.environment);
    } else if (!result.skipped && result.status !== 200) {
      console.error(`[push] APNs ${result.status || "Error"} (${device.environment}): ${result.reason || "unknown"}`);
    }
  }
  return results.map(({ device, result }) => ({
    installationId: device.installationId, environment: device.environment,
    status: result.skipped ? 0 : result.status, reason: result.skipped ? "No APNs key in the gateway" : (result.reason || ""),
    ok: result.status === 200,
  }));
}

// A test notification to ALL of the user's devices. It deliberately bypasses the backend's verdict — it checks the line (key,
// token, environment), not the settings.
export async function sendTestPush(userId, { title = "cbase", subtitle = "Test", body = "" } = {}) {
  const devices = users.listPushDevices(userId);
  if (!devices.length) return { devices: [], reason: "no-devices" };
  const notification = {
    title: cleanText(title, 120), subtitle: cleanText(subtitle, 80),
    body: cleanText(body, 700) || "If you read this, notifications arrive.",
    collapseId: "cbase-test",
    data: { kind: "test", category: "test", chatId: "", agentChatId: "", workspaceId: "", projectId: "" },
  };
  const out = [];
  for (const device of devices) {
    let result;
    try { result = await sendOne(device, notification); }
    catch (error) { result = { status: 0, reason: error?.message || String(error) }; }
    try { users.notePushResult(userId, device.token, device.environment, result.skipped ? { status: 0, reason: "No APNs key in the gateway" } : result); } catch {}
    out.push({
      installationId: device.installationId, environment: device.environment,
      status: result.skipped ? 0 : result.status,
      reason: result.skipped ? "No APNs key in the gateway" : (result.reason || ""),
      ok: result.status === 200,
    });
  }
  return { devices: out };
}

// The cursor is monotonic, the backend's event sequence is NOT: if its file is emptied or restored from a backup, it starts at 1
// again. Without reconciliation `id <= cursor` then discards every notification — silently and permanently ("Answer ready", a
// run event that bypasses the cursor, would keep arriving). It is reset to the CURRENT position, not to 0: the backlog is
// history, and 53 old lock-screen notifications at once are no service to the user — the same reason first activation only sets
// a marker.
function followUpReconcile(userId, seq) {
  const cursor = users.getPushCursor(userId);
  if (cursor == null || !Number.isFinite(seq) || seq >= cursor) return;
  console.warn(`[push] Backend event sequence restarted (highest number ${seq} < cursor ${cursor}) — cursor caught up.`);
  // resetPushCursor, not setPushCursor: normal setting clamps with MAX() and can never lower the position — the reconciliation
  // would otherwise be a call that does nothing.
  users.resetPushCursor(userId, seq);
}

// Catch-up via the bell route — with total deadline and cap: collecting the body without a limit or with only an idle deadline
// would let one request hold the event loop (see proxy.js fetchFromBackend). The cap must apply to the whole catch-up, not just
// the FETCH: 4 MiB hold ≈ 157,000 notes, each costing a cursor read and write in autocommit, and `await dispatchPush` returns at
// once without a device and never frees the event loop — login, proxy, tunnel and push of all users would stall. And a B that
// closed the event stream at once must count as a violation, or reconnect and catch-up would run every 2 s. Hence:
//  · at most CATCH_UP_CAP_NOTES per response — the backend's ring buffer holds 100 (server/backend/electron/server/services.js
//    pushEvent). More is a violation: discarded, nothing delivered, the gap doubled, and the cursor jumps ONCE to the highest of
//    the response (the same flood is not fetched again; a real backend is reconciled by followUpReconcile afterwards). Likewise
//    a response over the byte cap;
//  · the cursor is written ONCE, BEFORE sending and to the highest id to deliver — the same rule as consumeEvent ("mark before
//    the asynchronous send"): a note the live stream brings during catch-up sees the cursor and is not sent twice. The price: if
//    the gateway ends mid-catch-up, the rest is missing (at most 100 old ones);
//  · between two deliveries the catch-up frees the event loop (setImmediate);
//  · a stream that lived shorter than GW_PUSH_SHORT_MS counts as a violation (watchBackend).
export const CATCH_UP_CAP_BYTES = 4 * 1024 * 1024;
export const CATCH_UP_DEADLINE_MS = 10_000;
export const CATCH_UP_CAP_NOTES = 200;
const approve = () => new Promise((r) => setImmediate(r));
const highestId = (notices) => notices.reduce((max, n) => {
  const id = Number(n?.id);
  return Number.isFinite(id) && id > max ? id : max;
}, 0);
async function fetchNotices(userId, port, { violation = () => {} } = {}) {
  const cursor = users.getPushCursor(userId);
  const since = cursor ?? 0;
  const r = await fetchJsonFromBackend(port, `/api/services/events?since=${since}`, { deadlineMs: CATCH_UP_DEADLINE_MS, capBytes: CATCH_UP_CAP_BYTES });
  if (r.error) {
    if (r.error === "too-big") violation("catch-up-too-big");
    return;
  }
  const notices = Array.isArray(r.json?.events) ? r.json.events : [];
  const seq = Number(r.json?.seq);
  if (notices.length > CATCH_UP_CAP_NOTES) {
    violation("too-many-notes");
    users.setPushCursor(userId, Math.max(highestId(notices), Number.isFinite(seq) ? seq : 0));
    return;
  }
  // On first activation only mark historic bell events as a starting point — nobody wants to suddenly receive up to 100 old
  // lock-screen notifications.
  if (cursor == null) {
    users.setPushCursor(userId, Math.max(highestId(notices), Number.isFinite(seq) ? seq : 0));
    return;
  }
  // BEFORE the loop: a restarted counter returns nothing for `since=cursor` anyway, so the reconciliation must happen
  // independently of the list.
  followUpReconcile(userId, seq);
  const state = users.getPushCursor(userId) ?? 0;
  const open = notices.filter((n) => (Number(n?.id) || 0) > state);
  if (!open.length) return;
  users.setPushCursor(userId, highestId(open));
  for (const notice of open) {
    await dispatchPush(userId, { type: "notice", notice });
    await approve();
  }
}

// The delivery runs on the side — its rejection is reported, not left to the process.
const reportDelivery = (userId) => (e) => console.error(`[push] Delivery for ${userId}:`, e?.message || e);
function consumeEvent(userId, event) {
  if (event?.type === "notice" && event.notice?.id) {
    const id = Number(event.notice.id) || 0;
    const cursor = users.getPushCursor(userId);
    if (cursor != null && id <= cursor) return;
    // Mark before the asynchronous send: the catch-up started right afterwards reads the same persisted notice and would
    // otherwise deliver it a second time.
    users.setPushCursor(userId, id);
    dispatchPush(userId, event).catch(reportDelivery(userId));
    return;
  }
  dispatchPush(userId, event).catch(reportDelivery(userId));
}

// ── A container's event stream: capped, with idle deadline and growing gap ───────────────────────────────────────────────────
// A backend that writes without a blank line (the listener on 7718 belongs to the user `agent` in B, i.e. to any agent there)
// would drive the gateway to gigabytes and an event loop at full load — login, proxy, tunnel and push of ALL users would stall.
// Hence:
//  · one event (up to the blank line) is at most PUSH_EVENT_CAP characters — the backend's events are status messages of a few
//    hundred bytes (runtime/sse.js broadcast); above that it is no event but a violation;
//  · the search for the blank line starts at the end of the previous chunk, not at the start of the buffer (else quadratic);
//  · a budget per user per window (characters AND events) — a flood of valid small events would otherwise cost a DB query each;
//  · a violation discards the stream and doubles the reconnect gap up to PUSH_GAP_MAX_MS; only a stream that ran PUSH_PROVEN_MS
//    without a violation resets it (alternating good and bad keeps growing it); and a user request (ensureBackend →
//    watchBackend) no longer skips the waiting gap;
//  · idle deadline (knob GW_PUSH_SILENCE_MS, default 90 s = three backend heartbeats of 25 s): a silent stream is rebuilt. There
//    is deliberately no TOTAL deadline — the stream should live forever, and the budget limits what it may cost.
// What is lost when discarding is caught up by the reconnect via fetchNotices (bell notifications; not "Answer ready").
export const PUSH_EVENT_CAP = 1024 * 1024;
export const PUSH_WINDOW_MS = 60_000;
export const PUSH_WINDOW_CHARACTER = 16 * 1024 * 1024;
export const PUSH_WINDOW_EVENTS = 3000;
export const PUSH_GAP_MAX_MS = 5 * 60_000;
export const PUSH_PROVEN_MS = 5 * 60_000;
const slider = (name, preset) => {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : preset;
};
// Read at runtime; only the test sets them small (push.test.js).
const silenceMs = () => slider("GW_PUSH_SILENCE_MS", 90_000);
const reasonGapMs = () => slider("GW_PUSH_GAP_MS", 2000);
// A stream that lived shorter (ended by the backend, not by the idle deadline) is a violation: the backend sends an `init` at
// once and then a heartbeat every 25 s — it does not close after a second.
const shortMs = () => slider("GW_PUSH_SHORT_MS", 1000);

// The splitter alone (no network, for the test): `shift(chunk)` calls `atEvent(text)` per complete event and returns false as
// soon as the incomplete rest exceeds the cap — then the stream is to be discarded. After each chunk the rest is at most `cap`
// plus one chunk.
const BLANK_LINE = "\n\n";
export function sseSplitter({ cap = PUSH_EVENT_CAP, atEvent }) {
  let rest = "";
  return {
    shift(chunk) {
      let from = Math.max(0, rest.length - 1); // the blank line may span the chunk boundary
      rest += chunk;
      let pos = 0;
      let end;
      while ((end = rest.indexOf(BLANK_LINE, from)) >= 0) {
        atEvent(rest.slice(pos, end));
        pos = end + BLANK_LINE.length;
        from = pos;
      }
      if (pos > 0) rest = rest.slice(pos);
      return rest.length <= cap;
    },
    get rest() { return rest.length; },
  };
}

function situationOf(userId) {
  let l = situation.get(userId);
  if (!l) {
    l = { gapMs: reasonGapMs(), windowStart: Date.now(), windowCharacter: 0, windowEvents: 0, violations: 0, lastViolation: "" };
    situation.set(userId, l);
  }
  return l;
}
// Read-only, for test and diagnosis: the state of a user's observer (or null).
export function pushObserver(userId) {
  const w = watchers.get(userId);
  const l = situation.get(userId);
  if (!w && !l) return null;
  return {
    port: w?.port ?? null, connected: !!(w?.request && !w.request.destroyed), waiting: !!w?.retry,
    gapMs: l?.gapMs ?? null, violations: l?.violations ?? 0, lastViolation: l?.lastViolation ?? "",
  };
}

function bookWindow(l, character, events) {
  const now = Date.now();
  if (now - l.windowStart >= PUSH_WINDOW_MS) { l.windowStart = now; l.windowCharacter = 0; l.windowEvents = 0; }
  l.windowCharacter += character;
  l.windowEvents += events;
  if (l.windowCharacter > PUSH_WINDOW_CHARACTER) return "too-many-character";
  if (l.windowEvents > PUSH_WINDOW_EVENTS) return "too-many-events";
  return null;
}

export function watchBackend(userId, port) {
  // No (re)connection for a locked or deleted user — otherwise the observer would knock forever at a port another container may
  // get later.
  if (!users.isActive(userId)) { unwatchBackend(userId); return; }
  const current = watchers.get(userId);
  if (current?.port === port && current.request && !current.request.destroyed) return;
  // If the same port already waits for its reconnect, it stays so (see above). A NEW port (container replaced) connects at
  // once and starts with a fresh state.
  if (current?.port === port && current.retry) return;
  if (current?.retry) clearTimeout(current.retry);
  try { current?.request?.destroy(); } catch {}
  if (current && current.port !== port) situation.delete(userId);

  const l = situationOf(userId);
  const watcher = { port, request: null, retry: null, violation: "", responseAt: 0, silent: false };
  watchers.set(userId, watcher);
  const bookViolation = (reason) => {
    l.violations += 1;
    l.lastViolation = reason;
    l.gapMs = Math.min(PUSH_GAP_MAX_MS, Math.max(reasonGapMs(), l.gapMs) * 2);
    console.warn(`[push] Event stream of ${userId} discarded (${reason}) — next attempt in ${Math.round(l.gapMs / 1000)} s`);
  };
  const dismiss = (reason) => {
    if (watcher.violation) return;
    watcher.violation = reason;
    bookViolation(reason);
    try { watcher.request?.destroy(); } catch {}
  };
  // A catch-up violation counts on its own, even if the stream is already closed (a short stream AND a flood are two).
  const violationAtCatchUp = (reason) => {
    bookViolation(reason);
    if (!watcher.violation) watcher.violation = reason;
    try { watcher.request?.destroy(); } catch {}
  };
  const request = http.get({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
    watcher.responseAt = Date.now();
    const splitter = sseSplitter({
      atEvent: (frame) => {
        if (watcher.violation) return;
        const tooMuch = bookWindow(l, 0, 1);
        if (tooMuch) { dismiss(tooMuch); return; }
        const data = frame.split("\n").find((line) => line.startsWith("data:"));
        if (!data) return;
        try { consumeEvent(userId, JSON.parse(data.slice(5).trim())); } catch {}
      },
    });
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      if (watcher.violation) return;
      const tooMuch = bookWindow(l, chunk.length, 0);
      if (tooMuch) { dismiss(tooMuch); return; }
      if (!splitter.shift(chunk)) dismiss("event-too-large");
    });
    res.on("error", () => {});
    // SSE first; then catch up missed persistent notices without a race.
    fetchNotices(userId, port, { violation: violationAtCatchUp }).catch((e) => console.error(`[push] Catch-up for ${userId}:`, e?.message || e));
  });
  watcher.request = request;
  request.setTimeout(silenceMs(), () => { watcher.silent = true; request.destroy(); });
  const reconnect = () => {
    if (watchers.get(userId) !== watcher || watcher.retry) return;
    // Ended by the backend after less than GW_PUSH_SHORT_MS (not by us: neither violation nor idle deadline) ⇒ a violation.
    if (!watcher.violation && !watcher.silent && watcher.responseAt && Date.now() - watcher.responseAt < shortMs()) {
      watcher.violation = "stream-too-short";
      bookViolation("stream-too-short");
    }
    // A stream that ran long without a violation resets the gap; a short one keeps it.
    if (!watcher.violation && watcher.responseAt && Date.now() - watcher.responseAt >= PUSH_PROVEN_MS) l.gapMs = reasonGapMs();
    watcher.retry = setTimeout(() => {
      watcher.retry = null;
      if (watchers.get(userId) === watcher) watchBackend(userId, port);
    }, l.gapMs);
    watcher.retry.unref?.();
  };
  request.on("error", reconnect);
  request.on("close", reconnect);
}

export function unwatchBackend(userId) {
  const watcher = watchers.get(userId);
  watchers.delete(userId);
  situation.delete(userId);
  if (watcher?.retry) clearTimeout(watcher.retry);
  try { watcher?.request?.destroy(); } catch {}
}

export function pushConfiguration() {
  return {
    topic: TOPIC,
    sandbox: !!apnsConfig("sandbox"),
    production: !!apnsConfig("production"),
  };
}

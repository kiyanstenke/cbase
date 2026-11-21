// Notifications: global default per kind + three-valued override per chat.
// Proves the DECISION and its stamp on the event — not the delivery itself (that belongs to the
// gateway and is covered in server/gateway/push.test.js).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as notifications from "../electron/server/notify.js";

test("Vocabulary: kinds, defaults and the mapping of the bell kind", () => {
  // The defaults are half the promise of the feature: question on, finished reply off.
  assert.equal(notifications.defaultOf("question"), true);
  assert.equal(notifications.defaultOf("review"), true);
  assert.equal(notifications.defaultOf("finished"), false);
  assert.equal(notifications.defaultOf("workflow"), false);
  assert.equal(notifications.defaultOf("trigger"), false);
  assert.equal(notifications.defaultOf("info"), false);
  // Approval: an agent waits at a card, so on, like the question.
  assert.equal(notifications.defaultOf("approval"), true);
  assert.equal(notifications.isChatKind("approval"), true);
  // Usage limit: parking AND resuming report the same kind, default ON, because with a weekly
  // window days lie between the two halves.
  assert.equal(notifications.defaultOf("limit"), true);
  assert.equal(notifications.isChatKind("limit"), true);
  assert.deepEqual(notifications.CHAT_KINDS, ["question", "approval", "review", "finished", "workflow", "trigger", "limit"]);
  assert.deepEqual(notifications.SCHEDULE_KINDS, ["schedule", "question", "approval"]);
  assert.equal(notifications.kindOfKind("approval"), "approval");
  // Only two bell kinds deviate; anything unknown falls back to `info` and does not pass through.
  assert.equal(notifications.kindOfKind("question"), "question");
  assert.equal(notifications.kindOfKind("down"), "service");
  assert.equal(notifications.kindOfKind("up"), "service");
  assert.equal(notifications.kindOfKind("schedule"), "schedule");
  assert.equal(notifications.kindOfKind("was-also-always"), "info");
});

/** Deviations of the UI test fixture (NOTIFY_KINDS) from notify.js: order, default, chat flag, label, hint (German). */
function fixtureDeviations(fixture) {
  const out = [];
  const desired = notifications.KINDS.map((a) => ({ key: a.key, chat: a.chat, preset: a.preset, label: notifications.kindLabel(a.key), hint: notifications.kindHint(a.key) }));
  assert.deepEqual(fixture.map((a) => a.key), desired.map((a) => a.key), "the fixture lists other kinds (or another order) than notify.js");
  for (const [i, a] of desired.entries()) for (const k of ["chat", "preset", "label", "hint"]) {
    if (fixture[i][k] !== a[k]) out.push(`${a.key}.${k}: fixture ${JSON.stringify(fixture[i][k])}, server ${JSON.stringify(a[k])}`);
  }
  return out;
}

test("The UI test fixture (mobile/test-fixtures) lists the same kinds, defaults, labels and hints as notify.js", async () => {
  // Without this binding the fixture could keep an outdated approval hint ("Ein Manager-Agent will …") while the
  // server says "Ein Agent will …", and the iOS settings tests would measure a text the server does not send.
  const { NOTIFY_KINDS } = await import("../../../mobile/test-fixtures/chat-gateway/state.mjs");
  const out = fixtureDeviations(NOTIFY_KINDS);
  assert.deepEqual(out, [], out.join("\n"));
  // Counter-test built in: the old hint is noticed.
  const old = NOTIFY_KINDS.map((a) => (a.key === "approval" ? { ...a, hint: "Ein Manager-Agent will ein Werkzeug ausführen, das deine Freigabe braucht — der Lauf wartet." } : a));
  assert.ok(fixtureDeviations(old).some((z) => z.startsWith("approval.hint")), "the old approval hint would go unnoticed");
});

test("Decision: chat beats global, \"default\" is the absence of an entry", () => {
  const global = { question: true, finished: false, review: true };
  // Without its own choice the global value applies: the initial state of every new chat.
  assert.equal(notifications.pushAllowed("question", {}, global), true);
  assert.equal(notifications.pushAllowed("finished", {}, global), false);
  // Overridable in both directions: mute a noisy chat AND raise an important one.
  assert.equal(notifications.pushAllowed("question", { question: "off" }, global), false);
  assert.equal(notifications.pushAllowed("finished", { finished: "on" }, global), true);
  // An unknown kind never gets through, otherwise a future notice type would push unasked.
  assert.equal(notifications.pushAllowed("invented", { invented: "on" }, { invented: true }), false);
  // If the global map is missing entirely, the built-in default applies.
  assert.equal(notifications.pushAllowed("question", {}, {}), true);
  assert.equal(notifications.pushAllowed("finished", {}, {}), false);
});

test("Normalizing the choice: only real values, only allowed kinds; \"standard\" is not stored", () => {
  const raw = { question: "on", finished: "off", review: "standard", schedule: "on", nonsense: "on" };
  // "standard" is dropped (it IS the absence), `schedule` is not selectable on an ordinary chat,
  // and an unknown key does not reach the database.
  assert.deepEqual(notifications.normalizeChoice(raw), { question: "on", finished: "off" });
  // A schedule uses a different set.
  assert.deepEqual(notifications.normalizeChoice(raw, notifications.SCHEDULE_KINDS),
    { question: "on", schedule: "on" });
  assert.deepEqual(notifications.normalizeChoice(null), {});
  assert.deepEqual(notifications.normalizeChoice("broken"), {});
});

test("Chat row marker: \"off\" wins in a mixed state", () => {
  assert.equal(notifications.chatMarker({}), "");
  assert.equal(notifications.chatMarker({ finished: "on" }), "loud");
  assert.equal(notifications.chatMarker({ question: "off" }), "silent");
  // Mixed: silence is the state that surprises; the marker must answer "why did nothing come
  // here", not "something extra comes here".
  assert.equal(notifications.chatMarker({ question: "off", finished: "on" }), "silent");
});

test("The bell counter survives clearing, otherwise the push bridge discards everything", async () => {
  const services = await import("../electron/server/services.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-notify-seq-"));
  try {
    services.initServices({ dataDir: dir });
    services.recordNotice({ kind: "info", title: "one" });
    services.recordNotice({ kind: "info", title: "two" });
    assert.equal(services.currentEventSeq(), 2);
    services.clearMonitorEvents();
    assert.equal(services.getMonitorEvents(0).length, 0);
    // The counter keeps running although the list is empty.
    assert.equal(services.currentEventSeq(), 2);
    services.recordNotice({ kind: "info", title: "three" });
    assert.equal(services.getMonitorEvents(0)[0].id, 3);

    // And it survives a restart: it used to fall back to 0 here, after which the gateway's
    // monotonic cursor silently discarded every notification.
    services.initServices({ dataDir: dir });
    assert.equal(services.currentEventSeq(), 3, "after a restart the counter must continue");
    const next = services.recordNotice({ kind: "info", title: "four" });
    assert.equal(next.id, 4);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { console.warn("cleanup failed"); }
  }
});

test("The stamp travels with the event: verdict, kind and the chat name for the lock screen", async () => {
  const services = await import("../electron/server/services.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-notify-stamp-"));
  try {
    services.initServices({
      dataDir: dir,
      // server.js wires the real verdict this way: the gate knows chat and settings.
      pushGate: (ev) => ({
        category: notifications.kindOfKind(ev.kind),
        push: ev.kind !== "info",
        pushTitle: ev.chatTitle || "",
        pushSubtitle: notifications.kindLabel(notifications.kindOfKind(ev.kind)),
      }),
    });
    const question = services.recordNotice({ kind: "question", title: "Question: Epics", chatTitle: "Epics", body: "Which cut?" });
    assert.equal(question.category, "question");
    assert.equal(question.push, true);
    assert.equal(question.pushTitle, "Epics", "the bare chat name is on top, not the bell title");
    assert.equal(question.title, "Question: Epics", "the bell keeps its wording");
    const info = services.recordNotice({ kind: "info", title: "Intake" });
    assert.equal(info.push, false);
    // The stamp must be PERSISTED: the catch-up reads the same row and must see the same
    // decision as the live stream.
    const file = JSON.parse(fs.readFileSync(path.join(dir, "service-events.json"), "utf8"));
    assert.equal(file.events.find((e) => e.title === "Intake").push, false);
    assert.equal(file.events.find((e) => e.title === "Question: Epics").pushTitle, "Epics");
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { console.warn("cleanup failed"); }
  }
});

test("Resolved questions: resolveNotices marks per card, survives the restart and leaves other kinds alone", async () => {
  const services = await import("../electron/server/services.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-notify-resolved-"));
  try {
    services.initServices({ dataDir: dir });
    // A question carries its chat under `chatId`, and the foreign kind is an info notice.
    services.recordNotice({ kind: "question", title: "Question: Epics", chatId: "m1", requestId: "r1" });
    services.recordNotice({ kind: "question", title: "Question: Stories", chatId: "m1", requestId: "r2" });
    services.recordNotice({ kind: "review", title: "Review: Checkout", chatId: "c1" });
    services.recordNotice({ kind: "info", title: "Hint", chatId: "m1" });
    const events = () => services.getMonitorEvents(0);
    assert.equal(events().find((e) => e.requestId === "r1").resolved, undefined, "a fresh notice carries no marker");

    // Per card: only the notice with THIS requestId; the second question of the same chat stays open.
    assert.equal(services.resolveNotices({ id: "m1", requestId: "r1" }), 1);
    assert.equal(events().find((e) => e.requestId === "r1").resolved, true);
    assert.equal(Boolean(events().find((e) => e.requestId === "r2").resolved), false);
    assert.ok(events().find((e) => e.requestId === "r1").resolvedAt > 0);
    // Without requestId the chat applies: everything open of these kinds in it, never a foreign kind.
    assert.equal(services.resolveNotices({ id: "m1" }), 1, "only r2 was still open");
    assert.equal(Boolean(events().find((e) => e.kind === "info").resolved), false, "an info notice is not a question");
    assert.equal(Boolean(events().find((e) => e.kind === "review").resolved), false, "other chat");
    // Reviews go through their kind (answerReview), and a second call changes nothing.
    assert.equal(services.resolveNotices({ id: "c1", kinds: ["review"] }), 1);
    assert.equal(services.resolveNotices({ id: "c1", kinds: ["review"] }), 0);

    // The marker is persisted: it is still there after the restart.
    services.initServices({ dataDir: dir });
    assert.equal(events().filter((e) => e.resolved).length, 3);
    assert.equal(Boolean(events().find((e) => e.kind === "info").resolved), false);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { console.warn("cleanup failed"); }
  }
});

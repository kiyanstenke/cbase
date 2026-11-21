// Migrations of the store that cannot be produced through the store API.
//
// All of them check the same pattern: an old state lies on the disk, `initStore` runs over it, and afterwards the new state
// stands, exactly once, without data loss. The old state is written through a SECOND `DatabaseSync` connection because the store
// API cannot produce it after the migration.
//
// Own file: `initStore` rebinds the module-wide `db`, and these tests call it TWICE on the same store.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { db as storeDb } from "../electron/server/store/db.js";

function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-migration-"));
  try {
    store.initStore(dir);
    run(dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }
  }
}

// ── Visibility markers on skills ─────────────────────────────────────────────
//
// A skill carries two independent markers. The migration is NOT a function of its own with a marker in `app_settings` but the
// column default itself: `ALTER TABLE ... ADD COLUMN for_coding INTEGER NOT NULL DEFAULT 1` fills every existing row with 1,
// `for_managing` with 0. That is exactly the wanted state: every existing skill behaves as before, and the manager sees only
// what is released by hand. A migration of its own with a marker would be an intermediate layer that could do nothing more:
// ALTER TABLE runs exactly once per database anyway.
//
// The store API no longer produces the old state (the columns exist after the first init), so they are removed again through a
// second connection, as the table looked before.
//
// Every skill belongs to EXACTLY ONE area, and `createSkill` takes the area instead of two markers (default coding). The column
// defaults stay the migration of THIS stage; the one-time migration to the area is checked by skills-area-migration.test.js.
function skillMarkersRemove(dir) {
  const raw = new DatabaseSync(path.join(dir, "automater.db"));
  try {
    raw.exec("ALTER TABLE skills DROP COLUMN for_coding");
    raw.exec("ALTER TABLE skills DROP COLUMN for_managing");
  } finally { raw.close(); }
}

test("migration: an existing skill gets coding and NOT managing", () => {
  withStore((dir) => {
    const ws = store.createWorkspace({ id: randomUUID(), name: "W", path: "/tmp/w", createdAt: 1000 });
    const old = store.createSkill({ id: randomUUID(), workspaceId: ws.id, name: "grill", description: "d", body: "b", createdAt: 1000, updatedAt: 1000 });
    // Newly created without an indication it is a coding skill: the default of CREATING (an area).
    assert.equal(old.area, "coding");
    assert.equal(old.forCoding, true);
    assert.equal(old.forManaging, false);

    skillMarkersRemove(dir);
    store.initStore(dir);

    const after = store.getSkill(old.id);
    assert.equal(after.forCoding, true, "the skill behaves as before for coding");
    assert.equal(after.forManaging, false, "the manager sees it only after a manual step");
    // And the migration must not have touched anything else.
    assert.equal(after.name, "grill");
    assert.equal(after.body, "b");
  });
});

test("migration: a second start does not flip a set area back", () => {
  withStore((dir) => {
    const ws = store.createWorkspace({ id: randomUUID(), name: "W", path: "/tmp/w", createdAt: 1000 });
    const s = store.createSkill({ id: randomUUID(), workspaceId: ws.id, name: "grill", description: "d", body: "b", createdAt: 1000, updatedAt: 1000 });

    skillMarkersRemove(dir);
    store.initStore(dir);
    assert.equal(store.getSkill(s.id).forManaging, false);

    // The area is fixed (no way changes it): a row with the managing marker is produced here through the raw connection, as an
    // older release would have written it. Without idempotence the column default would come back at the next start, and no
    // area could be held.
    storeDb.prepare("UPDATE skills SET for_coding = 0, for_managing = 1 WHERE id = ?").run(s.id);
    store.initStore(dir);
    assert.equal(store.getSkill(s.id).area, "managing", "the set area holds");
    assert.equal(store.getSkill(s.id).forManaging, true);
    assert.equal(store.getSkill(s.id).forCoding, false);
  });
});

const hasColumn = (dir, table, column) => {
  const raw = new DatabaseSync(path.join(dir, "automater.db"));
  try { return raw.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column); }
  finally { raw.close(); }
};

// The special chat of a role, read raw: the store reader fell away without a caller.
const specialChatId = (wsId, role) => storeDb.prepare("SELECT id FROM chats WHERE workspace_id = ? AND specialRole = ?").get(wsId, role)?.id;

// ── Special roles on the chat ────────────────────────────────────────────────
//
// The marker is multi-valued (`chats.specialRole`), the index runs over workspace AND role. Column and index belong to the schema
// of the chats (store/db.js).
test("roles: two special chats per workspace are allowed, a second of the same role is not", () => {
  withStore((dir) => {
    const ws = store.createWorkspace({ id: randomUUID(), name: "W", path: "/tmp/w", createdAt: 1000 });
    const second = store.createWorkspace({ id: randomUUID(), name: "X", path: "/tmp/x", createdAt: 1000 });
    const mk = (wsId, title) => store.createChat({ id: randomUUID(), workspaceId: wsId, title, kind: "manager", createdAt: 1000, updatedAt: 1000 });

    const pipe = mk(ws.id, "Extraction");
    const verw = mk(ws.id, "Administrator");
    mk(ws.id, "Sparring"); // an ordinary manager chat beside it; the index sees only special roles
    store.updateChat(pipe.id, { specialRole: "pipeline" });
    store.updateChat(verw.id, { specialRole: "administrator" });

    // Two DIFFERENT roles in the same workspace: that is the whole reason for the rebuild.
    assert.equal(specialChatId(ws.id, "pipeline"), pipe.id);
    assert.equal(specialChatId(ws.id, "administrator"), verw.id);

    // A SECOND administrator in the same workspace is not: as an index, not as a convention.
    const duplicate = mk(ws.id, "Administrator again");
    assert.throws(() => store.updateChat(duplicate.id, { specialRole: "administrator" }),
      /UNIQUE|constraint/i, "the index rejects the second administrator");

    // In ANOTHER workspace the same role works again.
    const foreign = mk(second.id, "Administrator");
    store.updateChat(foreign.id, { specialRole: "administrator" });
    assert.equal(specialChatId(second.id, "administrator"), foreign.id);
  });
});

// Column and backfill of existing rows used to stand in the SAME swallowing try. If the backfill died (crash, BUSY, disk full),
// the column stayed with its DEFAULT; the next start threw "duplicate column" at the ALTER, the catch swallowed it, and the
// backfill NEVER ran again; for `titled` that meant every existing chat counted as untitled and was renamed by the auto-title.
// Here the backfill dies at a trigger (standing in for the crash between the two statements); afterwards the next start must
// catch up both.
test("migration: if the backfill of a new column dies, the next start catches up column AND backfill", () => {
  withStore((dir) => {
    const ws = store.createWorkspace({ id: randomUUID(), name: "W", path: "/tmp/w", createdAt: 1000 });
    const titled = store.createChat({ id: randomUUID(), workspaceId: ws.id, title: "Offer Müller", createdAt: 1000, updatedAt: 1000 });
    const fresh = store.createChat({ id: randomUUID(), workspaceId: ws.id, createdAt: 1000, updatedAt: 1000 });
    const raw = new DatabaseSync(path.join(dir, "automater.db"));
    try {
      raw.exec("ALTER TABLE chats DROP COLUMN titled");
      raw.exec("CREATE TRIGGER poison_n37 BEFORE UPDATE OF titled ON chats BEGIN SELECT RAISE(ABORT, 'POISON-N37'); END");
    } finally { raw.close(); }

    // The backfill dies: the start must SAY so instead of running on with a half migration.
    assert.throws(() => store.initStore(dir), /POISON-N37/, "the error in the backfill was swallowed; the migration would stay half");
    try { storeDb.close(); } catch { /* closed is closed */ }
    assert.equal(hasColumn(dir, "chats", "titled"), false, "the column stayed without its backfill; the next start never caught it up");

    const raw2 = new DatabaseSync(path.join(dir, "automater.db"));
    try { raw2.exec("DROP TRIGGER poison_n37"); } finally { raw2.close(); }
    store.initStore(dir);
    assert.equal(store.getChat(titled.id).titled, true, "the existing chat counts as untitled; the auto-title would rename it");
    assert.equal(store.getChat(fresh.id).titled, false);
  });
});

// Agent communication: the seven old tool names in stored lists, markers and seeded texts merge ONCE into the tool pair (the
// coding half: agent definitions, stored channel prompts; it runs idempotently in channels/migration-communication.js, table in
// channels/migration-communication-table.js). The old state can be produced here through the store API (the migration runs at
// server start, not in initStore), so it is called directly.
import { migrateCommunicationCoding } from "../electron/server/channels/migration-communication.js";

test("agent communication (a): an agent definition migrates in place, prefix kept; idempotent, without a marker", () => {
  withStore(() => {
    const ws = store.createWorkspace({ id: randomUUID(), name: "W", path: "/tmp/w", createdAt: 1000 });
    const old = "cbase_";
    // Agent definition (coding) with prefix form and bare form, in place.
    const def = store.createAgent({ id: randomUUID(), workspaceId: ws.id, name: "Researcher", toolList: ["Read", `mcp__cbase__${old}channel_read`, `${old}chat_read`, "Grep"], createdAt: 1, updatedAt: 1 });
    const c = migrateCommunicationCoding();
    assert.deepEqual(store.getAgent(def.id).toolList, ["Read", "mcp__cbase__cbase_agents_list", "cbase_agents_list", "Grep"], "in place, prefix kept");
    assert.equal(c.definitions, 1);
    // The coding half is idempotent and without a marker: a second run finds nothing more, a list saved later with an old name
    // migrates at the next start (counter-test: otherwise the list would stay with the old name).
    assert.deepEqual(migrateCommunicationCoding(), { definitions: 0, prompts: 0 });
    store.updateAgent(def.id, { toolList: [`${old}chat_list`] });
    assert.deepEqual(migrateCommunicationCoding(), { definitions: 1, prompts: 0 });
    assert.deepEqual(store.getAgent(def.id).toolList, ["cbase_agents_list"]);
  });
});

// (c) A channel turn PARKED at the limit/credit gate (pending_resumes, payload.cause "channel") and one INTERRUPTED by the deploy
// (active_runs, kind "chat:channel") start with their stored prompt (runs/auto-continue.js, runs/resume.js); the reply path in it
// must be the new one. Only the sentence, only channel rows, the counters stay.
// Counter-test: migration-communication.js without the two loops => red (they run without a marker, at every start).

test("agent communication (c): parked and interrupted channel turns get the new reply path; only the sentence changes, rows and counters stay", () => {
  withStore(() => {
    store.createWorkspace({ id: randomUUID(), name: "W", path: "/tmp/w", createdAt: 1000 });
    const channelId = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const oldSentence = `Antworte über cbase_${"channel_send"} (channelId: ${channelId})`;
    const prompt = `New message in the channel "K".\n${oldSentence}, if a reply is expected.\n\n<channel id="${channelId}">...</channel>`;
    const newSet = `Reply through cbase_agent_send (to: "channel:${channelId}")`;
    const [parked, userParked, interrupted, userInterrupted] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    store.setPendingResume(parked, { prompt, payload: { cause: "channel" }, provider: "claude", limitGroup: "weekly", resetsAt: 5_000, dueAt: 6_000 });
    store.bumpPendingResumeAttempts(parked);
    store.setPendingResume(userParked, { prompt, payload: { cause: "user" }, dueAt: 6_000 });
    store.setActiveRun(interrupted, { kind: "chat:channel", prompt, startedAt: 7_000 });
    store.bumpActiveRunAttempts(interrupted);
    store.setActiveRun(userInterrupted, { kind: "chat", prompt, startedAt: 7_000 });

    const b = migrateCommunicationCoding();

    const p = store.getPendingResume(parked);
    assert.ok(p.prompt.includes(newSet) && !p.prompt.includes(`cbase_${"channel_send"}`), p.prompt);
    assert.equal(p.prompt, prompt.replace(oldSentence, newSet), "only the sentence");
    assert.deepEqual([p.attempts, p.dueAt, p.resetsAt, p.limitGroup, p.payload.cause], [1, 6_000, 5_000, "weekly", "channel"], "the row stays as it is");
    assert.equal(store.getPendingResume(userParked).prompt, prompt, "a user turn stays");
    const runs = new Map(store.listActiveRuns().map((r) => [r.chatId, r]));
    assert.equal(runs.get(interrupted).prompt, prompt.replace(oldSentence, newSet));
    assert.deepEqual([runs.get(interrupted).attempts, runs.get(interrupted).startedAt], [1, 7_000]);
    assert.equal(runs.get(userInterrupted).prompt, prompt, "a user run stays");
    assert.equal(b.prompts, 2);
  });
});

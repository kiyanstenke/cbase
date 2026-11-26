// The agenda's archive and its read views (server/agenda/operations.js archive/restore/openOnly/searchAgenda, agenda/auto-archive.js,
// agenda/routes.js ?open/?point and /agenda/archive, mcp/tools/agenda.js). What the agent and the clients see of a long agenda: by
// default only what is not finished; a finished subtree leaves the active tree for the archive (by the main agent, or by the
// hourly sweep a week after a top-level item was finished) and comes back to its old place with `restore`.
//
// Counter-tests (which sabotage turns which test red):
//   - `archive` without the check of the computed status (operations.js)                 => "pure" falls (an unfinished subtree goes)
//   - the parent left without children keeps its stored status (drop the reset)          => "pure" falls (the parent reopens)
//   - `restore` ignores `afterId` (always at the end)                                     => "pure" falls (old place)
//   - store.agendaChange writes no archive row (drop the INSERT loop)                    => "seam" falls (nothing in the archive)
//   - openOnly filters the stored agenda instead of the response (counts of the subtree) => "pure" falls (progress 1/3)
//   - dueForArchive ignores `restoredAt`                                                  => "sweep" falls (a restored item goes again)
//   - dueForArchive also takes deeper points                                              => "sweep" falls
//   - the tool reads without `open=1` by default                                           => "seam" falls (done items in the read)
//   - the write answer carries the agenda again                                           => "seam" falls
//   - deleteAgenda leaves the archive rows / copyAgenda copies none or copies twice       => "seam" falls
//   - bringAlongWriter does not count archived points as touched/found                    => "pure" falls (keeper row)
//   - agendaFence returns "" for an empty agenda with an archive                           => "pure" falls
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { db as rawDb } from "../electron/server/store/db.js";
import { AgendaError, agendaResponse, applyOps, bringAlongWriter, openOnly, searchAgenda, upkeepInput } from "../electron/server/agenda/operations.js";
import { agendaFence } from "../electron/server/runs/agenda-block.js";
import { AGENDA_ARCHIVE_AFTER_MS, dueForArchive, sweepAgendaArchive } from "../electron/server/agenda/auto-archive.js";
import { withAgentsServer } from "./agent-harness.mjs";

const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));
const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const EMPTY = Object.freeze({ title: "", description: "", steps: [], nextSeq: 1 });
const ids = (a) => a.steps.map((s) => s.id);
const raises = (fn, pattern) => assert.throws(fn, (e) => e instanceof AgendaError && pattern.test(e.message), `expected: ${pattern}`);

// A tree: s1 (s2 done, s3 open), s4 (s5 done, s6 done), s7 done leaf, s8 open.
const tree = () => applyOps(EMPTY, { steps: [
  { op: "fresh", text: "Feature A" }, // s1
  { op: "fresh", text: "a done", under: "s1", status: "done", note: "history of a" }, // s2
  { op: "fresh", text: "a open", under: "s1" }, // s3
  { op: "fresh", text: "Feature B" }, // s4
  { op: "fresh", text: "b one", under: "s4", status: "done" }, // s5
  { op: "fresh", text: "b two", under: "s4", status: "done" }, // s6
  { op: "fresh", text: "Single done", status: "done" }, // s7
  { op: "fresh", text: "Single open" }, // s8
] }, T0);

test("pure: archive only finished subtrees, restore to the old place, a childless parent stays done", () => {
  const a = tree();
  raises(() => applyOps(a, { steps: [{ op: "archive", id: "s1" }] }, T0 + 1), /„s1“ ist nicht erledigt \(in_work\)/);
  raises(() => applyOps(a, { steps: [{ op: "archive", id: "s3" }] }, T0 + 1), /„s3“ ist nicht erledigt \(open\)/);

  const b = applyOps(a, { steps: [{ op: "archive", id: "s4" }, { op: "archive", id: "s2" }] }, T0 + 1);
  assert.deepEqual(ids(b), ["s1", "s3", "s7", "s8"]);
  assert.deepEqual(b.archived, ["s4", "s2"]);
  assert.deepEqual(b.archive.map((e) => [e.rootId, e.parentId, e.afterId, e.points.map((p) => p.id), e.leaves, e.by]),
    [["s4", null, "s1", ["s4", "s5", "s6"], 2, "main"], ["s2", "s1", null, ["s2"], 1, "main"]]);

  // The last child archived: the parent becomes a leaf with its STORED status — set to done, not left at "open".
  const lone = applyOps(applyOps(EMPTY, { steps: [{ op: "fresh", text: "P" }, { op: "fresh", text: "c", under: "s1", status: "done" }] }, T0), { steps: [{ op: "archive", id: "s2" }] }, T0 + 5);
  assert.deepEqual(lone.steps.map((s) => [s.id, s.status]), [["s1", "done"]]);

  // Restore: behind the old sibling; as first child when it was first; at the end when the sibling is gone; on top when the parent is gone.
  const entries = new Map(b.archive.map((e, i) => [e.rootId, { ...e, id: i + 1 }]));
  const entryOf = (id) => [...entries.values()].find((e) => e.points.some((p) => p.id === id)) || null;
  const c = applyOps(b, { steps: [{ op: "restore", id: "s4" }, { op: "restore", id: "s2" }] }, T0 + 2, { archiveEntryOf: entryOf });
  assert.deepEqual(ids(c), ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"], "both at their old place");
  assert.equal(c.steps.find((s) => s.id === "s4").restoredAt, T0 + 2);
  assert.deepEqual(c.restore, [1, 2]);
  const gone = applyOps(applyOps(b, { steps: [{ op: "erase", id: "s1" }] }, T0 + 3), { steps: [{ op: "restore", id: "s2" }, { op: "restore", id: "s5" }] }, T0 + 4, { archiveEntryOf: entryOf });
  assert.deepEqual(gone.steps.map((s) => [s.id, s.parent]), [["s7", null], ["s8", null], ["s2", null], ["s4", null], ["s5", "s4"], ["s6", "s4"]],
    "parent gone: top level at the end; sibling gone: end of the level; an inner id brings its whole entry");
  raises(() => applyOps(b, { steps: [{ op: "restore", id: "s99" }] }, T0, { archiveEntryOf: entryOf }), /„s99“ steht nicht im Archiv/);
  raises(() => applyOps(b, { steps: [{ op: "restore", id: "s4" }, { op: "restore", id: "s5" }] }, T0, { archiveEntryOf: entryOf }), /steht nicht im Archiv/);

  // The keeper archives nothing.
  assert.throws(() => upkeepInput({ ...a, version: 1 }, { steps: [{ op: "archive", id: "s7" }] }, { base: 1 }), (e) => e.code === "NOT_ALLOWED");
  // A point the keeper created and the main agent archived: its log row is confirmed (it still exists, elsewhere), not left open.
  const input = { steps: [{ op: "archive", id: "s7" }] };
  const arch = applyOps(a, input, T0 + 9);
  assert.deepEqual(bringAlongWriter(a, arch, input, { rows: [{ id: 5, pointId: "s7", kind: "fresh", stage: "done", outcome: "open", outdated: false }] }).touched,
    [{ id: 5, outcome: "confirmed" }]);
  // Everything archived: the block still says there is an archive (otherwise the agent would never learn of it).
  assert.match(agendaFence({ title: "", description: "", steps: [] }, new Map(), { archived: 2 }), /\(2 archived subtrees \(cbase_agenda with archive: true or search\)\)/);
  assert.equal(agendaFence({ title: "", description: "", steps: [] }), "", "empty and nothing archived: no block");
});

test("pure: openOnly filters the response — a kept parent keeps the counts of its whole subtree; search with paths", () => {
  const a = tree();
  const r = openOnly(agendaResponse({ ...a, chatId: "c" }));
  assert.deepEqual(r.agenda.steps.map((s) => [s.id, s.status, s.subitems ? `${s.done}/${s.total}` : null]),
    [["s1", "in_work", "1/2"], ["s3", "open", null], ["s8", "open", null]]);
  assert.deepEqual(r.hidden, { done: 4 }, "finished LEAVES: s2, s5, s6, s7");
  assert.deepEqual(r.agenda.counter, { open: 2, in_work: 0, done: 4 }, "the counter stays that of the whole agenda");

  const b = applyOps(a, { steps: [{ op: "archive", id: "s2" }] }, T0 + 1);
  const entries = b.archive.map((e, i) => ({ ...e, id: i + 7 }));
  assert.deepEqual(searchAgenda(b.steps, entries, "feature a").hits.map((h) => [h.id, h.path, h.archived]), [["s1", [], false]], "case-insensitive");
  const s = searchAgenda(b.steps, entries, "a o");
  assert.deepEqual(s.hits.map((h) => [h.id, h.path, h.archived, h.entryId ?? null]), [["s3", ["Feature A"], false, null]]);
  assert.deepEqual(searchAgenda(b.steps, entries, "a d").hits.map((h) => [h.id, h.path, h.archived, h.entryId ?? null]),
    [["s2", ["Feature A"], true, 7]], "an archived hit's path begins where it hung");
  assert.deepEqual(searchAgenda(b.steps, entries, "history").hits.map((h) => h.id), ["s2"], "the note is searched too");
  const capped = searchAgenda(b.steps, entries, "e", { cap: 2 });
  assert.deepEqual(capped.hits.map((h) => h.archived), [false, false, true], "the cap holds per source: many active hits do not crowd out the archive");
  assert.equal(capped.more, true, "a cut list says so");
});

test("sweep: top-level items finished for a week, from doneAt or else changedAt; a restored one waits", () => {
  const a = tree();
  const now = T0 + AGENDA_ARCHIVE_AFTER_MS;
  assert.deepEqual(dueForArchive(a, now - 1), [], "not yet a week");
  assert.deepEqual(dueForArchive(a, now), ["s4", "s7"], "only top-level items, only finished ones (s2 is deeper, s1 open)");
  const legacy = { steps: [{ id: "s1", parent: null, text: "old", status: "done", createdAt: 1, changedAt: T0, doneAt: null }] };
  assert.deepEqual(dueForArchive(legacy, now), ["s1"], "without doneAt the changedAt counts");
  const back = { steps: a.steps.map((p) => (p.id === "s4" ? { ...p, restoredAt: now - DAY } : p)) };
  assert.deepEqual(dueForArchive(back, now), ["s7"], "restored a day ago: stays");
  const deepBack = { steps: a.steps.map((p) => (p.id === "s5" ? { ...p, restoredAt: now - DAY } : p)) };
  assert.deepEqual(dueForArchive(deepBack, now), ["s7"], "a restored point anywhere in the subtree holds it");
});

// The real MCP server against a real backend.
function withMcp(env, run) {
  const child = spawn(process.execPath, [MCP_SCRIPT], {
    env: { ...process.env, CBASE_TOOLS: undefined, CBASE_TOOLSET: undefined, CBASE_SKILLS: undefined, CBASE_AGENT_DEPTH: undefined,
      CBASE_WORKFLOW_AGENT: undefined, CBASE_OUTER_LOOP: undefined, CBASE_INSTANCE: undefined, CBASE_PROFILE_KEY: undefined,
      CBASE_ONLY_SUBAGENTS: undefined, CBASE_TOKEN: undefined, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const open = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const z = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!z) continue;
      const msg = JSON.parse(z);
      open.get(msg.id)?.(msg);
      open.delete(msg.id);
    }
  });
  let n = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = n++;
    open.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name, args = {}) => {
    const r = (await rpc("tools/call", { name, arguments: args })).result || {};
    const text = r.content?.[0]?.text || "";
    let data = null;
    try { data = JSON.parse(text); } catch { /* error text */ }
    return { isError: r.isError === true, text, data };
  };
  return (async () => {
    try {
      await rpc("initialize", { protocolVersion: "2025-06-18" });
      return await run({ call });
    } finally {
      child.stdin.end();
      child.kill();
    }
  })();
}

async function request(base, method, filePath, body) {
  const res = await fetch(`${base}${filePath}`, { method, headers: { Connection: "close", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

test("seam: the agent reads only what is open, archives and restores, the sweep archives, fork and delete carry the archive", async () => {
  await withAgentsServer(async ({ base, ws, chat }) => {
    const env = { CBASE_BASE_URL: base, CBASE_CHAT_ID: chat.id, CBASE_WORKSPACE_ID: chat.workspaceId };
    await withMcp(env, async ({ call }) => {
      const w = await call("cbase_agenda_write", { title: "Plan", steps: [
        { op: "fresh", text: "Feature A" }, { op: "fresh", text: "a done", under: "s1", status: "done", note: "the old finding" },
        { op: "fresh", text: "a open", under: "s1" }, { op: "fresh", text: "Feature B" },
        { op: "fresh", text: "b one", under: "s4", status: "done" }, { op: "fresh", text: "Single open" },
      ] });
      assert.equal(w.isError, false, w.text);
      assert.equal(w.data.agenda, undefined, "the write answer carries no agenda");
      assert.equal(w.data.steps.length, 6);

      // Reading: only what is open, with the count of the hidden ones; done: true the whole tree.
      const r = await call("cbase_agenda");
      assert.deepEqual(r.data.agenda.steps.map((s) => [s.id, s.progress ?? null]), [["s1", "1/2"], ["s3", null], ["s6", null]], r.text);
      assert.deepEqual(r.data.hidden, { done: 2 });
      assert.equal(r.data.agenda.inArchive, 0);
      assert.equal(r.text.includes("the old finding"), false, "a done item's note is not in the default read");
      assert.equal((await call("cbase_agenda", { done: true })).data.agenda.steps.length, 6);

      // Archive: s4 is finished (computed), s1 not.
      const no = await call("cbase_agenda_write", { steps: [{ op: "archive", id: "s1" }] });
      assert.equal(no.isError, true);
      const a = await call("cbase_agenda_write", { steps: [{ op: "archive", id: "s4" }, { op: "archive", id: "s2" }] });
      assert.equal(a.isError, false, a.text);
      assert.match(a.data.archived, /^2 items archived with their sub-items \(s4, s2\)$/);
      assert.equal(a.data.inArchive, 2);
      assert.deepEqual(a.data.next, { id: "s3", text: "a open", status: "open" });

      // The archive: list, a subtree by id, the search over both.
      const list = await call("cbase_agenda", { archive: true });
      assert.deepEqual(list.data.entries.map((e) => [e.id, e.leaves, e.by]), [["s2", 1, "main"], ["s4", 1, "main"]], list.text);
      const sub = await call("cbase_agenda", { id: "s4" });
      assert.deepEqual(sub.data.agenda.steps.map((s) => s.id), ["s4", "s5"]);
      assert.equal(sub.data.point.archived, true);
      const hits = await call("cbase_agenda", { search: "FINDING" });
      assert.deepEqual(hits.data.hits.map((h) => [h.id, h.archived, h.path]), [["s2", true, ["Feature A"]]], hits.text);

      // Restore: back at its old place.
      const back = await call("cbase_agenda_write", { steps: [{ op: "restore", id: "s2" }] });
      assert.equal(back.isError, false, back.text);
      assert.deepEqual(back.data.steps.map((s) => s.id), ["s2"], "the touched item comes back in the answer");
      assert.deepEqual((await call("cbase_agenda", { done: true })).data.agenda.steps.map((s) => s.id), ["s1", "s2", "s3", "s6"]);
    });
    assert.equal(rawDb.prepare("SELECT COUNT(*) AS n FROM chat_agenda_archive WHERE chat_id = ?").get(chat.id).n, 1);

    // The UI's routes: the count on the agenda, the archive pages, the search hits.
    const g = (await request(base, "GET", `/api/chats/${chat.id}/agenda`)).data;
    assert.equal(g.agenda.archived, 1);
    assert.equal(g.agenda.steps.length, 4, "the clients get the whole active tree");
    const page = (await request(base, "GET", `/api/chats/${chat.id}/agenda/archive?limit=1`)).data;
    assert.deepEqual([page.entries.map((e) => e.rootId), page.more, page.total], [["s4"], false, 1]);

    // The sweep: a top-level item finished for a week goes; the event reaches the stream.
    store.agendaChange(chat.id, (old) => applyOps(old, { steps: [{ op: "change", id: "s3", status: "done" }, { op: "change", id: "s6", status: "done" }] }, Date.now()));
    assert.equal(sweepAgendaArchive({ now: Date.now() }), 0, "not yet a week");
    assert.equal(sweepAgendaArchive({ now: Date.now() + AGENDA_ARCHIVE_AFTER_MS + 1000 }), 2, "s1 and s6 — only top-level items");
    const after = (await request(base, "GET", `/api/chats/${chat.id}/agenda`)).data.agenda;
    assert.deepEqual([after.steps.map((s) => s.id), after.archived], [[], 3]);
    const auto = (await request(base, "GET", `/api/chats/${chat.id}/agenda/archive`)).data.entries.slice(0, 2);
    assert.deepEqual(auto.map((e) => [e.rootId, e.by]), [["s6", "auto"], ["s1", "auto"]]);

    // Fork carries the archive (restore works there), delete takes it along.
    const fork = await request(base, "POST", `/api/chats/${chat.id}/fork`, {});
    assert.equal(fork.status, 201, JSON.stringify(fork.data));
    assert.equal((await request(base, "GET", `/api/chats/${fork.data.id}/agenda`)).data.agenda.archived, 3);
    store.copyAgenda(chat.id, fork.data.id);
    assert.equal(rawDb.prepare("SELECT COUNT(*) AS n FROM chat_agenda_archive WHERE chat_id = ?").get(fork.data.id).n, 3, "a repeated copy doubles no archive row");
    assert.equal((await request(base, "PUT", `/api/chats/${fork.data.id}/agenda`, { steps: [{ op: "restore", id: "s4" }] })).status, 200);
    assert.equal((await request(base, "GET", `/api/chats/${chat.id}/agenda`)).data.agenda.archived, 3, "the original keeps its archive");
    assert.equal((await request(base, "DELETE", `/api/chats/${fork.data.id}`)).status, 200);
    assert.equal(rawDb.prepare("SELECT COUNT(*) AS n FROM chat_agenda_archive WHERE chat_id = ?").get(fork.data.id).n, 0, "the archive survived its chat");
    void ws;
  });
});

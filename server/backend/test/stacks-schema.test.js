// The stacks/ domain folder: table `stack_copies` (store/stack-copies.js), name rule (stacks/names.js), location
// (stacks/location.js), setter with the event `project/copy` and the coupling to the instance row (stacks/state.js), journal
// via the sheet of projectbox/journal.js.
//
// What holds here:
//   - Schema: ONE name per project through the partial UNIQUE index, `removed` frees it; state, phase and field are checked;
//     `base`/`result` JSON there and back, broken ⇒ null. A copy belongs to NO chat: there is no "one live copy per chat" and
//     no index `(chat_id)`, `chat_id` is the creator and may be NULL (a human creates), plus `base_instance` (default "main")
//     and `inset` (0/1). A table from before that (chat_id NOT NULL) is rebuilt at start without losing a row; the migration
//     `migration.copies_free` binds today's copy chats through `chats.instance` and is idempotent.
//   - Names: `K1`, `-a`, `a-`, `main`, `a/b` and 25 characters red; a leftover ref `copy/k1/x` ⇒ suggestion `k2`.
//   - Location: the paths of both sides; the names the entrypoint reads (server/backend/projectbox-entry.sh) are bound.
//   - Path guard: `layer`, `objects`, `returnPath`, `copies-backup`, `overlays.tsv`, `.prepared` as a path part in a string only
//     in stacks/location.js — except the named exceptions (words that spell the same but are no path); comments do not count.
//     With built-in sabotage.
//   - Setter: `waiting_*` does not hold `busy`; the transition to `build` creates the instance row `copy-<name>` IN THE SAME
//     synchronous step in `create`; the phase travels along; `ready` converts; `clearAway`/`earmarked` leaves the instance, from
//     `fetch` it is in `clearAway`; `error` takes a working instance along; `removed` only without an instance row; an invalid
//     transition throws and changes nothing; if the instance row fails, the setter takes the copy back. Every change appears as
//     `project/copy` in the global stream — only identifiers and words.
//   - Journal: `copyJournal(id)` runs via `run`, the storage is the column `journal`; an unknown section throws.
//
// COUNTER-PROOFS (each shown red):
//   store/stack-copies.js index (project_id, name) removed                           ⇒ "Schema …" red (Missing expected exception)
//   stacks/state.js case `build` in coupleInstance removed                           ⇒ "Setter …" red (no instance row in clone1)
//   stacks/state.js rollback in the catch removed, also only that of `result`        ⇒ "Setter …" red
//   stacks/names.js refOccupied checks only `k === space`                            ⇒ "Names …" red (k1 despite copy/k1/x)
//   stacks/names.js without `backups` and without the space                          ⇒ "Names (backups and space) …" red
//   nameFree without the backup check                                                ⇒ same red ("k1 has a backup …")
//   `backups` with default `[]` again                                                ⇒ same red (Missing expected exception)
//   refOccupied without `k === REF_SPACE`                                            ⇒ same red ("k1 free next to …")
//   automaticName without spaceError                                                 ⇒ same red (only a cap sentence: no name
//                                                                                       free, 10,000 attempts)
//   a literal of the copy in projectbox/instance.js, a comment, a removed exception  ⇒ built-in sabotage below
//   Outside this file: the registration "stack-copies" in store.js removed ⇒ schema-register.test.js and
//   tools/check/tree-rules.test.mjs (e) red; the 409 in projectbox/erase.js removed ⇒ projectbox-delete.test.js red; an import
//   of stacks/ from projectbox/ ⇒ import-direction.test.js red.
//   Table rebuild: initStackCopiesSchema does not call rebuildWithoutChatRequired (the old table stays chat_id NOT NULL) ⇒
//   "a table from before …" red; migrateCopiesFree without the marker migration.copies_free ⇒ same red; migrateCopiesFree
//   binds without copyCarriesBinding (also a waiting/never built copy) ⇒ same red.
//
// No clock: waiting is on states and on the stream barrier.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { MAIN_BOTTOM_INSIDE, COPY_ROOT_INSIDE } from "../electron/server/projectbox/creation.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { JournalTurned, run, journalPlan } from "../electron/server/projectbox/journal.js";
import { AUTO_CAP, automaticName, copyInstanceOf, nameError, nameFree, spaceError, refOccupied } from "../electron/server/stacks/names.js";
import { OVERLAYS_FILE, BACKUP_FOLDER, PREPARED_FILE, copyLocation, projectCopiesLocation } from "../electron/server/stacks/location.js";
import { CopyError, TRANSITIONS, copyRequests, copyJournal, setCopyState } from "../electron/server/stacks/state.js";
import { COPIES_FREE_MARKER, migrateCopiesFree } from "../electron/server/stacks/inset.js";
import { json, withAgentsServer } from "./agent-harness.mjs";
import { GLOBAL } from "./quiet.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON = path.join(HERE, "../electron");
const ENTRY = path.join(HERE, "../projectbox-entry.sh");

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-stack-copies-"));
  try {
    store.initStore(dir);
    return fn(dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
async function withStoreAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-stack-copies-"));
  try {
    store.initStore(dir);
    return await fn(dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

// ── Schema ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("Schema: one name per project — `removed` frees it; several live copies per chat and without a chat; state, phase, field checked", () => {
  withStore((dir) => {
    const base = { commit: "abc123", repos: [{ i: 0, path: "app" }] };
    const a = store.createStackCopy({ projectId: "p1", name: "k1", chatId: "c1", base, reason: "probe" });
    assert.deepEqual([a.projectId, a.name, a.chatId, a.state, a.phase, a.reason, a.error], ["p1", "k1", "c1", "waiting_queue", "", "probe", ""]);
    assert.deepEqual([a.baseInstance, a.inset], ["main", false], "defaults of base_instance and inset");
    assert.deepEqual(a.base, base, "base: JSON there and back");
    assert.equal(a.journal, null);
    assert.equal(a.result, null);
    assert.ok(a.requestedAt > 0 && a.createdAt === a.requestedAt);
    assert.equal("instance" in a || "identifier" in a, false, "the instance is computed by creation.js copyInstance — no second version in the store");

    // The same chat creates further live copies — in the same and in another project; a human without a chat likewise
    // (chat_id NULL, several). An index (chat_id) would throw here.
    const a2 = store.createStackCopy({ projectId: "p1", name: "k2", chatId: "c1", inset: true, baseInstance: "copy-k1" });
    assert.deepEqual([a2.chatId, a2.inset, a2.baseInstance], ["c1", true, "copy-k1"]);
    const a3 = store.createStackCopy({ projectId: "p2", name: "k9", chatId: "c1" });
    const m1 = store.createStackCopy({ projectId: "p1", name: "m1" });
    const m2 = store.createStackCopy({ projectId: "p1", name: "m2", chatId: null });
    assert.deepEqual([m1.chatId, m1.inset, m2.chatId], [null, false, null], "a copy without a chat");
    assert.throws(() => store.createStackCopy({ projectId: "p1", name: "m3", inset: true }), /inset requires the chat/, "inset without a chat");
    // One name per project — the same name in another project is free; without a chat the same holds.
    assert.throws(() => store.createStackCopy({ projectId: "p1", name: "k1", chatId: "c2" }), (e) => store.isUniqueViolation(e));
    assert.throws(() => store.createStackCopy({ projectId: "p1", name: "m1" }), (e) => store.isUniqueViolation(e));
    const b = store.createStackCopy({ projectId: "p2", name: "k1", chatId: "c2", state: "waiting_storage" });
    for (const x of [a2, a3, m1, m2]) store.changeStackCopy(x.id, { state: "removed" });

    assert.deepEqual(store.liveStackCopies("p1").map((k) => k.id), [a.id]);
    assert.deepEqual(store.liveStackCopies().map((k) => k.id), [a.id, b.id]);
    assert.deepEqual(store.liveStackCopiesOfChat("c1").map((k) => k.id), [a.id]);
    assert.deepEqual(store.liveStackCopiesOfChat("c9"), []);
    // setStackCopyMoveIn (the migration): only the value, nothing else.
    assert.equal(store.setStackCopyMoveIn(a.id, true).inset, true);
    assert.equal(store.setStackCopyMoveIn(a.id, false).inset, false);
    assert.equal(store.liveStackCopy("p2", "k1").id, b.id);
    assert.deepEqual(store.stackCopiesInState(["waiting_storage"]).map((k) => k.id), [b.id]);
    assert.deepEqual(store.stackCopiesInState([]), []);

    // State, phase, field: nothing silent.
    assert.throws(() => store.createStackCopy({ projectId: "p3", name: "k1", chatId: "c3", state: "running" }), /unknown state/);
    assert.throws(() => store.createStackCopy({ projectId: "p3" }), /mandatory/);
    assert.throws(() => store.changeStackCopy(a.id, { state: "build" }), /not a phase of "build"/);
    assert.throws(() => store.changeStackCopy(a.id, { state: "build", phase: "fetch" }), /not a phase of "build"/);
    assert.throws(() => store.changeStackCopy(a.id, { phase: "clone1" }), /has no phase/);
    assert.throws(() => store.changeStackCopy(a.id, { name: "k2" }), /unknown field name/);
    assert.throws(() => store.stackCopiesInState(["running"]), /unknown state/);
    assert.equal(store.stackCopy(a.id).state, "waiting_queue", "a throw changes nothing");
    const w = store.changeStackCopy(a.id, { state: "build", phase: "clone1" });
    assert.deepEqual([w.prior.state, w.after.state, w.after.phase], ["waiting_queue", "build", "clone1"]);
    assert.equal(store.changeStackCopy(a.id, { state: "ready" }).after.phase, "", "a new state without a phase clears it");

    // removed is history: both indexes free it, the row stays readable, changing throws.
    store.changeStackCopy(a.id, { state: "removed", result: { fetched: ["main"], backedUp: 0 } });
    assert.throws(() => store.changeStackCopy(a.id, { reason: "x" }), /already removed/);
    const c = store.createStackCopy({ projectId: "p1", name: "k1", chatId: "c1" });
    assert.notEqual(c.id, a.id);
    assert.deepEqual(store.stackCopiesOf("p1").filter((k) => k.name === "k1").map((k) => [k.id, k.state]), [[a.id, "removed"], [c.id, "waiting_queue"]]);
    assert.deepEqual(store.liveStackCopies("p1").map((k) => k.id), [c.id]);
    assert.deepEqual(store.stackCopy(a.id).result, { fetched: ["main"], backedUp: 0 });

    // Broken JSON yields null — the row stays readable.
    const raw = new DatabaseSync(path.join(dir, "automater.db"));
    try {
      raw.prepare("UPDATE stack_copies SET base = '{broken', journal = '[' WHERE id = ?").run(c.id);
      // The index is partial and unique — measured on the schema, not only on behavior. NO index (chat_id) any more.
      const idx = raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'stack_copies' ORDER BY name").all();
      assert.deepEqual(idx.map((i) => i.name), ["idx_stack_copies_name"]);
      const columns = raw.prepare("PRAGMA table_info(stack_copies)").all();
      const sp = (n) => columns.find((x) => x.name === n);
      assert.equal(sp("chat_id")?.notnull, 0, "chat_id is still NOT NULL");
      assert.deepEqual([sp("base_instance")?.notnull, sp("base_instance")?.dflt_value], [1, "'main'"]);
      assert.deepEqual([sp("inset")?.notnull, sp("inset")?.dflt_value], [1, "0"]);
      for (const i of idx) assert.match(i.sql, /^CREATE UNIQUE INDEX .* WHERE state != 'removed'$/);
    } finally { raw.close(); }
    const k = store.stackCopy(c.id);
    assert.equal(k.base, null);
    assert.equal(k.journal, null);
  });
});

// ── Names ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("Names: form rule, `main` never; automatically the first free k<n> — a leftover ref `copy/k1/x` ⇒ k2", () => {
  for (const gut of ["k1", "a", "0", "a-b", "k10", "x".repeat(24)]) assert.equal(nameError(gut), null, gut);
  for (const bad of ["K1", "-a", "a-", "main", "a/b", "x".repeat(25), "", "a_b", "ä1", "k 1", "copy.k1"]) {
    assert.equal(typeof nameError(bad), "string", `"${bad}" got through`);
  }
  assert.match(nameError("main"), /das Haupt/);
  assert.equal(typeof nameError(5), "string");
  assert.equal(typeof nameError(null), "string");

  const S0 = { backups: [] }; // no backup in the project (mandatory field)
  assert.equal(automaticName(S0), "k1");
  assert.equal(automaticName({ ...S0, live: ["k1"] }), "k2");
  assert.equal(automaticName({ ...S0, refs: ["refs/heads/copy/k1/x"] }), "k2", "leftover ref (full) ⇒ k2");
  assert.equal(automaticName({ ...S0, refs: ["copy/k1/x"] }), "k2", "leftover ref (short) ⇒ k2");
  assert.equal(automaticName({ ...S0, refs: ["refs/heads/copy/k1"] }), "k2", "the ref copy/<name> itself blocks too (git would let none below it)");
  assert.equal(automaticName({ ...S0, live: ["k1", "k2"], refs: ["copy/k3/main"] }), "k4");
  // No prefix error; removed branches do not count — tags and notes do (the fetch writes into all three spaces, fetch.js
  // copyTagTarget/copyNoteTarget).
  assert.equal(automaticName({ ...S0, refs: ["refs/heads/copy/k10/x", "copy/k1x/a"] }), "k1");
  assert.equal(automaticName({ ...S0, refs: ["refs/remotes/origin/copy/k1/x"] }), "k1");
  assert.equal(automaticName({ ...S0, refs: ["refs/tags/copy/k1/x", "refs/notes/copy/k2/y"] }), "k3", "tag and note occupy their name");
  assert.equal(nameFree("k1", { refs: ["refs/tags/copy/k1/v1"], backups: [] }), false, "a leftover tag copy/k1/v1 left k1 free");
  assert.equal(nameFree("k1", { refs: ["refs/notes/copy/k1"], backups: [] }), false, "the note copy/k1 itself");
  assert.equal(nameFree("k1", { refs: ["refs/tags/copy/k11/v1"], backups: [] }), true);
  assert.equal(refOccupied("k1", ["main", "copy/k1/feature"]), true);
  assert.equal(refOccupied("k1", ["copy/k11/feature"]), false);
  assert.equal(nameFree("k1", { ...S0, live: ["k2"], refs: [] }), true);
  assert.equal(nameFree("main"), false);
  assert.equal(nameFree("K1"), false);
  // The cap says that it is one.
  const all = Array.from({ length: AUTO_CAP }, (_, i) => `k${i + 1}`);
  assert.throws(() => automaticName({ ...S0, live: all }), /Deckel/);
  assert.equal(copyInstanceOf("k1"), "copy-k1");
  assert.throws(() => copyInstanceOf("main"));
});

// A removed name whose backup folder still stands is NOT free (the backup lives per name and survives the clearing away — the
// next copy of the same name would write into it); without the list of backups the rule does not judge. A local branch named
// exactly `copy` blocks the whole space of the copies (git: "'refs/heads/copy' exists; cannot create
// 'refs/heads/copy/k1/main'") — no name is free, automaticName says why.
test("Names (backups and space): a name with a backup is occupied, without `backups` no judgment; a branch `copy` blocks the space", () => {
  // backups
  assert.equal(nameFree("k1", { live: [], refs: [], backups: ["k1"] }), false, "k1 has a backup and counted as free");
  assert.equal(automaticName({ live: [], refs: [], backups: ["k1"] }), "k2", "the removed name with a backup came back");
  assert.equal(automaticName({ live: ["k2"], refs: ["copy/k3/main"], backups: ["k1"] }), "k4");
  assert.equal(nameFree("k2", { backups: ["k1"] }), true, "only the backup's name is occupied");
  assert.throws(() => automaticName({ live: [], refs: [] }), /`backups` is missing/, "without the list of backups");
  assert.throws(() => nameFree("k1", { live: [], refs: [] }), /`backups` is missing/);
  assert.throws(() => automaticName({ backups: null }), /`backups` is missing/);
  // space
  for (const refs of [["refs/heads/copy"], ["copy"], ["main", "refs/heads/copy"]]) {
    assert.equal(nameFree("k1", { refs, backups: [] }), false, `k1 free next to ${JSON.stringify(refs)}`);
    assert.equal(refOccupied("k7", refs), true);
    assert.match(spaceError(refs), /Branch „copy“ .* blockiert den Raum der Kopien/);
    assert.throws(() => automaticName({ refs, backups: [] }), /Branch „copy“ .* blockiert den Raum der Kopien/);
  }
  // A tag or a note named exactly `copy` blocks likewise (git creates no ref below it).
  for (const [refs, who] of [[["refs/tags/copy"], /Tag „copy“ .* blockiert den Raum der Kopien/], [["refs/notes/copy"], /Notiz „refs\/notes\/copy“ .* blockiert den Raum der Kopien/]]) {
    assert.equal(nameFree("k1", { refs, backups: [] }), false, `k1 free next to ${JSON.stringify(refs)}`);
    assert.match(spaceError(refs), who);
    assert.throws(() => automaticName({ refs, backups: [] }), who);
  }
  // Removed branches, tags under another name and branches that only begin with "copy" block nothing.
  for (const refs of [["refs/tags/copied"], ["refs/remotes/origin/copy"], ["copy-old", "copied"], []]) {
    assert.equal(spaceError(refs), null, JSON.stringify(refs));
    assert.equal(automaticName({ refs, backups: [] }), "k1", JSON.stringify(refs));
  }
});

// ── Location ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("Location: the paths in B and inside, the backup folder; a wrong part, index, name or location throws", () => {
  const o = copyLocation({ data: "/d", projectId: "p1", name: "k1" });
  const w = "/d/copies/p1/k1";
  assert.equal(o.root.base, w);
  assert.deepEqual(
    [o.root.layer("p"), o.root.layer("r0"), o.root.layer("local"), o.root.layerObjects("p"), o.root.layerObjects("r2"),
      o.root.objects("p"), o.root.objects("r1"), o.root.work(3), o.root.open, o.root.returnPath(0), o.root.snapshot,
      o.root.overlays, o.root.prepared],
    [`${w}/layer/p`, `${w}/layer/r0`, `${w}/layer/local`, `${w}/layer/p.objects`, `${w}/layer/r2.objects`,
      `${w}/objects/p`, `${w}/objects/r1`, `${w}/work/w3`, `${w}/open`, `${w}/returnPath/r0.git`, `${w}/snapshot.json`,
      `${w}/overlays.tsv`, `${w}/.prepared`]);
  assert.equal(o.inside.base, COPY_ROOT_INSIDE);
  assert.equal(o.inside.layer("p"), `${COPY_ROOT_INSIDE}/layer/p`);
  assert.equal(o.inside.overlays, `${COPY_ROOT_INSIDE}/overlays.tsv`);
  assert.equal(o.backup, "/d/copies-backup/p1/k1");
  assert.deepEqual(projectCopiesLocation({ data: "/d", projectId: "p1" }), { copies: "/d/copies/p1", backup: "/d/copies-backup/p1" });
  assert.equal(BACKUP_FOLDER, "copies-backup");
  // The empty repo per part (also the project repo `p`), its folder, the bundles and the backup's tar.
  assert.deepEqual([o.root.returnPath("p"), o.root.returnPath("r3"), o.root.returnPathFolder, o.bundle(0), o.bundle(12), o.ignoredTar],
    [`${w}/returnPath/p.git`, `${w}/returnPath/r3.git`, `${w}/returnPath`, "/d/copies-backup/p1/k1/n0.bundle", "/d/copies-backup/p1/k1/n12.bundle",
      "/d/copies-backup/p1/k1/ignored.tar"]);

  for (const [what, fn] of [
    ["part x", () => o.root.layer("x")],
    ["part r01", () => o.root.layer("r01")],
    ["local has no objects", () => o.root.layerObjects("local")],
    ["objects local", () => o.root.objects("local")],
    ["index -1", () => o.root.work(-1)],
    ["index 1.5", () => o.root.work(1.5)],
    ["index as text", () => o.root.returnPath("0")],
    ["returnPath local", () => o.root.returnPath("local")],
    ["returnPath ../p", () => o.root.returnPath("../p")],
    ["bundle -1", () => o.bundle(-1)],
    ["bundle as text", () => o.bundle("0")],
    ["name main", () => copyLocation({ data: "/d", projectId: "p1", name: "main" })],
    ["name K1", () => copyLocation({ data: "/d", projectId: "p1", name: "K1" })],
    ["relative data", () => copyLocation({ data: "d", projectId: "p1", name: "k1" })],
    ["project id ../x", () => copyLocation({ data: "/d", projectId: "../x", name: "k1" })],
    ["project id ../x (all)", () => projectCopiesLocation({ data: "/d", projectId: "../x" })],
  ]) assert.throws(fn, TypeError, what);
});

test("Location bound to the entrypoint: /cbase-copy, /cbase-main, overlays.tsv and .prepared stand there as here", () => {
  const sh = fs.readFileSync(ENTRY, "utf8");
  const value = (name) => {
    const m = sh.match(new RegExp(`^${name}="([^"]*)"$`, "m"));
    assert.ok(m, `${name}=… is missing in projectbox-entry.sh`);
    return m[1];
  };
  assert.equal(value("COPY"), `$W${COPY_ROOT_INSIDE}`);
  assert.equal(value("MAIN"), `$W${MAIN_BOTTOM_INSIDE}`);
  const inside = copyLocation({ data: "/d", projectId: "p1", name: "k1" }).inside;
  assert.equal(value("OVERLAYS"), `$COPY/${OVERLAYS_FILE}`);
  assert.equal(value("PREPARED"), `$COPY/${PREPARED_FILE}`);
  assert.equal(inside.overlays, path.posix.join(COPY_ROOT_INSIDE, OVERLAYS_FILE));
  assert.equal(inside.prepared, path.posix.join(COPY_ROOT_INSIDE, PREPARED_FILE));
});

// ── Path guard ────────────────────────────────────────────────────────────────────────────────────────────────────────

const HOME_BASE = "server/stacks/location.js";
// A path part IN a string: a quote or a slash before it (for `objects` also a dot — the ending `.objects`), and the same after
// it. The word in a sentence (`layer` as a phase of a list in a comment) does not count.
const MARKERS = [
  ["layer", /["'`/]layer(?=["'`/])/g],
  ["objects", /["'`/.]objects(?=["'`/])/g],
  ["returnPath", /["'`/]returnPath(?=["'`/])/g],
  ["copies-backup", /["'`/]copies-backup(?=["'`/])/g],
  ["overlays.tsv", /["'`/]overlays\.tsv(?=["'`/])/g],
  [".prepared", /["'`/]\.prepared(?=["'`/])/g],
].map(([name, re]) => ({ name, re }));

/** The named exceptions: the same word, but no path of the copy. */
const PATH_EXCEPTIONS = [
  {
    file: "server/i18n-de.js", marker: "objects", count: 8,
    reason: "not a path of the copy: `.git/objects/…` of a repo in the keys and German entries of the messages from stacks/objects.js (linkObjects).",
  },
  {
    file: "server/projectbox/helper.js", marker: "returnPath", count: 1,
    reason: "no path: the kind of the helper `returnPath` in HELPER_KINDS (the helper rebuilds a relocation or a copy backward).",
  },
  {
    file: "server/projectbox/relocation/procedure.js", marker: "returnPath", count: 1,
    reason: "no path: the phase `returnPath` of the main instance during the return path of a relocation.",
  },
  {
    file: "server/stacks/freeze.js", marker: "layer", count: 2,
    reason: "no path: the subcommand `layer` of the clone program cbase-clone (copy from a copy: phase 1 live, phase 2 in the pause — source and target come from stacks/location.js).",
  },
  {
    file: "server/store/stack-copies.js", marker: "layer", count: 1,
    reason: "no path: the phase `layer` of the clearing away (STACK_COPY_PHASES — the upper layer is removed there).",
  },
  {
    file: "server/stacks/returnPath.js", marker: "returnPath", count: 1,
    reason: "no path: the kind of the helper `returnPath` in withReturnPathHelper (the paths of the return path come from stacks/location.js).",
  },
  {
    file: "server/projectbox/layout/program.js", marker: "objects", count: 1,
    reason: "no path of the copy: `.git/objects` — git's own object folder.",
  },
  {
    file: "server/projectbox/layout/rebuild-program.js", marker: "objects", count: 1,
    reason: "no path of the copy: `.git/objects` — git's own object folder.",
  },
  {
    file: "server/projectbox/relocation/collect.js", marker: "objects", count: 2,
    reason: "no path of the copy: `.git/objects` — git's own object folder.",
  },
  {
    file: "server/projectbox/relocation/data.js", marker: "objects", count: 1,
    reason: "no path of the copy: `.git/objects` — git's own object folder.",
  },
  {
    file: "server/projectbox/relocation/plan.js", marker: "objects", count: 2,
    reason: "no path of the copy: `.git/objects` — git's own object folder.",
  },
  {
    file: "server/stacks/code-snapshot.js", marker: "objects", count: 1,
    reason: "no path of the copy: `.git/objects` — git's own object folder.",
  },
  {
    file: "server/stacks/creation.js", marker: "objects", count: 2,
    reason: "no path of the copy: `.git/objects` — git's own object folder; plus the kind `objects` of an overlay (no path).",
  },
  {
    file: "server/stacks/objects.js", marker: "objects", count: 5,
    reason: "no path of the copy: `.git/objects` — git's own object folder — in messages and when creating the empty repo.",
  },
  {
    file: "server/stacks/returnPath.js", marker: "objects", count: 4,
    reason: "no path of the copy: `.git/objects` — git's own object folder and `.git/lfs/objects` of git-lfs.",
  },
];

// Comments out, lines stay (for the line numbers). Strings with ' and " end at the line at the latest — a regex literal with a
// quote would otherwise swallow the rest of the file; templates (`) and block comments may span lines.
export function withoutComments(text) {
  let out = "";
  let state = "code";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "row"; i++; continue; }
      if (c === "/" && n === "*") { state = "block"; i++; continue; }
      if (c === "'" || c === "\"" || c === "`") state = c;
      out += c;
    } else if (state === "row") {
      if (c === "\n") { state = "code"; out += c; }
    } else if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; i++; } else if (c === "\n") out += c;
    } else {
      if (c === "\\") { out += c + (n ?? ""); i++; continue; }
      if (c === state || (c === "\n" && state !== "`")) state = "code";
      out += c;
    }
  }
  return out;
}

function sourceFiles(root = ELECTRON) {
  const out = [];
  const run2 = (dir) => {
    for (const n of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (n.name === "node_modules") continue;
      const abs = path.join(dir, n.name);
      if (n.isDirectory()) run2(abs);
      else if (/\.(c|m)?js$/.test(n.name)) out.push({ path: path.relative(root, abs).split(path.sep).join("/"), text: fs.readFileSync(abs, "utf8") });
    }
  };
  run2(root);
  return out;
}

function pathHits(files) {
  const hits = new Map();
  for (const d of files) {
    if (d.path === HOME_BASE) continue;
    const rows = withoutComments(d.text).split("\n");
    for (const m of MARKERS) {
      rows.forEach((z, i) => {
        const n = (z.match(m.re) || []).length;
        if (!n) return;
        const k = `${d.path}#${m.name}`;
        const t = hits.get(k) || { file: d.path, marker: m.name, count: 0, rows: [] };
        t.count += n;
        t.rows.push(i + 1);
        hits.set(k, t);
      });
    }
  }
  return hits;
}

function pathViolations(hits, exceptions) {
  const v = [];
  const list = new Map(exceptions.map((e) => [`${e.file}#${e.marker}`, e]));
  for (const [k, t] of hits) {
    const e = list.get(k);
    if (!e) v.push(`NEW ${t.marker} in ${t.file} (line ${t.rows.join(", ")}) — the path belongs in ${HOME_BASE} or, with a reason, in PATH_EXCEPTIONS`);
    else if (e.count !== t.count) v.push(`${k}: ${t.count} instead of ${e.count} (line ${t.rows.join(", ")})`);
  }
  for (const [k] of list) if (!hits.has(k)) v.push(`Entry without hit ${k} — renamed? Then strike the entry`);
  return v;
}

test("Path guard: the literals of the copy stand only in stacks/location.js — except the named list", () => {
  const files = sourceFiles();
  const homeBase = files.find((d) => d.path === HOME_BASE);
  assert.ok(homeBase, `${HOME_BASE} is missing — the guard looks in the wrong place`);
  // Every marker stands in the home (without comments): otherwise the guard would check a spelling that does not exist.
  const homeBaseCode = withoutComments(homeBase.text);
  for (const m of MARKERS) assert.ok((homeBaseCode.match(m.re) || []).length > 0, `${m.name} is missing in ${HOME_BASE}`);
  for (const e of PATH_EXCEPTIONS) console.log(`[stacks-location] exception ${e.file} ${e.marker} (${e.count}×): ${e.reason}`);
  const hits = pathHits(files);
  console.log(`[stacks-location] measured: ${[...hits.values()].reduce((n, t) => n + t.count, 0)} hits outside ${HOME_BASE} over ${files.length} files`);
  assert.deepEqual(pathViolations(hits, PATH_EXCEPTIONS), []);
});

test("Path guard, built-in sabotage: a new path in projectbox/instance.js is red, a comment is not, a removed exception is", () => {
  const real = sourceFiles();
  const including = (filePath, text) => [...real.filter((d) => d.path !== filePath), { path: filePath, text }];
  const one = (files) => pathViolations(pathHits(files), PATH_EXCEPTIONS);
  const target = "server/projectbox/instance.js";
  const instance = real.find((d) => d.path === target).text;
  for (const addition of [
    'const x = path.join(base, "layer", "p");',
    "const y = `${w}/objects/p`;",
    "const y2 = `${part}.objects`;",
    "const z = base + '/returnPath/r0.git';",
    "const s = `${data}/copies-backup/${pid}`;",
    'const o = path.join(COPY_ROOT_INSIDE, "overlays.tsv");',
    "const v = path.join(k, '.prepared');",
  ]) {
    const v = one(including(target, `${instance}\n${addition}\n`));
    assert.equal(v.length, 1, `not detected: ${addition}\n${v.join("\n")}`);
    assert.match(v[0], /^NEW .* in server\/projectbox\/instance\.js/);
  }
  // A comment is no path — in both forms, also behind code.
  assert.deepEqual(one(including(target, `${instance}\n// see "layer/p" and \`overlays.tsv\`\n/* "returnPath/r0.git" */\nconst q = 1; // "/copies-backup/"\n`)), []);
  // A string with // in it stays code.
  assert.equal(one(including(target, `${instance}\nconst u = "https://x" + "/layer/p";\n`)).length, 1);
  // The exception is counted: if it drops out, the entry is red; if a second one is added, too.
  const helper = real.find((d) => d.path === "server/projectbox/helper.js").text;
  const without = helper.replace(/"returnPath"(?=\s*,\s*"clearAway")/, '"rollback"');
  assert.notEqual(without, helper, "the sabotage replaced nothing");
  assert.deepEqual(one(including("server/projectbox/helper.js", without)), ["Entry without hit server/projectbox/helper.js#returnPath — renamed? Then strike the entry"]);
  const skStore = real.find((d) => d.path === "server/store/stack-copies.js").text;
  const duplicate = one(including("server/store/stack-copies.js", `${skStore}\nconst p = "layer";\n`));
  assert.equal(duplicate.length, 1);
  assert.match(duplicate[0], /: 2 instead of 1/);
});

// ── Journal ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test("Journal: copyJournal runs via the journal sheet, the storage is the column journal — sections named, removed is history", async () => {
  await withStoreAsync(async () => {
    const k = store.createStackCopy({ projectId: "p1", name: "k1", chatId: "c1" });
    const plan = journalPlan({ forward: ["clone1", "freeze", "start"], backward: ["thaw"], pivot: "start" });
    const j = copyJournal(k.id);
    assert.equal(j.snapshot(), null, "nothing announced");
    const run2 = [];
    const effect = (n, f) => async () => { run2.push(n); if (f) await f(); };
    const r = await run(plan, j, {
      clone1: effect("clone1", () => j.note({ plan: { repos: 2 } })),
      freeze: effect("freeze"),
      start: effect("start"),
      thaw: effect("thaw"),
    }, { fresh: true });
    assert.deepEqual(r, { direction: "forward", run: ["clone1", "freeze", "start"] });
    assert.deepEqual(run2, ["clone1", "freeze", "start"]);
    const state = store.stackCopy(k.id).journal;
    assert.deepEqual([state.direction, state.step, state.done], ["forward", "start", "start"]);
    assert.deepEqual(state.data, { plan: { repos: 2 } });
    assert.deepEqual(state.log.map((p) => `${p.what}:${p.step}`), ["announced:clone1", "done:clone1", "announced:freeze", "done:freeze", "announced:start", "done:start"]);
    // A second journal over the same row (the restart) reads the same state.
    assert.deepEqual(copyJournal(k.id).snapshot(), { direction: "forward", step: "start", done: "start" });

    // An error before the turn reverses — the way back is in the journal.
    const k2 = store.createStackCopy({ projectId: "p1", name: "k2", chatId: "c2" });
    const j2 = copyJournal(k2.id);
    await assert.rejects(run(plan, j2, {
      clone1: async () => {}, freeze: async () => { throw new Error("pause failed"); }, start: async () => {}, thaw: async () => {},
    }, { fresh: true }), (e) => e instanceof JournalTurned);
    assert.deepEqual(copyJournal(k2.id).snapshot(), { direction: "backward", step: "thaw", done: "thaw" });

    // Unknown section, unknown direction: throw, nothing written. removed: the journal is history.
    assert.throws(() => store.writeStackCopyJournal(k.id, { data: { worktrees: [] } }), /unknown section "worktrees"/);
    assert.throws(() => store.writeStackCopyJournal(k.id, { direction: "sideways" }), /unknown direction/);
    assert.deepEqual(store.stackCopy(k.id).journal.data, { plan: { repos: 2 } });
    store.writeStackCopyJournal(k.id, { data: { plan: null, report: { ok: true } } });
    assert.deepEqual(store.stackCopy(k.id).journal.data, { report: { ok: true } }, "a section is replaced as a whole, null strikes it");
    store.changeStackCopy(k.id, { state: "removed" });
    assert.throws(() => store.writeStackCopyJournal(k.id, { step: "x" }), /history/);
  });
});

// ── Setter ────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function active(base) { return json(`${base}/api/runs/active`); }

// A reader of the global stream (/api/events) — the same form as in project-instances.test.js.
async function globalReaderFor(base) {
  const events = [];
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal, headers: { Accept: "text/event-stream", Connection: "close" } });
  assert.equal(res.status, 200);
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch { /* partial line */ } }
        }
      }
    } catch { /* abort on closing */ }
  })();
  return { events, async shutdown() { ac.abort(); await pump; } };
}

const work = (a) => a.projectWork.map((x) => [x.projectId, x.instance, x.state, x.phase]);

test("Setter: waiting does not hold busy; build creates the instance row in the same step; ready converts; earmarked only here", async () => {
  await withAgentsServer(async ({ base, waitForTruthy, barrier }) => {
    const reader = await globalReaderFor(base);
    const pid = "p-copy";
    try {
      await waitForTruthy(() => reader.events.some((e) => e.type === "init"), "init of the global stream");
      const bar = await barrier(reader, GLOBAL);

      // The request: only waiting, form checked, one name per project — 409 with a code. A second copy of the same chat is
      // allowed.
      assert.throws(() => copyRequests({ projectId: pid, name: "K1", chatId: "c-a" }), TypeError);
      assert.throws(() => copyRequests({ projectId: pid, name: "k1", chatId: "c-a", state: "build" }), /begins waiting/);
      const k = copyRequests({ projectId: pid, name: "k1", chatId: "c-a", base: { from: "main" } });
      assert.equal(k.state, "waiting_queue");
      assert.equal(k.inset, true, "with a chat: inset is the default");
      const second = copyRequests({ projectId: "p-different", name: "k7", chatId: "c-a" });
      assert.equal(second.state, "waiting_queue", "a second copy of the same chat");
      const without = copyRequests({ projectId: "p-different", name: "k8" });
      assert.deepEqual([without.chatId, without.inset], [null, false], "without a chat: no inset");
      for (const x of [second, without]) setCopyState(x.id, "removed");
      for (const [request, set] of [
        [{ projectId: pid, name: "k1", chatId: "c-b" }, /im Projekt p-copy lebt schon eine Kopie „k1“ \(waiting_queue\)/],
        [{ projectId: pid, name: "k1", chatId: "c-a" }, /im Projekt p-copy lebt schon eine Kopie „k1“/],
        [{ projectId: pid, name: "k1" }, /im Projekt p-copy lebt schon eine Kopie „k1“/],
      ]) {
        assert.throws(() => copyRequests(request), (e) => e instanceof CopyError && e.code === "COPY_OCCUPIED" && e.status === 409 && set.test(e.message));
      }
      assert.equal(store.projectInstance(pid, "copy-k1"), null, "waiting: no instance row");
      let a = await active(base);
      assert.equal(a.busy, false, "waiting_queue does not hold busy");
      assert.deepEqual(a.projectWork, []);

      setCopyState(k.id, "waiting_storage", { reason: "storage low" });
      assert.equal((await active(base)).busy, false, "waiting_storage does not hold busy");

      // An invalid transition throws and changes nothing — neither the copy nor the instance.
      assert.throws(() => setCopyState(k.id, "ready"), /no transition "waiting_storage" → "ready"/);
      assert.throws(() => setCopyState(k.id, "build"), /is not a phase of "build"/);
      assert.throws(() => setCopyState(k.id, "build", { phase: "fetch" }), /is not a phase of "build"/);
      assert.throws(() => setCopyState(k.id, "running"), /unknown state/);
      assert.equal(store.stackCopy(k.id).state, "waiting_storage");
      assert.equal(store.projectInstance(pid, "copy-k1"), null);

      // In the SAME synchronous step — no await between the setter and the look at the instance row.
      setCopyState(k.id, "build", { phase: "clone1" });
      const inst = store.projectInstance(pid, "copy-k1");
      assert.ok(inst, "build/clone1 without an instance row — busy, reaper and delete lock would see nothing");
      assert.deepEqual([inst.state, inst.phase, inst.chatId, inst.copyName, inst.convertedAt], ["create", "clone1", "c-a", "k1", null]);
      a = await active(base);
      assert.equal(a.busy, true, "clone1 holds busy");
      assert.deepEqual(work(a), [[pid, "copy-k1", "create", "clone1"]]);

      setCopyState(k.id, "build", { phase: "freeze" });
      assert.equal(store.projectInstance(pid, "copy-k1").phase, "freeze", "the phase travels along");
      assert.deepEqual(work(await active(base)), [[pid, "copy-k1", "create", "freeze"]]);

      setCopyState(k.id, "ready");
      const b = store.projectInstance(pid, "copy-k1");
      assert.equal(b.state, "ready");
      assert.ok(b.convertedAt > 0, "ready without converted_at");
      assert.equal((await active(base)).busy, false);

      // earmarked is only in stack_copies.
      setCopyState(k.id, "clearAway", { phase: "earmarked" });
      assert.equal(store.projectInstance(pid, "copy-k1").state, "ready", "earmarked touched the instance");
      assert.equal((await active(base)).busy, false, "earmarked does not hold busy");
      setCopyState(k.id, "clearAway", { phase: "fetch" });
      assert.deepEqual(work(await active(base)), [[pid, "copy-k1", "clearAway", "fetch"]]);

      // error takes the working instance along.
      setCopyState(k.id, "error", { error: "probe: fetch failed" });
      const f = store.projectInstance(pid, "copy-k1");
      assert.deepEqual([f.state, f.error], ["error", "probe: fetch failed"]);
      a = await active(base);
      assert.equal(a.busy, false);
      assert.deepEqual(a.projectWork, []);

      // removed only without an instance row (the clearing-away path removes it beforehand) — otherwise a throw, nothing written.
      assert.throws(() => setCopyState(k.id, "removed"), /removed only without an instance row/);
      assert.equal(store.stackCopy(k.id).state, "error");
      store.deleteProjectInstance(pid, "copy-k1");
      setCopyState(k.id, "removed", { result: { fetched: [] } });
      assert.deepEqual(store.liveStackCopiesOfChat("c-a"), []);
      assert.throws(() => setCopyState(k.id, "waiting_queue"), /no transition "removed"/);
      assert.deepEqual(TRANSITIONS.removed, []);

      // If the instance row fails, the setter takes the copy back: ready without an instance row.
      const k2 = copyRequests({ projectId: pid, name: "k2", chatId: "c-a" });
      setCopyState(k2.id, "build", { phase: "clone1" });
      store.deleteProjectInstance(pid, "copy-k2");
      assert.throws(() => setCopyState(k2.id, "ready", { result: { probe: 1 } }), /instance p-copy\/copy-k2 is missing/);
      const back = store.stackCopy(k2.id);
      assert.deepEqual([back.state, back.phase, back.result], ["build", "clone1", null], "the copy was afterwards in a state that no instance row carries");
      setCopyState(k2.id, "error", { error: "probe" });
      setCopyState(k2.id, "waiting_queue");
      assert.equal(store.stackCopy(k2.id).error, "", "a new attempt does not carry the old reason along");
      setCopyState(k2.id, "removed");

      const until = await barrier(reader, GLOBAL);
      const ev = reader.events.slice(bar, until).filter((e) => e.type === "project/copy");
      for (const e of ev) assert.deepEqual(Object.keys(e).sort(), ["chatId", "error", "id", "name", "phase", "projectId", "state", "type"], "only identifiers and words");
      assert.deepEqual(ev.filter((e) => e.id === k.id).map((e) => [e.state, e.phase, e.error]), [
        ["waiting_queue", "", ""],
        ["waiting_storage", "", ""],
        ["build", "clone1", ""],
        ["build", "freeze", ""],
        ["ready", "", ""],
        ["clearAway", "earmarked", ""],
        ["clearAway", "fetch", ""],
        ["error", "", "probe: fetch failed"],
        ["removed", "", ""],
      ]);
      assert.deepEqual(ev.filter((e) => e.id === k2.id).map((e) => [e.state, e.phase]), [
        ["waiting_queue", ""], ["build", "clone1"], ["error", ""], ["waiting_queue", ""], ["removed", ""],
      ], "a rolled-back change reports nothing");
      assert.ok(reader.events.slice(bar, until).some((e) => e.type === "project/instance" && e.instance === "copy-k1" && e.state === "create"), "the instance row reports itself");
    } finally {
      for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) setInstanceState(z.projectId, z.instance, "error", { error: "end of test" });
      await reader.shutdown();
    }
  });
});

// ── Rebuild of the old table, migration copies_free ──────────────────────────────────────────────────────────────────────

// The table as it was created before the chat constraint was dropped — with both indexes.
const OLD_TABLE = `
  CREATE TABLE stack_copies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, name TEXT NOT NULL, chat_id TEXT NOT NULL,
    base TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, phase TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
    requested_at INTEGER NOT NULL, journal TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX idx_stack_copies_chat ON stack_copies(chat_id) WHERE state != 'removed';
  CREATE UNIQUE INDEX idx_stack_copies_name ON stack_copies(project_id, name) WHERE state != 'removed';`;

test("a table from before the chat constraint (chat_id NOT NULL, index per chat) is rebuilt at start — no row lost, index (chat_id) gone; the migration copies_free binds today's copy chats (chats.instance), sets inset and is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-stack-copies-alt-"));
  try {
    const raw = new DatabaseSync(path.join(dir, "automater.db"));
    try {
      raw.exec(OLD_TABLE);
      const one = raw.prepare("INSERT INTO stack_copies (project_id, name, chat_id, base, state, reason, requested_at, journal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      one.run("p1", "k1", "c1", '{"commit":"abc"}', "ready", "probe", 1, "", 1, 1);   // binds c1 (in project p1)
      one.run("p1", "k2", "c2", "", "waiting_queue", "", 2, "", 2, 2);                   // waiting: does not bind
      one.run("p1", "k3", "c3", "", "removed", "", 3, "", 3, 3);                       // history: untouched
      one.run("p2", "k1", "c4", "", "ready", "", 4, "", 4, 4);                         // c4 stands in p1: rests
    } finally { raw.close(); }

    store.initStore(dir);
    const rows = () => [...store.stackCopiesOf("p1"), ...store.stackCopiesOf("p2")];
    assert.deepEqual(rows().map((k) => [k.projectId, k.name, k.chatId, k.state, k.inset, k.baseInstance]), [
      ["p1", "k1", "c1", "ready", false, "main"],
      ["p1", "k2", "c2", "waiting_queue", false, "main"],
      ["p1", "k3", "c3", "removed", false, "main"],
      ["p2", "k1", "c4", "ready", false, "main"],
    ], "the rebuild lost or changed a row");
    assert.deepEqual(store.stackCopy(rows()[0].id).base, { commit: "abc" });
    const check = new DatabaseSync(path.join(dir, "automater.db"));
    try {
      assert.equal(check.prepare("PRAGMA table_info(stack_copies)").all().find((x) => x.name === "chat_id").notnull, 0, "chat_id stayed NOT NULL");
      assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'stack_copies' ORDER BY name").all().map((i) => i.name), ["idx_stack_copies_name"]);
    } finally { check.close(); }
    // After the rebuild: a second copy of c1 and one without a chat — both threw before.
    const second = store.createStackCopy({ projectId: "p1", name: "k5", chatId: "c1" });
    const without = store.createStackCopy({ projectId: "p1", name: "k6" });
    store.changeStackCopy(second.id, { state: "removed" });
    store.changeStackCopy(without.id, { state: "removed" });

    // A second start does not rebuild again (idempotent).
    store.initStore(dir);
    assert.equal(rows().length, 6);

    // The migration (server.js, once per storage).
    const t = Date.now();
    for (const [id, projectId] of [["c1", "p1"], ["c2", "p1"], ["c4", "p1"]]) store.createChat({ id, workspaceId: "w1", projectId, createdAt: t, updatedAt: t });
    assert.equal(store.getSetting(COPIES_FREE_MARKER, ""), "", "the marker was already set");
    assert.deepEqual(migrateCopiesFree(), { copies: 3, bound: 1 });
    assert.deepEqual(["c1", "c2", "c4"].map((id) => store.getChat(id).instance), ["copy-k1", null, null], "the binding does not follow today's rule");
    assert.deepEqual(rows().filter((k) => k.requestedAt <= 4).map((k) => [k.projectId, k.name, k.inset]),
      [["p1", "k1", true], ["p1", "k2", true], ["p1", "k3", false], ["p2", "k1", true]], "inset of the old rows (removed stays)");
    assert.deepEqual(rows().filter((k) => k.requestedAt > 4).map((k) => k.inset), [false, false], "the migration touched a removed row of today");
    assert.deepEqual(store.listMessages("c1"), [], "the migration wrote a separator — nothing changes for the chat");
    // Idempotent: the marker is set, a second run does nothing — not even if something changed meanwhile.
    assert.ok(store.getSetting(COPIES_FREE_MARKER, ""));
    store.updateChat("c1", { instance: null });
    assert.equal(migrateCopiesFree(), null);
    assert.equal(store.getChat("c1").instance, null, "the second run bound again");
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
});
